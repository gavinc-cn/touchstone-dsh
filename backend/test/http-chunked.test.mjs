/**
 * 分块请求体（`Transfer-Encoding: chunked`）的实例级回归（2026-10-21）。
 *
 * 背景（桌面端建项目「项目名已存在」事故的根因）：DSH 桌面端的面板 iframe 走
 * `dsh-app://` 自定义协议，Electron 主进程的 `forwardWebRequest` 用 ReadableStream
 * 重放请求体（`duplex:'half'`）⇒ 转出来的 POST **只有 chunked、没有 Content-Length**
 * （隔离 Electron 实测）。旧 `readJsonBody` 只认 Content-Length ⇒ 整个桌面端面板的
 * 写请求体被静默当空：建项目回落到 `os.homedir()`（Windows = 用户名），撞上库里那条
 * 兜底项目 ⇒ UNIQUE ⇒ 被误报成「项目名已存在」。本文件用**原始 socket 发真分块帧**
 * （fetch/urllib 发不出 chunked），在真进程上钉住后端读体口径。
 *
 * 期望值形态：Python 的 400 全是 `json.dumps` 口径（冒号后带空格）；重名仍回原文案，
 * 非重名约束错照实上报（不再冒充重名）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

import { DatabaseSync } from 'node:sqlite';

const SERVER_JS = path.resolve(import.meta.dirname, '..', 'server.js');
const TRUST_HEADER = 'x-ts-internal-user';
const BODY_MISSING = '{"error": "未收到项目信息（请求体为空或格式非法），请刷新页面后重试"}';

/** 造临时 WEB_DIR（等价于 webui/dist-plugin 的最小形态） */
function makeWebDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-node-web-'));
  fs.writeFileSync(path.join(dir, 'index.html'),
    '<!doctype html><html><head><script src="/assets/index-abc.js"></script></head><body></body></html>\n');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'index-abc.js'), 'console.log("ts")\n');
  return dir;
}

/** 起一个后端进程（隔离库/运行目录），等到 TOUCHSTONE_LISTEN 行 */
async function startBackend(webDir) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-node-run-'));
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ts-node-db-')), 't.db');
  const child = spawn(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    SERVER_JS,
    '--host', '127.0.0.1', '--port', '0',
    '--web-dir', webDir,
    '--trust-internal-user',
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TOUCHSTONE_DB: dbPath, TOUCHSTONE_RUN_DIR: runDir,
      TS_ADMIN_PASSWORDLESS: '1' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`10s 未见 TOUCHSTONE_LISTEN 行。stdout=${stdout} stderr=${stderr}`)),
      10000);
    const tick = () => {
      const m = stdout.match(/^TOUCHSTONE_LISTEN (\d+)/m);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    child.stdout.on('data', tick);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`后端提前退出 code=${code} stderr=${stderr}`)); });
    tick();
  });
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
  return { child, port, dbPath, stdout: () => stdout, stderr: () => stderr, stop };
}

/**
 * 发一条**原始 HTTP/1.1** 请求（chunked 或定长）并返回 {status, body}。
 *
 * chunked 模式下把 body 切成 `chunks` 段真分块帧发出（默认最多 3 段）——这样既覆盖
 * 「有 chunked 头」，也覆盖「分块帧跨多个 data 事件到达」。
 */
function rawRequest(port, method, urlPath, bodyBytes, { chunked = false, chunks = 3 } = {}) {
  const head = [
    `${method} ${urlPath} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    'Content-Type: application/json',
    `${TRUST_HEADER}: admin`,
    'Connection: close',
  ];
  if (chunked) head.push('Transfer-Encoding: chunked');
  else head.push(`Content-Length: ${bodyBytes.length}`);
  let payload = Buffer.alloc(0);
  if (chunked) {
    const n = Math.max(1, Math.min(chunks, bodyBytes.length || 1));
    const step = Math.ceil(bodyBytes.length / n) || 1;
    for (let i = 0; i < bodyBytes.length; i += step) {
      const part = bodyBytes.subarray(i, i + step);
      payload = Buffer.concat([
        payload, Buffer.from(`${part.length.toString(16)}\r\n`), part, Buffer.from('\r\n'),
      ]);
    }
    payload = Buffer.concat([payload, Buffer.from('0\r\n\r\n')]);
  } else {
    payload = bodyBytes;
  }
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write(Buffer.concat([Buffer.from(head.join('\r\n') + '\r\n\r\n'), payload]));
    });
    const received = [];
    socket.on('data', (c) => received.push(c));
    socket.on('end', () => {
      const raw = Buffer.concat(received);
      const sep = raw.indexOf('\r\n\r\n');
      if (sep < 0) { reject(new Error(`响应头不完整: ${raw.toString('utf8')}`)); return; }
      const headText = raw.subarray(0, sep).toString('utf8');
      const status = Number(headText.split('\r\n')[0].split(' ')[1]);
      resolve({ status, head: headText, body: raw.subarray(sep + 4).toString('utf8') });
    });
    socket.on('error', reject);
  });
}

const encode = (obj) => Buffer.from(JSON.stringify(obj), 'utf8');

test('分块请求体：chunked 建项目 ⇒ 200（桌面端 dsh-app 协议形态；修复前会 400 项目名已存在）', { timeout: 40000 }, async () => {
  const webDir = makeWebDir();
  const b = await startBackend(webDir);
  try {
    const projectDir = path.join(b.dbPath, '..', 'proj-chunked');
    const r = await rawRequest(b.port, 'POST', '/api/projects',
      encode({ name: '分块项目', project_dir: projectDir }), { chunked: true });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(JSON.parse(r.body), { id: 1 });
    // 落库的是请求体里的名字/目录，不是 homedir 兜底
    const list = await rawRequest(b.port, 'GET', '/api/projects', Buffer.alloc(0));
    assert.equal(list.status, 200);
    const rows = JSON.parse(list.body);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, '分块项目');
    assert.equal(rows[0].project_dir, projectDir);
    // 派生目录真被创建（建目录发生在 insert 之前，与定长请求同一条路径）
    assert.ok(fs.statSync(path.join(projectDir, '.touchstone', 'free_style')).isDirectory());
    assert.ok(fs.statSync(path.join(projectDir, '.touchstone', 'bug_report')).isDirectory());
  } finally {
    await b.stop();
  }
});

test('分块请求体：chunked 打其他写端点（fs/mkdir）同样生效', { timeout: 40000 }, async () => {
  const webDir = makeWebDir();
  const b = await startBackend(webDir);
  try {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-node-mkdir-'));
    const r = await rawRequest(b.port, 'POST', '/api/fs/mkdir',
      encode({ path: base, name: 'chunked-sub' }), { chunked: true });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(JSON.parse(r.body), { name: 'chunked-sub', path: path.join(base, 'chunked-sub') });
    assert.ok(fs.statSync(path.join(base, 'chunked-sub')).isDirectory());
  } finally {
    await b.stop();
  }
});

test('空请求体守卫：无 name/project_dir 键 ⇒ 400 明确文案，不落行、不建 homedir 项目', { timeout: 40000 }, async () => {
  const webDir = makeWebDir();
  const b = await startBackend(webDir);
  try {
    // ① Content-Length: 0（无体）
    const zero = await rawRequest(b.port, 'POST', '/api/projects', Buffer.alloc(0));
    assert.equal(zero.status, 400, zero.body);
    assert.equal(zero.body, BODY_MISSING);
    // ② chunked 空 JSON 对象（旧实现同样回落到 homedir ⇒ 会落一条「用户名项目」）
    const empty = await rawRequest(b.port, 'POST', '/api/projects', encode({}), { chunked: true });
    assert.equal(empty.status, 400, empty.body);
    assert.equal(empty.body, BODY_MISSING);
    // 一条行都不许落（这是本守卫的核心价值：不再产生「撞名源」）
    const list = await rawRequest(b.port, 'GET', '/api/projects', Buffer.alloc(0));
    assert.deepEqual(JSON.parse(list.body), []);
  } finally {
    await b.stop();
  }
});

test('重名仍是原文案；非重名约束错照实上报（不再冒充「项目名已存在」）', { timeout: 40000 }, async () => {
  const webDir = makeWebDir();
  const b = await startBackend(webDir);
  try {
    const projectDir = path.join(b.dbPath, '..', 'proj-dup');
    const body = encode({ name: '重名项目', project_dir: projectDir });
    const first = await rawRequest(b.port, 'POST', '/api/projects', body);
    assert.equal(first.status, 200, first.body);
    const dup = await rawRequest(b.port, 'POST', '/api/projects', body);
    assert.equal(dup.status, 400, dup.body);
    assert.equal(dup.body, '{"error": "项目名已存在"}');
    // 非重名约束错：给 projects 加一个 BEFORE INSERT 触发器 RAISE(ABORT)（真约束错，
    // 不是重名）⇒ 应回「数据库约束: …」而不是冒充重名
    const handle = new DatabaseSync(b.dbPath);
    try {
      handle.exec('CREATE TRIGGER block_projects BEFORE INSERT ON projects'
        + " BEGIN SELECT RAISE(ABORT, 'forced non-name constraint'); END;");
      const blocked = await rawRequest(b.port, 'POST', '/api/projects',
        encode({ name: '撞触发器项目', project_dir: path.join(b.dbPath, '..', 'proj-trigger') }));
      assert.equal(blocked.status, 400, blocked.body);
      assert.equal(blocked.body,
        '{"error": "项目创建失败（数据库约束: forced non-name constraint）"}');
    } finally {
      handle.exec('DROP TRIGGER IF EXISTS block_projects');
      handle.close();
    }
  } finally {
    await b.stop();
  }
});
