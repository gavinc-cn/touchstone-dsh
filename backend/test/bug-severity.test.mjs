/**
 * bug 报告严重程度等级端点（2026-10-25「测试报告等级划分」批次，Node 侧）。
 *
 * 与 `tests/test_bug_severity.py` 同一组语义（双端逐条镜像）：
 *   ① GET `/api/projects/<pid>/bugs` 列表每项带 `severity`（canonical 高/中/低/空串），
 *      排序 = 历史沉底 → 高→中→低→未分级 → 同级目录名倒序；
 *   ② GET `/api/projects/<pid>/bugs/<dir>` 详情带 `severity`（英文档 `High` → `高`）；
 *   ③ POST `/api/projects/<pid>/bugs/<dir>/severity`：200 写回（中文报告写「高」，英文报告写
 *      `High`），回执与 Python `json.dumps` **逐字节相同**；非法值 400（非字符串同样 400，
 *      不静默丢弃）、报告不存在 404、越权/项目不存在 404（`ctx.ownedProject` 前置）、
 *      `x-ts-lang: en` 时错误文案走英文词表。
 *
 * 实例层级用例：对拍夹具不造 bug 目录（见 `tools/parity/cases-http/m6_bug_session.json`
 * 的 why），200 成功档只能在这里用**临时 work_dir + 真 bug_report.md** 覆盖。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { dispatch, makeContext } from '../routes/index.js';
import { freshDb, insertProject } from './m3fixture.mjs';

// --------------------------------------------------------------------------
// 测试台（与 m6-endpoints.test.mjs 同一套最小 req/res 替身）
// --------------------------------------------------------------------------

function fakeRes() {
  const cap = { status: null, headers: null, chunk: [], body: null };
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
      destroy() { /* 普通响应不调用 */ },
    },
  };
}

function fakeReq(method, body, headers = {}) {
  const text = body === undefined ? '' : Buffer.from(JSON.stringify(body), 'utf8');
  const stream = Readable.from(text.length ? [text] : [], { objectMode: false });
  stream.headers = {
    ...(text.length ? { 'content-length': String(text.length) } : {}), ...headers,
  };
  stream.method = method;
  return stream;
}

/** 起一份夹具库 + 一个项目（work 目录在临时目录里，bug 报告由用例 seed） */
function setup(tag) {
  const fx = freshDb(`bugsev-${tag}`);
  const work = path.join(fx.dir, 'work');
  fs.mkdirSync(path.join(work, 'bug_report'), { recursive: true });
  fs.mkdirSync(path.join(work, 'free_style'), { recursive: true });
  const pid = insertProject(fx.db, {
    userId: 1, name: `P-${tag}`, projectDir: path.join(fx.dir, 'proj'), workDir: work,
  });
  fs.mkdirSync(path.join(fx.dir, 'proj'), { recursive: true });
  const adminRow = fx.db.prepare('SELECT * FROM users WHERE id=1').get();
  return { ...fx, pid, work, adminRow };
}

async function call(env, method, target, { body, user, headers } = {}) {
  const { res, cap } = fakeRes();
  const ctx = makeContext({
    req: fakeReq(method, body, headers),
    res,
    db: env.db,
    user: user === undefined ? env.adminRow : user,
    path: target.split('?')[0],
    search: target.includes('?') ? target.slice(target.indexOf('?') + 1) : '',
  });
  await dispatch(ctx);
  return {
    ...cap,
    text: () => (cap.body === null ? null : cap.body.toString('utf8')),
    json: () => (cap.body === null ? null : JSON.parse(cap.body.toString('utf8'))),
  };
}

/** seed 一枚 bug 报告（目录名必须含 `_FS_` 才被 scanBugs 收录） */
function seedBug(s, dirName, text) {
  const dir = path.join(s.work, 'bug_report', dirName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'bug_report.md');
  fs.writeFileSync(file, text, 'utf8');
  return { dir, file };
}

const ZH_HEAD = '# 样例报告\n\n- **状态**: 待分析\n';

// --------------------------------------------------------------------------
// ① 列表 / 详情
// --------------------------------------------------------------------------

test('GET 列表：每项带 canonical severity；按 高→中→低→未分级 排序（历史沉底）', async () => {
  const s = setup('list');
  try {
    seedBug(s, '20260201_0100_FS_none', '# 未分级\n\n- **状态**: 待分析\n');
    seedBug(s, '20260201_0200_FS_high', '# 高\n\n- **状态**: 待分析\n- **严重程度**: 高\n');
    seedBug(s, '20260201_0300_FS_en', '# en\n\n- **Status**: To analyze\n- **Severity**: Medium\n');
    seedBug(s, '20260201_0400_FS_low', '# 低\n\n- **状态**: 待分析\n- **严重程度**: 低\n');
    seedBug(s, '20260201_0500_FS_hist',
      '# 历史\n\n- **状态**: 复测通过\n- **严重程度**: 高\n');
    const r = await call(s, 'GET', `/api/projects/${s.pid}/bugs`);
    assert.equal(r.status, 200);
    const list = r.json();
    assert.deepEqual(list.map((b) => b.dir), [
      '20260201_0200_FS_high',
      '20260201_0300_FS_en',
      '20260201_0400_FS_low',
      '20260201_0100_FS_none',
      '20260201_0500_FS_hist',
    ]);
    assert.deepEqual(list.map((b) => b.severity), ['高', '中', '低', '', '高']);
    // 键序与 Python 一致：dir/title/status/severity/cases 之后才追加 last_task
    assert.deepEqual(Object.keys(list[0]),
      ['dir', 'title', 'status', 'severity', 'cases', 'last_task']);
  } finally {
    s.close();
  }
});

test('GET 详情：带 canonical severity（英文档 High → 高）', async () => {
  const s = setup('detail');
  try {
    seedBug(s, '20260301_0100_FS_detail',
      '# en\n\n- **Status**: To analyze\n- **Severity**: High\n');
    const r = await call(s, 'GET', `/api/projects/${s.pid}/bugs/20260301_0100_FS_detail`);
    assert.equal(r.status, 200);
    assert.equal(r.json().severity, '高');
  } finally {
    s.close();
  }
});

// --------------------------------------------------------------------------
// ② POST 写回
// --------------------------------------------------------------------------

test('POST severity：中文报告写回「高」，回执与 Python json.dumps 逐字节相同', async () => {
  const s = setup('write-zh');
  try {
    const { file } = seedBug(s, '20260401_0100_FS_set', `${ZH_HEAD}- **严重程度**: 中\n`);
    const r = await call(s, 'POST',
      `/api/projects/${s.pid}/bugs/20260401_0100_FS_set/severity`,
      { body: { severity: '高' } });
    assert.equal(r.status, 200);
    assert.equal(r.text(), '{"ok": true, "severity": "高"}');
    assert.equal(r.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.match(fs.readFileSync(file, 'utf8'), /- \*\*严重程度\*\*: 高\n/);
    // 列表回读（同一次请求后的缓存不残留旧值：mtime 变了就会重读）
    const list = (await call(s, 'GET', `/api/projects/${s.pid}/bugs`)).json();
    assert.equal(list.find((b) => b.dir === '20260401_0100_FS_set').severity, '高');
  } finally {
    s.close();
  }
});

test('POST severity：英文报告写回英文值 `High`（按文件语言写回）', async () => {
  const s = setup('write-en');
  try {
    const { file } = seedBug(s, '20260401_0200_FS_set_en',
      '# en write\n\n- **Status**: To analyze\n- **Severity**: Low\n');
    const r = await call(s, 'POST',
      `/api/projects/${s.pid}/bugs/20260401_0200_FS_set_en/severity`,
      { body: { severity: '高' } });
    assert.equal(r.status, 200);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /- \*\*Severity\*\*: High\n/);
    assert.equal(r.json().severity, '高');
  } finally {
    s.close();
  }
});

test('POST severity：入参兼容 high/medium/low（大小写不敏感），落盘中文 canonical', async () => {
  const s = setup('alias');
  try {
    const { file } = seedBug(s, '20260401_0300_FS_alias', `${ZH_HEAD}- **严重程度**: 高\n`);
    const r = await call(s, 'POST',
      `/api/projects/${s.pid}/bugs/20260401_0300_FS_alias/severity`,
      { body: { severity: 'medium' } });
    assert.equal(r.status, 200);
    assert.equal(r.json().severity, '中');
    assert.match(fs.readFileSync(file, 'utf8'), /- \*\*严重程度\*\*: 中\n/);
  } finally {
    s.close();
  }
});

// --------------------------------------------------------------------------
// ③ 错误档（与 Python 逐字节相同）
// --------------------------------------------------------------------------

test('POST severity：非法值/非字符串 400（紧凑体；en 请求走英文词表），不改文件', async () => {
  const s = setup('bad');
  try {
    const { file } = seedBug(s, '20260401_0400_FS_bad', `${ZH_HEAD}- **严重程度**: 高\n`);
    const before = fs.readFileSync(file, 'utf8');
    for (const body of [{ severity: 'urgent' }, { severity: 123 }, {}, { severity: null }]) {
      const r = await call(s, 'POST',
        `/api/projects/${s.pid}/bugs/20260401_0400_FS_bad/severity`, { body });
      assert.equal(r.status, 400);
      assert.equal(r.text(), '{"error":"严重程度不合法（仅支持 高/中/低）"}');
    }
    const en = await call(s, 'POST',
      `/api/projects/${s.pid}/bugs/20260401_0400_FS_bad/severity`,
      { body: { severity: 'urgent' }, headers: { 'x-ts-lang': 'en' } });
    assert.equal(en.status, 400);
    assert.equal(en.text(), '{"error":"Invalid severity (only High / Medium / Low allowed)"}');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally {
    s.close();
  }
});

test('POST severity：报告不存在 404 / 项目不存在 404（紧凑体，先于目录判定）', async () => {
  const s = setup('404');
  try {
    const miss = await call(s, 'POST',
      `/api/projects/${s.pid}/bugs/20260101_0000_FS_nope/severity`,
      { body: { severity: '高' } });
    assert.equal(miss.status, 404);
    assert.equal(miss.text(), '{"error":"bug not found"}');
    const noProj = await call(s, 'POST',
      '/api/projects/999999/bugs/20260101_0000_FS_x/severity',
      { body: { severity: '高' } });
    assert.equal(noProj.status, 404);
    assert.equal(noProj.text(), '{"error":"project not found"}');
  } finally {
    s.close();
  }
});
