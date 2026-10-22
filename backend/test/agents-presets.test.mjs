/**
 * `GET /api/agents/presets` 单测（2026-10-21 权限档对齐 DSH 宿主目录，契约 §5.2 / §7.1）。
 *
 * 数据源＝插件驱动 `GET /presets`（session_id 传空串取目录）。本文件用**真 HTTP 假驱动**
 * （形状抄 `m6-endpoints.test.mjs` 的模型目录用例：注入 `TS_AGENT_DRIVER_URL`，走真
 * `makeContext` + `dispatch`），断言的是端点字节与目录归一规则，不是自造桩期望。
 *
 * 三条本批特有的判据：
 *   ① 驱动未配置 ⇒ 200 `{available:false, …}`，**失败不入 60s 缓存**（随后配置好驱动能立刻成功）；
 *   ② 目录归一：内置三档用中文产品名、自定义档用宿主 name/description、`default_label` 由同值选项
 *      反查（找不到 ⇒ 空串）；
 *   ③ 「已知档位值集合」= 最近一次**成功**目录的 value 集；从未成功 ⇒ 回退内置三档。
 *
 * 模块级缓存（60s）是进程内状态，用例间用 `_resetPermissionCatalogCacheForTest()` 清干净。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { _resetPermissionCatalogCacheForTest, permissionCatalogValues }
  from '../lib/servercaps.js';
import { dispatch, makeContext } from '../routes/index.js';
import { freshDb } from './m3fixture.mjs';

// --------------------------------------------------------------------------
// 测试台
// --------------------------------------------------------------------------

function fakeRes() {
  const cap = { status: null, headers: null, body: null };
  return {
    cap,
    res: {
      writeHead(status, headers) { cap.status = status; cap.headers = headers; },
      end(buf) { cap.body = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''), 'utf8'); },
    },
  };
}

function fakeReq(method) {
  return { method, headers: {} };
}

/** 真分派一次（登录用户 = 夹具里的 admin） */
async function call(env, method, target) {
  const { res, cap } = fakeRes();
  const ctx = makeContext({
    req: fakeReq(method),
    res,
    db: env.db,
    user: env.adminRow,
    path: target.split('?')[0],
    search: target.includes('?') ? target.slice(target.indexOf('?') + 1) : '',
  });
  const hit = await dispatch(ctx);
  return {
    hit,
    ...cap,
    text: () => (cap.body === null ? null : cap.body.toString('utf8')),
    json: () => (cap.body === null ? null : JSON.parse(cap.body.toString('utf8'))),
  };
}

function setup(tag) {
  const fx = freshDb(`agents-presets-${tag}`);
  const adminRow = fx.db.prepare('SELECT * FROM users WHERE id=1').get();
  return { ...fx, adminRow };
}

/** 宿主 web profile 的实测目录（契约 §2 原文） */
const REAL_CATALOG = {
  current: 'danger-full-access',
  options: [
    { value: 'read-only', name: 'read-only' },
    { value: 'workspace-write', name: 'workspace-write' },
    { value: 'danger-full-access', name: 'danger-full-access' },
    { value: 'path-rules', name: '路径规则',
      description: '项目内可读写；项目外读允许、写需审批；白名单直通；黑名单一律审批。' },
    { value: 'write-guard', name: '完全权限（拦截）',
      description: '完全权限底座；项目内/白名单写入直通；越界写入弹框确认并自动学习白名单；复杂命令由 AI 判定。' },
    { value: 'auto', name: 'auto' },
  ],
  default: 'danger-full-access',
};

/** 假 dsh 驱动（只实现 `/presets`；`presetsPayload` 可在用例里改） */
class FakeDriver {
  constructor() {
    this.calls = [];
    this.presetsPayload = REAL_CATALOG;
    this.presetsFail = false;
    this.server = http.createServer((req, res) => {
      const full = req.url.split('?')[0];
      const p = full.startsWith('/touchstone-agent')
        ? full.slice('/touchstone-agent'.length) : full;
      this.calls.push({ path: p, rawUrl: req.url });
      const json = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };
      if (p === '/presets') {
        if (this.presetsFail) return json(503, { error: '权限目录服务不可用' });
        return json(200, this.presetsPayload);
      }
      return json(404, { error: `fake driver: no route ${p}` });
    });
  }

  async start() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${this.server.address().port}/touchstone-agent`;
    return this;
  }

  byPath(p) { return this.calls.filter((c) => c.path === p); }

  async close() {
    await new Promise((resolve) => this.server.close(resolve));
  }
}

/** 起假驱动并注入 env（dshdriver 每次调用现读 env） */
async function withDriver(fn) {
  const drv = await new FakeDriver().start();
  const savedUrl = process.env.TS_AGENT_DRIVER_URL;
  const savedToken = process.env.TS_AGENT_DRIVER_TOKEN;
  process.env.TS_AGENT_DRIVER_URL = drv.base;
  delete process.env.TS_AGENT_DRIVER_TOKEN;
  try {
    return await fn(drv);
  } finally {
    if (savedUrl === undefined) delete process.env.TS_AGENT_DRIVER_URL;
    else process.env.TS_AGENT_DRIVER_URL = savedUrl;
    if (savedToken !== undefined) process.env.TS_AGENT_DRIVER_TOKEN = savedToken;
    await drv.close();
  }
}

/** 未配置驱动（清 env） */
async function withoutDriver(fn) {
  const savedUrl = process.env.TS_AGENT_DRIVER_URL;
  delete process.env.TS_AGENT_DRIVER_URL;
  try {
    return await fn();
  } finally {
    if (savedUrl !== undefined) process.env.TS_AGENT_DRIVER_URL = savedUrl;
  }
}

/** 内置三档兜底集合（与契约 §5.2 逐字） */
const BUILTIN_VALUES = ['read-only', 'workspace-write', 'danger-full-access'];

// --------------------------------------------------------------------------
// ① 驱动不可用：available:false + 不缓存失败 + 档位集合回退内置三档
// --------------------------------------------------------------------------

test('GET /agents/presets：驱动未配置 ⇒ available:false（空目录，不缓存失败）', async () => {
  _resetPermissionCatalogCacheForTest();
  const s = setup('unconfigured');
  try {
    await withoutDriver(async () => {
      const r = await call(s, 'GET', '/api/agents/presets');
      assert.equal(r.status, 200);
      assert.equal(r.hit, true);
      assert.deepEqual(r.json(), { available: false, options: [], default: '', default_label: '' });
      // 从未成功过 ⇒ 「已知档位集合」回退三个 DSH 内置产品档
      assert.deepEqual([...permissionCatalogValues()].sort(), [...BUILTIN_VALUES].sort());
      // 失败不入缓存：同一进程内配好驱动后立刻能取到目录（若失败被缓存会继续 available:false）
      await withDriver(async (drv) => {
        const ok = await call(s, 'GET', '/api/agents/presets');
        assert.equal(ok.json().available, true);
        assert.equal(drv.byPath('/presets').length, 1);
      });
    });
  } finally {
    _resetPermissionCatalogCacheForTest();
    s.close();
  }
});

// --------------------------------------------------------------------------
// ② 正常目录：标签映射 / 描述优先级 / default_label
// --------------------------------------------------------------------------

test('GET /agents/presets：真宿主目录归一（内置中文名、自定义 name/desc、default_label）', async () => {
  _resetPermissionCatalogCacheForTest();
  const s = setup('catalog');
  try {
    await withDriver(async (drv) => {
      const r = await call(s, 'GET', '/api/agents/presets');
      assert.equal(r.status, 200);
      const j = r.json();
      assert.equal(j.available, true);
      assert.equal(j.default, 'danger-full-access');
      assert.equal(j.default_label, '完全权限');
      assert.deepEqual(j.options, [
        { value: 'read-only', label: '仅可查看',
          description: '只读运行；所有修改动作都需要审批。' },
        { value: 'workspace-write', label: '工作区内修改',
          description: '可修改工作区与允许的临时目录；更宽的操作需要审批。' },
        { value: 'danger-full-access', label: '完全权限',
          description: '不受沙箱限制，也不再弹审批。' },
        { value: 'path-rules', label: '路径规则',
          description: '项目内可读写；项目外读允许、写需审批；白名单直通；黑名单一律审批。' },
        { value: 'write-guard', label: '完全权限（拦截）',
          description: '完全权限底座；项目内/白名单写入直通；越界写入弹框确认并自动学习白名单；复杂命令由 AI 判定。' },
        { value: 'auto', label: '自动审查（实验）',
          description: '无沙箱运行；每次原生工具调用和 PTC 内层调用前由同一模型进行实验性审查。' },
      ]);
      // 取目录必须**不带 session_id**（空 sid 不查会话池）
      assert.equal(drv.byPath('/presets').length, 1);
      assert.equal(drv.calls[0].rawUrl, '/touchstone-agent/presets');
      // 「已知档位集合」更新为宿主目录全集（不随 TTL 过期清空）
      assert.deepEqual([...permissionCatalogValues()].sort(), j.options.map((o) => o.value).sort());
    });
  } finally {
    _resetPermissionCatalogCacheForTest();
    s.close();
  }
});

// --------------------------------------------------------------------------
// ③ 60s 缓存：成功才缓存（键固定，payload 变了仍回旧值）
// --------------------------------------------------------------------------

test('GET /agents/presets：成功后 60s 缓存（同进程重复请求不再打驱动）', async () => {
  _resetPermissionCatalogCacheForTest();
  const s = setup('cache');
  try {
    await withDriver(async (drv) => {
      const first = await call(s, 'GET', '/api/agents/presets');
      assert.equal(first.json().default_label, '完全权限');
      // 换目录 + 再打一次 ⇒ 仍旧值（缓存命中），驱动调用数不增
      drv.presetsPayload = {
        options: [{ value: 'read-only', name: 'read-only' }],
        default: 'read-only',
      };
      const second = await call(s, 'GET', '/api/agents/presets');
      assert.deepEqual(second.json(), first.json());
      assert.equal(drv.byPath('/presets').length, 1, '60s 内不得再打驱动');
      // 清缓存（测试缝）后拿到新目录，并覆盖「已知档位集合」
      _resetPermissionCatalogCacheForTest();
      const third = await call(s, 'GET', '/api/agents/presets');
      assert.equal(third.json().default, 'read-only');
      assert.equal(third.json().default_label, '仅可查看');
      assert.equal(drv.byPath('/presets').length, 2);
      assert.deepEqual([...permissionCatalogValues()], ['read-only']);
    });
  } finally {
    _resetPermissionCatalogCacheForTest();
    s.close();
  }
});

// --------------------------------------------------------------------------
// ④ 目录细节：default 反查不到 ⇒ default_label 空串；空 value 过滤；kebab Title-Case
// --------------------------------------------------------------------------

test('GET /agents/presets：default 不在选项里 ⇒ default_label 空串；空 value 过滤；kebab Title-Case', async () => {
  _resetPermissionCatalogCacheForTest();
  const s = setup('detail');
  try {
    await withDriver(async (drv) => {
      drv.presetsPayload = {
        options: [
          { value: '', name: '空档' },                        // 空 value 过滤
          { value: 'some-preset', name: 'some-preset' },      // kebab ⇒ Title-Case
          { value: 'path-rules', name: '路径规则', description: '宿主描述' },
        ],
        default: 'ghost',
      };
      const j = (await call(s, 'GET', '/api/agents/presets')).json();
      assert.equal(j.available, true);
      assert.deepEqual(j.options, [
        { value: 'some-preset', label: 'Some Preset', description: '' },
        { value: 'path-rules', label: '路径规则', description: '宿主描述' },
      ]);
      assert.equal(j.default, 'ghost');
      assert.equal(j.default_label, '', 'default 没有同值选项 ⇒ 空串（前端回落「默认（宿主默认）」）');
      assert.deepEqual([...permissionCatalogValues()].sort(), ['path-rules', 'some-preset']);
    });
  } finally {
    _resetPermissionCatalogCacheForTest();
    s.close();
  }
});

// --------------------------------------------------------------------------
// ⑤ 驱动报错（DshDriverError）⇒ available:false，非 DshDriverError 照抛
// --------------------------------------------------------------------------

test('GET /agents/presets：驱动 5xx ⇒ available:false（不缓存失败）', async () => {
  _resetPermissionCatalogCacheForTest();
  const s = setup('driver-fail');
  try {
    await withDriver(async (drv) => {
      drv.presetsFail = true;
      const r = await call(s, 'GET', '/api/agents/presets');
      assert.equal(r.status, 200);
      assert.deepEqual(r.json(), { available: false, options: [], default: '', default_label: '' });
      // 不缓存失败 ⇒ 驱动恢复后立刻成功
      drv.presetsFail = false;
      const ok = await call(s, 'GET', '/api/agents/presets');
      assert.equal(ok.json().available, true);
      assert.equal(drv.byPath('/presets').length, 2);
    });
  } finally {
    _resetPermissionCatalogCacheForTest();
    s.close();
  }
});
