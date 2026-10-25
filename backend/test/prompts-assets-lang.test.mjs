/**
 * T15：内置模板英译 + `_load_asset_lang` 语言选择（Node 端，node --test）。
 *
 * 与 `tests/test_prompts_assets_lang.py` 同覆盖面：
 *   - 8 个英文模板齐备、`_load_asset_lang('en')` 返回英文全文；
 *   - zh/其它语言与旧 `_load_asset` **逐字节相同**且零 `console.warn`；
 *   - 英文缺失回落中文并**每资产只 warn 一次**（不抛错）；
 *   - 英文模板经 T14 解析器回读中文 canonical，`setMdField` 按英文键+英文值写回；
 *   - en 任务 normal/stress 首轮注入英文模板，zh 任务仍注入中文模板。
 *
 * 零外部依赖、离线：RAG 配置指向不存在的文件；项目目录是 mkdtemp（非 git 仓库）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { parseFields, parseStatusMd, readText, setMdField } from '../lib/lib.js';
import * as prompts from '../lib/prompts.js';

// 单测不触网：RAG 配置指向不存在的文件（本机 ~/.touchstone/rag.json 存在）
process.env.TS_RAG_CONFIG = path.join(os.tmpdir(), 'ts-prompts-en-no-such-rag.json');

const TEMPLATES = ['case_template.md', 'status_template.md', 'index_template.md',
  'bug_report_template.md', 'load_charts_template.md', 'load_index_template.md',
  'load_plan_template.md', 'load_scenario_template.md'];
const LANG_HEAD_EN = '【产出语言】Write all deliverables (cases, reports, logs) in English.\n\n---\n\n';
const INDEX_ROW_RE = new RegExp('^\\|\\s*(FS\\d{4})\\s*\\|([^|]+)\\|([^|]+)\\|([^|]+)\\|([^|]+)\\|', 'm');

function tmpDir(tag = 'ts-prompts-en-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), tag));
}

function project(wd) {
  return {
    id: 7, name: '示例项目', project_dir: path.join(wd, 'repo'), work_dir: wd,
    env_label: '', guide_text: '', skill_understand: '', skill_deploy: '', skill_commit: '',
    skill_test: '', skill_cases: '',
    cases_root: path.join(wd, 'free_style'), bug_dir: path.join(wd, 'bug_report'),
  };
}

function task(kw = {}) {
  return {
    id: 101, project_id: 7, task_type: 'normal', start_stage: '', end_stage: '', payload: '',
    extra: '', auto_fix: 0, retest: '不复测', auto_commit: 0, auto_deploy: 0, auto_retest: 0,
    date_from: '', date_to: '', lang: 'zh', ...kw,
  };
}

/** 把真实模板拷到临时文件（写回测试用；绝不动仓库内资产）。 */
function copyTemplate(dir, name) {
  const dst = path.join(dir, name);
  fs.writeFileSync(dst, readText(path.join(prompts._ASSET_DIR, 'templates', name)));
  return dst;
}

/** 在捕获 console.warn 的状态下跑一段代码，返回 {result, warnings}。 */
function captureWarn(fn) {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = orig;
  }
}

// --------------------------------------------------------------------------
// ① 英文模板齐备 + 语言选择
// --------------------------------------------------------------------------

test('8 个英文模板齐备；_load_asset_lang("en") 返回英文文件全文', () => {
  for (const name of TEMPLATES) {
    const want = readText(path.join(prompts._ASSET_DIR, 'templates', name.replace(/\.md$/, '.en.md')));
    assert.ok(want.trim(), name);
    assert.equal(prompts._load_asset_lang('en', 'templates', name), want, name);
  }
});

test('zh / 其它语言与旧 _load_asset 逐字节相同，且零 warning', () => {
  const { warnings } = captureWarn(() => {
    for (const lang of ['zh', 'zh-CN', 'zh_CN', '', null, undefined, 'fr', 'english']) {
      for (const name of TEMPLATES) {
        assert.equal(prompts._load_asset_lang(lang, 'templates', name),
          prompts._load_asset('templates', name), `${lang}/${name}`);
      }
    }
  });
  assert.deepEqual(warnings, []);
});

test('英文缓存键 en:... 与 zh 键并存、互不覆盖；命中缓存不再读盘', () => {
  const zh = prompts._load_asset('templates', 'status_template.md');
  const en = prompts._load_asset_lang('en', 'templates', 'status_template.md');
  assert.equal(prompts._ASSET_CACHE.get('templates/status_template.md'), zh);
  assert.equal(prompts._ASSET_CACHE.get('en:templates/status_template.md'), en);
  assert.notEqual(zh, en);
  const sentinel = { iAmA: 'sentinel' };
  prompts._ASSET_CACHE.set('en:templates/status_template.md', sentinel);
  try {
    assert.equal(prompts._load_asset_lang('en', 'templates', 'status_template.md'), sentinel);
  } finally {
    prompts._ASSET_CACHE.delete('en:templates/status_template.md');
  }
});

test('英文缺失回落中文、每资产只 warn 一次、不抛错（flow.md 无英文版）', () => {
  prompts._EN_ASSET_WARNED.clear();
  const freeStyle = prompts._load_asset('flow.md');
  const { result, warnings } = captureWarn(() => {
    const seen = [];
    for (let i = 0; i < 3; i += 1) seen.push(prompts._load_asset_lang('en', 'flow.md'));
    return seen;
  });
  assert.deepEqual(result, [freeStyle, freeStyle, freeStyle]);
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /英文资产缺失/);
  assert.match(warnings[0], /flow\.en\.md/);
  // zh 仍静默
  const again = captureWarn(() => prompts._load_asset_lang('zh', 'flow.md'));
  assert.deepEqual(again.warnings, []);
  assert.equal(again.result, freeStyle);
  prompts._EN_ASSET_WARNED.clear();
});

test('_free_style_doc / _stress_doc 按 lang 选模板；流程文档保持中文单份', () => {
  const zh = prompts._free_style_doc();
  assert.equal(zh, prompts._free_style_doc('zh'));
  for (const frag of ['# FS0000_用例名称', '# FS0000 状态', '# <目录名> 索引', '# <一句话标题>']) {
    assert.ok(zh.includes(frag), frag);
  }
  const en = prompts._free_style_doc('en');
  for (const frag of ['# FS0000_Case name', '# FS0000 Status', '# <directory name> Index',
    '## Related cases']) {
    assert.ok(en.includes(frag), frag);
  }
  for (const frag of ['# FS0000_用例名称', '# FS0000 状态', '# <目录名> 索引', '# <一句话标题>']) {
    assert.ok(!en.includes(frag), frag);
  }
  assert.ok(zh.startsWith(prompts._load_asset('flow.md')));
  assert.ok(en.startsWith(prompts._load_asset('flow.md')));

  const stressZh = prompts._stress_doc();
  assert.equal(stressZh, prompts._stress_doc('zh'));
  assert.ok(stressZh.includes('# 压测方案文档模板（plan.md）'));
  assert.ok(stressZh.startsWith(prompts._load_asset('load_test.md')));
  const stressEn = prompts._stress_doc('en');
  for (const frag of ['# Load test plan document template (plan.md)',
    '# Chart declaration template (charts.json)', '# Load test scenario JSON template',
    '# Load test scenario index']) {
    assert.ok(stressEn.includes(frag), frag);
  }
  assert.ok(!stressEn.includes('# 压测方案文档模板（plan.md）'));
  assert.ok(stressEn.startsWith(prompts._load_asset('load_test.md')));
});

// --------------------------------------------------------------------------
// ② 英文模板经 T14 解析器回读 canonical + 写回
// --------------------------------------------------------------------------

test('英文 status 模板 → 中文 canonical；setMdField 写英文键+英文值', () => {
  const dir = tmpDir();
  const file = copyTemplate(dir, 'status_template.en.md');
  const fields = parseFields(readText(file));
  assert.equal(fields['状态'], 'Not run / Pass / Failed / Skipped / Needs retest');
  assert.equal(fields['最近执行时间'], '%Y-%m-%d %H:%M');
  assert.ok(fields['执行轮次'].startsWith('Round N'));
  assert.equal(parseStatusMd(file).status, '未执行');

  assert.equal(setMdField(file, '状态', '失败'), true);
  let text = readText(file);
  assert.ok(text.includes('- **Status**: Failed'));
  assert.ok(!text.includes('**状态**'));
  assert.equal(text.split('**Status**:').length - 1, 1);
  assert.equal(parseStatusMd(file).status, '失败');

  assert.equal(setMdField(file, '结果摘要', 'code=0 返回 3 条记录'), true);
  text = readText(file);
  assert.ok(text.includes('- **Result summary**: code=0 返回 3 条记录'));
  assert.ok(!text.includes('- **结果摘要**'));
});

test('英文 bug 模板字段回读 canonical；状态写英文值；关联表/FS 号保留', () => {
  const dir = tmpDir();
  const file = copyTemplate(dir, 'bug_report_template.en.md');
  const fields = parseFields(readText(file));
  for (const key of ['状态', '严重程度', '报告时间', '执行环境', '错误签名']) {
    assert.ok(Object.hasOwn(fields, key), key);
  }
  assert.equal(fields['严重程度'], 'High / Medium / Low');
  assert.equal(fields['报告时间'], '%Y-%m-%d %H:%M');

  assert.equal(setMdField(file, '状态', '已分析，待修复'), true);
  assert.ok(readText(file).includes('- **Status**: Analyzed, to fix'));
  assert.equal(parseFields(readText(file))['状态'], '已分析，待修复');

  assert.equal(setMdField(file, '状态', '复测通过'), true);
  assert.ok(readText(file).includes('- **Status**: Retest passed'));
  const text = readText(file);
  assert.ok(text.includes('| Case ID | Case name | Status |'));
  assert.deepEqual(text.match(/FS\d{4}/g), ['FS0001']);
});

test('英文 case 模板 13 个字段归一到中文 canonical 键', () => {
  const dir = tmpDir();
  const fields = parseFields(readText(copyTemplate(dir, 'case_template.en.md')));
  assert.equal(fields['用例 ID'], 'FS0000');
  assert.ok(fields['接口'].startsWith('interface under test'));
  assert.ok(fields['所属模块/功能'].startsWith('Level-1 category'));
  assert.ok(fields['依据代码'].startsWith('(required)'));
  assert.ok(fields['脚本'].startsWith('(optional)'));
  // 既有 FIELD_RE 的 `\s*` 跨行 quirk（T14 §8.4 已登记）：空值字段吞下一行首行
  assert.equal(fields['测试方法'], '1. Step 1');
  assert.equal(fields['输入参数'], '```json');
  assert.deepEqual(Object.keys(fields).sort(), ['依据代码', '分类', '备注', '所属模块/功能',
    '接口', '测试方法', '测试目标', '用例 ID', '脚本', '输入参数', '输出获取方式', '预期输出',
    '验证逻辑'].sort());
});

test('英文 INDEX 模板用例行保持 FSxxxx + 5 列形状', () => {
  const text = readText(path.join(prompts._ASSET_DIR, 'templates', 'index_template.en.md'));
  const m = INDEX_ROW_RE.exec(text);
  assert.ok(m, '英文 INDEX 模板缺 FS 用例行');
  assert.equal(m[1], 'FS0001');
  assert.equal(m[2].trim(), 'Reject overlong request parameters');
  assert.ok(text.includes('Next available id: FS0001'));
});

// --------------------------------------------------------------------------
// ③ prompt 级：en 用英文模板、zh 用中文模板
// --------------------------------------------------------------------------

test('normal_prompt：en 注入英文模板、zh 注入中文模板；头部逐字节相同', () => {
  const proj = project(tmpDir());
  const en = prompts.normal_prompt(proj, task({ lang: 'en' }));
  const zh = prompts.normal_prompt(proj, task({ lang: 'zh' }));
  assert.ok(en.includes('# FS0000_Case name'));
  assert.ok(!en.includes('# FS0000_用例名称'));
  assert.ok(zh.includes('# FS0000_用例名称'));
  assert.ok(!zh.includes('# FS0000_Case name'));
  assert.ok(en.includes('执行一轮自由风格探索测试'));       // 约束块保持中文（D5）
  const flow = prompts._load_asset('flow.md');
  assert.equal(zh.slice(0, zh.indexOf(flow)), en.slice(0, en.indexOf(flow)));
  assert.ok(zh.endsWith(prompts._free_style_doc() + '\n'));
  assert.ok(en.endsWith(prompts._free_style_doc('en') + '\n'));
});

test('first_round_prompt：en 头部语言指令 + 英文模板，去头后与 builder 相同', async () => {
  const proj = project(tmpDir());
  for (const taskType of ['normal', 'mystery']) {
    const tk = task({ task_type: taskType, lang: 'en' });
    const p = await prompts.first_round_prompt(proj, tk);
    assert.ok(p.startsWith(LANG_HEAD_EN), taskType);
    assert.ok(p.includes('# FS0000_Case name'));
    assert.equal(p.slice(LANG_HEAD_EN.length), prompts.normal_prompt(proj, tk));
  }
});

test('stress_prompt：en 注入英文压测模板、zh 注入中文压测模板', () => {
  const proj = project(tmpDir());
  const en = prompts.stress_prompt(proj, task({ task_type: 'stress', lang: 'en' }));
  const zh = prompts.stress_prompt(proj, task({ task_type: 'stress', lang: 'zh' }));
  assert.ok(en.includes('# Load test plan document template (plan.md)'));
  assert.ok(!en.includes('# 压测方案文档模板（plan.md）'));
  assert.ok(zh.includes('# 压测方案文档模板（plan.md）'));
  assert.ok(!zh.includes('# Load test plan document template (plan.md)'));
  assert.ok(en.includes('压测任务（第 1 步/共 2 步'));   // 包装文案保持中文（D5）
});
