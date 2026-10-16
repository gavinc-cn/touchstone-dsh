/**
 * `backend/lib/builtin-assets.js` 的单测（M6-6 前置批次）。
 *
 * 量具（`tools/parity/mod-run.mjs --case assets`，128 op / 逐值 100%）已经把「两侧等价」
 * 钉住了；本文件**只补量具难表达**的五类：
 *   ① **进程 env 的组合分支**：`dsh_profiles_dir()` 三级回落（TS_DSH_PROFILES → DSH_HOME
 *      → `~/.dsh`）与 `ext_dir()` 的空串/未设回落——量具的 `env` 是**用例级一次设定**，
 *      一个用例只能表达一种组合，三级回落无法在一条用例里全打；
 *   ② **原子写的权限位与失败清理**：量具的状态快照只比内容 sha，看不出 mode，也造不出
 *      「写完 rename 失败」；
 *   ③ **「先报错、不落半个文件」的顺序断言**：量具比的是最终状态，看不出中途有没有写过；
 *   ④ **严格 UTF-8**：量具的夹具动作只能写文本（写不出非法字节）；
 *   ⑤ **坏 profile manifest 的 `AttributeError`**：Python `dict.get` 用在非 dict 上会抛，
 *      量具的夹具能造出这个文件、但 `_plugin_restart_required` 不在用例的调用面上。
 *
 * ★★ 隔离铁律（照 `tests/test_builtin_assets_plugin.py:9-10`「绝不碰真实 ~/.dsh」）★★
 *   `HOME` / `TS_EXT_DIR` / `TS_DSH_PROFILES` / `DSH_HOME` 四个变量由 `withEnv` **逐个
 *   显式改到本侧临时目录**并在 `finally` 里还原；夹具里的 install/uninstall 因此只会写
 *   临时目录。文件末尾再用**模块导入时抓下的**真实家目录指纹核对一遍「真实 ~/.dsh 没被
 *   本文件创建/修改」——这一条不依赖任何 mock，是结构性自证。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as ba from '../lib/builtin-assets.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 真实家目录：**必须在任何 `withEnv` 之前**抓（改完 env 就取不回来了） */
const REAL_HOME = Object.hasOwn(process.env, 'HOME') ? process.env.HOME : os.homedir();
const REAL_DSH = path.join(REAL_HOME, '.dsh');

// --------------------------------------------------------------------------
// 夹具
// --------------------------------------------------------------------------

/**
 * 临时目录里的一套「三根」：HOME（skill 落点与 `~` 折叠）、profiles 根、清单根。
 * 三个根都在 `mkdtemp` 下 ⇒ 本文件的 install/uninstall **结构上**写不到真实 ~/.dsh。
 * 建过的根登记在 `CREATED_ROOTS`，文件末尾的 `after` 钩子统一收掉（不给 /tmp 留垃圾）。
 */
const CREATED_ROOTS = [];

function freshRoots(tag = 'assets') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ts-assets-${tag}-`));
  CREATED_ROOTS.push(root);
  const home = path.join(root, 'home');
  const prof = path.join(root, 'prof');
  const dshHome = path.join(root, 'dshhome');
  const ext = path.join(root, 'ext');
  for (const d of [home, prof, dshHome, ext]) fs.mkdirSync(d, { recursive: true });
  return { root, home, prof, dshHome, ext };
}

/** 收尾：删掉本文件建过的所有临时根（**只删 mkdtemp 出来的那些**） */
after(() => {
  for (const root of CREATED_ROOTS) {
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'ts-assets-')), `只删临时夹具：${root}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** 临时改 env（`undefined` ⇒ 删除该键，不是设成 "undefined"）；`finally` 里逐个还原 */
function withEnv(overrides, fn) {
  const saved = new Map();
  for (const key of Object.keys(overrides)) {
    saved.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
  }
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** 把 env 指向夹具的三根（缺省全给） */
function envFor(roots, over = {}) {
  return {
    HOME: roots.home,
    TS_EXT_DIR: roots.ext,
    TS_DSH_PROFILES: roots.prof,
    DSH_HOME: undefined,
    ...over,
  };
}

/** 往清单根里落一份资产（manifest 对象 + 载荷文件表） */
function writeAsset(ext, name, manifest, payload = {}) {
  const dir = path.join(ext, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ba.MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [rel, text] of Object.entries(payload)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  return dir;
}

/** 一份可安装的 skill（用户级 + 项目级） */
function skillManifest(over = {}) {
  return {
    id: 'demo-skill',
    name: '演示技能',
    type: 'skill',
    family: 'dsh_plugin',
    description: '演示用',
    targets: ['user', 'project'],
    files: [
      { from: 'files/SKILL.md', to: 'demo-skill/SKILL.md' },
      { from: 'files/notes.txt', to: 'demo-skill/notes.txt' },
    ],
    ...over,
  };
}

const SKILL_PAYLOAD = {
  'files/SKILL.md': '---\nname: demo-skill\n---\n\n# 演示\n',
  'files/notes.txt': 'note-a\n',
};

/** 一份可安装的 dsh_plugin（profile=web） */
function pluginManifest(over = {}, pluginOver = {}) {
  return {
    id: 'demo-plugin',
    name: '演示插件',
    type: 'dsh_plugin',
    family: 'dsh_plugin',
    description: '演示用',
    targets: ['user'],
    plugin: {
      package: '@scope/demo-plugin',
      entry_id: 'demo-plugin',
      profile: 'web',
      config: { maxItems: 3 },
      requires: [],
      ...pluginOver,
    },
    files: [
      { from: 'pkg/package.json', to: 'package.json' },
      { from: 'pkg/lib/index.mjs', to: 'lib/index.mjs' },
    ],
    ...over,
  };
}

const PLUGIN_PAYLOAD = {
  'pkg/package.json': '{"name":"@scope/demo-plugin"}\n',
  'pkg/lib/index.mjs': "export const name = 'demo-plugin';\n",
};

/** 建一个 profile 目录（含 package.json；`patchReload: live` 才热生效） */
function writeProfile(prof, name, packageJson = { dsh: { profile: { patchReload: 'live' } } }) {
  const dir = path.join(prof, name);
  fs.mkdirSync(dir, { recursive: true });
  if (packageJson !== null) {
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(packageJson)}\n`);
  }
  return dir;
}

/** 读一个资产的规范化 dict（走真 `load_assets`，不手搓） */
function assetOf(id) {
  const asset = ba.get_asset(id);
  assert.ok(asset, `夹具里应有资产 ${id}`);
  return asset;
}

/** 目录里剩下的 `.tf-asset-*` 临时文件（原子写的清理自证） */
function tempLeftovers(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n.startsWith('.tf-asset-')).sort();
  } catch {
    return [];
  }
}

// --------------------------------------------------------------------------
// ① env 组合分支（量具的用例级 env 表达不了三级回落）
// --------------------------------------------------------------------------

test('dsh_profiles_dir：TS_DSH_PROFILES 覆盖 → DSH_HOME → ~/.dsh（三级回落，空串算未设）', () => {
  const r = freshRoots('prof3');
  const dshHome = path.join(r.root, 'dsh-home');
  const explicit = path.join(r.root, 'explicit');

  withEnv(envFor(r, { TS_DSH_PROFILES: explicit, DSH_HOME: dshHome }), () => {
    assert.equal(ba.dsh_profiles_dir(), explicit, '一级：TS_DSH_PROFILES 胜出（DSH_HOME 不参与）');
  });
  withEnv(envFor(r, { TS_DSH_PROFILES: undefined, DSH_HOME: dshHome }), () => {
    assert.equal(ba.dsh_profiles_dir(), path.join(dshHome, 'profiles'), '二级：DSH_HOME + /profiles');
  });
  withEnv(envFor(r, { TS_DSH_PROFILES: undefined, DSH_HOME: undefined }), () => {
    assert.equal(ba.dsh_profiles_dir(), path.join(r.home, '.dsh', 'profiles'),
      '三级：~/.dsh/profiles（HOME 指向夹具 ⇒ 不碰真实家目录）');
  });
  withEnv(envFor(r, { TS_DSH_PROFILES: '', DSH_HOME: '' }), () => {
    assert.equal(ba.dsh_profiles_dir(), path.join(r.home, '.dsh', 'profiles'),
      '空串在 Python 里是假值 ⇒ 与未设同（`or` 语义，不是 `??`）');
  });
  withEnv(envFor(r, { TS_DSH_PROFILES: path.join(r.root, 'rel', '..', 'x') }), () => {
    assert.equal(ba.dsh_profiles_dir(), path.join(r.root, 'x'), '走 os.path.abspath（折叠 ..）');
  });
});

test('ext_dir：TS_EXT_DIR 覆盖；空串/未设回落到仓库 extensions/（默认根就是真仓库那份）', () => {
  const r = freshRoots('ext');
  withEnv(envFor(r, { TS_EXT_DIR: r.ext }), () => {
    assert.equal(ba.ext_dir(), r.ext);
  });
  for (const value of ['', undefined]) {
    withEnv(envFor(r, { TS_EXT_DIR: value }), () => {
      assert.equal(ba.ext_dir(), ba.DEFAULT_EXT_DIR, `TS_EXT_DIR=${JSON.stringify(value)} 回落缺省`);
      assert.equal(ba.DEFAULT_EXT_DIR, path.join(REPO_ROOT, 'extensions'), '缺省 = 仓库根的 extensions/');
    });
  }
  assert.ok(fs.existsSync(path.join(ba.DEFAULT_EXT_DIR, 'dsh-autocommit', 'asset.json')),
    '缺省清单根里确实有平台自带资产（证明默认根指向真仓库，不是空目录）');
});

// --------------------------------------------------------------------------
// ② 原子写：权限位 + 失败清理（量具的状态快照看不到 mode）
// --------------------------------------------------------------------------

test('_atomic_write_bytes：保留原权限位；新文件留 mkstemp 的 0600；内容整份替换', () => {
  const r = freshRoots('atomic');
  const dir = path.join(r.root, 'd');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'x.txt');

  fs.writeFileSync(target, 'old\n');
  fs.chmodSync(target, 0o640);
  ba._atomic_write_bytes(target, Buffer.from('new\n', 'utf8'));
  assert.equal(fs.readFileSync(target, 'utf8'), 'new\n', '内容整份替换');
  assert.equal(fs.statSync(target).mode & 0o777, 0o640, '目标已存在 ⇒ chmod 回原 mode');

  fs.chmodSync(target, 0o604);
  ba._atomic_write_bytes(target, 'again\n');
  assert.equal(fs.statSync(target).mode & 0o777, 0o604, '换一个 mode 也照样保留');

  const fresh = path.join(dir, 'sub', 'fresh.txt');
  ba._atomic_write_bytes(fresh, 'brand new\n');
  assert.equal(fs.readFileSync(fresh, 'utf8'), 'brand new\n', '目录不存在则先建（makedirs）');
  assert.equal(fs.statSync(fresh).mode & 0o777, 0o600, '新文件 = mkstemp 的 0600（同 Python）');
  assert.deepEqual(tempLeftovers(dir), [], '同目录不留临时文件');
  assert.deepEqual(tempLeftovers(path.dirname(fresh)), [], '子目录也不留');
});

test('_atomic_write_bytes：rename 失败时 unlink 临时文件后重抛（不残留、不动目标）', () => {
  const r = freshRoots('atomicfail');
  const dir = path.join(r.root, 'd');
  const blocked = path.join(dir, 'blocked');
  fs.mkdirSync(blocked, { recursive: true });
  fs.writeFileSync(path.join(blocked, 'keep.txt'), 'keep\n');

  assert.throws(() => ba._atomic_write_bytes(blocked, 'data'), (err) => {
    assert.ok(err && err.code, `应抛 fs 错误（拿到 ${err && err.code}）`);
    return true;
  });
  assert.deepEqual(tempLeftovers(dir), [], '失败路径必须 unlink 临时文件');
  assert.equal(fs.readFileSync(path.join(blocked, 'keep.txt'), 'utf8'), 'keep\n', '目标目录原样不动');
});

// --------------------------------------------------------------------------
// ③ 清单校验：非法整份抛错（不静默跳过）+ 严格 UTF-8
// --------------------------------------------------------------------------

test('load_assets：非法清单整份抛错而不是跳过；id 重复也抛', () => {
  const r = freshRoots('manifest');
  writeAsset(r.ext, 'good', skillManifest({ id: 'good-skill' }), SKILL_PAYLOAD);
  writeAsset(r.ext, 'dup-a', skillManifest({ id: 'dup-skill' }), SKILL_PAYLOAD);
  writeAsset(r.ext, 'dup-b', skillManifest({ id: 'dup-skill' }), SKILL_PAYLOAD);

  withEnv(envFor(r), () => {
    assert.throws(() => ba.load_assets(), (err) => {
      assert.ok(err instanceof ba.AssetError);
      assert.equal(err.code, 500);
      assert.equal(err.message, '资产清单非法（dup-b）：id 重复：dup-skill');
      return true;
    });
    fs.rmSync(path.join(r.ext, 'dup-a'), { recursive: true });
    fs.rmSync(path.join(r.ext, 'dup-b'), { recursive: true });
    assert.deepEqual(ba.load_assets().map((a) => a.id), ['good-skill'], '坏清单清掉后剩一份合法的');
    assert.equal(ba.get_asset('good-skill').dir, path.join(r.ext, 'good'));
    assert.equal(ba.get_asset('nope'), null);
  });
});

test('_load_manifest：字段校验逐条报错（顶层类型 / id / type / family / targets / files / .. 越界 / register）', () => {
  const r = freshRoots('fields');
  const cases = [
    ['t-notobj', '[1,2]\n', '顶层必须是 JSON 对象'],
    ['t-badid', '{"id":"Bad Id","type":"skill","family":"dsh_plugin","targets":["user"],"files":[{"from":"f","to":"t"}]}\n', "id 非法：'Bad Id'"],
    ['t-badtype', '{"id":"x","type":"nope","family":"dsh_plugin","targets":["user"],"files":[{"from":"f","to":"t"}]}\n', "type 必须是 skill/dsh_plugin：'nope'"],
    ['t-badfam', '{"id":"x","type":"skill","family":"nope","targets":["user"],"files":[{"from":"f","to":"t"}]}\n', "family 未知：'nope'"],
    ['t-badtargets', '{"id":"x","type":"skill","family":"dsh_plugin","targets":["boss"],"files":[{"from":"f","to":"t"}]}\n', "targets 必须是 ['user', 'project'] 的非空子集"],
    ['t-notargets', '{"id":"x","type":"skill","family":"dsh_plugin","files":[{"from":"f","to":"t"}]}\n', "targets 必须是 ['user', 'project'] 的非空子集"],
    ['t-nofiles', '{"id":"x","type":"skill","family":"dsh_plugin","targets":["user"]}\n', 'files 必须是非空数组'],
    ['t-badfileitem', '{"id":"x","type":"skill","family":"dsh_plugin","targets":["user"],"files":["f"]}\n', 'files 元素必须是 {from, to} 对象'],
    ['t-nosrc', '{"id":"x","type":"skill","family":"dsh_plugin","targets":["user"],"files":[{"from":"files/none.txt","to":"t"}]}\n', '清单文件不存在：files/none.txt'],
    ['t-escape', '{"id":"x","type":"skill","family":"dsh_plugin","targets":["user"],"files":[{"from":"files/ok.txt","to":"../escape.txt"}]}\n', 'files[].to 不允许 .. 越界：../escape.txt'],
    ['t-abs', '{"id":"x","type":"skill","family":"dsh_plugin","targets":["user"],"files":[{"from":"files/ok.txt","to":"/tmp/x"}]}\n', 'files[].to 必须是相对路径：/tmp/x'],
    ['t-register', '{"id":"x","type":"skill","family":"dsh_plugin","targets":["user"],"files":[{"from":"files/ok.txt","to":"t"}],"register":{}}\n', '不支持 register 声明（skill 资产无需注册）'],
  ];
  for (const [name, text, want] of cases) {
    const dir = path.join(r.ext, name);
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'files', 'ok.txt'), 'ok\n');
    fs.writeFileSync(path.join(dir, ba.MANIFEST_NAME), text);
  }
  withEnv(envFor(r), () => {
    for (const [name, , want] of cases) {
      assert.throws(() => ba._load_manifest(path.join(r.ext, name)), (err) => {
        assert.ok(err instanceof ba.AssetError, `${name} 应抛 AssetError`);
        assert.equal(err.code, 500, `${name}`);
        assert.equal(err.message, `资产清单非法（${name}）：${want}`, name);
        return true;
      });
    }
    // register 显式为 null 不算「声明」（Python `raw.get("register") is not None`）
    const okDir = writeAsset(r.ext, 't-regnull',
      skillManifest({ id: 'regnull', files: [{ from: 'files/ok.txt', to: 't' }], register: null }),
      { 'files/ok.txt': 'ok\n' });
    assert.equal(ba._load_manifest(okDir).id, 'regnull');
  });
});

test('_load_manifest：非法 UTF-8 抛 AssetError（严格解码，绝不用 U+FFFD 静默兜底）', () => {
  const r = freshRoots('utf8');
  const dir = path.join(r.ext, 'bad-bytes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ba.MANIFEST_NAME),
    Buffer.concat([Buffer.from('{"id":"x","name":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}\n')]));
  withEnv(envFor(r), () => {
    assert.throws(() => ba._load_manifest(dir), (err) => {
      assert.ok(err instanceof ba.AssetError, '坏字节要变成 AssetError，不能静默成 U+FFFD');
      assert.equal(err.code, 500);
      assert.ok(err.message.startsWith('资产清单非法（bad-bytes）：读取/解析失败（'), err.message);
      return true;
    });
  });
});

test('_load_manifest：清单文件缺失也是「读取/解析失败」（不是静默空清单）', () => {
  const r = freshRoots('nomanifest');
  const dir = path.join(r.ext, 'empty-dir');
  fs.mkdirSync(dir, { recursive: true });
  withEnv(envFor(r), () => {
    assert.throws(() => ba._load_manifest(dir), (err) => {
      assert.ok(err.message.startsWith('资产清单非法（empty-dir）：读取/解析失败（'), err.message);
      return true;
    });
    assert.deepEqual(ba.load_assets(), [], '没有 asset.json 的目录被跳过（load_assets 只认清单文件）');
  });
});

// --------------------------------------------------------------------------
// ④ 「先报错、不落半个文件」的顺序断言
// --------------------------------------------------------------------------

test('install（dsh_plugin）：profile 缺失时先报错，一个字节都不落', () => {
  const r = freshRoots('noprofile');
  writeAsset(r.ext, 'demo-plugin', pluginManifest(), PLUGIN_PAYLOAD);
  const asset = withEnv(envFor(r), () => assetOf('demo-plugin'));
  assert.equal(fs.existsSync(path.join(r.prof, 'web')), false, '夹具刻意不给 web profile');

  withEnv(envFor(r), () => {
    assert.throws(() => ba.install(asset, 'user'), (err) => {
      assert.ok(err instanceof ba.AssetError);
      assert.equal(err.code, 400);
      assert.equal(err.message, `未找到 dsh profile「web」：${path.join(r.prof, 'web')}`);
      return true;
    });
    const pkgRoot = path.join(r.prof, 'node_modules', '@scope', 'demo-plugin');
    assert.equal(fs.existsSync(pkgRoot), false, '包目录不能被建出来（半残状态）');
    assert.equal(fs.existsSync(path.join(r.prof, 'web', 'cordis.patch.yml')), false, 'patch 也不能写');
    assert.equal(fs.existsSync(path.join(r.prof, 'node_modules')), false, 'node_modules 都不该出现');
    const st = ba.asset_status(asset, 'user');
    assert.equal(st.state, 'absent', '状态仍是 absent（没有半安装）');
  });
});

test('install（skill）：项目目录不存在先报错，不落文件', () => {
  const r = freshRoots('noproj');
  writeAsset(r.ext, 'demo-skill', skillManifest(), SKILL_PAYLOAD);
  const asset = withEnv(envFor(r), () => assetOf('demo-skill'));
  withEnv(envFor(r), () => {
    assert.throws(() => ba.install(asset, 'project', path.join(r.root, 'no-such')),
      (err) => err instanceof ba.AssetError && err.message === '项目目录不存在');
    assert.equal(fs.existsSync(path.join(r.root, 'no-such')), false);
  });
});

// --------------------------------------------------------------------------
// ⑤ 原子安装 / 卸载 / 四态 / patch 标记块
// --------------------------------------------------------------------------

test('install：幂等（二次 files_written 为空）且只动清单内文件', () => {
  const r = freshRoots('idem');
  writeAsset(r.ext, 'demo-skill', skillManifest(), SKILL_PAYLOAD);
  withEnv(envFor(r), () => {
    const asset = assetOf('demo-skill');
    const first = ba.install(asset, 'user');
    assert.equal(first.state, 'installed');
    assert.deepEqual(first.files_written, [
      '~/.dsh/skills/demo-skill/SKILL.md', '~/.dsh/skills/demo-skill/notes.txt',
    ]);
    const second = ba.install(asset, 'user');
    assert.deepEqual(second.files_written, [], '内容一致 ⇒ 不重写（mtime 不动）');
    assert.equal(ba.asset_status(asset, 'user').state, 'installed');

    // 用户在技能目录里放了自己的文件：卸载只删清单内的，且**不**收敛空目录（skill 无 prune）
    fs.writeFileSync(path.join(r.home, '.dsh', 'skills', 'demo-skill', 'extra.txt'), 'mine\n');
    const un = ba.uninstall(asset, 'user');
    assert.deepEqual(un.files_deleted, [
      '~/.dsh/skills/demo-skill/SKILL.md', '~/.dsh/skills/demo-skill/notes.txt',
    ]);
    assert.equal(un.state, 'absent');
    assert.equal(fs.readFileSync(path.join(r.home, '.dsh', 'skills', 'demo-skill', 'extra.txt'), 'utf8'),
      'mine\n', '别人的文件一律不动');
    assert.equal(fs.existsSync(path.join(r.home, '.dsh', 'skills', 'demo-skill')), true);
  });
});

test('asset_status（skill）：absent → installed → outdated → partial 四态', () => {
  const r = freshRoots('fourstate');
  writeAsset(r.ext, 'demo-skill', skillManifest(), SKILL_PAYLOAD);
  const target = path.join(r.home, '.dsh', 'skills', 'demo-skill', 'SKILL.md');
  withEnv(envFor(r), () => {
    const asset = assetOf('demo-skill');
    assert.equal(ba.asset_status(asset, 'user').state, 'absent');
    ba.install(asset, 'user');
    assert.equal(ba.asset_status(asset, 'user').state, 'installed');
    fs.writeFileSync(target, '用户改过\n');
    assert.equal(ba.asset_status(asset, 'user').state, 'outdated');
    fs.rmSync(path.join(r.home, '.dsh', 'skills', 'demo-skill', 'notes.txt'));
    assert.equal(ba.asset_status(asset, 'user').state, 'partial');
  });
});

test('dsh_plugin：装/卸的 patch 标记块（写入幂等、启停、剥离、canonical 归零）', () => {
  const r = freshRoots('patch');
  writeProfile(r.prof, 'web');
  writeAsset(r.ext, 'demo-plugin', pluginManifest(), PLUGIN_PAYLOAD);
  const patchPath = path.join(r.prof, 'web', 'cordis.patch.yml');
  withEnv(envFor(r), () => {
    const asset = assetOf('demo-plugin');
    assert.equal(ba.asset_status(asset, 'user').state, 'absent');

    const first = ba.install(asset, 'user');
    assert.equal(first.patch_action, 'added');
    assert.equal(first.state, 'installed');
    const blockBytes = fs.readFileSync(patchPath, 'utf8');
    assert.ok(blockBytes.includes('# >>> touchstone-asset:demo-plugin'), '带平台标记');
    assert.ok(blockBytes.includes('# <<< touchstone-asset:demo-plugin'));
    assert.ok(blockBytes.endsWith('\n') && !blockBytes.endsWith('\n\n'), '结尾恰好一个换行');

    const second = ba.install(asset, 'user');
    assert.equal(second.patch_action, 'kept');
    assert.equal(fs.readFileSync(patchPath, 'utf8'), blockBytes, 'kept ⇒ 文件字节不动');

    // dsh 面板停用：顶层 `- id:` + 缩进 `disabled: true` ⇒ 合成态 partial
    fs.writeFileSync(patchPath, `${blockBytes}\n- id: demo-plugin\n  disabled: true\n`);
    assert.equal(ba.asset_status(asset, 'user').state, 'partial', '注册行被停用 ⇒ partial');
    const third = ba.install(asset, 'user');
    assert.equal(third.patch_action, 'enabled');
    assert.equal(ba.asset_status(asset, 'user').state, 'installed');
    assert.ok(fs.readFileSync(patchPath, 'utf8').includes('\n  disabled: false\n'));

    // 卸载：标记块整块删掉；**标记块之外**的行（dsh 面板自己那行结构化开关 + 用户注释）留着
    // —— 口径已用 `python3` 直跑 oracle 核过，逐字节相同：
    //    `'\n- id: demo-plugin\n  disabled: false\n# 用户自己的注释\n'`
    fs.appendFileSync(patchPath, '# 用户自己的注释\n');
    const un = ba.uninstall(asset, 'user');
    assert.equal(un.patch_action, 'removed');
    assert.equal(fs.readFileSync(patchPath, 'utf8'),
      '\n- id: demo-plugin\n  disabled: false\n# 用户自己的注释\n',
      '只删平台标记块，块外一行不动');
    assert.equal(fs.existsSync(path.join(r.prof, 'node_modules', '@scope', 'demo-plugin')), false,
      '包目录清空后连空目录一起收掉（含 scope 段）');
    assert.equal(fs.existsSync(path.join(r.prof, 'node_modules')), false, '空的祖先目录也收敛');
    assert.equal(fs.existsSync(path.join(r.prof, 'web')), true, 'stop_at（profiles 根）不动');

    // canonical（手工写的、与规范逐字一致）也要能整块移除，且文件清成空
    ba.install(asset, 'user');
    fs.writeFileSync(patchPath, '- insert:\n    - id: demo-plugin\n      name: "@scope/demo-plugin"\n');
    assert.equal(ba.plugin_patch_state(asset).mode, 'canonical');
    assert.equal(ba.uninstall(asset, 'user').patch_action, 'removed');
    assert.equal(fs.readFileSync(patchPath, 'utf8'), '');
  });
});

test('uninstall（dsh_plugin）：foreign 注册行**先拒绝再谈删文件**，且不删别人的文件', () => {
  const r = freshRoots('foreign');
  writeProfile(r.prof, 'web');
  writeAsset(r.ext, 'demo-plugin', pluginManifest(), PLUGIN_PAYLOAD);
  const patchPath = path.join(r.prof, 'web', 'cordis.patch.yml');
  const pkgRoot = path.join(r.prof, 'node_modules', '@scope', 'demo-plugin');
  withEnv(envFor(r), () => {
    const asset = assetOf('demo-plugin');
    ba.install(asset, 'user');
    fs.writeFileSync(path.join(pkgRoot, 'user-extra.txt'), 'mine\n');

    fs.writeFileSync(patchPath, '# 手写\n- id: demo-plugin\n  name: "@scope/demo-plugin"\n  config:\n    x: 1\n');
    assert.equal(ba.plugin_patch_state(asset).mode, 'foreign');
    assert.throws(() => ba.uninstall(asset, 'user'), (err) => {
      assert.ok(err instanceof ba.AssetError);
      assert.equal(err.code, 409, 'foreign 是 409（冲突），不是 400');
      assert.ok(err.message.includes('已有自定义写法的注册行'), err.message);
      return true;
    });
    assert.equal(fs.existsSync(path.join(pkgRoot, 'package.json')), true,
      '拒绝发生在删文件之前（包文件必须还在）');
    assert.equal(fs.existsSync(path.join(pkgRoot, 'lib', 'index.mjs')), true);

    // 换成平台标记块后：只删清单内文件，用户塞进来的文件与目录都留着
    fs.writeFileSync(patchPath, `${ba.plugin_patch_blocks(asset).join('\n')}\n`);
    assert.equal(ba.plugin_patch_state(asset).mode, 'marked');
    const un = ba.uninstall(asset, 'user');
    assert.deepEqual(un.files_deleted, [
      path.join(pkgRoot, 'package.json'), path.join(pkgRoot, 'lib', 'index.mjs'),
    ], '只删清单内两个文件');
    assert.equal(fs.readFileSync(path.join(pkgRoot, 'user-extra.txt'), 'utf8'), 'mine\n');
    assert.equal(fs.existsSync(path.join(pkgRoot, 'lib')), false, '空目录 lib 被收掉');
    assert.equal(fs.existsSync(pkgRoot), true, '非空 ⇒ 目录留着（不递归删别人的文件）');
  });
});

// --------------------------------------------------------------------------
// ⑥ 量具覆盖不到的诊断口
// --------------------------------------------------------------------------

test('_plugin_restart_required：live 才免重启；读不到/坏 JSON/非 live 一律 true', () => {
  const r = freshRoots('restart');
  writeAsset(r.ext, 'demo-plugin', pluginManifest(), PLUGIN_PAYLOAD);
  const manifest = path.join(r.prof, 'web', 'package.json');
  withEnv(envFor(r), () => {
    const asset = assetOf('demo-plugin');
    writeProfile(r.prof, 'web');
    assert.equal(ba._plugin_restart_required(asset), false, 'patchReload: live');

    fs.writeFileSync(manifest, '{"dsh":{"profile":{"patchReload":"manual"}}}\n');
    assert.equal(ba._plugin_restart_required(asset), true);
    fs.writeFileSync(manifest, '{"dsh":{"profile":{}}}\n');
    assert.equal(ba._plugin_restart_required(asset), true, '缺 patchReload ⇒ 需要重启（宁可多提示）');
    fs.writeFileSync(manifest, '{"dsh":{}}\n');
    assert.equal(ba._plugin_restart_required(asset), true);
    fs.writeFileSync(manifest, '{ 坏 JSON\n');
    assert.equal(ba._plugin_restart_required(asset), true, '坏 JSON ⇒ 不猜，按需要重启');
    fs.rmSync(manifest);
    assert.equal(ba._plugin_restart_required(asset), true, '读不到 ⇒ 需要重启');
    fs.writeFileSync(manifest, JSON.stringify({ dsh: [] }) + '\n');
    assert.equal(ba._plugin_restart_required(asset), true, 'dsh:[] 是假值 ⇒ 走 {}，不抛');
    fs.writeFileSync(manifest, JSON.stringify({ dsh: [1] }) + '\n');
    assert.throws(() => ba._plugin_restart_required(asset),
      (err) => err instanceof ba.AttributeError && err.name === 'AttributeError',
      "Python 是 `[1].get(...)` ⇒ AttributeError（本实现必须同样抛）");
    fs.writeFileSync(manifest, JSON.stringify({ dsh: { profile: 'x' } }) + '\n');
    assert.throws(() => ba._plugin_restart_required(asset),
      (err) => err instanceof ba.AttributeError, 'profile 非 dict 且为真 ⇒ 同样抛');
    fs.writeFileSync(manifest, JSON.stringify({ dsh: { profile: [] } }) + '\n');
    assert.equal(ba._plugin_restart_required(asset), true, 'profile:[] 是假值 ⇒ 不抛');
  });
});

test('_node_resolve：祖先查找 + 断链软链不算命中', () => {
  const r = freshRoots('resolve');
  const start = path.join(r.prof, 'node_modules', '@scope', 'demo-plugin');
  fs.mkdirSync(path.join(r.prof, 'node_modules', '@deepseek-ai', 'dsh-llm'), { recursive: true });
  fs.writeFileSync(path.join(r.prof, 'node_modules', '@deepseek-ai', 'dsh-llm', 'package.json'), '{}\n');
  fs.mkdirSync(start, { recursive: true });
  assert.equal(ba._node_resolve('@deepseek-ai/dsh-llm', start),
    path.join(r.prof, 'node_modules', '@deepseek-ai', 'dsh-llm'), '从包的祖先 node_modules 解析');
  assert.equal(ba._node_resolve('@deepseek-ai/nope', start), '', '找不到返回空串');

  fs.symlinkSync(path.join(r.root, 'does-not-exist'),
    path.join(r.prof, 'node_modules', '@deepseek-ai', 'dangling'));
  assert.equal(ba._node_resolve('@deepseek-ai/dangling', start), '',
    '断链的软链因 exists 跟随解析而为 false，正是要暴露的情况');
});

test('list_assets：target 非法抛 AssetError(400)；project 目标缺 project_dir 时逐条给 reason', () => {
  const r = freshRoots('list');
  writeProfile(r.prof, 'web');
  writeAsset(r.ext, 'demo-skill', skillManifest(), SKILL_PAYLOAD);
  writeAsset(r.ext, 'demo-plugin', pluginManifest(), PLUGIN_PAYLOAD);
  withEnv(envFor(r), () => {
    assert.throws(() => ba.list_assets('boss'), (err) => {
      assert.ok(err instanceof ba.AssetError);
      assert.equal(err.code, 400);
      assert.equal(err.message, 'target 必须是 user/project');
      return true;
    });
    const proj = ba.list_assets('project', '');
    assert.deepEqual(proj.map((a) => [a.id, a.supported, a.reason]), [
      ['demo-plugin', false, '该资产只支持用户级安装'],
      ['demo-skill', false, '该资产（dsh_plugin）暂不支持此目标的安装'],
    ]);
    const user = ba.list_assets('user');
    assert.deepEqual(user.map((a) => a.id), ['demo-plugin', 'demo-skill'], '按清单目录名排序');
    assert.equal(user[0].plugin.package, '@scope/demo-plugin');
    assert.equal(user[1].plugin, undefined, 'skill 资产不带 plugin 键');
    assert.equal(user[1].type_label, 'skill');
    assert.equal(user[1].family_label, 'dsh 插件');
  });
});

// --------------------------------------------------------------------------
// ⑦ 隔离自证（本文件跑完，真实 ~/.dsh 必须原封不动）
// --------------------------------------------------------------------------

/** 真实家目录里 builtin-assets **可能**写入的那几个位置的指纹（内容级，不含 mtime） */
function realAssetFingerprint() {
  const out = [];
  const note = (p) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      out.push(`${p} <missing>`);
      return;
    }
    if (st.isSymbolicLink()) {
      out.push(`${p} l ${fs.readlinkSync(p)}`);      // node_modules 里有指向 dsh 安装的软链
      return;
    }
    if (st.isDirectory()) {
      out.push(`${p} d`);
      for (const name of fs.readdirSync(p).sort()) note(path.join(p, name));
    } else {
      out.push(`${p} f ${st.size} ${createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`);
    }
  };
  note(path.join(REAL_DSH, 'skills'));
  note(path.join(REAL_DSH, 'profiles', 'node_modules'));
  let profiles = [];
  try {
    profiles = fs.readdirSync(path.join(REAL_DSH, 'profiles')).sort();
  } catch { /* 没有 profiles 也一样比 */ }
  for (const name of profiles) note(path.join(REAL_DSH, 'profiles', name, 'cordis.patch.yml'));
  return out.join('\n');
}

const REAL_BEFORE = realAssetFingerprint();

test('隔离自证：真跑一次 install（写进夹具 HOME），真实 ~/.dsh 指纹一字未变', () => {
  const r = freshRoots('iso');
  writeAsset(r.ext, 'demo-skill', skillManifest(), SKILL_PAYLOAD);
  withEnv(envFor(r), () => {
    assert.notEqual(path.resolve(process.env.HOME), path.resolve(REAL_HOME),
      '本测试期间 HOME 必须是夹具目录（不是真实家目录）');
    assert.equal(ba.display_path(path.join(r.home, '.dsh', 'skills')), '~/.dsh/skills',
      '夹具 HOME 就是 display_path 折叠出来的那个 ~');
    const res = ba.install(assetOf('demo-skill'), 'user');
    assert.deepEqual(res.files_written,
      ['~/.dsh/skills/demo-skill/SKILL.md', '~/.dsh/skills/demo-skill/notes.txt']);
    assert.ok(fs.existsSync(path.join(r.home, '.dsh', 'skills', 'demo-skill', 'SKILL.md')),
      '真的落了盘（落在夹具 HOME 下）——这条反证「不是靠没跑到来装绿」');
  });
  assert.equal(realAssetFingerprint(), REAL_BEFORE,
    `真实家目录的资产落点被改动了：${REAL_DSH}\n（本文件任何 install/uninstall 都不许碰它）`);
  assert.equal(fs.existsSync(path.join(REAL_HOME, '.dsh', 'skills', 'demo-skill')), false,
    '真实 ~/.dsh/skills/demo-skill 不存在');
  assert.equal(fs.existsSync(
    path.join(REAL_HOME, '.dsh', 'profiles', 'node_modules', '@scope', 'demo-plugin')), false,
  '真实 ~/.dsh/profiles/node_modules 下没有夹具的插件包');
});
