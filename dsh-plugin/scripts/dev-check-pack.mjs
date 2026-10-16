/**
 * 发包产物端到端自检（慢；不经 dsh）—— 「`npm pack` 出来的包，解包后 Node 后端起不起得来」。
 *
 * 用法: node dsh-plugin/scripts/dev-check-pack.mjs
 * 退出码: 0=全过, 1=有失败项（含「npm/tar 不可用，本判据跑不了」）。
 *
 * 为什么要有它（2026-10-15 实测）：`@gavinc-cn/touchstone-dsh@0.1.1` 发出去的 105 个文件里
 * **没有 `backend/routes/` 的 11 个文件**，解包后 `node backend/server.js` 当场
 * `ERR_MODULE_NOT_FOUND: .../backend/routes/index.js` 并 exit 1（`backend/server.js:61`）。
 * 静态判据（`tools/parity/test/pack-closure.test.mjs` + `prepack-check.mjs`）查的是「白名单
 * 有没有盖住闭包」；本脚本查的是**真产物**：真 `npm pack`（会走 `prepack` 钩子）→ 真解包 →
 * 真起后端 → 真打接口。两者都要，因为静态判据对「npm 真实打包行为」的建模总有缺口。
 *
 * 判据（每条都打到真东西上，不只看文件在不在）:
 *   ① npm pack 出且只出一个 .tgz；解包里指名文件在（`backend/routes/index.js` 等 11 个）；
 *   ② 用解包出来的入口真起后端：`process.execPath --disable-warning=ExperimentalWarning
 *      <unpack>/backend/server.js --host 127.0.0.1 --port 0 --web-dir <unpack>/webui/dist-plugin
 *      --trust-internal-user --parent-watch`，stdout 上等到 `TOUCHSTONE_LISTEN <port>`；
 *   ③ 起来之后接口真通（每一条都对应一个运行时资源根，缺了就红）:
 *        /api/auth/me             → 200 admin（证明数据层起来了 ⇒ schema.sql/schema.json/
 *                                   migrations.json 真被读到）
 *        /app                     → 200 HTML 含 /assets/（证明 webui/dist-plugin 在包里）
 *        /api/projects            → 200 JSON 数组（证明 routes/index.js 与路由族真被 import）
 *        /api/builtin-assets      → 200 且含 dsh-autocommit（证明 extensions/ 在包里且真被扫描）
 *   ④ **隔离红线**：子进程 `HOME` 指到临时目录，且库路径必须落在临时目录里（从子进程自己的
 *      stderr 行 `touchstone-node: 数据库 <path>` 里解析 —— 不猜），同时断言**生产库**
 *      `~/.touchstone/touchstone.db` 的 mtime/size 前后一字不变（它与活动插件共用，绝不能写）。
 *   ⑤ 收尾：杀**整棵进程树**（`detached` 起进程组 ⇒ `process.kill(-pid)`），断言 pid 真没了。
 *
 * 与 `dev-check-backend.mjs` 的分工：那个测「双后端开关在**仓库工作副本**里的行为」
 * （PATH 只有假 python、五场景）；本脚本测「**发出去的包**本身完不完整」，只跑 Node 后端。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-pack-check-'));
const DEST = path.join(TMP, 'tgz');
const UNPACK = path.join(TMP, 'unpack');
const FAKE_HOME = path.join(TMP, 'home');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : '  → ' + detail}`);
  if (!ok) failures++;
}

/** 生产库（子进程绝不许碰它）：本进程 HOME 下的真库 */
const PROD_DB = path.join(os.homedir(), '.touchstone', 'touchstone.db');
/** 前后快照（存在性 + mtime + size），用来证明红线没被跨过 */
function dbSnapshot(p) {
  try {
    const st = fs.statSync(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'absent';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** pid 还活着吗（不发信号，只探） */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 带信任头探一次接口，返回 {status, text, json, contentType} */
async function probe(port, urlPath) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    headers: { 'x-ts-internal-user': 'admin' },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON：留 null */ }
  return { status: res.status, text, json, contentType: res.headers.get('content-type') || '' };
}

/**
 * 在临时目录里起解包出来的后端，等 `TOUCHSTONE_LISTEN <port>`，跑用例，最后杀整棵进程树。
 * 子进程 env **从零构造**（不 spread process.env）：绝不能把父进程的 HOME/TOUCHSTONE_DB
 * 漏进去 —— 那是隔离红线的全部依据。
 */
async function withPackedBackend(entryPath, webDir, run) {
  const outLines = [];
  const errLines = [];
  const childEnv = {
    PATH: process.env.PATH || '',
    HOME: FAKE_HOME,
    TMPDIR: os.tmpdir(),
    LANG: process.env.LANG || 'C.UTF-8',
    TS_ADMIN_PASSWORDLESS: '1',        // 与薄壳同款：插件形态默认空口令 admin，不起「强制改密门」
  };
  const child = spawn(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    entryPath,
    '--host', '127.0.0.1',
    '--port', '0',                      // 空闲端口交给内核选（与薄壳契约同形：解析 LISTEN 行）
    '--web-dir', webDir,
    '--trust-internal-user',
    '--parent-watch',
  ], { cwd: path.dirname(entryPath), env: childEnv, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });

  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  const onLine = (line, sink) => { sink.push(line); };
  const buffered = (sink) => {
    let rest = '';
    return (chunk) => {
      rest += chunk.toString('utf8');
      const parts = rest.split('\n');
      rest = parts.pop();
      for (const line of parts) onLine(line, sink);
    };
  };
  child.stdout.on('data', buffered(outLines));
  child.stderr.on('data', buffered(errLines));

  /** 等 stdout 上的契约行（薄壳也是逐行正则匹配这一行；行号随薄壳改动漂，别写死） */
  const waitListen = async (ms = 30000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const line = outLines.find((l) => /^TOUCHSTONE_LISTEN (\d+)/.test(l));
      if (line) return Number(line.match(/^TOUCHSTONE_LISTEN (\d+)/)[1]);
      if (exited) return null;                     // 起来就崩：立刻失败，不空等
      if (Date.now() > deadline) return null;
      await sleep(50);
    }
  };

  try {
    const port = await waitListen();
    return await run({ port, pid: child.pid, outLines, errLines, exited: () => exited });
  } finally {
    // ---- 杀整棵进程树：detached ⇒ 子进程是组长，负 pid 即整组 ----
    if (!exited) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* 已死 */ } }
      for (let i = 0; i < 60 && !exited; i++) await sleep(50);
      if (!exited) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 已死 */ } }
        for (let i = 0; i < 40 && !exited; i++) await sleep(50);
      }
    }
    try { child.stdin.end(); } catch { /* 已关 */ }
    try { child.unref(); } catch { /* 忽略 */ }
  }
}

// ---------------------------------------------------------------------------
// 开跑
// ---------------------------------------------------------------------------
fs.mkdirSync(DEST, { recursive: true });
fs.mkdirSync(UNPACK, { recursive: true });
fs.mkdirSync(FAKE_HOME, { recursive: true });
const prodBefore = dbSnapshot(PROD_DB);
console.log('== 发包产物自检（真 npm pack → 真解包 → 真起 Node 后端）==');
console.log(`   临时目录: ${TMP}`);
console.log(`   生产库（只读红线）: ${PROD_DB}  快照前=${prodBefore}`);
let childPid = null;
let childDbPath = '';

try {
  // ---- ① npm pack（会走 prepack 钩子：prepack-check.mjs 的静态判据在这里先挡一道）----
  const packed = spawnSync(NPM, ['pack', '--pack-destination', DEST], { cwd: REPO, encoding: 'utf8' });
  const packOk = packed.status === 0 && !packed.error;
  check('npm pack 成功（prepack 钩子通过）', packOk,
    (packed.error ? `error=${packed.error.message} ` : '') + `status=${packed.status} ${String(packed.stderr || '').trim().slice(-400)}`);
  if (!packOk) throw new Error('npm pack 失败，后续判据无处可跑');

  const tgzs = fs.readdirSync(DEST).filter((f) => f.endsWith('.tgz'));
  check('pack 出且只出一个 .tgz', tgzs.length === 1, `实际: ${JSON.stringify(tgzs)}`);
  if (tgzs.length !== 1) throw new Error('tgz 数量不对');
  const tgz = path.join(DEST, tgzs[0]);
  console.log(`   产物: ${tgzs[0]} (${fs.statSync(tgz).size} bytes)`);

  // ---- ② 解包（用系统 tar；Windows 10+ 自带的 bsdtar 同参数可用，但本机未验）----
  const untar = spawnSync('tar', ['-xzf', tgz, '-C', UNPACK, '--strip-components=1'], { encoding: 'utf8' });
  check('解包成功（tar -xzf --strip-components=1）', untar.status === 0 && !untar.error,
    (untar.error ? `error=${untar.error.message}` : `status=${untar.status} ${String(untar.stderr || '').slice(-200)}`));

  const entryPath = path.join(UNPACK, 'backend', 'server.js');
  const webDir = path.join(UNPACK, 'webui', 'dist-plugin');
  check('解包产物里有 Node 后端入口 backend/server.js', fs.existsSync(entryPath), entryPath);
  // 指名判据：2026-10-15 发出去的包里恰好整族缺失。名单从**仓库**现读（不手抄，免得路由改名后
  // 本判据变成陈旧的红），对照的是「仓库里那一族的同名文件，包里有没有」。
  const routeNames = fs.readdirSync(path.join(REPO, 'backend', 'routes')).filter((f) => f.endsWith('.js')).sort();
  check('仓库 backend/routes/ 里有 .js 可对照（否则下面那条会假绿）', routeNames.length > 0,
    `实际: ${JSON.stringify(routeNames)}`);
  const missingRoutes = routeNames.filter((n) => !fs.existsSync(path.join(UNPACK, 'backend', 'routes', n)));
  check(`解包产物里 backend/routes/*.js 齐全（${routeNames.length} 个）`, missingRoutes.length === 0,
    `缺: ${missingRoutes.join(', ')}`);
  if (!fs.existsSync(entryPath)) throw new Error('入口不在包里，起不了后端');

  // ---- ③/④ 真起后端 + 接口 + 隔离红线 ----
  await withPackedBackend(entryPath, webDir, async ({ port, pid, errLines, exited }) => {

    childPid = pid;
    check('stdout 上出现契约行 TOUCHSTONE_LISTEN <port>', port !== null,
      `exit=${JSON.stringify(exited())}`
      + (errLines.length ? ' | stderr=' + errLines.slice(-6).join(' | ') : ''));
    if (port === null) return;
    console.log(`   后端端口: ${port}（pid=${pid}）`);

    // 库路径从子进程**自己**的启动行里解析（不猜、不按公式推）
    const dbLine = errLines.find((l) => l.includes('数据库 '));
    childDbPath = dbLine ? String(dbLine.split('数据库 ')[1] || '').split('（')[0].trim() : '';
    console.log(`   子进程实际库路径: ${childDbPath || '(没解析到启动行)'}`);
    console.log(`   子进程 HOME: ${FAKE_HOME}`);
    check('子进程自报的库路径落在临时 HOME 里（隔离红线①）',
      childDbPath.startsWith(FAKE_HOME + path.sep),
      `db=${childDbPath || '(没解析到启动行)'} tmpHome=${FAKE_HOME}`);
    check('临时库里真建出了 touchstone.db（证明上面那行不是空话）',
      childDbPath !== '' && fs.existsSync(childDbPath), childDbPath);

    const me = await probe(port, '/api/auth/me');
    check('/api/auth/me → 200 且是 admin（数据层起来了 ⇒ schema 三件套真被读）',
      me.status === 200 && me.json && me.json.is_admin === true && me.json.username === 'admin',
      `status=${me.status} body=${me.text.slice(0, 160)}`);

    const app = await probe(port, '/app');
    check('/app → 200 HTML 且带 /assets/（webui/dist-plugin 真在包里）',
      app.status === 200 && app.contentType.startsWith('text/html') && app.text.includes('/assets/'),
      `status=${app.status} type=${app.contentType}`);

    const projects = await probe(port, '/api/projects');
    check('/api/projects → 200 JSON 数组（routes/index.js 与路由族真被 import）',
      projects.status === 200 && Array.isArray(projects.json),
      `status=${projects.status} body=${projects.text.slice(0, 160)}`);

    const assets = await probe(port, '/api/builtin-assets');
    const ids = assets.json && Array.isArray(assets.json.assets)
      ? assets.json.assets.map((a) => a && a.id) : [];
    check('/api/builtin-assets → 200 且含 dsh-autocommit（extensions/ 真在包里且被扫描）',
      assets.status === 200 && ids.includes('dsh-autocommit'),
      `status=${assets.status} ids=${JSON.stringify(ids)} body=${assets.text.slice(0, 160)}`);
  });

  // ---- ⑤ 进程树收干净 ----
  const closed = await (async () => {
    if (!childPid) return false;                  // 没起来 ⇒ 上面已红，这里别再谎报绿
    for (let i = 0; i < 20; i++) {
      if (!pidAlive(childPid)) return true;
      await sleep(100);
    }
    return false;
  })();
  check('后端进程树已收干净（SIGTERM→SIGKILL 整组）', closed, `pid=${childPid}`);
} catch (error) {
  check(`自检中断: ${error && error.message}`, false);
} finally {
  // ---- 隔离红线②：生产库前后一字不变 ----
  const prodAfter = dbSnapshot(PROD_DB);
  check(`生产库未被写（快照 ${prodBefore} → ${prodAfter}）`, prodBefore === prodAfter,
    `生产库被改动或新建: ${PROD_DB}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 临时目录删不掉不致命 */ }
}

console.log(failures === 0 ? '\nOVERALL: PASS' : `\nOVERALL: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
