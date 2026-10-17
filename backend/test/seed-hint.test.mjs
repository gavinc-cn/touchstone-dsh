/**
 * 启动横幅的默认账号提示（`lib/seed_hint.js` ← `server.py:5457 _seed_hint`）。
 *
 * 为什么给一句文案单测：横幅是首装的**唯一口令出口**（随机档）与**唯一状态说明**
 * （空口令档），而它只在 `main()` 里被拼一次——不抽成纯函数就只能真起进程才验得到。
 * 本文件钉三件事：
 *   ① 三档的分支判据（`seeded` / `seedPassword` / `TS_ADMIN_PASSWORD`）与优先级；
 *   ② **绝不回显口令明文**（随机档与 env 档都验）；
 *   ③ 空口令档不得冒充另两档的话术——2026-10-16 修的缺陷正是它当时说
 *      「初始口令取自 TS_ADMIN_PASSWORD」，而那个变量根本没设。
 *
 * 期望值来源：`server.py:5457-5472`（同一句文案的 Python 侧原文，逐字节相同），
 * 不是读实现反推。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { seedHint } from '../lib/seed_hint.js';

test('seedHint：非本次种子（seeded=false）恒为空串', () => {
  assert.equal(seedHint(), '');
  assert.equal(seedHint({ seeded: false }), '');
  // 已有库（seeded=false）即便手里有一串口令也不该打印（Python 同：`if not seeded: return ""`）
  assert.equal(seedHint({ seeded: false, seedPassword: 'pw-should-not-print' }), '');
});

test('seedHint：随机一次性口令档打印口令本体 + 首登须改密', () => {
  const hint = seedHint({ seeded: true, seedPassword: 'one-time-pw-9' });
  assert.ok(hint.includes('一次性初始口令：one-time-pw-9'), hint);
  assert.ok(hint.includes('首次登录须修改'), hint);
  assert.ok(hint.startsWith('  （') && hint.endsWith('）'), `括号包夹形态: ${hint}`);
});

test('seedHint：随机档优先于 TS_ADMIN_PASSWORD（种子的优先级就是它）', () => {
  const hint = seedHint({
    seeded: true, seedPassword: 'one-time-pw-9', env: { TS_ADMIN_PASSWORD: 'env-secret-9' },
  });
  assert.ok(hint.includes('一次性初始口令：one-time-pw-9'), hint);
  assert.ok(!hint.includes('env-secret-9'), '不得回显环境变量里的口令');
});

test('seedHint：TS_ADMIN_PASSWORD 档只指变量名、不回显口令值', () => {
  const hint = seedHint({ seeded: true, env: { TS_ADMIN_PASSWORD: 'env-secret-9' } });
  assert.ok(hint.includes('初始口令取自 TS_ADMIN_PASSWORD'), hint);
  for (const token of ['env-secret-9', '123456', '一次性初始口令']) {
    assert.ok(!hint.includes(token), `不得出现 ${token}：${hint}`);
  }
});

test('seedHint：空口令档（TS_ADMIN_PASSWORDLESS=1）说「空口令」，不冒充另两档', () => {
  const hint = seedHint({ seeded: true, env: { TS_ADMIN_PASSWORDLESS: '1' } });
  assert.ok(hint.includes('空口令（插件形态免登）'), hint);
  assert.ok(hint.includes('设置页设置密码'), '要告诉用户去哪设密码');
  // 2026-10-16 修的缺陷：这一档当时落进 env 档文案 / Python 落进「已在上一次打印」文案
  for (const wrong of ['初始口令取自', '一次性初始口令', '上一次启动时打印']) {
    assert.ok(!hint.includes(wrong), `空口令档不得出现「${wrong}」：${hint}`);
  }
  assert.ok(hint.startsWith('  （') && hint.endsWith('）'), `括号包夹形态: ${hint}`);
});

test('seedHint：env 档优先于空口令档（seedAdmin 的三档顺序照抄）', () => {
  const hint = seedHint({
    seeded: true, env: { TS_ADMIN_PASSWORD: 'env-secret-9', TS_ADMIN_PASSWORDLESS: '1' },
  });
  assert.ok(hint.includes('初始口令取自 TS_ADMIN_PASSWORD'), hint);
  assert.ok(!hint.includes('空口令'), hint);
});

test('seedHint：空口令档文案与 Python `_seed_hint` 逐字节相同（跨语言契约定点）', () => {
  // 两侧各自改字最容易漏的就是这一档（Python 单测见 tests/test_seed_admin.py:105）。
  const expected = '  （首次启动已创建默认账号 admin，空口令（插件形态免登）'
    + '；如需口令登录请在设置页设置密码）';
  assert.equal(seedHint({ seeded: true, env: { TS_ADMIN_PASSWORDLESS: '1' } }), expected);
});
