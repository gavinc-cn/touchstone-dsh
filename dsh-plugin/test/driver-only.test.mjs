/**
 * 插件驱动-only 模式契约测试（2026-11-26）。
 *
 * 用桩 cordis ctx/webServer 真调 apply：断言只注册 /touchstone-agent、不 spawn 后端、
 * driver.json/token 0600、令牌跨 apply 稳定、/mode 免令牌、dispose 清理。
 * 不需要真 dsh；AgentDriver 的 agents 注入在本桩里不回调（不依赖宿主 agent 服务）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { apply } from '../lib/index.js';

function makeStub() {
  const routes = new Map();
  const logs = [];
  const webServer = {
    port: 3099,
    register({ path, handler }) {
      routes.set(path, handler);
      return () => routes.delete(path);
    },
  };
  const logger = {
    info: (m) => logs.push('I ' + m),
    warn: (m) => logs.push('W ' + m),
    error: (m) => logs.push('E ' + m),
  };
  const ctx = {
    get: (name) => (name === 'webServer' ? webServer : null),
    logger: () => logger,
    effect: () => {},
    inject: () => () => {},
  };
  return { ctx, routes, logs };
}

function jsonCall(handler, req) {
  return new Promise((resolve) => {
    const cap = { status: 0, body: '' };
    const res = {
      writeHead(status) { cap.status = status; },
      end(body) { cap.body = String(body || ''); resolve(cap); },
    };
    handler(req, res);
  });
}

test('driverOnly：只注册驱动、写 0600 端点、令牌稳定、dispose 清理、普通形态不变', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ts-driver-only-'));
  const file = join(dir, 'driver.json');
  const prev = process.env.TS_AGENT_DRIVER_FILE;
  process.env.TS_AGENT_DRIVER_FILE = file;
  const { ctx, routes, logs } = makeStub();
  let dispose = null;
  try {
    dispose = await apply(ctx, { driverOnly: true, repoDir: process.cwd() });
    await new Promise((r) => setTimeout(r, 100));

    assert.deepEqual([...routes.keys()], ['/touchstone-agent'], 'driverOnly 不得注册 /touchstone');
    assert.equal(logs.some((l) => l.includes('启动后端')), false, 'driverOnly 不得 spawn 后端');
    const row = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(row.url, 'http://127.0.0.1:3099/touchstone-agent');
    assert.equal(row.port, 3099);
    assert.ok(row.token);
    if (process.platform !== 'win32') {
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(join(dir, 'driver.token')).mode & 0o777, 0o600);
    }
    const token = row.token;

    // /mode 免令牌（只回布尔）；其他端点无令牌仍 403
    const handler = routes.get('/touchstone-agent');
    const mode = await jsonCall(handler, {
      method: 'GET', url: '/touchstone-agent/mode', headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    });
    assert.equal(mode.status, 200);
    assert.deepEqual(JSON.parse(mode.body), { driverOnly: true });
    const noToken = await jsonCall(handler, {
      method: 'GET', url: '/touchstone-agent/health', headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    });
    assert.equal(noToken.status, 403);

    await dispose();
    dispose = null;
    assert.equal(routes.has('/touchstone-agent'), false, 'dispose 后路由注销');
    assert.equal(statSync(file, { throwIfNoEntry: false }), undefined, 'dispose 后端点文件删除');

    // 再 apply 一次：令牌文件保留 ⇒ 令牌稳定
    const second = makeStub();
    const d2 = await apply(second.ctx, { driverOnly: true, repoDir: process.cwd() });
    const row2 = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(row2.token, token, '令牌跨 apply 稳定');
    await d2();
    assert.deepEqual([...second.routes.keys()], [], '第二次 dispose 后无残留');
  } finally {
    if (dispose) await dispose();
    if (prev === undefined) delete process.env.TS_AGENT_DRIVER_FILE;
    else process.env.TS_AGENT_DRIVER_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('普通形态：未写 driverOnly 时仍注册双前缀并尝试 spawn（不写端点文件）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ts-driver-normal-'));
  const file = join(dir, 'driver.json');
  const prev = process.env.TS_AGENT_DRIVER_FILE;
  process.env.TS_AGENT_DRIVER_FILE = file;
  const { ctx, routes } = makeStub();
  let dispose = null;
  try {
    dispose = await apply(ctx, { repoDir: '/nonexistent-touchstone-repo' });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(routes.has('/touchstone-agent'), '普通形态注册驱动');
    assert.ok(routes.has('/touchstone'), '普通形态注册反代');
    assert.equal(statSync(file, { throwIfNoEntry: false }), undefined, '普通形态不写端点文件');
  } finally {
    if (dispose) await dispose();
    if (prev === undefined) delete process.env.TS_AGENT_DRIVER_FILE;
    else process.env.TS_AGENT_DRIVER_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
