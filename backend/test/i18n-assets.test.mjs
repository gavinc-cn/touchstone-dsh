/**
 * Task 3（KB-02）：内置资产残余中文路径（manifest 500 / 200 reason / `{targets}`）
 * Node 侧；与 `tests/test_i18n_builtin_assets.py` 逐条镜像。
 *
 * 覆盖：
 *   ① manifest 500：只翻外层 `资产清单非法（{name}）：{why}`；`{why}` 保持中文
 *      （Ruling R-A4，开发者诊断边界），zh 逐字节为旧串；
 *   ② 200 列表 `assets[].reason`：lang 从 `listAssets` → `assetJson` → `assetStatus`
 *      → `_unsupported_reason` 下沉，三键复用；
 *   ③ `{targets}` 标签：新增 `用户级`/`项目级` 两键，en 分隔符 `, `、zh `、`；
 *   ④ install/uninstall：lang 透传到 `unsupportedError` 与结果里的 `asset`（reason
 *      结构上恒空串；非空 reason 的 en 渲染由 lib 层覆盖）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import * as ba from '../lib/builtin-assets.js';
import { t as i18nT } from '../lib/i18n.js';
import { dispatch, makeContext } from '../routes/index.js';
import { freshDb, insertProject } from './m3fixture.mjs';

const USER_ONLY = {
  id: 'user-only-skill', name: '仅用户级技能', type: 'skill', family: 'dsh_plugin',
  description: '', targets: ['user'], plugin: null, files: [], dir: '/tmp/x',
};
const BOTH = {
  id: 'demo-skill', name: '演示技能', type: 'skill', family: 'dsh_plugin',
  description: '', targets: ['user', 'project'], plugin: null, files: [], dir: '/tmp/x',
};
const PLUGIN = {
  id: 'demo-plugin', name: '演示插件', type: 'dsh_plugin', family: 'dsh_plugin',
  description: '',
  // dsh_plugin 的合法清单只允许 ['user']；这里按 parity 用例的合成形态声明双目标，
  // 专门覆盖 `_unsupported_error` 的 dsh_plugin 分支
  targets: ['user', 'project'],
  plugin: { package: '@scope/demo-plugin', entry_id: 'demo-plugin', profile: 'web',
    config: {}, requires: [] },
  files: [], dir: '/tmp/x',
};

const REASON_EN = 'This asset can only be installed at the user-level tier';
const REASON_EN_BOTH = 'This asset can only be installed at the '
  + 'user-level, project-level tier';
const SKILL_MD = '---\nname: demo-skill\ndescription: 隔离测试用\n---\n\n演示内容\n';

// --------------------------------------------------------------------------
// 路由测试台
// --------------------------------------------------------------------------

function fakeRes() {
  const cap = { status: null, headers: null, body: null, destroyed: false };
  return {
    cap,
    res: {
      writeHead(status, headers) { cap.status = status; cap.headers = headers; },
      end(buf) { cap.body = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''), 'utf8'); },
      destroy() { cap.destroyed = true; },
    },
  };
}

function fakeReq(method, body, headers = {}) {
  const text = body === undefined ? '' : Buffer.from(JSON.stringify(body), 'utf8');
  const stream = Readable.from(text.length ? [text] : [], { objectMode: false });
  stream.headers = text.length
    ? { 'content-length': String(text.length), ...headers }
    : { ...headers };
  stream.method = method;
  return stream;
}

function setup(tag) {
  const fx = freshDb(`i18n-assets-${tag}`);
  const pid = insertProject(fx.db, {
    userId: 1, name: `P-${tag}`, projectDir: fx.dir, workDir: fx.dir,
  });
  const adminRow = fx.db.prepare('SELECT * FROM users WHERE id=1').get();
  return { ...fx, pid, adminRow };
}

async function call(env, method, target, { body, headers = {} } = {}) {
  const { res, cap } = fakeRes();
  const ctx = makeContext({
    req: fakeReq(method, body, headers),
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

/** 写一个合成清单根（`TS_EXT_DIR`）；返回 ext 路径与还原函数。 */
function isolateExt() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-ext-'));
  const ext = path.join(root, 'extensions');
  fs.mkdirSync(ext, { recursive: true });
  const old = process.env.TS_EXT_DIR;
  process.env.TS_EXT_DIR = ext;
  return {
    ext,
    restore() {
      if (old === undefined) delete process.env.TS_EXT_DIR;
      else process.env.TS_EXT_DIR = old;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeAsset(ext, dirName, manifest, files = {}) {
  const d = path.join(ext, dirName);
  fs.mkdirSync(d, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), content, 'utf8');
  }
  fs.writeFileSync(path.join(d, 'asset.json'), JSON.stringify(manifest), 'utf8');
}

function writeGoodAssets(ext) {
  writeAsset(ext, 'user-only-skill', {
    id: 'user-only-skill', name: '仅用户级技能', type: 'skill',
    family: 'dsh_plugin', description: '', targets: ['user'],
    files: [{ from: 'SKILL.md', to: 'user-only-skill/SKILL.md' }],
  }, { 'SKILL.md': SKILL_MD });
  writeAsset(ext, 'demo-skill', {
    id: 'demo-skill', name: '演示技能', type: 'skill',
    family: 'dsh_plugin', description: '', targets: ['user', 'project'],
    files: [{ from: 'SKILL.md', to: 'demo-skill/SKILL.md' }],
  }, { 'SKILL.md': SKILL_MD });
}

function reasonOf(text, assetId) {
  return JSON.parse(text).assets.find((a) => a.id === assetId).reason;
}

// --------------------------------------------------------------------------
// ①/③ lib 层：reason 与 targets 标签（含 zh golden）
// --------------------------------------------------------------------------

test('_unsupported_reason：en 标签/分隔符；zh 逐字旧串', () => {
  // zh golden（实现前实测旧串）
  assert.equal(ba._unsupported_reason(USER_ONLY, 'project'), '该资产只支持用户级安装');
  assert.equal(ba._unsupported_reason(BOTH, 'nope'), '该资产只支持用户级、项目级安装');
  // en
  assert.equal(ba._unsupported_reason(USER_ONLY, 'project', 'en'), REASON_EN);
  assert.equal(ba._unsupported_reason(BOTH, 'nope', 'en'), REASON_EN_BOTH);
  assert.equal(ba._unsupported_reason(PLUGIN, 'project', 'en'),
    'dsh plugin assets support only user-level installs '
    + '(installed into the dsh profile, independent of projects)');
  const third = {
    id: 'x', type: 'skill', family: 'nope', targets: ['user', 'project'],
    plugin: null, files: [], dir: '/tmp/x',
  };
  assert.equal(ba._unsupported_reason(third, 'project', 'en'),
    'This asset (nope) does not support installation at this target yet');
});

test('{targets} 分隔符：TS_I18N=0 回滚时回落 `、`（全中文）', () => {
  const old = process.env.TS_I18N;
  process.env.TS_I18N = '0';
  try {
    assert.equal(ba._unsupported_reason(BOTH, 'nope', 'en'),
      '该资产只支持用户级、项目级安装');
  } finally {
    if (old === undefined) delete process.env.TS_I18N;
    else process.env.TS_I18N = old;
  }
});

test('asset_status / asset_json 的 lang 下沉到 reason', () => {
  const st = ba.asset_status(USER_ONLY, 'project', '', 'en');
  assert.equal(st.reason, REASON_EN);
  assert.equal(st.supported, false);
  assert.equal(ba.asset_status(USER_ONLY, 'project').reason, '该资产只支持用户级安装');
  assert.equal(ba.asset_json(USER_ONLY, 'project', '', 'en').reason, REASON_EN);
  assert.equal(ba.asset_json(USER_ONLY, 'project').reason, '该资产只支持用户级安装');
});

test('install / uninstall 不支持目标：en 异常文案仍是 key+vars 载体', () => {
  assert.throws(() => ba.install(USER_ONLY, 'project', '/tmp', 'en'),
    (err) => err.message === REASON_EN
      && err.i18nKey === '该资产只支持{targets}安装'
      && err.i18nVars.targets === 'user-level');
  assert.throws(() => ba.install(USER_ONLY, 'project', '/tmp'),
    (err) => err.message === '该资产只支持用户级安装');
  assert.throws(() => ba.uninstall(USER_ONLY, 'project', '/tmp', 'en'),
    (err) => err.message === REASON_EN);
  assert.throws(() => ba.uninstall(USER_ONLY, 'project', '/tmp'),
    (err) => err.message === '该资产只支持用户级安装');
});

// --------------------------------------------------------------------------
// ① lib 层：manifest 只翻外层（R-A4）
// --------------------------------------------------------------------------

test('_manifest_error：外层 key+vars；why 保持中文', () => {
  const err = ba._manifest_error('/tmp/zz-bad', "family 未知：'nope'");
  assert.equal(err.message, "资产清单非法（zz-bad）：family 未知：'nope'");
  assert.equal(err.code, 500);
  assert.equal(err.i18nKey, '资产清单非法（{name}）：{why}');
  assert.deepEqual(err.i18nVars, { name: 'zz-bad', why: "family 未知：'nope'" });
  assert.equal(i18nT('api', err.i18nKey, 'en', err.i18nVars),
    "Invalid asset manifest (zz-bad): family 未知：'nope'");
});

// --------------------------------------------------------------------------
// ②/③ 端点级：200 list reason + install 400 + manifest 500（zh 字节 golden）
// --------------------------------------------------------------------------

test('GET /api/builtin-assets：en reason 英文；无头 zh 字段字节不变', async () => {
  const iso = isolateExt();
  writeGoodAssets(iso.ext);
  const env = setup('list');
  try {
    const target = `/api/builtin-assets?target=project&project_id=${env.pid}`;
    const zh = await call(env, 'GET', target);
    assert.equal(zh.status, 200);
    assert.equal(reasonOf(zh.text(), 'user-only-skill'), '该资产只支持用户级安装');
    assert.ok(zh.text().includes('"reason": "该资产只支持用户级安装"'));
    const en = await call(env, 'GET', target, { headers: { 'x-ts-lang': 'en' } });
    assert.equal(en.status, 200);
    assert.equal(reasonOf(en.text(), 'user-only-skill'), REASON_EN);
    assert.ok(en.text().includes('"reason": "This asset can only be installed at the user-level tier"'));
  } finally {
    env.close();
    iso.restore();
  }
});

test('POST install 不支持目标：en 400 `{targets}` 为英文标签；zh 字节不变', async () => {
  const iso = isolateExt();
  writeGoodAssets(iso.ext);
  const env = setup('install-400');
  try {
    const target = '/api/builtin-assets/user-only-skill/install';
    const body = { target: 'project', project_id: env.pid };
    const zh = await call(env, 'POST', target, { body });
    assert.equal(zh.status, 400);
    assert.equal(zh.text(), '{"error": "该资产只支持用户级安装"}');
    const en = await call(env, 'POST', target,
      { body, headers: { 'x-ts-lang': 'en' } });
    assert.equal(en.status, 400);
    assert.equal(en.text(),
      '{"error": "This asset can only be installed at the user-level tier"}');
  } finally {
    env.close();
    iso.restore();
  }
});

test('GET /api/builtin-assets：manifest 500 外层英文、why 中文（R-A4）', async () => {
  const iso = isolateExt();
  writeGoodAssets(iso.ext);
  writeAsset(iso.ext, 'zz-bad', {
    id: 'x', type: 'skill', family: 'nope', targets: ['user'], files: [],
  });
  const env = setup('manifest-500');
  try {
    const target = '/api/builtin-assets?target=user';
    const zh = await call(env, 'GET', target);
    assert.equal(zh.status, 500);
    assert.equal(zh.text(),
      '{"error": "资产清单非法（zz-bad）：family 未知：\'nope\'"}');
    const en = await call(env, 'GET', target, { headers: { 'x-ts-lang': 'en' } });
    assert.equal(en.status, 500);
    assert.equal(en.text(),
      '{"error": "Invalid asset manifest (zz-bad): family 未知：\'nope\'"}');
  } finally {
    env.close();
    iso.restore();
  }
});

test('POST install/uninstall 成功档：asset.reason 恒空串（en 形状同 zh）', async () => {
  const iso = isolateExt();
  writeGoodAssets(iso.ext);
  const env = setup('install-200');
  try {
    const body = { target: 'project', project_id: env.pid };
    const inst = await call(env, 'POST', '/api/builtin-assets/demo-skill/install',
      { body, headers: { 'x-ts-lang': 'en' } });
    assert.equal(inst.status, 200);
    assert.equal(inst.json().ok, true);
    assert.equal(inst.json().state, 'installed');
    assert.equal(inst.json().asset.reason, '');
    const un = await call(env, 'POST', '/api/builtin-assets/demo-skill/uninstall',
      { body, headers: { 'x-ts-lang': 'en' } });
    assert.equal(un.status, 200);
    assert.equal(un.json().state, 'absent');
    assert.equal(un.json().asset.reason, '');
  } finally {
    env.close();
    iso.restore();
  }
});
