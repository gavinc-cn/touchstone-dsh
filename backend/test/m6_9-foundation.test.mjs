/**
 * M6.9 基建（R2）单测：`auth.js` 四件 + `cookie.js`（新）+ `lib.js` 三个 helper。
 *
 * 期望值来源（**逐行对照 Python，不是读 Node 实现反推**）：
 *   - `auth.py:15` SESSION_TTL / `auth.py:16` COOKIE_NAME / `auth.py:61` session_expiry /
 *     `auth.py:66-85` LoginLimiter；
 *   - `server.py:5249-5254` `_cookie_token`（partition 第一个 `=`、名字精确比较）、
 *     `server.py:1511-1513` 登录 Set-Cookie、`server.py:1525-1526` 登出 Set-Cookie；
 *   - `server.py:815` normalize_project_name / `server.py:825` path_last_segment /
 *     `server.py:968` fs_mkdir（错误文案是直接给用户看的中文，必须逐字相等）。
 *
 * 钉住的几条**易错语义**：
 *   ① `LoginLimiter.allow` 只「剪枝 + 判数」**不写计数**，计数由 `record` 追加 ⇒ 不配对调用时
 *      永远放行；且 `allow` 会**写回**剪枝结果（副作用可观测：窗口过期后计数归零）；
 *   ② cookie **名**比较是精确的（`TS_SESSION` 不算），而**头名** `Cookie` 大小写不敏感；
 *      `ts_session=` 的返回值是**空串**（falsy，调用方 `if not token` 与「无 cookie」同路）；
 *   ③ `partition("=")` 按第一个 `=` 切，值是 `a=b` 这种形态；
 *   ④ `normalize_project_name` 的 `(name or "")` 是 Python 真值口径：`0`/`False`/`{}`/`[]`
 *      一律落 `"project"`（JS 的 `0 || ''` 同、但 `{} || ''` 不同 ⇒ 用 pyTruthy 口径）；
 *   ⑤ `fs_mkdir` 的 `os.path.lexists`（悬空符号链接也算「已存在」）与
 *      `name != name.rstrip(". ")`（结尾点/空格一律拒，跨平台统一）。
 *
 * 已知有意保留的差异（写在这里备案，测试按差异断言）：
 *   - `os.mkdir` 的 `OSError` 分支：Python `e.strerror`（如 `File name too long`）在 Node 无
 *     对应字段（`err.strerror === undefined`），Node 的 `err.message` 形如
 *     `ENAMETOOLONG: name too long, mkdir '/tmp/x'` ⇒ 文案**不可能逐字节相同**，
 *     该条只断言前缀 `新建失败：`；
 *   - `os.path.realpath` 对**符号链接父目录**的展开：Node 走 `realpathSync`（存在时等价），
 *     本文件用真符号链接在 Linux 上验一条；macOS `/tmp` 自身是符号链接、Windows 未验。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { COOKIE_NAME, LoginLimiter, SESSION_TTL, sessionExpiry } from '../lib/auth.js';
import { clearSessionCookie, cookieToken, sessionCookie } from '../lib/cookie.js';
import { fsMkdir, normalizeProjectName, pathLastSegment } from '../lib/lib.js';

// --------------------------------------------------------------------------
// 测试台
// --------------------------------------------------------------------------

/** 临时目录（每个用例自建自清；失败也清） */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-m69-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 阻塞 ms 毫秒（限流窗口到期用） */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// --------------------------------------------------------------------------
// auth.js:常量与会话过期串
// --------------------------------------------------------------------------

test('SESSION_TTL / COOKIE_NAME 与 auth.py 逐字相同', () => {
  assert.equal(SESSION_TTL, 604800);          // auth.py:15  7 * 24 * 3600
  assert.equal(COOKIE_NAME, 'ts_session');    // auth.py:16
});

test('sessionExpiry() 是本地时间 YYYY-MM-DD HH:MM:SS，且 = now + SESSION_TTL', () => {
  const before = Date.now() + SESSION_TTL * 1000;
  const text = sessionExpiry();
  const after = Date.now() + SESSION_TTL * 1000;

  assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  // 无时区后缀的日期时间串按**本地时区**解析（ES 规范），故与 time.localtime 同口径；
  // 若实现写成 UTC（toISOString）则在本机 TZ=Asia/Shanghai 下会差 8 小时 ⇒ 这条会红
  const parsed = new Date(text.replace(' ', 'T')).getTime();
  assert.ok(Number.isFinite(parsed), `无法按本地时间解析：${text}`);
  const tolerance = 2000;                     // 秒级截断 + 用例内时钟推进
  assert.ok(parsed >= before - tolerance && parsed <= after + tolerance,
    `sessionExpiry()=${text} 偏离 now+SESSION_TTL 超过 ${tolerance}ms`);

  // 逐字段复核：与本地字段手拼串完全相同（证明不是 UTC、也不是 ISO）
  const d = new Date(parsed);
  const p = (n) => String(n).padStart(2, '0');
  const manual = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  assert.equal(text, manual);
});

// --------------------------------------------------------------------------
// auth.js:LoginLimiter
// --------------------------------------------------------------------------

test('LoginLimiter：allow+record 十次后第 11 次 allow 为 false（缺省 10/60）', () => {
  const limiter = new LoginLimiter();
  assert.equal(limiter.maxAttempts, 10);
  assert.equal(limiter.window, 60);
  const ip = '203.0.113.10';
  for (let i = 1; i <= 10; i += 1) {
    assert.equal(limiter.allow(ip), true, `第 ${i} 次尝试应放行`);
    limiter.record(ip);
  }
  assert.equal(limiter.allow(ip), false, '第 11 次应被限流');
});

test('LoginLimiter：allow 不写计数——不 record 时反复调用不涨计数', () => {
  const limiter = new LoginLimiter();
  const ip = '203.0.113.11';
  for (let i = 0; i < 50; i += 1) assert.equal(limiter.allow(ip), true);
  // 50 次 allow 之后补上第 1 次 record：若 allow 偷偷写计数，这里第 2 次 allow 就会 false
  limiter.record(ip);
  assert.equal(limiter.allow(ip), true);
  for (let i = 0; i < 9; i += 1) limiter.record(ip);
  assert.equal(limiter.allow(ip), false);
});

test('LoginLimiter：allow 有剪枝副作用（窗口过期后计数归零并写回）', async () => {
  const limiter = new LoginLimiter(1, 0.05);
  const ip = '203.0.113.12';
  limiter.record(ip);
  assert.equal(limiter.allow(ip), false, '窗口内 1 条已达上限');
  await sleep(100);
  assert.equal(limiter.allow(ip), true, '过期记录应被剪掉');
  // 写回也发生了：旧记录不会复活 —— 再记 1 条仍应立刻达上限
  limiter.record(ip);
  assert.equal(limiter.allow(ip), false);
  await sleep(100);
  assert.equal(limiter.allow(ip), true);
});

test('LoginLimiter：窗口判据是严格小于（window=0 时任何记录都已过期）', () => {
  const limiter = new LoginLimiter(1, 0);
  const ip = '203.0.113.13';
  limiter.record(ip);
  assert.equal(limiter.allow(ip), true, 'now - t < 0 恒假 ⇒ 记录全被剪掉');
});

test('LoginLimiter：不同 ip 互不影响', () => {
  const limiter = new LoginLimiter(1, 60);
  limiter.record('198.51.100.1');
  assert.equal(limiter.allow('198.51.100.1'), false);
  assert.equal(limiter.allow('198.51.100.2'), true);
  limiter.record('198.51.100.2');
  assert.equal(limiter.allow('198.51.100.2'), false);
  assert.equal(limiter.allow('198.51.100.1'), false, 'A 的记录不受 B 影响');
});

test('LoginLimiter：每个实例各自持计数（单例由 server.js 持有，类本身不共享）', () => {
  const a = new LoginLimiter(1, 60);
  const b = new LoginLimiter(1, 60);
  a.record('127.0.0.1');
  assert.equal(a.allow('127.0.0.1'), false);
  assert.equal(b.allow('127.0.0.1'), true, '实例之间不得共享 _records');
});

// --------------------------------------------------------------------------
// cookie.js
// --------------------------------------------------------------------------

test('cookieToken：取第一个同名 cookie 的值，非首个匹配则无视其余', () => {
  assert.equal(cookieToken({ cookie: 'a=1; ts_session=abc; b=2' }), 'abc');
  assert.equal(cookieToken({ cookie: 'ts_session=first; ts_session=second' }), 'first');
  assert.equal(cookieToken({ cookie: 'ts_session=abc' }), 'abc');
  assert.equal(cookieToken({ cookie: 'ts_session=abc;' }), 'abc');
});

test('cookieToken：partition 按第一个 = 切分（值是 a=b 形态）', () => {
  assert.equal(cookieToken({ cookie: 'ts_session=a=b' }), 'a=b');
  assert.equal(cookieToken({ cookie: 'ts_session==x' }), '=x');
  // 没有 = 时 Python partition 返回 ("ts_session", "", "") ⇒ 值空串
  assert.equal(cookieToken({ cookie: 'ts_session' }), '');
});

test('cookieToken：命中但值为空串时返回 ""（不是 null）——空串与 null 由调用方按 falsy 统一处理', () => {
  assert.equal(cookieToken({ cookie: 'ts_session=' }), '');
  assert.equal(cookieToken({ cookie: 'a=1; ts_session=; b=2' }), '');
});

test('cookieToken：cookie 名比较精确（TS_SESSION 不算），头名 Cookie 大小写不敏感', () => {
  assert.equal(cookieToken({ cookie: 'TS_SESSION=x' }), null);
  assert.equal(cookieToken({ cookie: 'Ts_Session=x' }), null);
  assert.equal(cookieToken({ Cookie: 'ts_session=xyz' }), 'xyz');
  assert.equal(cookieToken({ COOKIE: 'ts_session=xyz' }), 'xyz');
  // 名字两侧的空隙不 trim：先 strip 整段再 partition，名字里带空格就不匹配
  assert.equal(cookieToken({ cookie: ' ts_session = x ' }), null);
  assert.equal(cookieToken({ cookie: '  ts_session=x  ' }), 'x');
});

test('cookieToken：无 Cookie 头 / 无该 cookie / 头值非字符串 ⇒ null', () => {
  assert.equal(cookieToken({}), null);
  assert.equal(cookieToken({ cookie: '' }), null);
  assert.equal(cookieToken({ cookie: 'a=1; b=2' }), null);
  assert.equal(cookieToken({ host: 'x' }), null);
  assert.equal(cookieToken(undefined), null);
  assert.equal(cookieToken(null), null);
});

test('sessionCookie：整串逐字节等于 Python 登录响应（server.py:1511-1513）', () => {
  assert.equal(sessionCookie('t'),
    'ts_session=t; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800');
  assert.equal(sessionCookie('deadbeef'),
    'ts_session=deadbeef; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800');
  // 常量同源：改 SESSION_TTL 必须同步反映到 Max-Age
  assert.ok(sessionCookie('t').endsWith(`Max-Age=${SESSION_TTL}`));
});

test('clearSessionCookie：整串逐字节等于 Python 登出响应（server.py:1525-1526）', () => {
  assert.equal(clearSessionCookie(),
    'ts_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
});

// --------------------------------------------------------------------------
// lib.js:normalizeProjectName
// --------------------------------------------------------------------------

test('normalizeProjectName：去两端空白 + 斜杠换下划线（server.py:815）', () => {
  assert.equal(normalizeProjectName('  a/b\\c  '), 'a_b_c');
  assert.equal(normalizeProjectName('a/b'), 'a_b');
  assert.equal(normalizeProjectName('a\\b'), 'a_b');
  assert.equal(normalizeProjectName('../etc/passwd'), '.._etc_passwd');
  assert.equal(normalizeProjectName('  demo  '), 'demo');
});

test('normalizeProjectName：空值/假值走 (name or "") ⇒ "project"（Python 真值口径）', () => {
  assert.equal(normalizeProjectName(''), 'project');
  assert.equal(normalizeProjectName('   '), 'project');
  assert.equal(normalizeProjectName(null), 'project');
  assert.equal(normalizeProjectName(undefined), 'project');
  assert.equal(normalizeProjectName(0), 'project');        // Python: 0 or "" → ""
  assert.equal(normalizeProjectName(false), 'project');    // Python: False or "" → ""
  assert.equal(normalizeProjectName([]), 'project');       // Python: [] 为假（JS 的 [] 为真）
  assert.equal(normalizeProjectName({}), 'project');       // Python: {} 为假
  assert.equal(normalizeProjectName('///'), '___');        // 非空 ⇒ 规范化后原样返回
});

// --------------------------------------------------------------------------
// lib.js:pathLastSegment
// --------------------------------------------------------------------------

test('pathLastSegment：取最后一段，跨平台分隔符、忽略尾部分隔符（server.py:825）', () => {
  assert.equal(pathLastSegment('/a/b/'), 'b');
  assert.equal(pathLastSegment('a//b///'), 'b');
  assert.equal(pathLastSegment('C:\\x\\y'), 'y');
  assert.equal(pathLastSegment('/a/b'), 'b');
  assert.equal(pathLastSegment('b'), 'b');
});

test('pathLastSegment：纯盘符段被跳过，无有效段返回空串', () => {
  assert.equal(pathLastSegment('D:'), '');
  assert.equal(pathLastSegment('D:\\'), '');
  assert.equal(pathLastSegment('C:\\'), '');
  assert.equal(pathLastSegment('c:/'), '');
  assert.equal(pathLastSegment(''), '');
  assert.equal(pathLastSegment(null), '');
  assert.equal(pathLastSegment(undefined), '');
  assert.equal(pathLastSegment('   '), '');
  // 盘符段只跳「纯 X:」：带子段的照常取最后一段
  assert.equal(pathLastSegment('D:/proj'), 'proj');
});

// --------------------------------------------------------------------------
// lib.js:fsMkdir
// --------------------------------------------------------------------------

test('fsMkdir：成功创建返回 [ {name, path}, null ]，path 是 realpath', (t) => {
  const root = tempDir(t);
  const parent = path.join(root, 'parent');
  fs.mkdirSync(parent);
  const [data, err] = fsMkdir(parent, '新建 目录');
  assert.equal(err, null);
  assert.equal(data.name, '新建 目录');
  assert.equal(data.path, fs.realpathSync(parent) + path.sep + '新建 目录');
  assert.equal(data.path, fs.realpathSync(data.path));
  assert.ok(fs.statSync(data.path).isDirectory());
  // 名称两端空白先 strip 归整（与前端输入框 .trim() 一致）
  const [data2, err2] = fsMkdir(parent, '  spaced  ');
  assert.equal(err2, null);
  assert.equal(data2.name, 'spaced');
  assert.ok(fs.statSync(path.join(parent, 'spaced')).isDirectory());
});

test('fsMkdir：父目录是符号链接时按 realpath 落盘并返回解析后的路径', (t) => {
  const root = tempDir(t);
  const realParent = path.join(root, 'real');
  fs.mkdirSync(realParent);
  const linkParent = path.join(root, 'link');
  fs.symlinkSync(realParent, linkParent);
  const [data, err] = fsMkdir(linkParent, 'sub');
  assert.equal(err, null);
  assert.equal(data.path, path.join(fs.realpathSync(realParent), 'sub'));
  assert.ok(fs.statSync(path.join(realParent, 'sub')).isDirectory());
});

test('fsMkdir：父目录不存在或为空 ⇒ "请先进入一个存在的目录再新建文件夹"', (t) => {
  const root = tempDir(t);
  const cases = ['', '   ', path.join(root, 'nope'), path.join(root, 'file-not-dir')];
  fs.writeFileSync(path.join(root, 'file-not-dir'), 'x');
  for (const raw of cases) {
    const [data, err] = fsMkdir(raw, 'sub');
    assert.equal(data, null, `raw_path=${JSON.stringify(raw)} 不应成功`);
    assert.equal(err, '请先进入一个存在的目录再新建文件夹');
  }
});

test('fsMkdir：空名 / . / .. / 含分隔符 / 带 NUL ⇒ "文件夹名称不能包含路径分隔符，也不能是 . 或 .."', (t) => {
  const parent = tempDir(t);
  for (const name of ['.', '..', 'a/b', 'a\\b', '/abs', '\\abs', 'a\x00b']) {
    const [data, err] = fsMkdir(parent, name);
    assert.equal(data, null, `name=${JSON.stringify(name)} 不应成功`);
    assert.equal(err, '文件夹名称不能包含路径分隔符，也不能是 . 或 ..');
  }
});

test('fsMkdir：空名单独一档 ⇒ "文件夹名称不能为空"', (t) => {
  const parent = tempDir(t);
  for (const name of ['', '   ', '\t\n', null, undefined]) {
    const [data, err] = fsMkdir(parent, name);
    assert.equal(data, null);
    assert.equal(err, '文件夹名称不能为空');
  }
});

test('fsMkdir：结尾点一律拒（strip 后仍可能留点）⇒ "文件夹名称不能以点或空格结尾"', (t) => {
  const parent = tempDir(t);
  for (const name of ['x.', 'x..', 'x .', 'x. ', 'x...']) {
    const [data, err] = fsMkdir(parent, name);
    assert.equal(data, null, `name=${JSON.stringify(name)} 不应成功`);
    assert.equal(err, '文件夹名称不能以点或空格结尾');
  }
  // 结尾空白已被 strip 吃掉的形态是**合法**的（'x ' → 'x'）
  const [data, err] = fsMkdir(parent, 'x ');
  assert.equal(err, null);
  assert.equal(data.name, 'x');
});

test('fsMkdir：同名文件或目录已存在 ⇒ "同名文件或目录已存在"（不覆盖、不复用）', (t) => {
  const parent = tempDir(t);
  fs.writeFileSync(path.join(parent, 'taken-file'), 'x');
  fs.mkdirSync(path.join(parent, 'taken-dir'));
  for (const name of ['taken-file', 'taken-dir']) {
    const [data, err] = fsMkdir(parent, name);
    assert.equal(data, null, `name=${name} 不应成功`);
    assert.equal(err, '同名文件或目录已存在');
  }
  // os.path.lexists 口径：悬空符号链接也算「已存在」（existsSync 会漏）
  fs.symlinkSync(path.join(parent, 'dangling-target'), path.join(parent, 'taken-link'));
  const [data, err] = fsMkdir(parent, 'taken-link');
  assert.equal(data, null);
  assert.equal(err, '同名文件或目录已存在');
  // 首个用例失败不应留下副作用
  assert.equal(fs.readFileSync(path.join(parent, 'taken-file'), 'utf8'), 'x');
  assert.ok(fs.statSync(path.join(parent, 'taken-dir')).isDirectory());
});

test('fsMkdir：os.mkdir 抛 OSError 时回 "新建失败：…"（Node 无 strerror，只断言前缀）', (t) => {
  const parent = tempDir(t);
  // ENAMETOOLONG 在 root 下同样触发（无写权限那条会被 root 旁路，故不用它）
  const [, err] = fsMkdir(parent, 'x'.repeat(300));
  assert.ok(err !== null && err.startsWith('新建失败：'), `实际：${JSON.stringify(err)}`);
  assert.ok(err.length > '新建失败：'.length, '前缀之后应有原因文本');
  // 失败后不留下半成品
  assert.equal(fs.readdirSync(parent).length, 0);
});
