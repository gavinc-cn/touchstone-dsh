/**
 * backend/lib/args.js 的契约测试（node --test，零依赖）。
 *
 * 为什么这些断言值是这样：Node 后端的命令行契约要与 Python 侧 `server.py` 的 argparse
 * **逐项等价**（薄壳按同一份 argv 拉起两者，见方案 §3.2），默认值直接对齐
 * `server.py:_build_arg_parser()`：--host 127.0.0.1 / --port 4601 / --web-dir 缺省
 * `<仓库根>/webui/dist`（可被 TS_WEB_DIR 覆盖）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseBackendArgs, resolveWebDir } from '../lib/args.js';

test('解析薄壳下发的完整契约 argv', () => {
  const a = parseBackendArgs([
    '--host', '127.0.0.1',
    '--port', '0',
    '--web-dir', '/repo/webui/dist-plugin',
    '--trust-internal-user',
    '--parent-watch',
  ]);
  assert.deepEqual(a, {
    host: '127.0.0.1',
    port: 0,
    webDir: '/repo/webui/dist-plugin',
    trustInternalUser: true,
    parentWatch: true,
    allowSharedDb: false,          // 薄壳不下发该开关（逃生口由人显式加），缺省 false
  });
});

test('缺省值与 Python argparse 一致（host/port/webDir/两个开关）', () => {
  const a = parseBackendArgs([]);
  assert.deepEqual(a, {
    host: '127.0.0.1',
    port: 4601,
    webDir: null,
    trustInternalUser: false,
    parentWatch: false,
    allowSharedDb: false,
  });
});

test('--allow-shared-db：布尔开关（缺省 false，出现即 true，与 Python store_true 同义）', () => {
  // M1：单实例锁已实现（lib/lock.js），该选项不再是「语义未实现的开关」
  assert.equal(parseBackendArgs([]).allowSharedDb, false);
  assert.equal(parseBackendArgs(['--allow-shared-db']).allowSharedDb, true);
  const a = parseBackendArgs(['--allow-shared-db', '--parent-watch', '--port', '0']);
  assert.equal(a.allowSharedDb, true);
  assert.equal(a.parentWatch, true);
  assert.equal(a.port, 0);
  // 重复出现仍是 true（与 argparse store_true 同义），不是计数
  assert.equal(parseBackendArgs(['--allow-shared-db', '--allow-shared-db']).allowSharedDb, true);
});

test('--port 0 不能被当成缺省值（0 = 随机端口，薄壳恒传）', () => {
  assert.equal(parseBackendArgs(['--port', '0']).port, 0);
});

test('webDir 缺省 = <仓库根>/webui/dist；TS_WEB_DIR 可覆盖；显式 --web-dir 最优先', () => {
  const root = '/repo';
  assert.equal(resolveWebDir(parseBackendArgs([]), { env: {}, repoRoot: root }),
    '/repo/webui/dist');
  assert.equal(resolveWebDir(parseBackendArgs([]), { env: { TS_WEB_DIR: '/from/env' }, repoRoot: root }),
    '/from/env');
  assert.equal(
    resolveWebDir(parseBackendArgs(['--web-dir', '/explicit']), { env: { TS_WEB_DIR: '/from/env' }, repoRoot: root }),
    '/explicit');
});

test('非法输入一律抛错（不做静默兜底）', () => {
  assert.throws(() => parseBackendArgs(['--port', 'abc']), /端口/);
  assert.throws(() => parseBackendArgs(['--nope']), /未知|nope/);
  assert.throws(() => parseBackendArgs(['--web-dir']), /web-dir|参数/);
});
