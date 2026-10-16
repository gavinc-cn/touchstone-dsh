/**
 * M6-6 端点族单测（`node --test`）：覆盖**实例级对拍难表达**的分支。
 *
 * 对拍（`tools/parity/http-run.mjs` 的 `m6_*` 三个场景）覆盖的是「同一份夹具 + 同一串请求，
 * 两版后端逐字节/逐 op 落库 dump 比」。下面这些档位它表达不了，故在此逐条钉住：
 *   ① `load/stream` 的**裸 `id:/data:` 帧**：对拍的 text 档能比整段字节，但造不出「坏行/空行
 *      推进行号」「Last-Event-ID 续传」「首连只回放最后 20000 行」这三条语义（夹具里没有
 *      这些形态的指标文件，量具也不能造文件）；
 *   ② `load/custom_html` 的**两个安全响应头**（`X-Content-Type-Options` /
 *      `Content-Security-Policy`）：http-run 的观测面只有 status/content-type/正文哈希，
 *      拿不到这两头；
 *   ③ 内置资产的 **403（用户级写仅管理员）与 500（磁盘 OSError）**：对拍登录态恒 admin
 *      （信任头由量具统一注入，不能按 op 换用户）；
 *   ④ RAG 三条的 **403**：同上；
 *   ⑤ bug 拒绝的 **200 成功档**：要磁盘上真有 `bug_report/<dir>/bug_report.md`，
 *      对拍夹具不造 bug 目录；
 *   ⑥ `profile`/`rewind` 的 **200 档**：要真 driver（假 driver 注入 `TS_AGENT_DRIVER_URL`）。
 *
 * 另外两条「只能单侧验」的富文本判据（期望值由**真 Python 探针**产出，命令见各用例头）：
 *   - `_load_diagnose_text` 的 KPI 渲染（`受理委托=1190` 是 int、`错误率=0.0` 是 float，
 *     Python 的 f-string 两者形态不同 ⇒ 需要 `JSON.parse` 的 `context.source` 才分得出来）；
 *   - `_append_reject_record` 的小节形态（贪婪 `\s*` 吃掉空行后再拼回）。
 *
 * 两条隔离纪律（沿用 `board-write-route-m5c.test.mjs`）：
 *   - **资产用例必须双隔离**：`TS_EXT_DIR`（清单根）与 `TS_DSH_PROFILES`（profile 落点）
 *     都指到临时夹具，**绝不**碰真 `~/.dsh`；用例结束在 finally 里还原 env；
 *   - **会话用例必须还原会话根**：`sessparse.setSessionsRoot` 指到夹具，finally 还原。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';

import { nowStr } from '../lib/db.js';
import * as runner from '../lib/runner.js';
import * as sessparse from '../lib/sessparse.js';
import { dispatch, makeContext } from '../routes/index.js';
import { freshDb, insertProject, insertTask } from './m3fixture.mjs';

// --------------------------------------------------------------------------
// 测试台
// --------------------------------------------------------------------------

/** 假 `res`：`openSse` 要 `writeHead/flushHeaders/write/end`，普通响应用 `writeHead/end` */
function fakeRes() {
  const cap = { status: null, headers: null, chunk: [], body: null, destroyed: false };
  return {
    cap,
    res: {
      writeHead(status, headers) { cap.status = status; cap.headers = headers; },
      flushHeaders() { /* 无 socket：忽略 */ },
      write(text) { cap.chunk.push(Buffer.from(String(text), 'utf8')); return true; },
      end(buf) {
        if (buf !== undefined && buf !== null) cap.chunk.push(Buffer.from(buf));
        cap.body = Buffer.concat(cap.chunk);
      },
      destroy() { cap.destroyed = true; },
    },
  };
}

function fakeReq(method, body, headers = {}) {
  const text = body === undefined ? '' : Buffer.from(JSON.stringify(body), 'utf8');
  const stream = Readable.from(text.length ? [text] : [], { objectMode: false });
  stream.headers = { ...(text.length ? { 'content-length': String(text.length) } : {}), ...headers };
  stream.method = method;
  return stream;
}

/** 起一份夹具库 + 一个项目（`workDir` 在临时目录里，落盘用例都往它下面写） */
function setup(tag) {
  const fx = freshDb(`m6-${tag}`);
  const work = path.join(fx.dir, 'work');
  fs.mkdirSync(path.join(work, '.web'), { recursive: true });
  fs.mkdirSync(path.join(work, 'free_style'), { recursive: true });
  const pid = insertProject(fx.db, {
    userId: 1, name: `P-${tag}`, projectDir: path.join(fx.dir, 'proj'), workDir: work,
  });
  fs.mkdirSync(path.join(fx.dir, 'proj'), { recursive: true });
  const adminRow = fx.db.prepare('SELECT * FROM users WHERE id=1').get();
  const bobRow = (() => {
    fx.db.prepare('INSERT INTO users(id, username, pass_hash, salt, must_change_pw, created_at)'
      + ' VALUES (?,?,?,?,?,?)').run(101, 'bob', 'x', '', 0, '2026-10-12 00:00:00');
    return fx.db.prepare('SELECT * FROM users WHERE id=101').get();
  })();
  return { ...fx, pid, work, adminRow, bobRow };
}

async function call(env, method, target, { body, user, headers } = {}) {
  const { res, cap } = fakeRes();
  const ctx = makeContext({
    req: fakeReq(method, body, headers),
    res,
    db: env.db,
    user: user === undefined ? env.adminRow : user,
    path: target.split('?')[0],
    // `search` 是**去掉 `?`** 的那一段（`server.js:93` 同口径）；带上 `?` 会被
    // `parseQs` 当成键名的一部分（`?run`）⇒ 查询参数静默失效。
    search: target.includes('?') ? target.slice(target.indexOf('?') + 1) : '',
  });
  const hit = await dispatch(ctx);
  return {
    hit,
    ...cap,
    text: () => (cap.body === null ? null : cap.body.toString('utf8')),
    json: () => (cap.body === null ? null : JSON.parse(cap.body.toString('utf8'))),
  };
}

/** 一条指标行（新格式，value 用非整数值浮点 ⇒ 两侧 repr 一致，便于逐字节断言） */
const metricLine = (ts, metric, value) => JSON.stringify(
  { ts, metric, value, type: 'gauge' });

/** 落一条 `kind='load'` 的轮次行（`_load_run_row` 只认这个 kind） */
function insertLoadRound(env, taskId, { runKey = '20260101_000000', status = 'done',
  roundNo = 3, exitCode = 0, logPath = '', startedAt = '2026-01-01 00:00:00',
  endedAt = '2026-01-01 00:10:00' } = {}) {
  env.db.prepare('INSERT INTO rounds(task_id, round_no, status, exit_code, log_path, kind, run_key,'
    + ' started_at, ended_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(taskId, roundNo, status, exitCode, logPath, 'load', runKey, startedAt, endedAt);
}

// --------------------------------------------------------------------------
// ① load/stream：裸 id:/data: 帧 + 坏行/空行推进行号 + Last-Event-ID 续传 + 回放上限
// --------------------------------------------------------------------------

test('GET /load/stream：裸帧逐字节 + 坏行/空行推进行号 + 收尾 done 帧', async () => {
  const s = setup('stream');
  const tid = insertTask(s.db, s.pid, { name: '压测', taskType: 'stress', status: 'done' });
  insertLoadRound(s, tid, {});
  const metrics = path.join(s.work, '.web', `task_${tid}_metrics_20260101_000000.jsonl`);
  fs.writeFileSync(metrics, [
    metricLine(1.5, 'rps', 2.5),
    'not json at all',                       // 坏行：跳过样本但**行号照常推进**（id=2）
    '',                                      // 空行：行号**不**推进
    '{"kind": "meta", "ts": 3.5}',           // 控制行原样透传（id=3）
    '',
  ].join('\n'), 'utf8');
  const r = await call(s, 'GET', `/api/tasks/${tid}/load/stream`);
  assert.equal(r.status, 200);
  assert.equal(r.headers['Content-Type'], 'text/event-stream; charset=utf-8');
  assert.equal(r.headers['Cache-Control'], 'no-store');
  // 只有看板那两条流带这个头；压测流**不带**（server.py:4683-4685 只发两个头）
  assert.equal(r.headers['X-Accel-Buffering'], undefined);
  assert.equal(r.text(), 'id: 1\ndata: {"ts": 1.5, "metric": "rps", "value": 2.5, "type": "gauge"}\n\n'
    + 'id: 3\ndata: {"kind": "meta", "ts": 3.5}\n\n'
    + 'data: {"done":true}\n\n');
  s.close();
});

test('GET /load/stream：Last-Event-ID 续传（从该行之后续推，不回放已看过的）', async () => {
  const s = setup('stream-resume');
  const tid = insertTask(s.db, s.pid, { name: '压测', taskType: 'stress', status: 'done' });
  insertLoadRound(s, tid, {});
  const metrics = path.join(s.work, '.web', `task_${tid}_metrics_20260101_000000.jsonl`);
  fs.writeFileSync(metrics, [
    metricLine(1.5, 'rps', 2.5),
    metricLine(2.5, 'rps', 3.5),
    metricLine(3.5, 'rps', 4.5),
    '',
  ].join('\n'), 'utf8');
  const r = await call(s, 'GET', `/api/tasks/${tid}/load/stream`,
    { headers: { 'last-event-id': '2' } });
  // after=2 ⇒ 从第 3 行（0-based 2）起；只有它一条样本 ⇒ id 从 3 开始
  assert.equal(r.text(), 'id: 3\ndata: {"ts": 3.5, "metric": "rps", "value": 4.5, "type": "gauge"}\n\n'
    + 'data: {"done":true}\n\n');
  // 非法头（Python int() 抛 ValueError ⇒ 按首连处理：回放最后 LOAD_STREAM_REPLAY_MAX 行）
  const bad = await call(s, 'GET', `/api/tasks/${tid}/load/stream`,
    { headers: { 'last-event-id': 'abc' } });
  assert.match(bad.text(), /^id: 1\ndata: \{"ts": 1\.5/);
  s.close();
});

test('GET /load/stream：首连只回放最后 20000 行（LOAD_STREAM_REPLAY_MAX）', async () => {
  const s = setup('stream-tail');
  const tid = insertTask(s.db, s.pid, { name: '压测', taskType: 'stress', status: 'done' });
  insertLoadRound(s, tid, {});
  const metrics = path.join(s.work, '.web', `task_${tid}_metrics_20260101_000000.jsonl`);
  const total = 20003;
  const lines = [];
  for (let i = 0; i < total; i += 1) lines.push(metricLine(1.5, 'rps', 2.5));
  fs.writeFileSync(metrics, `${lines.join('\n')}\n`, 'utf8');
  const r = await call(s, 'GET', `/api/tasks/${tid}/load/stream`);
  const frames = r.text().match(/^id: (\d+)$/gm) || [];
  assert.equal(frames.length, 20000);                    // 只回放最后两万行
  assert.equal(frames[0], 'id: 4');                      // 20003 - 20000 + 1
  assert.equal(frames[frames.length - 1], `id: ${total}`);
  assert.match(r.text(), /data: \{"done":true\}\n\n$/);
  s.close();
});

test('GET /load/stream：轮次 running 但任务已非 running ⇒ live 仍为真、推完样本即收尾（不空转）', async () => {
  const s = setup('stream-live');
  const tid = insertTask(s.db, s.pid, { name: '压测', taskType: 'stress', status: 'done' });
  // 轮次行 status='running' ⇒ `_load_run_row` 命中「正在跑的那次运行」分支（live=true）；
  // 但任务行不是 running ⇒ 推完已有样本必须补 `{"done":true}` 并返回。
  // 这条是「会不会挂住」的判据：Node 侧循环里若漏掉任务状态检查，此用例会超时。
  insertLoadRound(s, tid, { status: 'running' });
  const metrics = path.join(s.work, '.web', `task_${tid}_metrics_20260101_000000.jsonl`);
  fs.writeFileSync(metrics, `${metricLine(1.5, 'rps', 2.5)}\n`, 'utf8');
  const r = await call(s, 'GET', `/api/tasks/${tid}/load/stream`);
  assert.equal(r.text(), 'id: 1\ndata: {"ts": 1.5, "metric": "rps", "value": 2.5, "type": "gauge"}\n\n'
    + 'data: {"done":true}\n\n');
  // `?run=<运行键>` 指定历史运行 ⇒ 同一行数据走 `_load_metrics_source` 的显式键分支
  const byRun = await call(s, 'GET', `/api/tasks/${tid}/load/stream?run=20260101_000000`);
  assert.equal(byRun.text(), r.text());
  // 孤儿运行键：文件按该键推导（不存在）⇒ 只有 done 帧，**不回落**到「最新一次运行」
  const orphan = await call(s, 'GET', `/api/tasks/${tid}/load/stream?run=20200101_000000`);
  assert.equal(orphan.text(), 'data: {"done":true}\n\n');
  s.close();
});

// --------------------------------------------------------------------------
// ② load/custom_html：两个安全响应头（对拍观测面拿不到）
// --------------------------------------------------------------------------

test('GET /load/custom_html：200 + sandbox/nosniff 两头 + 原字节正文', async () => {
  const s = setup('custom-html');
  const tid = insertTask(s.db, s.pid, { name: '压测', taskType: 'stress', status: 'done' });
  const cdir = path.join(s.work, 'free_style', 'load', `task_${tid}`);
  fs.mkdirSync(cdir, { recursive: true });
  const html = '<!doctype html><script>parent.postMessage(1)</script>\n';
  fs.writeFileSync(path.join(cdir, 'panel.html'), html, 'utf8');
  const r = await call(s, 'GET', `/api/tasks/${tid}/load/custom_html`);
  assert.equal(r.status, 200);
  assert.equal(r.headers['Content-Type'], 'text/html; charset=utf-8');
  assert.equal(r.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(r.headers['Content-Security-Policy'], 'sandbox allow-scripts');
  assert.equal(r.headers['Cache-Control'], 'no-store');
  assert.equal(r.text(), html);
  s.close();
});

// --------------------------------------------------------------------------
// ②b agents/models：模型目录映射（**只能单侧验**——本机驱动未配置，对拍两侧都走空表分支）
// --------------------------------------------------------------------------

/**
 * 模型目录夹具与**期望值**（`deepseek-official/deepseek-chat` 那项刻意把 efforts 放在
 * `reasoning.efforts` 里：oracle 读的是**顶层** `m["efforts"]`，嵌套的一律忽略——这条
 * 正是探针实测出来的，别按宿主文档想当然）。
 *
 * 期望值来源（可复算）：
 * ```
 * python3 - <<'PY'
 * # 起一个只回 /models 的假 driver（目录 = 下面的 MODELS_CATALOG），
 * # 设 TS_AGENT_DRIVER_URL 后调 server._dsh_plugin_models('dsh-plugin:/x')
 * PY
 * ```
 * 逐字节输出即 `MODELS_GOLDEN`（本文件用 `JSON.parse` 后的深比，等价）。
 */
const MODELS_CATALOG = {
  groups: [
    { id: 'deepseek-official', models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat',
        reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
      { id: 'deepseek-reasoner', name: '', default_effort: 'medium',
        efforts: [{ id: 'medium' }, { id: 'bogus' }] },
    ] },
    { id: '', models: [{ id: 'bare-model', name: '裸模型' }] },
    { id: 'empty-group', models: [] },
  ],
  default: { provider: 'deepseek-official', model: 'deepseek-chat' },
};

const MODELS_GOLDEN = {
  models: [
    { name: 'deepseek-official/deepseek-chat',
      display_name: 'deepseek-official/DeepSeek Chat', efforts: [], default_effort: '' },
    { name: 'deepseek-official/deepseek-reasoner',
      display_name: 'deepseek-official/deepseek-reasoner',
      efforts: [{ id: 'medium', name: 'medium' }], default_effort: 'medium' },
    { name: 'bare-model', display_name: '裸模型', efforts: [], default_effort: '' },
  ],
  default: 'deepseek-official/deepseek-chat',
};

test('GET /agents/models：dsh 插件族目录映射（值与显示分离 / 空 provider / efforts 白名单过滤）', async () => {
  const s = setup('agents-models');
  await withDriver(async (drv) => {
    drv.modelsPayload = { groups: MODELS_CATALOG.groups, default: MODELS_CATALOG.default };
    const ap = 'dsh-plugin:/usr/local/bin/dsh';
    const r = await call(s, 'GET', `/api/agents/models?agent_path=${encodeURIComponent(ap)}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json(), MODELS_GOLDEN);
    assert.equal(drv.byPath('/models').length, 1);
    // 60s 缓存：换掉驱动目录后再打同一 agent_path ⇒ 仍旧值（**不入缓存**的只有「驱动不可用」档）
    drv.modelsPayload = { groups: [{ id: 'x', models: [{ id: 'y', name: 'Y' }] }], default: {} };
    const again = await call(s, 'GET', `/api/agents/models?agent_path=${encodeURIComponent(ap)}`);
    assert.deepEqual(again.json(), MODELS_GOLDEN);
    assert.equal(drv.byPath('/models').length, 1, '第二次不得再打驱动（60s 缓存）');
    // 缓存按 agent_path 分键：另一个路径照样打驱动
    const other = await call(s, 'GET',
      '/api/agents/models?agent_path=' + encodeURIComponent('dsh-plugin:/other'));
    assert.deepEqual(other.json().models.map((m) => m.name), ['x/y']);
    assert.equal(drv.byPath('/models').length, 2);
  });
  s.close();
});

test('GET /agents/models：目录形状非法（非 dict 段）⇒ 上抛断连，不静默兜底', async () => {
  const s = setup('agents-models-bad');
  await withDriver(async (drv) => {
    drv.modelsPayload = { groups: ['not-a-dict'], default: {} };
    await assert.rejects(
      () => call(s, 'GET', '/api/agents/models?agent_path=dsh-plugin%3A%2Fbad'),
      /has no attribute 'get'/);
  });
  s.close();
});

// --------------------------------------------------------------------------
// ③ 内置资产：403（用户级写仅管理员）/ 成功档（双隔离）/ 500（磁盘 OSError）
// --------------------------------------------------------------------------

/** 把仓库 `extensions/` 拷进夹具，并把两个落点 env 指过去（双隔离） */
function isolateAssets() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm6-assets-'));
  const extDir = path.join(root, 'extensions');
  fs.cpSync(path.resolve(import.meta.dirname, '..', '..', 'extensions'), extDir,
    { recursive: true });
  const profiles = path.join(root, 'profiles');
  fs.mkdirSync(path.join(profiles, 'web'), { recursive: true });
  fs.writeFileSync(path.join(profiles, 'web', 'cordis.patch.yml'), '# 夹具 profile\n', 'utf8');
  const oldExt = process.env.TS_EXT_DIR;
  const oldProf = process.env.TS_DSH_PROFILES;
  process.env.TS_EXT_DIR = extDir;
  process.env.TS_DSH_PROFILES = profiles;
  return {
    root, extDir, profiles,
    restore() {
      if (oldExt === undefined) delete process.env.TS_EXT_DIR;
      else process.env.TS_EXT_DIR = oldExt;
      if (oldProf === undefined) delete process.env.TS_DSH_PROFILES;
      else process.env.TS_DSH_PROFILES = oldProf;
    },
  };
}

test('内置资产：非管理员做用户级写 ⇒ 403；用户级**读**仍开放（can_install=false）', async () => {
  const s = setup('assets-403');
  const iso = isolateAssets();
  try {
    const denied = await call(s, 'POST', '/api/builtin-assets/dsh-autocommit/install',
      { body: { target: 'user' }, user: s.bobRow });
    assert.equal(denied.status, 403);
    assert.equal(denied.text(), '{"error": "用户级安装影响本机所有项目，仅管理员可操作"}');
    const list = await call(s, 'GET', '/api/builtin-assets?target=user', { user: s.bobRow });
    assert.equal(list.status, 200);
    assert.equal(list.json().can_install, false);
    // 403 档**不得**落任何文件（连 profile 目录都不该被建）
    assert.equal(fs.existsSync(path.join(iso.profiles, 'node_modules')), false);
  } finally {
    iso.restore();
    s.close();
  }
});

test('内置资产：用户级安装/卸载（TS_EXT_DIR + TS_DSH_PROFILES 双隔离，绝不碰 ~/.dsh）', async () => {
  const s = setup('assets-install');
  const iso = isolateAssets();
  try {
    const inst = await call(s, 'POST', '/api/builtin-assets/dsh-autocommit/install',
      { body: { target: 'user' } });
    assert.equal(inst.status, 200);
    const body = inst.json();
    assert.equal(body.ok, true);
    assert.ok(body.files_written.length >= 2);
    const pkg = path.join(iso.profiles, 'node_modules', '@gavinc-cn', 'dsh-autocommit');
    assert.equal(fs.existsSync(path.join(pkg, 'package.json')), true);
    assert.equal(fs.existsSync(path.join(pkg, 'lib', 'index.mjs')), true);
    const patch = fs.readFileSync(path.join(iso.profiles, 'web', 'cordis.patch.yml'), 'utf8');
    assert.match(patch, /^# >>> touchstone-asset:dsh-autocommit$/m);
    assert.match(patch, /^# <<< touchstone-asset:dsh-autocommit$/m);
    const st = await call(s, 'GET', '/api/builtin-assets?target=user');
    assert.equal(st.json().assets.find((a) => a.id === 'dsh-autocommit').state, 'installed');
    // 幂等：再装一次不重复写
    const again = await call(s, 'POST', '/api/builtin-assets/dsh-autocommit/install',
      { body: { target: 'user' } });
    assert.equal(again.status, 200);
    assert.deepEqual(again.json().files_written, []);
    // 卸载：删清单内文件 + 摘掉注册块（夹具 profile 回到原样）
    const un = await call(s, 'POST', '/api/builtin-assets/dsh-autocommit/uninstall',
      { body: { target: 'user' } });
    assert.equal(un.status, 200);
    assert.ok(un.json().files_deleted.length >= 2);
    assert.equal(fs.existsSync(path.join(pkg, 'package.json')), false);
    assert.equal(fs.readFileSync(path.join(iso.profiles, 'web', 'cordis.patch.yml'), 'utf8'),
      '# 夹具 profile\n');
  } finally {
    iso.restore();
    s.close();
  }
});

test('内置资产：磁盘异常（profile 落点不可写）⇒ 500 带 `操作失败：` 前缀', async () => {
  const s = setup('assets-500');
  const iso = isolateAssets();
  try {
    // 把 `<profiles>/node_modules` 造成**文件**（不是目录）⇒ mkdir/write 抛 ENOTDIR（OSError）
    fs.writeFileSync(path.join(iso.profiles, 'node_modules'), 'not a dir\n', 'utf8');
    const r = await call(s, 'POST', '/api/builtin-assets/dsh-autocommit/install',
      { body: { target: 'user' } });
    assert.equal(r.status, 500);
    assert.match(r.json().error, /^操作失败：/);
  } finally {
    iso.restore();
    s.close();
  }
});

// --------------------------------------------------------------------------
// ④ RAG 三条：403（对拍登录态恒 admin，换不了用户）
// --------------------------------------------------------------------------

test('RAG 三条：非管理员一律 403 紧凑体（GET / PATCH / POST test）', async () => {
  const s = setup('rag-403');
  for (const [method, target, body] of [
    ['GET', '/api/admin/rag', undefined],
    ['PATCH', '/api/admin/rag', { clear: true }],
    ['POST', '/api/admin/rag/test', {}],
  ]) {
    const r = await call(s, method, target, { body, user: s.bobRow });
    assert.equal(r.status, 403, `${method} ${target}`);
    // `_require_admin` 是硬编码字节串 ⇒ **紧凑**（无空格）
    assert.equal(r.text(), '{"error":"仅管理员可操作"}', `${method} ${target}`);
  }
  s.close();
});

test('RAG 三条成功档：PATCH 落盘（0600 / Python json.dumps(indent=2) 形态）→ GET 打码回显 → clear 停用', async () => {
  const s = setup('rag-ok');
  const cfg = path.join(s.dir, 'rag.json');
  const old = process.env.TS_RAG_CONFIG;
  process.env.TS_RAG_CONFIG = cfg;               // 单点隔离（两版后端都认这个 env）
  try {
    const set = await call(s, 'PATCH', '/api/admin/rag', { body: {
      api_base: 'https://api.example.com/v1/', model: 'bge-m3', api_key: 'sk-abcdefgh1234',
      timeout_s: '5', batch_size: '4',
    } });
    assert.equal(set.status, 200);
    assert.equal(set.text(), '{"ok":true}');     // 成功体是硬编码**紧凑**字面量
    // 落盘形态：Python `json.dumps(..., ensure_ascii=False, indent=2)` + 末尾换行；
    // api_base 去掉尾斜杠；权限收紧到 0600（文件含 api_key 明文）
    assert.equal(fs.readFileSync(cfg, 'utf8'), [
      '{',
      '  "api_base": "https://api.example.com/v1",',
      '  "api_key": "sk-abcdefgh1234",',
      '  "model": "bge-m3",',
      '  "timeout_s": 5,',
      '  "batch_size": 4',
      '}',
      '',
    ].join('\n'));
    assert.equal(fs.statSync(cfg).mode & 0o777, 0o600);
    const got = await call(s, 'GET', '/api/admin/rag');
    assert.equal(got.json().configured, true);
    assert.equal(got.json().has_api_key, true);
    assert.equal(got.json().api_key_masked, '****1234');       // 只回末四位
    assert.equal(fs.readFileSync(cfg, 'utf8').includes('****'), false);   // 打码只在响应里
    // api_key 留空 = 沿用已存值（表单补全半填配置的语义）
    const keep = await call(s, 'PATCH', '/api/admin/rag', { body: {
      api_base: 'https://api.example.com/v1', model: 'bge-m3',
    } });
    assert.equal(keep.status, 200);
    assert.match(fs.readFileSync(cfg, 'utf8'), /"api_key": "sk-abcdefgh1234"/);
    // clear=true ⇒ 停用（删配置）
    const clear = await call(s, 'PATCH', '/api/admin/rag', { body: { clear: true } });
    assert.equal(clear.status, 200);
    assert.equal(fs.existsSync(cfg), false);
    assert.equal((await call(s, 'GET', '/api/admin/rag')).json().configured, false);
  } finally {
    if (old === undefined) delete process.env.TS_RAG_CONFIG;
    else process.env.TS_RAG_CONFIG = old;
    s.close();
  }
});

// --------------------------------------------------------------------------
// ⑤ bug 拒绝：200 成功档 + 拒绝记录累加 + 去重复用（对拍夹具无 bug 目录）
// --------------------------------------------------------------------------

const BUG_MD = [
  '# 20260101_0000_FS_样例报告',
  '',
  '> 样例 bug',
  '',
  '- **状态**: 待分析',
  '- **关联用例**: FS0001',
  '',
  '## 现象',
  '',
  '接口偶发 500。',
  '',
].join('\n');

/**
 * 拒绝记录的**时刻打码**（与 `tools/parity/http-run.mjs:NORMALIZE` 同口径）：
 * `db.now_str()` 是墙上时钟，用例里的「期望值」若拿测试进程现算的 nowStr() 拼，
 * 跨秒就会假红（本文件首跑实测踩到：`16:39:25` vs `16:39:26`）。
 * 打码只换**时刻值**，格式（`YYYY-MM-DD HH:MM:SS` + 空格 + 理由）照旧逐字节比。
 */
const maskTs = (text) => String(text).replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /gm, '<ts> ');

function makeBug(s, dirName = '20260101_0000_FS_样例报告') {
  const dir = path.join(s.work, 'bug_report', dirName);
  fs.mkdirSync(dir, { recursive: true });
  const report = path.join(dir, 'bug_report.md');
  fs.writeFileSync(report, BUG_MD, 'utf8');
  return { dir, report };
}

test('POST /projects/<pid>/bugs/<dir>/reject：200 + 状态改已拒绝 + 建修例任务（去重）', async () => {
  const s = setup('reject');
  const { report } = makeBug(s);
  const submitted = [];
  runner.setInstance({
    submit: (id) => { submitted.push(id); },
    submitMsg: () => {},
    unitBusy: () => false,
  });
  try {
    const r = await call(s, 'POST',
      `/api/projects/${s.pid}/bugs/20260101_0000_FS_样例报告/reject`,
      { body: { reason: '误报：接口其实返回 200' } });
    assert.equal(r.status, 200);
    const { task_id: tid } = r.json();
    assert.ok(tid > 0);
    assert.deepEqual(submitted, [tid]);                     // 入队走统一队列（submit 一次）
    // 报告落盘：字段改写 + 追加「拒绝记录」小节（最新在最上）
    const text = fs.readFileSync(report, 'utf8');
    assert.equal(maskTs(text), maskTs(BUG_MD.replace('- **状态**: 待分析', '- **状态**: 已拒绝')
      + `\n## 拒绝记录\n\n- ${nowStr()} 误报：接口其实返回 200\n`));
    // 修例任务行：payload 是 Python json.dumps 形态（`", "` / `": "`）
    const row = s.db.prepare('SELECT * FROM tasks WHERE id=?').get(tid);
    assert.equal(row.task_type, 'reject');
    assert.equal(row.name, '修例 FS_样例报告');
    assert.equal(row.stop_type, 'rounds');
    assert.equal(row.stop_value, '1');
    assert.equal(row.retest, '不复测');
    assert.equal(row.payload,
      '{"bug_dir": "20260101_0000_FS_样例报告", "reason": "误报：接口其实返回 200"}');
    // 去重：再次拒绝**复用**同一任务 id，且拒绝记录**累加**（新行插在旧行之上）
    const r2 = await call(s, 'POST',
      `/api/projects/${s.pid}/bugs/20260101_0000_FS_样例报告/reject`,
      { body: { reason: '二次确认：仍判误报' } });
    assert.equal(r2.json().task_id, tid);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_type='reject'").get().n, 1);
    assert.deepEqual(submitted, [tid]);
    const text2 = fs.readFileSync(report, 'utf8');
    // 注意第三节多出的那个空行是 **oracle 自己的形态**（`^## 拒绝记录\s*$` 的贪婪 `\s*`
    // 吃掉小节标题后的换行，拼回时 `\n\n` 又加一层 ⇒ 每拒绝一次多一个空行）。
    // 真 Python 探针实测：第 1 次 `## 拒绝记录\n\n- …`、第 2 次 `## 拒绝记录\n\n\n- …`、
    // 第 3 次 `\n\n\n\n`。Node 侧逐字照抄（**不许**「顺手修整齐」）。
    assert.equal(maskTs(text2), maskTs(BUG_MD.replace('- **状态**: 待分析', '- **状态**: 已拒绝')
      + `\n## 拒绝记录\n\n\n- ${nowStr()} 二次确认：仍判误报`
      + `\n- ${nowStr()} 误报：接口其实返回 200\n`));
    // 缺理由 ⇒ 400 硬编码紧凑体（这条与「bug 不存在」的 404 次序不可换）
    const noReason = await call(s, 'POST',
      `/api/projects/${s.pid}/bugs/20260101_0000_FS_样例报告/reject`, { body: {} });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.text(), '{"error":"请填写拒绝理由"}');
  } finally {
    runner.setInstance(null);
    s.close();
  }
});

// --------------------------------------------------------------------------
// ⑥ diagnose 富文本（期望值来自真 Python 探针，见文末「期望值来源」）
// --------------------------------------------------------------------------

test('POST /load/diagnose：现场文本逐字节（int/float KPI 渲染 + 方案包清单 + 日志尾截断）', async () => {
  const s = setup('diagnose');
  const tid = insertTask(s.db, s.pid, {
    name: '对拍压测', taskType: 'stress', status: 'done', sessionId: 'sess-diag',
  });
  const cdir = path.join(s.work, 'free_style', 'load', `task_${tid}`);
  fs.mkdirSync(cdir, { recursive: true });
  fs.writeFileSync(path.join(cdir, 'run.py'), 'x'.repeat(12), 'utf8');
  fs.writeFileSync(path.join(cdir, 'scenario.json'), 'y'.repeat(9), 'utf8');
  fs.writeFileSync(path.join(cdir, 'charts.json'), 'z'.repeat(20), 'utf8');
  fs.writeFileSync(path.join(cdir, 'panel.html'), 'p'.repeat(30), 'utf8');
  const logPath = path.join(s.work, '.web', `task_${tid}_load_20260101_000000.log`);
  const logLines = [];
  for (let i = 0; i < 80; i += 1) logLines.push(`line ${i}`);
  fs.writeFileSync(logPath, `${logLines.join('\n')}\n`, 'utf8');
  const metrics = path.join(s.work, '.web', `task_${tid}_metrics_20260101_000000.jsonl`);
  // 注意：这里是**手写 JSON 文本**而不是 `JSON.stringify`（后者会把 `0.0` 写成 `0`，
  // 在 Python 里就变成 int ⇒ 期望值跟着变）。要钉住 int/float 之别，原文必须是 Python 形态。
  fs.writeFileSync(metrics, '{"kind": "summary", "ts": 2.5, "values": {"结果": "完成", '
    + '"受理委托": 1190, "有成交委托": 465, "成交量(BTC)": 0.93, "错误率": 0.0, "总请求": 2206}}\n',
  'utf8');
  insertLoadRound(s, tid, { logPath, startedAt: '2026-01-01 00:00:00',
    endedAt: '2026-01-01 00:10:00' });
  runner.setInstance({ submit: () => {}, submitMsg: () => {}, unitBusy: () => false });
  try {
    const r = await call(s, 'POST', `/api/tasks/${tid}/load/diagnose`, { body: {} });
    assert.equal(r.status, 200);
    const row = s.db.prepare('SELECT * FROM chat_msgs ORDER BY rowid DESC LIMIT 1').get();
    // 日志尾 = 最后 60 行（20..79），`.strip()` 掉末尾换行
    const tail = logLines.slice(20).join('\n');
    assert.equal(row.message,
      `【压测运行现场】任务 #${tid}「对拍压测」\n`
      + '- 最近一次运行：运行键 20260101_000000（轮次 3）状态 done 退出码 0\n'
      + '- 开始 2026-01-01 00:00:00 · 结束 2026-01-01 00:10:00\n'
      + `- 方案包：${cdir}（run.py(12B)、charts.json(20B)、panel.html(30B)）\n`
      + '- 指标摘要：结果=完成、受理委托=1190、有成交委托=465、成交量(BTC)=0.93、'
      + '错误率=0.0、总请求=2206\n'
      + `- 日志尾（task_${tid}_load_20260101_000000.log）：\n`
      + `\`\`\`\n${tail}\n\`\`\`\n`
      + '请判断这次发压是否正常、方案包（run.py / charts.json / plan.md）是否需要修正；'
      + '如需修正请直接改方案包文件，改完告诉我「已改好」，我会在压测面板点「复压」再跑一次。'
      + '**不要自己执行压测脚本**（发压必须由平台托管，才能被停止/超时保护并留下运行记录）。');
  } finally {
    runner.setInstance(null);
    s.close();
  }
});

// --------------------------------------------------------------------------
// ⑦ 任务会话的 profile / rewind：200 档（假 driver；rewind 任务侧多一步改绑）
// --------------------------------------------------------------------------

/** 假 dsh 驱动（只实现本批用到的 3 条路由；形状抄 m5c 的 FakeDriver） */
class FakeDriver {
  constructor() {
    this.calls = [];
    this.forkSid = 'session-11111111-1111-4111-8111-111111111111';
    this.modelsPayload = { groups: [], default: {} };
    this.server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
        const full = req.url.split('?')[0];
        const p = full.startsWith('/touchstone-agent')
          ? full.slice('/touchstone-agent'.length) : full;
        this.calls.push({ path: p, method: req.method, body });
        const json = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(obj));
        };
        if (p === '/session') return json(200, { session_id: body.session_id || 'session-new' });
        if (p === '/model') return json(200, { selected: { model: body.model } });
        if (p === '/fork') return json(200, { new_session_id: this.forkSid });
        if (p === '/models') return json(200, this.modelsPayload);
        return json(404, { error: `fake driver: no route ${p}` });
      });
    });
  }

  byPath(p) { return this.calls.filter((c) => c.path === p); }

  listen() {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => resolve(this.server.address().port));
    });
  }

  close() {
    return new Promise((resolve) => { this.server.close(() => resolve()); });
  }
}

async function withDriver(fn) {
  const drv = new FakeDriver();
  const port = await drv.listen();
  const old = process.env.TS_AGENT_DRIVER_URL;
  process.env.TS_AGENT_DRIVER_URL = `http://127.0.0.1:${port}/touchstone-agent`;
  try {
    return await fn(drv);
  } finally {
    if (old === undefined) delete process.env.TS_AGENT_DRIVER_URL;
    else process.env.TS_AGENT_DRIVER_URL = old;
    await drv.close();
  }
}

/** 造一个含一次用户提问的多帧 zstd 会话文件（形状抄 m5c / sessparse.test.mjs） */
function writeSession(root, bucket, sid, frames) {
  const dir = path.join(root, bucket, sid);
  fs.mkdirSync(dir, { recursive: true });
  const buf = Buffer.concat(frames.map((rows) => {
    const text = `${rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`;
    return zstdCompressSync(Buffer.from(text, 'utf8'));
  }));
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), buf);
}

const REAL_SESSIONS_ROOT = sessparse.dshSessionsRoot();

test('POST /tasks/<tid>/session/rewind：任务侧 fork 后**改绑新会话** + rebound:true', async () => {
  const s = setup('task-rewind');
  const sid = 'session-00000000-0000-4000-8000-0000000000b1';
  const tid = insertTask(s.db, s.pid, {
    name: '任务', taskType: 'normal', status: 'done', sessionId: sid,
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm6-sessions-'));
  writeSession(root, '--proj--', sid, [
    [{ type: 'session', version: 4, id: sid, cwd: path.join(s.dir, 'proj') }],
    [{ type: 'user/message', seq: 2, time: 200,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一问' }] } }],
    [{ type: 'assistant/message', seq: 3, time: 300,
      data: { message: { content: [{ type: 'text', text: '回答' }] } } }],
  ]);
  sessparse.setSessionsRoot(root);
  try {
    const anchors = sessparse.dsh_user_anchors(sid);
    assert.equal(anchors.length, 1);
    await withDriver(async (drv) => {
      const r = await call(s, 'POST', `/api/tasks/${tid}/session/rewind`,
        { body: { mid: anchors[0].mid } });
      assert.equal(r.status, 200);
      const j = r.json();
      assert.equal(j.ok, true);
      assert.equal(j.new_session_id, drv.forkSid);
      assert.equal(j.boundary, anchors[0].eseq - 1);
      assert.equal(j.rebound, true);                       // 任务路径恒 true（看板恒 false）
      const fcall = drv.byPath('/fork');
      assert.equal(fcall[0].body.session_id, sid);
      assert.equal(fcall[0].body.at_seq, j.boundary);
      // 新会话接进驱动池（否则 UI 切过去后 /rename、/compact 会 404）
      const scall = drv.byPath('/session');
      assert.equal(scall[0].body.session_id, drv.forkSid);
      assert.equal(scall[0].body.task, `rewind-${sid.slice(0, 8)}`);
      // **任务侧关键差异**：任务只有一个会话位 ⇒ 必须把新会话设为任务会话
      assert.equal(s.db.prepare('SELECT session_id FROM tasks WHERE id=?').get(tid).session_id,
        drv.forkSid);
    });
  } finally {
    sessparse.setSessionsRoot(REAL_SESSIONS_ROOT);
    s.close();
  }
});

test('POST /tasks/<tid>/session/rewind：fork 失败 ⇒ 502 且**不改绑**（写序：fork→接池→改绑）', async () => {
  const s = setup('task-rewind-502');
  const sid = 'session-00000000-0000-4000-8000-0000000000b2';
  const tid = insertTask(s.db, s.pid, {
    name: '任务', taskType: 'normal', status: 'done', sessionId: sid,
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm6-sessions-'));
  writeSession(root, '--proj--', sid, [
    [{ type: 'session', version: 4, id: sid, cwd: path.join(s.dir, 'proj') }],
    [{ type: 'user/message', seq: 2, time: 200,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一问' }] } }],
  ]);
  sessparse.setSessionsRoot(root);
  const old = process.env.TS_AGENT_DRIVER_URL;
  process.env.TS_AGENT_DRIVER_URL = 'http://127.0.0.1:1/touchstone-agent';   // 连不上
  try {
    const anchors = sessparse.dsh_user_anchors(sid);
    const r = await call(s, 'POST', `/api/tasks/${tid}/session/rewind`,
      { body: { mid: anchors[0].mid } });
    assert.equal(r.status, 502);
    assert.match(r.json().error, /^回退失败：/);
    assert.equal(s.db.prepare('SELECT session_id FROM tasks WHERE id=?').get(tid).session_id, sid);
  } finally {
    if (old === undefined) delete process.env.TS_AGENT_DRIVER_URL;
    else process.env.TS_AGENT_DRIVER_URL = old;
    sessparse.setSessionsRoot(REAL_SESSIONS_ROOT);
    s.close();
  }
});

test('POST /tasks/<tid>/session/profile：只改思考等级 ⇒ /model 带任务口径的模型', async () => {
  const s = setup('task-profile');
  const tid = insertTask(s.db, s.pid, {
    name: '任务', taskType: 'normal', status: 'done', sessionId: 'session-cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  });
  s.db.prepare('UPDATE tasks SET model=? WHERE id=?').run('deepseek-official/deepseek-chat', tid);
  await withDriver(async (drv) => {
    const r = await call(s, 'POST', `/api/tasks/${tid}/session/profile`,
      { body: { reasoning_effort: 'high' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json(), { ok: true, reasoning_effort: 'high' });
    const mcall = drv.byPath('/model');
    assert.equal(mcall.length, 1);
    // `split_model('deepseek-official/deepseek-chat')` ⇒ provider/model 拆开下传
    assert.equal(mcall[0].body.model, 'deepseek-chat');
    assert.equal(mcall[0].body.provider, 'deepseek-official');
    assert.equal(mcall[0].body.reasoning_effort, 'high');
  });
  s.close();
});

// --------------------------------------------------------------------------
// 期望值来源（可复算）：
//   python3 - <<'PY'   # 见 M6-6 实施记录 §三 的探针脚本（临时库 + 夹具产物 → 打印文本）
//   把同一份夹具喂 `server.Handler._load_diagnose_text(row)` 与
//   `server.Handler._append_reject_record(path, reason)`，逐字节抄进上面的断言。
// --------------------------------------------------------------------------
