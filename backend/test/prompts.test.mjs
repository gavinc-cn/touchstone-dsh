/**
 * `backend/lib/prompts.js` 单测（node --test，零依赖）。
 *
 * 只覆盖**对拍量具测不到或难以覆盖**的面（`tools/parity/cases-mod/prompts.json` 已经逐字节
 * 比过 80 个 call op 的返回值与 6 份状态快照，那边是「与 Python 等价」的主判据）：
 *   ① **进程级缓存**：`_ASSET_CACHE` 命中时不再碰磁盘（量具比的是值，字符串相等对「有没有
 *      重读」不敏感——这里用「往缓存里塞哨兵对象再调一次」把「命中即返回同一对象」钉死）；
 *   ② **资产缺失/为空**：两条分支都要抛 `RuntimeError`（消息里的绝对路径逐字核）；
 *   ③ **`json.loads` 的读侧口径**：非 dict → 调用方 `.get` 抛 `AttributeError`；`NaN`/`Infinity`
 *      字面量在 Python 合法、`JSON.parse` 非法（`db.js` 的 `pyJsonLoads` 未导出，本文件另有一份）；
 *      非 str 入参抛 `TypeError`（Python 只 catch `ValueError`，TypeError 照旧冒出去）；
 *   ④ **截断边界**：`commits[:60]` / `files[:50]` / `code_refs[:100]`——最后一条是**码点**切片，
 *      边界落在 emoji 上时 JS 的 `String.slice` 会切出半个代理对（量具侧有真 git 夹具，
 *      这里用「假 git 脚本 + 精确边界语料」把数字钉死，不依赖本机仓库状态）；
 *   ⑤ **oracle 的活缺陷**：`retest_prompt` 的 `NameError` 与 `first_round_prompt` 的同一条路径；
 *   ⑥ **`git_log_changes`**（M6-4 新落 `lib.gitLogChanges`）：块分隔/去重排序/条数截断/
 *      stderr 码点截断/非零退出降级——全部用**假 git 脚本**驱动：不执行真 git、不碰任何仓库。
 *
 * 全部用例都在 mkdtemp 目录里造数据；`TS_RAG_CONFIG` 指向不存在的文件（本机 `~/.touchstone/rag.json`
 * 存在，不钉住就会真的触网检索）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { gitLogChanges, readText } from '../lib/lib.js';
import { t as i18nT } from '../lib/i18n.js';
import * as prompts from '../lib/prompts.js';

// --------------------------------------------------------------------------
// 夹具工具
// --------------------------------------------------------------------------

/** 建临时目录 */
function tmpDir(tag = 'ts-prompts-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), tag));
}

/** 写文件（自动建父目录） */
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/** 造「项目视图 / 任务视图」（键集照 `db.project_view` / tasks 行，与 Python 单测同构） */
function project(wd, kw = {}) {
  return {
    id: 7, name: '示例项目', project_dir: path.join(wd, 'repo'), work_dir: wd,
    env_label: '', guide_text: '', skill_understand: '', skill_deploy: '', skill_commit: '',
    skill_test: '', skill_cases: '',
    cases_root: path.join(wd, 'free_style'), bug_dir: path.join(wd, 'bug_report'), ...kw,
  };
}

function task(kw = {}) {
  return {
    id: 101, project_id: 7, task_type: 'normal', start_stage: '', end_stage: '', payload: '',
    extra: '', auto_fix: 0, retest: '不复测', auto_commit: 0, auto_deploy: 0, auto_retest: 0,
    date_from: '', date_to: '', ...kw,
  };
}

/** 建「案例库 + 一枚关联 FS0001/FS0002 的报告」环境，返回 {proj, bugName} */
function bugEnv(wd, kw = {}) {
  const proj = project(wd, kw);
  for (const [cid, name] of [['FS0001', '登录超时'], ['FS0002', '导出超时']]) {
    write(path.join(proj.cases_root, 'mod_login', `${cid}_${name}`, 'case.md'),
      `# ${cid}\n\n- **用例 ID**: ${cid}\n- **依据代码**: src/login.py\n`);
    write(path.join(proj.cases_root, 'mod_login', `${cid}_${name}`, 'status.md'), '- **状态**: 未执行\n');
  }
  const bugName = '20260901_1200_FS0001_登录异常';
  write(path.join(proj.bug_dir, bugName, 'bug_report.md'),
    '# 登录接口异常\n\n- **状态**: 待分析\n\n关联用例：FS0001、FS0002\n');
  return { proj, bugName };
}

/**
 * 在 PATH 前端放一个**假 git** 脚本跑一段代码（用完还原 PATH、删临时目录）。
 *
 * 为什么不跑真 git：单测不得依赖/触碰任何真仓库（提交由受控通道走），而 `gitLogChanges`
 * 的可观察面全在「怎么解析 git 的输出」——假脚本能把 61 条提交、51 个文件、非零退出、
 * 带 emoji 的 stderr 精确造出来，真仓库反而造不动。
 */
function withFakeGit(script, fn) {
  const dir = tmpDir('ts-fakegit-');
  const bin = path.join(dir, 'git');
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
  try {
    return fn(dir);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 假 git：输出写死在文件里（脚本只用 `cat`，不引外部依赖） */
function cannedGit(canned, { failStderr = '' } = {}) {
  return `#!/bin/sh
if [ -f "${canned}.fail" ]; then
  cat "${canned}.fail" >&2
  exit 128
fi
cat "${canned}"
`;
}

/** 造「一屏 git log --pretty=… --name-only」文本：每块以 \x00 开头 */
function logBlocks(commits) {
  return commits.map(([head, ...files]) => `\x00${head}\n${files.join('\n')}`).join('\n');
}

// 单测不触网：RAG 配置指向不存在的文件（本机 ~/.touchstone/rag.json 是存在的）
const NO_RAG = path.join(os.tmpdir(), 'ts-prompts-no-such-rag.json');
process.env.TS_RAG_CONFIG = NO_RAG;

// --------------------------------------------------------------------------
// ① 资产加载与进程级缓存
// --------------------------------------------------------------------------

test('_load_asset：读出真实资产全文，缓存键是 "/".join(names)', () => {
  const flow = prompts._load_asset('flow.md');
  assert.equal(flow, readText(path.join(prompts._ASSET_DIR, 'flow.md')));
  assert.ok(flow.includes('# 自由风格探索性测试（Free Style Test）流程'));
  const tpl = prompts._load_asset('templates', 'case_template.md');
  assert.ok(tpl.includes('# FS0000_用例名称'));
  assert.equal(prompts._ASSET_CACHE.get('templates/case_template.md'), tpl);
  // T15：英文模板走 `_load_asset_lang`，与中文键分开缓存（此处只钉「读得到 + 是英文」）
  const enTpl = prompts._load_asset_lang('en', 'templates', 'case_template.md');
  assert.ok(enTpl.includes('# FS0000_Case name'));
  assert.notEqual(enTpl, tpl);
  assert.equal(prompts._ASSET_CACHE.get('en:templates/case_template.md'), enTpl);
  // `_ASSET_DIR` 推的是仓库根下的 builtin_prompts/free_style（不是 backend/lib/…）
  assert.ok(fs.existsSync(path.join(prompts._ASSET_DIR, 'templates', 'bug_report_template.md')));
});

test('_load_asset：命中缓存时不再碰磁盘（哨兵对象原样返回）', () => {
  const key = 'flow.md';
  const real = prompts._ASSET_CACHE.get(key);
  assert.ok(real, '前置：flow.md 已在缓存里');
  const sentinel = { iAmA: 'sentinel' };
  prompts._ASSET_CACHE.set(key, sentinel);
  try {
    // 若实现是「每次重新读盘」，这里会拿到 flow.md 的文本而不是哨兵
    assert.equal(prompts._load_asset(key), sentinel);
    assert.equal(prompts._load_asset('flow.md'), sentinel);      // 同 key 二次调用仍是同一对象
  } finally {
    prompts._ASSET_CACHE.set(key, real);
  }
});

test('_load_asset：文件缺失 → RuntimeError（消息含绝对路径，照 Python 文案）', () => {
  assert.throws(() => prompts._load_asset('nope.md'), (e) => {
    assert.equal(e.constructor.name, 'RuntimeError');
    assert.equal(e.message, `内置提示词资产缺失或为空: ${path.join(prompts._ASSET_DIR, 'nope.md')}`);
    return true;
  });
  // 失败不进缓存（下次仍然抛，而不是缓存一个 undefined）
  assert.equal(prompts._ASSET_CACHE.has('nope.md'), false);
});

test('_load_asset：目录（读出来是空串）→ 同样按「缺失或为空」抛 RuntimeError', () => {
  assert.throws(() => prompts._load_asset('templates'), (e) => {
    assert.equal(e.constructor.name, 'RuntimeError');
    assert.equal(e.message, `内置提示词资产缺失或为空: ${path.join(prompts._ASSET_DIR, 'templates')}`);
    return true;
  });
});

test('_free_style_doc / _stress_doc：五份/五份资产按分隔线拼接，末尾无多余换行', () => {
  const doc = prompts._free_style_doc();
  assert.equal(doc.split('\n\n---\n\n').length, 5);
  assert.ok(doc.startsWith(prompts._load_asset('flow.md')));
  assert.ok(doc.endsWith(prompts._load_asset('templates', 'bug_report_template.md')));
  const stress = prompts._stress_doc();
  assert.equal(stress.split('\n\n---\n\n').length, 5);
  assert.ok(stress.startsWith(prompts._load_asset('load_test.md')));
});

// --------------------------------------------------------------------------
// ② payload：json.loads 的读侧口径
// --------------------------------------------------------------------------

test('_task_payload：合法 JSON 原样返回；空/非法回落 {}', () => {
  assert.deepEqual(prompts._task_payload(task({ payload: '{"a": 1, "b": [2, {"c": null}]}' })),
    { a: 1, b: [2, { c: null }] });
  assert.deepEqual(prompts._task_payload(task({ payload: '[1, 2]' })), [1, 2]);
  assert.deepEqual(prompts._task_payload(task({ payload: '' })), {});
  assert.deepEqual(prompts._task_payload(task({ payload: '   ' })), {});
  assert.deepEqual(prompts._task_payload(task({ payload: '{"a": ' })), {});
  assert.deepEqual(prompts._task_payload(task({ payload: null })), {});
});

test('_task_payload：`NaN`/`Infinity` 字面量按 CPython 口径解析（JSON.parse 会直接抛）', () => {
  const bad = prompts._task_payload(task({ payload: '{"a": NaN, "b": Infinity, "c": -Infinity}' }));
  assert.ok(Number.isNaN(bad.a));
  assert.equal(bad.b, Infinity);
  assert.equal(bad.c, -Infinity);
  // 字符串里的同名文本不动（不是「无脑替换」）
  assert.deepEqual(prompts._task_payload(task({ payload: '{"a": "NaN"}' })), { a: 'NaN' });
});

test('_task_payload：非 str/bytes 入参抛 TypeError（Python 只 catch ValueError）', () => {
  assert.throws(() => prompts._task_payload(task({ payload: 5 })), (e) => {
    assert.equal(e.constructor.name, 'TypeError');
    assert.match(e.message, /must be str, bytes or bytearray, not int/);
    return true;
  });
});

test('_task_payload：非 dict JSON 由调用方 `.get` 抛 AttributeError（消息照 Python）', () => {
  const t = task({ payload: '[1, 2]' });
  assert.throws(() => prompts._linked_bug(project(tmpDir()), t), (e) => {
    assert.equal(e.constructor.name, 'AttributeError');
    assert.equal(e.message, "'list' object has no attribute 'get'");
    return true;
  });
  assert.throws(() => prompts._reject_reason(task({ payload: '5' })), (e) => {
    assert.equal(e.constructor.name, 'AttributeError');
    assert.equal(e.message, "'int' object has no attribute 'get'");
    return true;
  });
  assert.throws(() => prompts._reject_reason(task({ payload: 'null' })), (e) => {
    assert.equal(e.constructor.name, 'AttributeError');
    assert.equal(e.message, "'NoneType' object has no attribute 'get'");
    return true;
  });
});

test('_reject_reason / _linked_bug：三态（有值 / 缺键 / 非法）', () => {
  assert.equal(prompts._reject_reason(task({ payload: '{"reason": "误报"}' })), '误报');
  assert.equal(prompts._reject_reason(task({ payload: '{"reason": ""}' })), '（未填写）');
  assert.equal(prompts._reject_reason(task({ payload: '{"other": 1}' })), '（未填写）');
  assert.equal(prompts._reject_reason(task({ payload: '不是 JSON' })), '（未填写）');

  const wd = tmpDir();
  const { proj, bugName } = bugEnv(wd);
  assert.deepEqual(prompts._linked_bug(proj, task({ payload: JSON.stringify({ bug_dir: bugName }) })),
    [bugName, readText(path.join(proj.bug_dir, bugName, 'bug_report.md'))]);
  assert.equal(prompts._linked_bug(proj, task({ payload: '{}' })), null);
  assert.equal(prompts._linked_bug(proj, task({ payload: JSON.stringify({ bug_dir: 'nope' }) })), null);
  // 报告文件为空 ⇒ 也按「无报告」处理
  write(path.join(proj.bug_dir, 'empty_bug', 'bug_report.md'), '');
  assert.equal(prompts._linked_bug(proj, task({ payload: JSON.stringify({ bug_dir: 'empty_bug' }) })), null);
});

// --------------------------------------------------------------------------
// ③ 截断边界（commits[:60] / files[:50] / code_refs[:100]）
// --------------------------------------------------------------------------

test('gitLogChanges：块分隔/去重排序/条数截断（commits[:60] 的上游）', () => {
  const dir = tmpDir('ts-git-');
  const canned = path.join(dir, 'canned.txt');
  const commits = Array.from({ length: 61 }, (_, i) => [
    `c${String(i).padStart(7, '0')} 2026-01-01 ts-parity commit ${i}`,
    'src/b.py', 'src/a.py', 'src/a.py',
  ]);
  fs.writeFileSync(canned, `${logBlocks(commits)}\n`);
  try {
    withFakeGit(cannedGit(canned), () => {
      const r = gitLogChanges('/whatever', '2026-01-01', '2026-01-02');
      assert.equal(r.ok, true);
      assert.equal(r.commits.length, 61);                       // 默认 limit=100
      assert.deepEqual(r.files, ['src/a.py', 'src/b.py']);      // 去重 + 码点升序
      assert.equal(r.commits[0], 'c0000000 2026-01-01 ts-parity commit 0');
      assert.equal(gitLogChanges('/whatever', '', '', 60).commits.length, 60);   // commits[:60]
      assert.equal(gitLogChanges('/whatever', '', '', 0).commits.length, 0);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gitLogChanges：非零退出 → ok=False + stderr（按码点截 300）；空块不算提交', () => {
  const dir = tmpDir('ts-git-');
  const canned = path.join(dir, 'canned.txt');
  // 61 个字符 + emoji + 尾巴：[:300] 必须切在第 300 个**码点**上（JS slice 会劈开代理对）
  const longErr = `${'E'.repeat(299)}😀TAIL`;
  fs.writeFileSync(canned, '\x00\n\x00\n\x00head 2026-01-01 a b\n');
  fs.writeFileSync(`${canned}.fail`, longErr);
  try {
    withFakeGit(cannedGit(canned), () => {
      const r = gitLogChanges('/x');
      assert.equal(r.ok, false);
      assert.equal(Array.from(r.error).length, 300);
      assert.equal(r.error, `${'E'.repeat(299)}😀`);
      assert.equal(r.error.endsWith('\ud83d'), false, '不能切出半个代理对');
    });
    fs.rmSync(`${canned}.fail`);
    withFakeGit(cannedGit(canned), () => {
      const r = gitLogChanges('/x');
      assert.equal(r.ok, true);
      assert.deepEqual(r.commits, ['head 2026-01-01 a b']);     // 前两个空块跳过、无变更文件
      assert.deepEqual(r.files, []);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('_date_range_ctx：files[:50] 截断 + 「…共 N 个」后缀（N 是去重后的真实条数）', () => {
  const dir = tmpDir('ts-git-');
  const canned = path.join(dir, 'canned.txt');
  const files = Array.from({ length: 51 }, (_, i) => `bulk/f${String(i + 1).padStart(2, '0')}.txt`);
  fs.writeFileSync(canned, `${logBlocks([['abc1234 2026-01-01 ts-parity bulk add', ...files]])}\n`);
  const wd = tmpDir();
  const proj = project(wd);
  try {
    withFakeGit(cannedGit(canned), () => {
      const ctx = prompts._date_range_ctx(proj, task({ date_from: '2026-01-01', date_to: '2026-01-01' }));
      const lines = ctx.split('\n');
      assert.equal(lines[0], '- 提交日期范围：2026-01-01 .. 2026-01-01（本任务优先覆盖该范围内提交）');
      assert.equal(lines[1], '- 范围内提交（1 条）：');
      assert.equal(lines[2], '  abc1234 2026-01-01 ts-parity bulk add');
      assert.equal(lines[3], '- 变更文件（51 个，去重）：');
      const listed = [];
      for (let i = 4; i < lines.length; i += 1) {
        if (!lines[i].startsWith('  ')) break;
        listed.push(lines[i].slice(2));
      }
      assert.equal(listed.length, 50);                          // files[:50]
      assert.equal(listed[49], 'bulk/f50.txt …共 51 个');        // 后缀贴在最后一个文件后
      assert.ok(!ctx.includes('bulk/f51.txt'));
      // 刚好 50 个：不出现省略后缀
      fs.writeFileSync(canned, `${logBlocks([['abc1234 2026-01-01 ts-parity x', ...files.slice(0, 50)]])}\n`);
      const ctx50 = prompts._date_range_ctx(proj, task({ date_from: '2026-01-01' }));
      assert.ok(ctx50.includes('- 变更文件（50 个，去重）：'));
      assert.ok(!ctx50.includes('…共'));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('_date_range_ctx：commits[:60] 截断（第 61 条不注入）', () => {
  const dir = tmpDir('ts-git-');
  const canned = path.join(dir, 'canned.txt');
  const commits = Array.from({ length: 61 }, (_, i) => [`c${i} 2026-01-01 a s${i}`, 'f.txt']);
  fs.writeFileSync(canned, `${logBlocks(commits)}\n`);
  try {
    withFakeGit(cannedGit(canned), () => {
      const ctx = prompts._date_range_ctx(project(tmpDir()), task({ date_from: '2026-01-01' }));
      assert.ok(ctx.includes('- 范围内提交（61 条）：'));
      assert.ok(ctx.includes('  c59 2026-01-01 a s59'));
      assert.ok(!ctx.includes('c60 2026-01-01 a s60'));          // 第 61 条被 [:60] 截掉
      assert.equal(ctx.split('\n').filter((ln) => ln.startsWith('  c')).length, 60);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// 最近变更优先（无日期范围的默认优先范围；取数走 lib.gitRecentCommits）
// --------------------------------------------------------------------------

/** 最近提交的假 git 输出：块首行是 TAB 分隔的 hash/日期/标题（标题含空格不能按空格切） */
function recentBlocks(commits) {
  return commits.map(([head, ...files]) => `\x00${head}\n${files.join('\n')}`).join('\n');
}

test('normal_prompt：无日期范围默认注入「最近变更优先」段（按天倒序、逐条列变更文件）', () => {
  const dir = tmpDir('ts-git-');
  const canned = path.join(dir, 'canned.txt');
  const argsFile = path.join(dir, 'args.txt');
  fs.writeFileSync(canned, recentBlocks([
    ['abc1234\t2026-10-13\trefactor(interface): 定长字符类型宏', 'src/a.h', 'src/b.h'],
    ['def5678\t2026-10-13\ttest: 补单测', 'test/c.cpp'],
    ['aaa1111\t2026-10-12\tfix: 修复下单链路', 'src/order.py'],
  ]));
  // 记录 argv 以钉死 `-n 30`（条数上限若漏传，夹具输出相同会静默通过）
  const script = `#!/bin/sh
printf '%s\\n' "$*" > "${argsFile}"
cat "${canned}"
`;
  const proj = project(tmpDir());
  try {
    withFakeGit(script, () => {
      const p = prompts.normal_prompt(proj, task());
      assert.ok(p.includes('- 优先范围（最近变更优先）：'));
      assert.ok(p.includes('按功能聚类并合并同一功能的跨天改动'));
      assert.ok(p.includes('「最近变更与功能合并规则」'));
      assert.ok(p.includes('- 最近变更（按提交日期倒序，最多 30 条提交）：'));
      assert.ok(p.includes('  【2026-10-13】2 条提交：'));
      assert.ok(p.includes('  【2026-10-12】1 条提交：'));
      assert.ok(p.indexOf('【2026-10-13】') < p.indexOf('【2026-10-12】'));
      assert.ok(p.includes('    - abc1234 refactor(interface): 定长字符类型宏'));
      assert.ok(p.includes('      文件：src/a.h、src/b.h'));
      assert.ok(p.includes('      文件：src/order.py'));
      assert.ok(p.indexOf('- 优先范围（最近变更优先）') < p.indexOf('- 停止条件'));
      assert.ok(readText(argsFile).includes(' -n 30 '), readText(argsFile));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('normal_prompt：「最近变更」每条提交文件最多 8 个；失败/空仓库降级仍留规则', () => {
  const dir = tmpDir('ts-git-');
  const canned = path.join(dir, 'canned.txt');
  const files = Array.from({ length: 10 }, (_, i) => `src/f${i}.py`);
  fs.writeFileSync(canned, recentBlocks([['abc1234\t2026-10-13\tfeat: 大改动', ...files]]));
  const proj = project(tmpDir());
  try {
    withFakeGit(cannedGit(canned), () => {
      const p = prompts.normal_prompt(proj, task());
      assert.ok(p.includes(`      文件：${files.slice(0, 8).join('、')} …共 10 个`));
      assert.ok(!p.includes('src/f8.py') && !p.includes('src/f9.py'));
    });
    fs.writeFileSync(`${canned}.fail`, 'fatal: boom');
    withFakeGit(cannedGit(canned), () => {
      const p = prompts.normal_prompt(proj, task());
      assert.ok(p.includes('- 优先范围（最近变更优先）：'));
      assert.ok(p.includes('git 摘录失败（fatal: boom）'));
      assert.ok(p.includes('请自行用 git log 等分析最近改动'));
      assert.ok(p.includes('无法判断时按功能分级推进'));
    });
    fs.rmSync(`${canned}.fail`);
    fs.writeFileSync(canned, '');
    withFakeGit(cannedGit(canned), () => {
      const p = prompts.normal_prompt(proj, task());
      assert.ok(p.includes('仓库没有提交记录'));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('normal_prompt：显式日期范围优先，不叠加「最近变更优先」段', () => {
  const dir = tmpDir('ts-git-');
  const canned = path.join(dir, 'canned.txt');
  // 日期范围路径走 gitLogChanges（块首行空格分隔）：这里只要求取数成功
  fs.writeFileSync(canned, `${logBlocks([['abc1234 2026-01-01 ts-parity x', 'src/a.py']])}\n`);
  const proj = project(tmpDir());
  try {
    withFakeGit(cannedGit(canned), () => {
      const p = prompts.normal_prompt(proj, task({ date_from: '2026-01-01', date_to: '2026-01-02' }));
      assert.ok(p.includes('- 提交日期范围：2026-01-01 .. 2026-01-02'));
      assert.ok(!p.includes('- 优先范围（最近变更优先）'));
      assert.ok(!p.includes('最多 30 条提交'));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('retest_range_prompt：code_refs[:100] 按**码点**截断（emoji 恰在第 100 个码点）', async () => {
  const wd = tmpDir();
  const { proj } = bugEnv(wd);
  const refs = `${'A'.repeat(99)}😀ZZZ`;
  write(path.join(proj.cases_root, 'mod_export', 'FS0003_边界', 'case.md'),
    `# FS0003\n\n- **用例 ID**: FS0003\n- **依据代码**: ${refs}\n`);
  write(path.join(proj.cases_root, 'mod_export', 'FS0003_边界', 'status.md'), '- **状态**: 未执行\n');
  const p = await prompts.retest_range_prompt(proj, task({ task_type: 'retest_bug', date_from: '2026-01-01' }));
  assert.ok(p.includes(`依据代码：${'A'.repeat(99)}😀）`), 'emoji 必须整只保留（码点切片）');
  assert.ok(!p.includes(`${'A'.repeat(99)}\ud83d）`), '不能只切到半个代理对');
  assert.ok(!p.includes('ZZZ'), '[:100] 之后的尾巴不能出现');
  assert.equal(Array.from(`${'A'.repeat(99)}😀`).length, 100);
});

// --------------------------------------------------------------------------
// ④ 分派 / 异常分支（oracle 缺陷照抄）
// --------------------------------------------------------------------------

test('first_round_prompt：七类 task_type 分派 + 空/未知回落 normal', async () => {
  const wd = tmpDir();
  const { proj, bugName } = bugEnv(wd);
  const payload = JSON.stringify({ bug_dir: bugName });
  const titles = {
    '': '执行一轮自由风格探索测试',
    normal: '执行一轮自由风格探索测试',
    mystery: '执行一轮自由风格探索测试',
    regression: '执行一轮存量用例回归',
    stress: '压测任务（第 1 步/共 2 步',
    fix: '处理以下 bug 报告（任务范围：',
    retest_bug: '复测以下 bug 报告关联的全部用例',
    pipeline: '后段任务：处理前一段探索/回归任务产出的全部 bug 报告',
    reject: '以下 bug 报告已被用户拒绝',
  };
  for (const [tt, title] of Object.entries(titles)) {
    const p = await prompts.first_round_prompt(proj, task({ task_type: tt, payload }));
    assert.ok(p.includes(title), `${tt} → ${title}`);
    assert.equal(p.includes('执行一轮自由风格探索测试') && tt !== '' && tt !== 'normal' && tt !== 'mystery',
      false, `${tt} 不该串到 normal 文案`);
  }
  // 阶段进度上报只给 fix/retest_bug/pipeline/regression
  for (const [tt, want] of [['fix', true], ['retest_bug', true], ['pipeline', true], ['regression', true],
    ['normal', false], ['stress', false], ['reject', false]]) {
    const p = await prompts.first_round_prompt(proj, task({ task_type: tt, payload }));
    assert.equal(p.includes('阶段进度上报（仅监控展示）'), want, tt);
  }
  // extra 非空：末尾追加并 strip
  const withExtra = await prompts.first_round_prompt(proj, task({ extra: '  追加要求  ' }));
  assert.ok(withExtra.endsWith('\n\n---\n用户附加要求（平台转达，务必遵守；如与上面约束冲突以本段为准）:\n追加要求\n'));
});

test('retest_prompt：未绑定报告 + 日期范围 ⇒ 照抄 oracle 的 NameError（活缺陷）', async () => {
  const wd = tmpDir();
  const proj = project(wd);
  const t = task({ task_type: 'retest_bug', date_from: '2026-01-01', date_to: '2026-01-31' });
  await assert.rejects(() => prompts.retest_prompt(proj, t), (e) => {
    assert.equal(e.constructor.name, 'NameError');
    assert.equal(e.message, "name 'log' is not defined");
    return true;
  });
  // first_round_prompt 走同一条路径（prompts.py:353）
  await assert.rejects(() => prompts.first_round_prompt(proj, t), (e) => e.constructor.name === 'NameError');
  // 未绑定报告且**无**日期范围：正常回落 normal（这条才对）
  const p = await prompts.retest_prompt(proj, task({ task_type: 'retest_bug' }));
  assert.ok(p.includes('执行一轮自由风格探索测试'));
});

test('fix_prompt / pipeline_prompt：未知 end_stage 照旧抛 KeyError / ValueError', async () => {
  const wd = tmpDir();
  const { proj, bugName } = bugEnv(wd);
  assert.throws(() => prompts.fix_prompt(proj,
    task({ task_type: 'fix', end_stage: 'bogus', payload: JSON.stringify({ bug_dir: bugName }) })),
  (e) => {
    assert.equal(e.constructor.name, 'KeyError');
    assert.equal(e.message, "'bogus'");                       // Python: str(KeyError('bogus'))
    return true;
  });
  assert.throws(() => prompts.pipeline_prompt(proj, task({ task_type: 'pipeline', end_stage: 'bogus' })),
    (e) => {
      assert.equal(e.constructor.name, 'ValueError');
      assert.equal(e.message, 'tuple.index(x): x not in tuple');
      return true;
    });
  // 合法终点不抛：fix 的四分支各自带标志段
  const branches = { analyze: '终点即报告分析', fix: '阶段二 问题修复', deploy: '阶段三 重新部署',
    retest: '阶段四 复测（本任务内执行）' };
  for (const [end, mark] of Object.entries(branches)) {
    const p = prompts.fix_prompt(proj, task({ task_type: 'fix', end_stage: end,
      payload: JSON.stringify({ bug_dir: bugName }) }));
    assert.ok(p.includes(mark), end);
  }
});

test('_project_context / normal_prompt 的 end_stage 收窄与真值口径', () => {
  const wd = tmpDir();
  const proj = project(wd);
  assert.equal(prompts._project_context(proj), '');
  assert.ok(!prompts.normal_prompt(proj, task()).includes('- 项目上下文：'));
  // 全空白字段按「未配置」处理（(x or "").strip() 口径）
  const blank = project(wd, { env_label: ' \t\n ', guide_text: '  ', skill_test: '\u3000' });
  assert.equal(prompts._project_context(blank), '');
  const set = project(wd, { env_label: 'A', guide_text: 'G', skill_understand: 'U',
    skill_test: 'T', skill_cases: 'C' });
  assert.equal(prompts._project_context(set),
    '- 环境标签：A（测试/修复/部署针对该环境）\n'
    + '- 项目附加提示（如何理解项目/写 commit/部署等）：\n  G\n'
    + '- 理解项目：优先使用 skill「U」分析项目结构与约定\n'
    + '- 测试项目：优先使用 skill「T」了解本项目的测试方式（启动/运行/环境/压测等要求）\n'
    + '- 用例规范：生成用例时遵循 skill「C」的用例命名/结构/登记规范');
  // auto_fix 真值：0/None/"" 都是「关」，1/"1" 是「开」
  for (const [v, want] of [[0, '关'], [null, '关'], ['', '关'], [1, '开'], ['1', '开']]) {
    assert.ok(prompts.normal_prompt(proj, task({ auto_fix: v })).includes(`- 选项：自动修复=${want}；`));
  }
  // end_stage：gen_case / execute 各加收窄段，report 与空值不加
  assert.ok(prompts.normal_prompt(proj, task({ end_stage: 'gen_case' })).includes('严禁执行用例、严禁发起任何请求'));
  assert.ok(prompts.normal_prompt(proj, task({ end_stage: 'execute' })).includes('严禁写 bug 报告'));
  for (const end of ['', 'report', 'analyze']) {
    assert.ok(!prompts.normal_prompt(proj, task({ end_stage: end })).includes('- 任务终点='));
  }
});

test('_semantic_order：RAG 未配置 ⇒ 返回 [] 且不触发检索（不触网）', async () => {
  const wd = tmpDir();
  assert.equal(process.env.TS_RAG_CONFIG, NO_RAG);
  assert.deepEqual(await prompts._semantic_order(project(wd), task({ date_from: '2026-01-01' })), []);
  // log 回调在这条路径上一次都不该被调用（没检索就没有统计行）
  let called = 0;
  await prompts._semantic_order(project(wd), task({ date_from: '2026-01-01' }), () => { called += 1; });
  assert.equal(called, 0);
});

test('next_round_prompt / compact_prompt：续轮分版与常量', () => {
  const p = prompts.next_round_prompt(3);
  assert.ok(p.includes('继续执行自由风格探索测试第 3 轮'));
  // 多轮任务：续轮先继续未覆盖的「最近变更」功能组，再回落到功能分级
  assert.ok(p.includes('最近变更') && p.includes('变更功能组'));
  assert.ok(p.indexOf('变更功能组') < p.indexOf('功能分级'));
  const r = prompts.next_round_prompt(2, task({ task_type: 'regression' }));
  assert.ok(r.includes('继续执行存量用例回归第 2 轮'));
  assert.ok(!r.includes('最近变更'));          // 回归不生成新用例，不注入变更优先
  assert.ok(prompts.next_round_prompt(1, task({ task_type: 'mystery' })).includes('继续执行自由风格探索测试第 1 轮'));
  assert.equal(prompts.compact_prompt(), '/compact');
  assert.deepEqual([...prompts.STAGE_ORDER], ['gen_case', 'execute', 'report', 'analyze', 'fix', 'deploy', 'retest']);
  assert.deepEqual(Object.keys(prompts.STAGE_LABELS), [...prompts.STAGE_ORDER]);
  assert.equal(prompts.STAGE_LABELS.fix, '问题修复');
});

// --------------------------------------------------------------------------
// 语言指令（T14：zh/en 头部唯一一段；除该段外 prompt 逐字节不变）
// --------------------------------------------------------------------------

const LANG_HEAD_ZH = '【产出语言】用中文撰写所有产出（用例、报告、日志）。\n\n---\n\n';
const LANG_HEAD_EN = '【产出语言】Write all deliverables (cases, reports, logs) in English.\n\n---\n\n';
const LANG_DIRECTIVE = '用中文撰写所有产出（用例、报告、日志）。';

test('prompt 指令词条：i18n prompt ns 的 key=中文原句、en 返回英文句', () => {
  assert.equal(i18nT('prompt', LANG_DIRECTIVE, 'en'),
    'Write all deliverables (cases, reports, logs) in English.');
  assert.equal(i18nT('prompt', LANG_DIRECTIVE, 'zh'), LANG_DIRECTIVE);
});

test('first_round_prompt：语言指令只加头部，去掉后与 builder 输出逐字节相同', async () => {
  const wd = tmpDir();
  const proj = project(wd);
  for (const [lang, head] of [['zh', LANG_HEAD_ZH], ['en', LANG_HEAD_EN]]) {
    for (const taskType of ['normal', 'mystery']) {
      const tk = task({ task_type: taskType, lang });
      const p = await prompts.first_round_prompt(proj, tk);
      assert.ok(p.startsWith(head), `${lang}/${taskType}`);
      assert.equal(p.split('【产出语言】').length - 1, 1);
      assert.equal(p.slice(head.length), prompts.normal_prompt(proj, tk));
    }
  }
});

test('语言来源走 taskLang：大写/空白识别 en，地区变体/脏值/缺失回落 zh', async () => {
  const proj = project(tmpDir());
  for (const lang of [undefined, null, '', 'zh', 'EN-US', 'fr', 'english']) {
    const p = await prompts.first_round_prompt(proj, task({ lang }));
    assert.ok(p.startsWith(LANG_HEAD_ZH), String(lang));
  }
  for (const lang of ['en', 'EN', ' en ']) {
    const p = await prompts.first_round_prompt(proj, task({ lang }));
    assert.ok(p.startsWith(LANG_HEAD_EN), String(lang));
  }
});

test('七类首轮都在最外层注入一次语言指令', async () => {
  const wd = tmpDir();
  const { proj, bugName } = bugEnv(wd);
  const payloads = {
    fix: { bug_dir: bugName },
    retest_bug: { bug_dir: bugName },
    reject: { bug_dir: bugName, reason: '误报' },
    pipeline: { bug_dirs: [bugName] },
    stress: { brief: '压测登录接口' },
    regression: {},
    normal: {},
  };
  for (const [taskType, data] of Object.entries(payloads)) {
    for (const [lang, head] of [['zh', LANG_HEAD_ZH], ['en', LANG_HEAD_EN]]) {
      const tk = task({
        task_type: taskType, lang,
        payload: Object.keys(data).length ? JSON.stringify(data) : '',
      });
      const p = await prompts.first_round_prompt(proj, tk);
      assert.ok(p.startsWith(head), `${taskType}/${lang}`);
      assert.equal(p.split('【产出语言】').length - 1, 1, `${taskType}/${lang}`);
    }
  }
});

test('next_round_prompt：同注入、task=null 回落 zh、两语言 body 相同；compact 不变', () => {
  const zh = prompts.next_round_prompt(3);
  assert.ok(zh.startsWith(LANG_HEAD_ZH));
  assert.equal(zh.slice(LANG_HEAD_ZH.length), prompts.next_round_prompt(3, task({ lang: 'zh' }))
    .slice(LANG_HEAD_ZH.length));
  const en = prompts.next_round_prompt(3, task({ lang: 'en' }));
  assert.ok(en.startsWith(LANG_HEAD_EN));
  assert.equal(en.slice(LANG_HEAD_EN.length), zh.slice(LANG_HEAD_ZH.length));
  assert.ok(prompts.next_round_prompt(3, null).startsWith(LANG_HEAD_ZH));
  assert.equal(prompts.compact_prompt(), '/compact');
});
