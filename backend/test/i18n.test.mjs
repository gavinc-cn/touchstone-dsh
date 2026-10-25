/**
 * 后端 i18n 运行时（Node）单测 + 与 Python 侧共享的期望表。
 *
 * 口径（与 `task-9-brief.md`、Controller 裁决和 `backend_py/i18n.py` 的测试逐条对齐）：
 *   ① zh 是源语言：不查表，直接把中文 key 插值返回；
 *   ② en 查 `dict[ns][key]`（string 或 {one, other} 复数对象），缺失/类型非法回落中文 key；
 *   ③ 插值只认 `{标识符}`，变量缺失/null/对象等保留占位符原样，绝不抛错；
 *   ④ 语言解析优先级 `X-TS-Lang` → `?lang=` → `userPref` → `zh`（非法值跳过、继续下一档）；
 *   ⑤ `TS_I18N=0` ⇒ 恒 zh；词典读不到/读坏 ⇒ 降级为仅中文且只 warning 一次。
 *
 * 用例真源是 `backend/test/i18n-cases.json`：本文件与 `tests/test_i18n.py` 读同一份
 * 文件、逐条断言同一输出，任何一端语义分叉都会在同一行失败。两端测试文件里不再各写
 * 一份手抄期望表。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, test } from 'node:test';

import { loadDict, normalizeLang, resetCache, resolveLang, t } from '../lib/i18n.js';

// 共享用例表：fixture 词典 + 全部断言（与 Python 测试同源）
const CASES_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'i18n-cases.json');
const CASES = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
const FIXTURE = CASES.fixture;
const T_CASES = CASES.cases.filter((c) => c.kind === 't');
const NORMALIZE_CASES = CASES.cases.filter((c) => c.kind === 'normalize');
const RESOLVE_CASES = CASES.cases.filter((c) => c.kind === 'resolve');
const DICT_CASES = CASES.cases.filter((c) => c.kind === 'dict');

let tmpDir = '';
let fixturePath = '';

/**
 * 把用例表里的特殊值标记还原成本平台的原生值。
 * JSON 无法表达 NaN/Infinity/undefined/抛错对象，故用 `{"$native": "..."}` 描述。
 */
function _materialize(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).length === 1 && typeof value.$native === 'string') {
    switch (value.$native) {
      case 'undefined':
        return undefined;
      case 'NaN':
        return NaN;
      case 'Infinity':
        return Infinity;
      case '-Infinity':
        return -Infinity;
      case 'throwingToString':
        // 任何字符串化/取值都抛错：实现若调用 String(value) 会炸，按契约必须保留占位符
        return {
          toString() { throw new Error('throwingToString'); },
          valueOf() { throw new Error('throwingToString'); },
        };
      case 'throwingProxy':
        // 属性 get 陷阱抛错的 Proxy（仅作为变量值时普通实现不会碰它，仍应保留占位符）
        return new Proxy({}, { get() { throw new Error('throwingProxy'); } });
      default:
        throw new Error(`未知 $native 标记: ${value.$native}`);
    }
  }
  return value;
}

/**
 * 构造用例的 vars。`varsNative: "throwingProxy"` 表示整个 vars 对象是抛错 Proxy：
 * 目标上确实有 v 属性，因此实现一旦读取 vars.v 就会触发 get 陷阱。
 */
function _buildVars(c) {
  if (c.varsNative === 'throwingProxy') {
    return new Proxy({ v: 1 }, { get() { throw new Error('throwingProxy vars'); } });
  }
  if (!Object.prototype.hasOwnProperty.call(c, 'vars')) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(c.vars)) out[key] = _materialize(value);
  return out;
}

/** 调 t()：lang 缺省时走函数默认参数（省略第三个实参）。 */
function _callT(c) {
  return t(c.ns, c.key, c.lang, _buildVars(c));
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-i18n-'));
  fixturePath = path.join(tmpDir, 'en.json');
  fs.writeFileSync(fixturePath, JSON.stringify(FIXTURE), 'utf8');
});

after(() => {
  delete process.env.TS_I18N;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetCache();
  delete process.env.TS_I18N;
});

// 用临时词典替换缓存（显式路径是 loadDict 的测试钩子）
function useFixtureDict() {
  loadDict(fixturePath);
}

test('zh 透传并插值：不查表，直接返回中文 key', () => {
  useFixtureDict();
  assert.equal(t('web', '保存', 'zh'), '保存');
  assert.equal(t('web', '共 {n} 张卡片', 'zh', { n: 3 }), '共 3 张卡片');
});

test('en 查表并插值', () => {
  useFixtureDict();
  assert.equal(t('web', '保存', 'en'), 'Save');
  assert.equal(t('web', '你好 {name}', 'en', { name: 'Ada' }), 'Hello Ada');
  assert.equal(t('api', '删除失败: {name}', 'en', { name: 'x' }), 'Delete failed: x');
});

test('en 复数：one/other 按 n 选择', () => {
  useFixtureDict();
  assert.equal(t('web', '共 {n} 张卡片', 'en', { n: 1 }), '1 card');
  assert.equal(t('web', '共 {n} 张卡片', 'en', { n: 2 }), '2 cards');
});

test('缺失 key / 缺失 ns / 非法词条回落中文 key', () => {
  useFixtureDict();
  assert.equal(t('web', '未收录', 'en'), '未收录');
  assert.equal(t('nope', '保存', 'en'), '保存');
  assert.equal(t('web', '非法词条', 'en'), '非法词条');
  assert.equal(t('prompt', '任意', 'en'), '任意');
});

test('共享用例表：t() 同输入同输出（与 Python 测试同源）', () => {
  useFixtureDict();
  for (const c of T_CASES) {
    assert.equal(_callT(c), c.expected, JSON.stringify(c));
  }
});

test('共享用例表：normalizeLang 大小写/地区变体与非法值', () => {
  for (const c of NORMALIZE_CASES) {
    assert.equal(normalizeLang(c.input), c.expected, JSON.stringify(c));
  }
});

test('共享用例表：resolveLang 优先级链（含重复头数组）', () => {
  for (const c of RESOLVE_CASES) {
    const got = resolveLang({ headers: c.headers, query: c.query, userPref: c.userPref });
    assert.equal(got, c.expected, JSON.stringify(c));
  }
});

test('共享用例表：非法词典根节点/NaN/Infinity 一律降级为中文', () => {
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  try {
    for (const [index, c] of DICT_CASES.entries()) {
      resetCache();
      const rawPath = path.join(tmpDir, `dict-${index}.json`);
      fs.writeFileSync(rawPath, c.raw, 'utf8');
      loadDict(rawPath);
      assert.equal(t(c.ns, c.key, c.lang), c.expected, JSON.stringify(c));
    }
  } finally {
    console.warn = originalWarn;
  }
});

test('resolveLang 支持 Map 头（键名大小写不敏感）', () => {
  assert.equal(resolveLang({ headers: new Map([['x-ts-lang', 'EN']]) }), 'en');
  assert.equal(resolveLang({ headers: new Map([['X-TS-Lang', 'en-US']]) }), 'en');
  assert.equal(resolveLang({ headers: new Map([['x-ts-lang', 'zh-CN']]) }), 'zh');
});

test('resolveLang 接受 URLSearchParams 与无参调用（缺省 zh）', () => {
  assert.equal(resolveLang({ query: new URLSearchParams('lang=en') }), 'en');
  assert.equal(resolveLang({ query: new URLSearchParams('lang=zh-CN') }), 'zh');
  assert.equal(resolveLang(), 'zh');
});

test('vars 非对象或取值抛错时不抛错且保留占位符', () => {
  useFixtureDict();
  assert.equal(t('web', '你好 {name}', 'zh', 'not-an-object'), '你好 {name}');
  assert.equal(t('web', '你好 {name}', 'zh', 42), '你好 {name}');
  assert.equal(t('web', '你好 {name}', 'zh', null), '你好 {name}');
  const proxy = new Proxy({ v: 1 }, { get() { throw new Error('boom'); } });
  assert.doesNotThrow(() => t('web', '代理 {v}', 'zh', proxy));
  assert.equal(t('web', '代理 {v}', 'zh', proxy), '代理 {v}');
  const bad = {
    toString() { throw new Error('boom'); },
    valueOf() { throw new Error('boom'); },
  };
  assert.doesNotThrow(() => t('web', '值 {v}', 'en', { v: bad }));
  assert.equal(t('web', '值 {v}', 'en', { v: bad }), 'value {v}');
});

test('TS_I18N=0 强制中文：t 与 resolveLang 恒 zh，normalizeLang 不受影响', () => {
  useFixtureDict();
  process.env.TS_I18N = '0';
  try {
    assert.equal(t('web', '保存', 'en'), '保存');
    assert.equal(t('web', '共 {n} 张卡片', 'en', { n: 1 }), '共 1 张卡片');
    assert.equal(resolveLang({ headers: { 'X-TS-Lang': 'en' }, query: { lang: 'en' } }), 'zh');
    assert.equal(normalizeLang('en'), 'en');
  } finally {
    delete process.env.TS_I18N;
  }
});

test('TS_I18N 非 0（如 1）不关闭本地化', () => {
  useFixtureDict();
  process.env.TS_I18N = '1';
  try {
    assert.equal(t('web', '保存', 'en'), 'Save');
    assert.equal(resolveLang({ headers: { 'X-TS-Lang': 'en' } }), 'en');
  } finally {
    delete process.env.TS_I18N;
  }
});

test('默认词典：从仓库根 i18n/en.json 读取并缓存', () => {
  const dict = loadDict();
  assert.equal(typeof dict, 'object');
  assert.equal(typeof dict.web, 'object');
  // 已知词条抽查（en.json 的稳定条目，不是读实现反推）
  assert.equal(t('web', '保存', 'en'), 'Save');
  assert.equal(t('web', '共 {n} 张卡片', 'en', { n: 1 }), '1 card');
});

test('词典文件缺失时降级为中文：不抛错、warning 只一次', () => {
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  try {
    loadDict(path.join(tmpDir, 'missing.json'));
    assert.doesNotThrow(() => t('web', '保存', 'en'));
    assert.equal(t('web', '保存', 'en'), '保存');
    assert.equal(t('web', '共 {n} 张卡片', 'en', { n: 1 }), '共 1 张卡片');
    assert.equal(t('web', '保存', 'en'), '保存');
    assert.equal(warns.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test('词典 JSON 损坏时降级为中文：不抛错、warning 只一次', () => {
  const brokenPath = path.join(tmpDir, 'broken.json');
  fs.writeFileSync(brokenPath, '{ not valid json', 'utf8');
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  try {
    loadDict(brokenPath);
    assert.equal(t('web', '保存', 'en'), '保存');
    assert.equal(t('web', '保存', 'en'), '保存');
    assert.equal(warns.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});
