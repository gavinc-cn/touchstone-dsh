/**
 * M6-2 单测：`agents.js` 的**扫描口**（M3 只交付了 `agentFamily`，本批补齐）。
 *
 * 期望值一律来自 `agents.py` 原文（frontmatter 正则、4096 字节读头、深度上限 2、
 * 项目级覆盖用户级、`--version` 的 2s 超时与「取首行截 120」）。对拍量具
 * （`tools/parity/mod-run.mjs --case agents`）已覆盖「与 Python 逐字节一致」的路径；
 * 本文件覆盖它测不到的边界：**码点截断**（emoji）、4096 字节读头、超时/不可执行降级、
 * `HOME`/`PATH` 隔离下 `scan_skills` 的四目录语义。
 *
 * 夹具一律 `mkdtemp`；**绝不碰真实 `~/.dsh`**（用 `process.env.HOME` 指到临时目录）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import * as agents from '../lib/agents.js';

/** 临时目录夹具 */
function tmpTree(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-${tag}-`));
  const write = (rel, text, mode) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    if (mode) fs.chmodSync(p, mode);
    return p;
  };
  return { dir, write };
}

/** 临时改环境变量（测试末尾恢复） */
function withEnv(pairs, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(pairs)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// --------------------------------------------------------------------------
// _parse_skill_md
// --------------------------------------------------------------------------

test('parseSkillMd：frontmatter / 无 frontmatter 回落目录名 / 缺失文件 null', () => {
  const fx = tmpTree('ag-skill');
  const good = fx.write('a/SKILL.md', '---\nname: alpha\ndescription: 描述一\n---\n\n正文\n');
  const plain = fx.write('b/SKILL.md', '没有 frontmatter 的技能文件\n');
  assert.deepEqual(agents.parseSkillMd(good, 'fb'), ['alpha', '描述一']);
  assert.deepEqual(agents.parseSkillMd(plain, 'fb'), ['fb', ''],
    '无 frontmatter ⇒ name 用 fallback、description 空串');
  assert.equal(agents.parseSkillMd(path.join(fx.dir, 'nope/SKILL.md'), 'fb'), null);
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test('parseSkillMd：description 按**码点**截 200（emoji 不被切成半个代理对）', () => {
  const fx = tmpTree('ag-trunc');
  // 199 个 a + 30 个 emoji = 229 个码点 / 259 个 UTF-16 码元
  const desc = `${'a'.repeat(199)}${'🙂'.repeat(30)}`;
  const p = fx.write('long/SKILL.md', `---\nname: long\ndescription: ${desc}\n---\n`);
  const [name, got] = agents.parseSkillMd(p, 'fb');
  assert.equal(name, 'long');
  const points = [...got];
  assert.equal(points.length, 200, 'Python `[:200]` 是码点切片');
  assert.equal(got, `${'a'.repeat(199)}🙂`, '第 200 个码点是完整的 emoji');
  assert.ok(!got.includes('\uFFFD'), '不能留半个代理对');
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test('parseSkillMd：只读前 4096 **字节**（frontmatter 起点在 4096 之后 ⇒ 视同无 frontmatter）', () => {
  const fx = tmpTree('ag-head');
  const filler = 'x'.repeat(5000);
  const p = fx.write('far/SKILL.md', `${filler}\n---\nname: far\ndescription: 看不见\n---\n`);
  assert.deepEqual(agents.parseSkillMd(p, 'fb-name'), ['fb-name', ''],
    '读头 4096 字节截断 ⇒ frontmatter 不在头部');
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

// --------------------------------------------------------------------------
// _scan_skill_dir / scan_skills
// --------------------------------------------------------------------------

test('scanSkillDir：深度上限 2（第一二层收、第三层不收）、来源标记照传', () => {
  const fx = tmpTree('ag-dir');
  fx.write('cat/one/SKILL.md', '---\nname: one\ndescription: d1\n---\n');
  fx.write('two/SKILL.md', '---\nname: two\ndescription: d2\n---\n');
  fx.write('a/b/c/SKILL.md', '---\nname: toodeep\ndescription: d3\n---\n');
  fx.write('cat/noskill/readme.md', 'not a skill\n');
  const got = agents.scanSkillDir(fx.dir, 'user');
  // **不假设目录遍历顺序**：Python `os.walk` 用 `scandir` 顺序（readdir 序），Node 同——
  // 两者相同但不是「按名排序」。`scan_skills` 才按 name 排序（见下一个用例）。
  assert.deepEqual(got.map((s) => s.name).sort(), ['one', 'two'],
    '第一二层收（`cat/one`、`two`），第三层 `a/b/c` 不收');
  assert.deepEqual([...new Set(got.map((s) => s.source))], ['user']);
  assert.deepEqual(agents.scanSkillDir(path.join(fx.dir, 'nope'), 'user'), []);
  assert.deepEqual(agents.scanSkillDir('', 'user'), []);
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test('scanSkills：用户级 + 项目级（项目级同名覆盖）、空 agent_path 与退场族都返回 []', () => {
  const fx = tmpTree('ag-skills');
  fx.write('home/.dsh/skills/alpha/SKILL.md', '---\nname: alpha\ndescription: 用户级\n---\n');
  fx.write('home/.dsh/skills/plain/SKILL.md', '无 frontmatter\n');
  fx.write('proj/.agents/skills/alpha/SKILL.md', '---\nname: alpha\ndescription: 项目级\n---\n');
  fx.write('proj/.agents/skills/zeta/SKILL.md', '---\nname: zeta\ndescription: 项目独有\n---\n');

  const got = withEnv({ HOME: path.join(fx.dir, 'home') },
    () => agents.scanSkills('dsh-plugin:x', path.join(fx.dir, 'proj')));
  assert.deepEqual(got.map((s) => s.name), ['alpha', 'plain', 'zeta'], '按 name 排序');
  const alpha = got.find((s) => s.name === 'alpha');
  assert.equal(alpha.description, '项目级', '项目级覆盖用户级（同名）');
  assert.equal(alpha.source, 'project');
  const plain = got.find((s) => s.name === 'plain');
  assert.equal(plain.name, 'plain', '无 frontmatter ⇒ name 取所在目录名');
  assert.equal(plain.source, 'user');

  // 只给用户级（项目目录空串）
  const userOnly = withEnv({ HOME: path.join(fx.dir, 'home') },
    () => agents.scanSkills('dsh-plugin:x', ''));
  assert.deepEqual(userOnly.map((s) => s.source), ['user', 'user']);
  // 空 agent_path / 退场族
  assert.deepEqual(agents.scanSkills('', path.join(fx.dir, 'proj')), []);
  assert.deepEqual(agents.scanSkills('kimi-web:old', path.join(fx.dir, 'proj')), []);
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

// --------------------------------------------------------------------------
// which / searchExtra / probeVersion / scanAgents
// --------------------------------------------------------------------------

test('whichSync：只认「文件 + 可执行位」；名字含 `/` 时直接判', () => {
  const fx = tmpTree('ag-which');
  const exe = fx.write('bin/fakedsh', '#!/bin/sh\necho v1\n', 0o755);
  const notExe = fx.write('bin/noexec', 'x\n');
  withEnv({ PATH: path.join(fx.dir, 'bin') }, () => {
    assert.equal(agents.whichSync('fakedsh'), exe);
    assert.equal(agents.whichSync('noexec'), null, '缺可执行位不算命中');
    assert.equal(agents.whichSync('missing-xyz'), null);
    assert.equal(agents.whichSync(exe), exe, '含 `/` 直接判');
    assert.equal(agents.whichSync(''), null);
  });
  assert.ok(fs.existsSync(notExe));
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test('probeVersion：取首行、按码点截 120、不可执行/不存在一律空串', () => {
  const fx = tmpTree('ag-ver');
  const ok = fx.write('bin/dsh', '#!/bin/sh\necho "dsh 1.2.3"\necho second\n', 0o755);
  assert.equal(agents.probeVersion(ok), 'dsh 1.2.3', '只取首行');
  const long = fx.write('bin/long', `#!/bin/sh\necho "${'x'.repeat(200)}"\n`, 0o755);
  assert.equal(agents.probeVersion(long).length, 120);
  // 第 120 个码点正好是 emoji：按码点切不应留半个代理对
  const emoji = fx.write('bin/emoji', `#!/bin/sh\necho "${'a'.repeat(119)}🙂${'b'.repeat(10)}"\n`, 0o755);
  assert.equal(agents.probeVersion(emoji), `${'a'.repeat(119)}🙂`);
  assert.equal(agents.probeVersion(path.join(fx.dir, 'nope')), '');
  const noExec = fx.write('bin/noexec', 'whatever\n');
  assert.equal(agents.probeVersion(noExec), '', '不可执行 ⇒ spawn 失败 ⇒ 空串');
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test('scanAgents：恒 1 条；PATH 命中假 dsh 时给 dsh-plugin:<路径> 与版本串', () => {
  const fx = tmpTree('ag-scan');
  const fake = fx.write('bin/dsh', '#!/bin/sh\necho "dsh 9.9.9-parity"\n', 0o755);
  const got = withEnv({ PATH: path.join(fx.dir, 'bin') }, () => agents.scanAgents());
  assert.equal(got.length, 1, '下拉里有且只有这一条');
  assert.deepEqual(Object.keys(got[0]), ['name', 'path', 'version', 'found']);
  assert.equal(got[0].name, agents.PLUGIN_ENTRY_NAME);
  assert.equal(got[0].path, `dsh-plugin:${fake}`);
  assert.equal(got[0].version, 'dsh 9.9.9-parity');
  assert.equal(got[0].found, true);
  fs.rmSync(fx.dir, { recursive: true, force: true });
});
