/**
 * backend/server.js 的进程契约测试（node --test，零依赖，真 spawn 子进程）。
 *
 * 为什么是「真进程」而不是 import 进来调函数：这个后端的**接口是进程级的**——argv、stdout 的
 * `TOUCHSTONE_LISTEN <port>` 行、stdin EOF + 父存活复核（父死感知）、HTTP 语义，全都不在函数签名里。
 * 期望值逐条对齐 `server.py`（方案 §3.2 + §3.5）与 `dev-check.mjs` 里已固化的三条实测口径。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const SERVER_JS = path.resolve(import.meta.dirname, '..', 'server.js');

/** 造临时 WEB_DIR（等价于 webui/dist-plugin 的最小形态） */
function makeWebDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-node-web-'));
  fs.writeFileSync(path.join(dir, 'index.html'),
    '<!doctype html><html><head><script src="/assets/index-abc.js"></script></head><body></body></html>\n');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'index-abc.js'), 'console.log("ts")\n');
  return dir;
}

/** 起一个后端进程，等到 TOUCHSTONE_LISTEN 行；返回 {port, child, stdout, stderr, stop()} */
async function startBackend(webDir, extraArgv = []) {
  // 库与 .run 必须隔离到临时目录：M1 起 server.js 会取同库单实例锁并写 `<db>.pid`，
  // 不隔离就会去锁 `~/.touchstone/touchstone.db`（真实实例的归属记录被覆盖/删除）。
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-node-run-'));
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ts-node-db-')), 't.db');
  const child = spawn(process.execPath, [
    // 薄壳起后端时固定带这个 flag（`NODE_EXTRA_FLAGS`）：node:sqlite 在 22.x 是实验特性，
    // 不加会往 stderr 打 ExperimentalWarning，污染 plugin-backend.log（唯一排障证据源）。
    '--disable-warning=ExperimentalWarning',
    SERVER_JS,
    '--host', '127.0.0.1',
    '--port', '0',
    '--web-dir', webDir,
    '--trust-internal-user',
    '--parent-watch',
    ...extraArgv,
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
    const timer = setTimeout(() => reject(new Error(`10s 未见 TOUCHSTONE_LISTEN 行。stdout=${stdout} stderr=${stderr}`)), 10000);
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
  return { child, port, stdout: () => stdout, stderr: () => stderr, stop };
}

const base = (port) => `http://127.0.0.1:${port}`;

/** 进程存活探测（POSIX kill(pid,0)；EPERM 视为存活） */
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('契约：stdout 出 TOUCHSTONE_LISTEN <port> 行，静态/SPA/鉴权/信任头语义对齐 Python', { timeout: 40000 }, async () => {
  const webDir = makeWebDir();
  const b = await startBackend(webDir);
  try {
    // ① 端口行在 stdout（薄壳按行解析端口：`dsh-plugin/lib/index.js:663` 是**逐行**正则，
    //    不要求首行）。M4.5 实测修正：M0 写下的「首行」契约 **Python 自己从未遵守**——
    //    实测 `python3 server.py` 的 stdout 首行是 `[waitq] 对账完成：活跃行 0 条，收口 0 条`
    //    （见 M4.5 实施记录），Node 接上调度核心后同样先打对账行。断言因此收紧为
    //    「出现的端口行**恰好一行**且形状正确」，比原来的 `^` 更严（防重复打印）。
    const listenLines = b.stdout().split('\n').filter((l) => l.startsWith('TOUCHSTONE_LISTEN'));
    assert.equal(listenLines.length, 1,
      `stdout 必须恰有一行端口行：stdout=${JSON.stringify(b.stdout())}`);
    assert.match(listenLines[0], /^TOUCHSTONE_LISTEN \d+$/, `stdout=${JSON.stringify(b.stdout())}`);

    // ② SPA 页面 → index.html 200 + text/html + no-store
    const app = await fetch(`${base(b.port)}/app`);
    assert.equal(app.status, 200);
    assert.equal(app.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(app.headers.get('cache-control'), 'no-store');
    assert.match(await app.text(), /assets\/index-abc\.js/);

    // ③ 真实静态资源 → 200 + JS MIME
    const js = await fetch(`${base(b.port)}/assets/index-abc.js`);
    assert.equal(js.status, 200);
    assert.equal(js.headers.get('content-type'), 'application/javascript; charset=utf-8');
    assert.equal(await js.text(), 'console.log("ts")\n');

    // ④ /api/* 无信任头 → 401 {"error":"unauthorized"}（与 Python 同形状）
    const anon = await fetch(`${base(b.port)}/api/nope`);
    assert.equal(anon.status, 401);
    assert.deepEqual(await anon.json(), { error: 'unauthorized' });

    // ⑤ 带信任头但端点不存在 → 404 {"error":"not found"}
    const authed404 = await fetch(`${base(b.port)}/api/nope`, { headers: { 'x-ts-internal-user': 'admin' } });
    assert.equal(authed404.status, 404);
    assert.deepEqual(await authed404.json(), { error: 'not found' });

    // ⑥ /api/auth/me：信任头 → admin 形状（键集合与类型与 Python 一致）
    const me = await fetch(`${base(b.port)}/api/auth/me`, { headers: { 'x-ts-internal-user': 'admin' } });
    assert.equal(me.status, 200);
    assert.equal(me.headers.get('content-type'), 'application/json; charset=utf-8');
    const meBody = await me.json();
    assert.deepEqual(Object.keys(meBody).sort(), ['is_admin', 'must_change_password', 'username']);
    assert.equal(meBody.username, 'admin');
    assert.equal(meBody.is_admin, true);
    assert.equal(meBody.must_change_password, false);

    // ⑦ 根路径 302：已登录 → /app；未登录 → /login（Python `_redirect`）
    const rootAuthed = await fetch(`${base(b.port)}/`, { redirect: 'manual', headers: { 'x-ts-internal-user': 'admin' } });
    assert.equal(rootAuthed.status, 302);
    assert.equal(rootAuthed.headers.get('location'), '/app');
    const rootAnon = await fetch(`${base(b.port)}/`, { redirect: 'manual' });
    assert.equal(rootAnon.status, 302);
    assert.equal(rootAnon.headers.get('location'), '/login');
  } finally {
    await b.stop();
  }
});

test('路径穿越：原始 `..` 段 → 403 forbidden（未解码的 %2e%2e 不越界）', { timeout: 40000 }, async () => {
  const b = await startBackend(makeWebDir());
  try {
    // 用裸 socket：fetch/URL 会在发请求前把 `/../` 归一掉，测不到服务端行为
    const raw = await new Promise((resolve, reject) => {
      const sock = net.connect(b.port, '127.0.0.1', () => {
        sock.write('GET /../etc/passwd HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      });
      let text = '';
      sock.setEncoding('utf8');
      sock.on('data', (c) => { text += c; });
      sock.on('end', () => resolve(text));
      sock.on('error', reject);
      sock.setTimeout(8000, () => { sock.destroy(); reject(new Error('裸 socket 超时')); });
    });
    assert.match(raw, /^HTTP\/1\.1 403 /);
    assert.match(raw, /forbidden/);

    const encoded = await fetch(`${base(b.port)}/%2e%2e/etc/passwd`);
    assert.equal(encoded.status, 200, '未解码的 %2e%2e 不是越界，按 Python 语义回退 index.html');
    assert.equal(encoded.headers.get('content-type'), 'text/html; charset=utf-8');
  } finally {
    await b.stop();
  }
});

test('安全阀：非回环 host 配 --trust-internal-user ⇒ 拒绝启动（对齐 server.py:5423-5428）', { timeout: 40000 }, async () => {
  // 信任头等价 admin 全权；Python 侧对此有硬校验（`--host not in (127.0.0.1, localhost)` ⇒ exit 1），
  // Node 侧必须同款，否则 `--host 0.0.0.0` 一开就是局域网 admin 后门。
  const webDir = makeWebDir();
  const child = spawn(process.execPath, [
    SERVER_JS, '--host', '0.0.0.0', '--port', '0',
    '--web-dir', webDir, '--trust-internal-user', '--parent-watch',
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // 同样隔离库：安全阀在取锁之前，但校验顺序将来可能变——不让测试有机会碰真实库
    env: { ...process.env,
      TOUCHSTONE_DB: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ts-node-db-')), 't.db') },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  const code = await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    // 现状（无安全阀）是「正常起服务、永不退出」——不能无限等，5s 后收口并判失败
    new Promise((resolve) => setTimeout(() => resolve('still-running'), 5000)),
  ]);
  if (code === 'still-running') {
    child.kill('SIGKILL');
    assert.fail(`非回环 + 信任头竟然启动了（stdout=${stdout} stderr=${stderr}）`);
  }
  assert.equal(code, 1, `应当拒绝启动，实际退出码 ${code}（stderr=${stderr}）`);
  assert.doesNotMatch(stdout, /TOUCHSTONE_LISTEN/, '拒绝启动时不得打出端口行');
  assert.match(stderr, /127\.0\.0\.1|回环/, `提示须说明只允许回环: ${stderr}`);
});

test('方法语义：无 do_* 的方法 501，写方法的鉴权/404 语义对齐 Python（M3 收口）',
  { timeout: 40000 }, async () => {
    // 期望值是**真起 Python 后端实测**出来的（2026-10-11，同一 fixture，命令见 M3 计划 §六）：
    //   HEAD /app → 501；PUT /api/auth/me → 501（BaseHTTPRequestHandler 没这两个 do_*）；
    //   POST /api/auth/me 无信任头 → 401（do_POST 先过 `/api/` 鉴权门）；
    //   POST /api/auth/me 带信任头 → 404 {"error":"not found"}（没有这个 POST 路由）；
    //   POST /nope 无信任头 → 404（do_POST 只对 `/api/` 前缀鉴权，非 API 路径直接落末行 404）。
    // M0 时代这里断言「POST 一律 501」——那是骨架期的临时口径，M3 按 Python 实测收口。
    const b = await startBackend(makeWebDir());
    try {
      const head = await fetch(`${base(b.port)}/app`, { method: 'HEAD' });
      assert.equal(head.status, 501);
      const put = await fetch(`${base(b.port)}/api/auth/me`, { method: 'PUT' });
      assert.equal(put.status, 501);

      const postNoAuth = await fetch(`${base(b.port)}/api/auth/me`, { method: 'POST' });
      assert.equal(postNoAuth.status, 401);
      assert.deepEqual(await postNoAuth.json(), { error: 'unauthorized' });

      const postTrust = await fetch(`${base(b.port)}/api/auth/me`, {
        method: 'POST', headers: { 'x-ts-internal-user': 'admin' },
      });
      assert.equal(postTrust.status, 404);
      assert.deepEqual(await postTrust.json(), { error: 'not found' });

      const postNonApi = await fetch(`${base(b.port)}/nope`, { method: 'POST' });
      assert.equal(postNonApi.status, 404, '非 /api 的 POST 不过鉴权门，直接 404');
      assert.deepEqual(await postNonApi.json(), { error: 'not found' });
    } finally {
      await b.stop();
    }
  });

test('写方法 + 非法 Content-Length ⇒ 无响应即断（对齐 Python `int()` 语义；M4.5 量具抓出）',
  { timeout: 40000 }, async () => {
    // 期望值的来源：**实例级对拍量具实测**（`tools/parity/http-run.mjs` 的 write_foundation 场景）
    // ——`POST /api/tasks/<id>/session/chat` + `Content-Length: abc` 时，
    //   Python 侧 `_read_json` 的 `int()` 抛 ValueError 一路冒到 socketserver ⇒ **0 字节、直接断**；
    //   Node 侧 llhttp 在解析层就拒收（HPE_INVALID_CONTENT_LENGTH），默认回 400 ⇒ 契约不符。
    // 这里用**裸 socket**（fetch 造不出非法 Content-Length）钉住修好后的口径：
    //   写方法（POST/PATCH/DELETE）⇒ 连接关闭且**一个字节响应都没有**；
    //   GET ⇒ 仍是 400（Python 会 200，因为 do_GET 不读体；llhttp 已拒收 ⇒ Node 进不到路由，
    //   属**已知不可对齐**的协议层差异，断言现状以免它被无声改掉）。
    const b = await startBackend(makeWebDir());
    const raw = (payload) => new Promise((resolve) => {
      const sock = net.connect(b.port, '127.0.0.1', () => sock.write(payload));
      let got = '';
      let closed = false;
      sock.setEncoding('utf8');
      sock.on('data', (c) => { got += c; });
      sock.on('close', () => { closed = true; resolve({ got, closed }); });
      sock.on('error', () => { closed = true; resolve({ got, closed }); });
      setTimeout(() => { sock.destroy(); }, 3000);
    });
    try {
      for (const method of ['POST', 'PATCH', 'DELETE']) {
        const r = await raw(`${method} /api/tasks/1/session/chat HTTP/1.1\r\n`
          + 'Host: 127.0.0.1\r\n'
          + 'x-ts-internal-user: admin\r\n'
          + 'Content-Type: application/json\r\n'
          + 'Content-Length: abc\r\n\r\n');
        assert.equal(r.got, '', `${method} 不该收到任何响应字节，实得 ${JSON.stringify(r.got)}`);
        assert.equal(r.closed, true, `${method} 的连接应被关闭`);
      }
      // 反例（同一个 server 进程里，正常请求照常工作——证明上面不是「服务被打挂」）
      const ok = await fetch(`${base(b.port)}/api/auth/me`, {
        headers: { 'x-ts-internal-user': 'admin' },
      });
      assert.equal(ok.status, 200);
      // 已知协议层差异（GET 不读体）：Node 400 / Python 200
      const g = await raw('GET /api/auth/me HTTP/1.1\r\nHost: 127.0.0.1\r\n'
        + 'x-ts-internal-user: admin\r\nContent-Length: abc\r\n\r\n');
      assert.match(g.got, /^HTTP\/1\.1 400 /,
        `GET 的现状是 llhttp 层 400（不可对齐 Python 的 200），实得 ${JSON.stringify(g.got)}`);
    } finally {
      await b.stop();
    }
  });

test('--parent-watch：stdin 关闭但父仍存活 ⇒ 判定误报、继续运行（对齐 lifecycle 的防误杀）',
  { timeout: 40000 }, async () => {
    // 2026-10-11 对齐 Python：`lifecycle._watch_stdin` 在 EOF 后要 `parent_alive()` 复核，
    // 只有父真死才自杀。反例实测：`node backend/server.js … < /dev/null` 无条件自杀会让
    // 「手工/包装脚本起后端」立刻退出（而 Python 版继续跑）。
    const b = await startBackend(makeWebDir());
    b.child.stdin.end();                            // 父（本测试进程）仍活着
    const exited = await Promise.race([
      new Promise((resolve) => b.child.once('exit', (code) => resolve(code))),
      new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    assert.equal(exited, null, '父仍存活时不得因 stdin 关闭而退出');
    assert.match(b.stderr(), /判定为误报，继续运行/);
    // 仍然可服务（进程真活着）
    const me = await fetch(`${base(b.port)}/api/auth/me`,
      { headers: { 'x-ts-internal-user': 'admin' } });
    assert.equal(me.status, 200);
    await b.stop();
  });

test('--parent-watch：真·父死（中间进程被 kill -9）⇒ 后端自行退出', { timeout: 60000 }, async () => {
  // 真孤儿场景（薄壳被 kill -9）：中间进程 spawn 后端后被杀 ⇒ 后端被 init 收养、stdin 写端关闭，
  // 此时 EOF + 父死两条都成立，必须退出（不能留孤儿继续写库）。
  const webDir = makeWebDir();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-node-run-'));
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ts-node-db-')), 't.db');
  const middleSrc = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ${JSON.stringify([
      '--disable-warning=ExperimentalWarning', SERVER_JS, '--host', '127.0.0.1', '--port', '0',
      '--web-dir', webDir, '--trust-internal-user', '--parent-watch'])}, {
      stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
    child.stdout.pipe(process.stdout);
    console.log('CHILD_PID ' + child.pid);
    setTimeout(() => {}, 120000);
  `;
  const middle = spawn(process.execPath, ['-e', middleSrc], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, TOUCHSTONE_DB: dbPath, TOUCHSTONE_RUN_DIR: runDir,
      TS_ADMIN_PASSWORDLESS: '1' },
  });
  let out = '';
  let childPid = 0;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`中间进程未就绪: ${out}`)), 20000);
      middle.stdout.setEncoding('utf8');
      middle.stdout.on('data', (c) => {
        out += c;
        const m = out.match(/CHILD_PID (\d+)/);
        if (m) childPid = Number(m[1]);
        if (/^TOUCHSTONE_LISTEN \d+/m.test(out) && childPid) { clearTimeout(timer); resolve(); }
      });
      middle.on('exit', () => { clearTimeout(timer); reject(new Error(`中间进程提前退出: ${out}`)); });
    });
    assert.ok(childPid > 0, `未拿到后端 pid: ${out}`);
    process.kill(middle.pid, 'SIGKILL');            // 模拟薄壳/宿主被 kill -9
    await new Promise((r) => middle.once('exit', r));
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && isAlive(childPid)) await sleep(150);
    assert.equal(isAlive(childPid), false,
      `父被 kill -9 后 Node 后端未退出（孤儿！pid=${childPid}）`);
  } finally {
    try { process.kill(middle.pid, 'SIGKILL'); } catch { /* 已退出 */ }
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch { /* 已退出 */ } }
  }
});

test('就绪即停：看到 TOUCHSTONE_LISTEN 立刻 SIGTERM ⇒ 优雅退出（退出码 0 + 收尾日志）',
  { timeout: 40000 }, async () => {
    // 为什么要这条：端口行是消费方判断「就绪」的唯一信号，而它一度是在注册 SIGTERM handler
    // **之前**打印的——薄壳 stopBackend / 自检 / 对拍器一看到就停，信号就落在窗口里，进程
    // 直接死于信号：release() 不跑，现场留下 `.pid` 记录与锁库热日志（M1 实测踩中）。
    // Python 侧顺序是对的（server.py:5546 注册 handler 后才 :5562 打印 LISTEN），Node 必须同序。
    const webDir = makeWebDir();
    const b = await startBackend(webDir);
    b.child.kill('SIGTERM');                       // 不等待、不 sleep：把窗口挤到最小
    const code = await new Promise((resolve) => b.child.once('exit', resolve));
    assert.equal(code, 0, `应优雅退出（0），实际 ${code}；stderr=${b.stderr()}`);
    assert.match(b.stderr(), /退出（sigterm）/, `缺少收尾日志：${b.stderr()}`);
    assert.doesNotMatch(b.stderr(), /ExperimentalWarning/,
      '起后端必须带 --disable-warning=ExperimentalWarning（否则污染 plugin-backend.log）');
  });
