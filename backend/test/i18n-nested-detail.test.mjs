/**
 * Task 4（KB-01）：嵌套 `{detail}` 可翻子集（Node 侧；与 `tests/test_i18n_nested_detail.py`
 * 逐条镜像）。
 *
 * 覆盖：
 *   ① `detailText()`：内层带 `i18nKey` 时 zh 用 `.message`、en 按 key+vars 渲染；无 key
 *      的动态异常在 en 下也保持原文（KB-37 口径）；
 *   ② 路由层写点：真路由表 + 真驱动替身，`POST /tasks/<id>/session/chat`（agent 调用失败）
 *      与 `POST /projects/<p>/board/cards/<c>/compact`（compact 失败，含 lib 层 lang 透传）
 *      在 en 下内外层全英文、zh 逐字节不变；
 *   ③ lib 层 5 个 HTTP-only 函数中的 `startWeb` / `forkSession` / `forkCompactSession`：
 *      尾参 lang 透传后 `i18nVars.detail` 已按 en 渲染（`.message` 旧中文不变）；
 *   ④ 静态接线：13 处路由写点全部改成 `detailText(...)`（漏一处即红）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as board from '../lib/board.js';
import * as chat from '../lib/chat.js';
import { detailText, localizable } from '../lib/i18n.js';
import { DshDriverError } from '../lib/dshdriver.js';
import { dispatch, makeContext } from '../routes/index.js';
import { freshDb, insertCard, insertProject, insertTask } from './m3fixture.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// --------------------------------------------------------------------------
// 测试台（session-write.test.mjs 的最小版）
// --------------------------------------------------------------------------

function fakeReq({ method = 'POST', headers = {}, body = null } = {}) {
  const chunks = [];
  if (body !== null && body !== undefined) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    if (text !== '') chunks.push(Buffer.from(text, 'utf8'));
  }
  const stream = Readable.from(chunks, { objectMode: false });
  stream.method = method;
  stream.headers = chunks.length === 0
    ? headers
    : { 'content-length': String(chunks[0].length), ...headers };
  return stream;
}

class FakeRes {
  constructor() {
    this.status = null;
    this.headers = null;
    this.text = '';
  }

  writeHead(status, headers) { this.status = status; this.headers = headers || {}; return this; }

  end(buf) {
    if (buf !== undefined && buf !== null) {
      this.text += Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
    }
  }

  destroy() {}
}

async function post(fx, target, body, headers = {}) {
  const res = new FakeRes();
  const user = fx.db.prepare("SELECT id FROM users WHERE username='admin'").get();
  const ctx = makeContext({
    req: fakeReq({ body, headers }),
    res,
    db: fx.db,
    user,
    path: target,
    search: '',
  });
  assert.equal(await dispatch(ctx), true, `路由未命中: ${target}`);
  return res;
}

/** 极简假驱动：默认全 200；`handlers[path]` 接管造 4xx/5xx。 */
function startDriver(handlers = {}) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const urlPath = String(req.url || '').split('?')[0];
      const reply = (status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(value));
      };
      if (typeof handlers[urlPath] === 'function') {
        handlers[urlPath]({ reply });
        return;
      }
      return reply(200, { ok: true, session_id: 'session-new' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function withDriver(handlers, fn) {
  const drv = await startDriver(handlers);
  const saved = process.env.TS_AGENT_DRIVER_URL;
  process.env.TS_AGENT_DRIVER_URL = drv.base;
  try {
    return await fn(drv);
  } finally {
    if (saved === undefined) delete process.env.TS_AGENT_DRIVER_URL;
    else process.env.TS_AGENT_DRIVER_URL = saved;
    await drv.close();
  }
}

function driverError(detail = '驱动炸了', status = 500) {
  return localizable(new DshDriverError(status, detail), '{driver_detail}',
    { driver_detail: detail, status });
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ts-nested-${tag}-`));
}

after(() => {
  chat.setRunnerInstance(null);
});

// --------------------------------------------------------------------------
// ① detailText 与 ⑤ 静态接线
// --------------------------------------------------------------------------

test('detailText：zh 用 .message；en 渲染内层 key；无 key 保留动态原文', () => {
  const err = driverError();
  assert.equal(detailText(err), '驱动炸了');
  assert.equal(detailText(err, 'zh'), '驱动炸了');
  assert.equal(detailText(err, 'en'), 'Driver returned HTTP 500: 驱动炸了');
  assert.equal(detailText(new Error('disk full'), 'en'), 'disk full');
  assert.equal(detailText('plain', 'en'), 'plain');
  assert.equal(detailText(null, 'en'), 'null');
  assert.equal(detailText(err, 'fr-FR'), '驱动炸了');
});

test('静态接线：路由层 4 条外层键的 detail 实参都是 detailText(...)', () => {
  const specs = [
    ['backend/routes/board.js', ['agent 调用失败: {detail}', '回退失败：{detail}']],
    ['backend/routes/sessions.js', ['agent 调用失败: {detail}', '回退失败：{detail}',
      'compact 失败: {detail}', '注入失败：{detail}']],
  ];
  for (const [rel, keys] of specs) {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    for (const key of keys) {
      // 每个出现该 key 的写点都在后面 400 字符内使用 detailText(
      let from = 0;
      let seen = 0;
      for (;;) {
        const idx = src.indexOf(key, from);
        if (idx < 0) break;
        seen += 1;
        from = idx + key.length;
        assert.match(src.slice(idx, idx + 400), /detailText\(/,
          `${rel} 的 ${key} 未走 detailText`);
      }
      assert.ok(seen > 0, `${rel} 找不到 ${key} 写点`);
    }
  }
});

// --------------------------------------------------------------------------
// ② 路由层两条完整链路（agent 调用失败 / compact 失败）
// --------------------------------------------------------------------------

test('路由：/tasks/<id>/session/chat 驱动 500 ⇒ en 内外层英文、zh 旧字节', async () => {
  const fx = freshDb('nested-chat');
  try {
    const pid = insertProject(fx.db, { name: 'nested', projectDir: fx.dir });
    const tid = insertTask(fx.db, pid, { sessionId: 'session-d1' });
    chat.setRunnerInstance(null);
    await withDriver({ '/prompt': ({ reply }) => reply(500, { error: '驱动炸了' }) }, async () => {
      const path = `/api/tasks/${tid}/session/chat`;
      const zh = await post(fx, path, { message: 'hi' });
      assert.equal(zh.status, 500);
      assert.equal(zh.text, '{"error": "agent 调用失败: 驱动炸了"}');
      const en = await post(fx, path, { message: 'hi' }, { 'X-TS-Lang': 'en' });
      assert.equal(en.status, 500);
      assert.equal(en.text,
        '{"error": "Agent call failed: Driver returned HTTP 500: 驱动炸了"}');
    });
  } finally {
    chat.setRunnerInstance(null);
    fx.close();
  }
});

test('路由：cards/<id>/compact 驱动 500 ⇒ en 内外层英文（含 lib lang 透传）、zh 旧字节', async () => {
  const fx = freshDb('nested-compact');
  try {
    const pid = insertProject(fx.db, { name: 'nested-c', projectDir: fx.dir });
    const cid = insertCard(fx.db, pid, { sessionId: 'sid-c', sessions: '["sid-c"]' });
    await withDriver({ '/compact': ({ reply }) => reply(500, { error: '驱动炸了' }) }, async () => {
      const target = `/api/projects/${pid}/board/cards/${cid}/compact`;
      const zh = await post(fx, target, {});
      assert.equal(zh.status, 400);
      assert.equal(zh.text, '{"error": "compact 失败: 驱动炸了"}');
      const en = await post(fx, target, {}, { 'X-TS-Lang': 'en' });
      assert.equal(en.status, 400);
      assert.equal(en.text,
        '{"error": "Compact failed: Driver returned HTTP 500: 驱动炸了"}');
    });
  } finally {
    fx.close();
  }
});

// --------------------------------------------------------------------------
// ③ lib 层：startWeb / forkSession / forkCompactSession 的 lang 透传
// --------------------------------------------------------------------------

test('startWeb：失败载荷 detail 按 lang 渲染，.message 旧中文不变', async () => {
  const fx = freshDb('nested-start');
  try {
    const pid = insertProject(fx.db, { name: 'nested-start', projectDir: fx.dir });
    const cid = insertCard(fx.db, pid, { sessionId: '' });
    const project = fx.db.prepare('SELECT * FROM projects WHERE id=?').get(pid);
    const card = fx.db.prepare('SELECT * FROM board_cards WHERE id=?').get(cid);
    await withDriver({ '/session': ({ reply }) => reply(500, { error: '驱动炸了' }) },
      async () => {
        await assert.rejects(board.startWeb(project, card, 'dsh_plugin', '', 'en', { db: fx.db }),
          (err) => {
            assert.equal(err.message, '会话启动失败: 驱动炸了');
            assert.equal(err.i18nVars.detail, 'Driver returned HTTP 500: 驱动炸了');
            return true;
          });
      });
    const after = fx.db.prepare('SELECT last_error FROM board_cards WHERE id=?').get(cid);
    assert.equal(after.last_error, '会话启动失败: 驱动炸了');
  } finally {
    fx.close();
  }
});

test('forkSession / forkCompactSession：失败载荷 detail 按 lang 渲染', async () => {
  const dir = tmpDir('fork');
  const project = { id: 1, project_dir: dir, work_dir: dir, agent_path: 'dsh-plugin:/x' };
  const card = { id: 1, session_id: 'sid', sessions: '["sid"]', title: '' };
  await withDriver({ '/fork': ({ reply }) => reply(500, { error: '驱动炸了' }) }, async () => {
    await assert.rejects(board.forkSession(project, card, 'sid', 'en'), (err) => {
      assert.equal(err.message, 'fork 失败: 驱动炸了');
      assert.equal(err.i18nVars.detail, 'Driver returned HTTP 500: 驱动炸了');
      return true;
    });
    await assert.rejects(board.forkCompactSession(project, card, 'sid', 'en'), (err) => {
      assert.equal(err.message, '压缩新建失败: 驱动炸了');
      assert.equal(err.i18nVars.detail, 'Driver returned HTTP 500: 驱动炸了');
      return true;
    });
  });
});
