/**
 * backend/lib/auth.js 单测（node --test，零依赖）：把「密码口径是需求约定、不得自创」钉死。
 *
 * 三层证据：
 *   ① 静态向量：用 Python 侧（`python3 -c "import auth; ..."`）生成的 (明文, hash, salt)
 *      三元组**硬编码**在本文件里（下方各常量，生成命令见注释），Node 必须逐条验过；
 *   ② 跨语言双向：真起 `python3` 调 auth.py —— Python 生成的哈希 Node 能验，Node 生成的
 *      哈希 Python 能验（PBKDF2 是确定性编码，固定盐下两侧 hash 串必须逐字符相同）；
 *   ③ 边角语义：非字符串口令/坏盐不抛异常只判 False（对齐 auth.verify_password 的容错）。
 *
 * 为什么真起 Python 进程：口径等价性的唯一证据是「另一侧自己说通过」，用 JS 复算一遍
 * PBKDF2 只能证明 JS 自洽。找不到 python3 时该条 skip（静态向量仍然全覆盖格式口径）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

import {
  PBKDF2_ITER,
  hashPassword,
  md5Password,
  newToken,
  verifyPassword,
} from '../lib/auth.js';

/** 仓库根（<根>/backend/test/auth.test.mjs 上溯两级） */
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
/** Python 后端源码在 backend_py/（2026-10-19 起）——Python 侧要 sys.path 到这里才能 import auth */
const BACKEND_PY = path.join(REPO_ROOT, 'backend_py');

/** Python 解释器（与项目其它 Node 侧自检同口径：TS_PYTHON 可覆盖） */
const PYTHON = process.env.TS_PYTHON || 'python3';

/**
 * Python 生成向量用的固定盐（16 字节 hex）与派生结果。
 * 生成命令（2026-10-11，与 auth.py 逐字同口径）：
 *   python3 -c "import hashlib,auth; print(hashlib.pbkdf2_hmac(
 *       'sha256', pw.encode(), bytes.fromhex(salt), auth.PBKDF2_ITER).hex())"
 */
const PBKDF2_VECTORS = [
  { password: '', salt: '00112233445566778899aabbccddeeff',
    hash: '3b27f61e9e2e794cbdf0e3332d84918cdc530120984fcd5fbbfb37c348249a75' },
  { password: 'secret', salt: '00112233445566778899aabbccddeeff',
    hash: 'f92d0c0b7758f48a976587412c2bf21b7f1dae21875133fda2983fa4cbf1ea9d' },
  { password: 'pass1234', salt: 'ffeeddccbbaa99887766554433221100',
    hash: 'a3064dda3465ff52b3570a80f7f2a2101d538b9e589f6d617edfbafc0920c859' },
  // 非 ASCII：UTF-8 编码（emoji 是 4 字节序列，专门用来抓「按 UTF-16/误编码」的实现）
  { password: '中文口令🔒', salt: '0123456789abcdef0123456789abcdef',
    hash: 'b16e4d623568367efee643b52ef2e633dd2c98f46d59db1d5a6e8fdc55508c11' },
  { password: 'a'.repeat(200), salt: 'deadbeefdeadbeefdeadbeefdeadbeef',
    hash: '1451b01bfd2200dabd80ad610b29b903e4beb8eabdf85a2c5645e2202782aafa' },
];

/** MD5 向量（`hashlib.md5(s.encode()).hexdigest()`），含空串标准值 */
const MD5_VECTORS = [
  { password: '', hash: 'd41d8cd98f00b204e9800998ecf8427e' },
  { password: '123456', hash: 'e10adc3949ba59abbe56e057f20f883e' },
  { password: 'pass1234', hash: 'b4af804009cb036a4ccdc33431ef9ac9' },
  { password: '中文口令🔒', hash: 'bf7c37c02d3376f26cfad532cc62f4d1' },
];

/** Python 侧 helper：按 mode 调 auth.py，结果以 JSON 打到 stdout（argv 传参，不经 shell） */
const PY_HELPER = [
  'import json, sys',
  'sys.path.insert(0, sys.argv[1])',
  'import auth',
  'mode, payload = sys.argv[2], json.loads(sys.argv[3])',
  "if mode == 'verify':",
  "    out = auth.verify_password(payload['password'], payload['hash'], payload['salt'])",
  "elif mode == 'hash':",
  '    h, s = auth.hash_password(payload["password"])',
  '    out = {"hash": h, "salt": s}',
  "elif mode == 'md5':",
  '    out = auth.md5_password(payload["password"])[0]',
  "elif mode == 'pbkdf2':",
  '    import hashlib',
  "    out = hashlib.pbkdf2_hmac('sha256', payload['password'].encode('utf-8'),",
  "                              bytes.fromhex(payload['salt']), auth.PBKDF2_ITER).hex()",
  'else:',
  "    raise SystemExit('bad mode: ' + mode)",
  'print(json.dumps(out))',
].join('\n');

/** python3 是否可用（不可用则跨语言那条 skip，不用环境问题把整套测试打红） */
function detectPython() {
  try {
    const probe = spawnSync(PYTHON, ['-c', 'pass'], { encoding: 'utf8' });
    return probe.status === 0;
  } catch {
    return false;
  }
}

const PYTHON_READY = detectPython();
const PYTHON_SKIP = PYTHON_READY ? false : `未找到可用的 Python 解释器: ${PYTHON}（TS_PYTHON 可指定）`;

/**
 * 调一次 Python helper。
 * @param {'verify'|'hash'|'md5'} mode
 * @param {object} payload
 * @returns {any}
 */
function runPython(mode, payload) {
  const result = spawnSync(
    PYTHON, ['-c', PY_HELPER, BACKEND_PY, mode, JSON.stringify(payload)], { encoding: 'utf8' });
  assert.equal(result.status, 0, `python 调用失败(status=${result.status}): ${result.stderr}`);
  return JSON.parse(result.stdout);
}

// ---------- MD5（新写入密码的唯一格式） ----------

test('md5Password：32 位小写 hex，逐条命中 Python/hashlib 向量', () => {
  for (const vector of MD5_VECTORS) {
    assert.equal(md5Password(vector.password), vector.hash,
      `MD5 向量不符: ${JSON.stringify(vector.password)}`);
  }
  assert.equal(md5Password('').length, 32);
  assert.match(md5Password('x'), /^[0-9a-f]{32}$/);
});

test('md5Password：非字符串显式抛错（绝不把 null 静默哈希成 "null"）', () => {
  assert.throws(() => md5Password(null), TypeError);
  assert.throws(() => md5Password(123), TypeError);
  assert.throws(() => md5Password(undefined), TypeError);
});

// ---------- PBKDF2（存量/种子账号格式） ----------

test('hashPassword：{hash, salt} 形状；盐 16 字节(32 hex)、哈希 32 字节(64 hex)、盐随机', () => {
  const first = hashPassword('secret');
  const second = hashPassword('secret');
  assert.deepEqual(Object.keys(first).sort(), ['hash', 'salt']);
  assert.match(first.salt, /^[0-9a-f]{32}$/);
  assert.match(first.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(first.salt, second.salt, '同口令两次必须不同盐（随机盐）');
  assert.notEqual(first.hash, second.hash, '盐不同则哈希必须不同');
  assert.equal(PBKDF2_ITER, 100000);
  assert.throws(() => hashPassword(null), TypeError);
});

test('verifyPassword：PBKDF2 向量（Python 生成）逐条通过，错口令/错盐不过', () => {
  for (const vector of PBKDF2_VECTORS) {
    assert.equal(verifyPassword(vector.password, vector.hash, vector.salt), true,
      `PBKDF2 向量应通过: ${JSON.stringify(vector.password)}`);
    assert.equal(verifyPassword(vector.password + 'x', vector.hash, vector.salt), false);
  }
  const generated = hashPassword('pass1234');
  assert.equal(verifyPassword('pass1234', generated.hash, generated.salt), true);
  assert.equal(verifyPassword('pass1235', generated.hash, generated.salt), false);
});

test('verifyPassword：MD5/PBKDF2 双格式按哈希长度分派', () => {
  for (const vector of MD5_VECTORS) {
    assert.equal(verifyPassword(vector.password, vector.hash, ''), true);
    assert.equal(verifyPassword(vector.password, vector.hash, 'ignored-salt'), true,
      '32 位哈希一律走 MD5 分支，盐参数不参与');
  }
  const pbkdf2 = hashPassword('pass1234');
  assert.equal(verifyPassword('pass1234', pbkdf2.hash, pbkdf2.salt), true);
});

test('verifyPassword：非字符串/坏盐一律 False 不抛异常（对齐 auth.verify_password）', () => {
  const md5 = md5Password('pass1234');
  const pbkdf2 = hashPassword('pass1234');
  for (const password of [null, undefined, 12345678, {}, []]) {
    assert.equal(verifyPassword(password, md5, ''), false);
    assert.equal(verifyPassword(password, pbkdf2.hash, pbkdf2.salt), false);
  }
  assert.equal(verifyPassword('pass1234', null, ''), false);
  assert.equal(verifyPassword('pass1234', pbkdf2.hash, null), false, '缺盐 → 不匹配（Python 是 TypeError 被吞）');
  assert.equal(verifyPassword('pass1234', pbkdf2.hash, '不是hex'), false);
  assert.equal(verifyPassword('pass1234', pbkdf2.hash, ''), false, '空盐 ≠ 生成时的盐');
  assert.equal(verifyPassword('pass1234', '', ''), false);
});

// ---------- 会话 token ----------

test('newToken：64 位小写 hex（= secrets.token_hex(32)），两次不重复', () => {
  const first = newToken();
  const second = newToken();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);
});

// ---------- 跨语言双向 ----------

test('跨语言：Python 生成的哈希 Node 能验，Node 生成的哈希 Python 能验', { skip: PYTHON_SKIP }, () => {
  const password = '跨语言口令🔒 mixed-ASCII';

  // ① Python 生成 PBKDF2 → Node verify
  const pyHash = runPython('hash', { password });
  assert.match(pyHash.salt, /^[0-9a-f]{32}$/);
  assert.match(pyHash.hash, /^[0-9a-f]{64}$/);
  assert.equal(verifyPassword(password, pyHash.hash, pyHash.salt), true,
    'Node 未通过 Python 生成的 PBKDF2 哈希');
  assert.equal(verifyPassword(password + '!', pyHash.hash, pyHash.salt), false);

  // ② Node 生成 PBKDF2 → Python verify
  const nodeHash = hashPassword(password);
  assert.equal(runPython('verify', { password, hash: nodeHash.hash, salt: nodeHash.salt }), true,
    'Python 未通过 Node 生成的 PBKDF2 哈希');

  // ③ Node 的 MD5 与 Python 的 md5_password 逐字符相同 → Python verify 也认 Node 的 MD5
  const pyMd5 = runPython('md5', { password });
  assert.equal(md5Password(password), pyMd5, 'MD5 串两侧不一致');
  assert.equal(runPython('verify', { password, hash: md5Password(password), salt: '' }), true);

  // ④ 固定盐下**逐字符相等**：把固定盐/Node 生成的盐交给 Python 重算，PBKDF2 是确定性编码，
  //    两侧派生串必须一模一样（比「能验过」更强：能验过也可能因为双方同错而巧合）
  for (const vector of PBKDF2_VECTORS) {
    const pyDerived = runPython('pbkdf2', { password: vector.password, salt: vector.salt });
    assert.equal(pyDerived, vector.hash, 'Python 重算与硬编码向量必须一致（基准自证）');
    assert.equal(verifyPassword(vector.password, pyDerived, vector.salt), true);
  }
  const pySameSalt = runPython('pbkdf2', { password, salt: nodeHash.salt });
  assert.equal(pySameSalt, nodeHash.hash, '固定盐下 Node/Python 的 PBKDF2 派生串不相等');
});
