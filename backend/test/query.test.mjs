/**
 * backend/lib/query.js 的测试（node --test，零依赖）。
 *
 * 判据来源：**本机 Python 3.12 实测**（`python3 -c "from urllib.parse import parse_qs; ..."`），
 * 期望值逐条硬编码在这里 —— 不是按文档写的。这样做的理由：`parse_qs` 有四处反直觉行为
 * （空值丢弃 / `;` 不再分隔 / `+` 只在查询串转空格 / 非法转义与非法 UTF-8 的容错口径），
 * 靠「读着对」写出来的实现几乎必错其中一条。
 *
 * 覆盖：parse_qs 18 组输入、unquote 11 组、unquote_plus、quote 的安全字符集与 UTF-8、
 * qsGet 的缺键/首值语义、以及「无原型对象」这条安全性质。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseQs, qsGet, quote, unquote, unquotePlus } from '../lib/query.js';

/** Python `parse_qs(qs)` 的实测结果（键序按 Python dict 插入序；这里用 deepStrictEqual 比内容） */
const PY_PARSE_QS = [
  ['a=1&b=2', { a: ['1'], b: ['2'] }],
  ['a=1;a=2', { a: ['1;a=2'] }],                 // 3.10 起 ';' 不再是分隔符
  ['raw=', {}],                                  // 空值整对丢弃（keep_blank_values=False）
  ['raw', {}],
  ['a&b=1', { b: ['1'] }],
  ['=1', { '': ['1'] }],                         // 空名 + 非空值：Python 保留
  ['=&=', {}],
  ['a=1&a=2&a=3', { a: ['1', '2', '3'] }],       // 同名聚成数组，保持出现序
  ['k=+plus+space', { k: [' plus space'] }],     // '+' → 空格（unquote_plus）
  ['k=%2Bplus', { k: ['+plus'] }],               // %2B 是字面 '+'
  ['sid=abc%2Fdef&x=%E4%B8%AD', { sid: ['abc/def'], x: ['中'] }],
  ['?a=1', { '?a': ['1'] }],                     // 调用方先切 '?'；没切就是键名的一部分
  ['a=%ZZ', { a: ['%ZZ'] }],                     // 非法转义原样保留
  ['b=1&', { b: ['1'] }],
  ['a=%E4%B8', { a: ['\ufffd'] }],               // 截断的三字节序列 → 一个替换符
  ['a=%FF%FE', { a: ['\ufffd\ufffd'] }],         // 每字节一个替换符
  ['%2F=1', { '/': ['1'] }],                     // 键也要解码
  ['a=1&&b=2', { a: ['1'], b: ['2'] }],          // 空段跳过
];

test('parseQs：与 Python parse_qs 逐例一致（18 组实测向量）', () => {
  for (const [input, expected] of PY_PARSE_QS) {
    const got = parseQs(input);
    // Object.create(null) 与普通对象 deepStrictEqual 会因原型不同判不等：先归一
    assert.deepStrictEqual({ ...got }, expected, `parseQs(${JSON.stringify(input)})`);
  }
});

test('parseQs：空串/undefined 返回空表；返回对象无原型（__proto__ 不污染）', () => {
  assert.deepStrictEqual({ ...parseQs('') }, {});
  assert.deepStrictEqual({ ...parseQs(null) }, {});
  const got = parseQs('__proto__=polluted&a=1');
  assert.equal(Object.getPrototypeOf(got), null);
  // 注意不能用对象字面量 `{__proto__: [...]}` 当期望值：字面量里的 `__proto__` 是**设原型**
  // 的语法（且赋数组会静默忽略），根本建不出同名自有键 —— 这条断言本身就是被它坑过一次
  // 才写成现在这样（实测报 actual 有 ['__proto__'] 而 expected 没有）。
  assert.deepStrictEqual(Object.keys(got), ['__proto__', 'a']);
  assert.deepStrictEqual(got['__proto__'], ['polluted']);
  assert.deepStrictEqual(got.a, ['1']);
  assert.equal({}.polluted, undefined, '原型链未被污染');
});

test('qsGet：键不存在才回落默认值（Python parsed.get(k, [def])[0] 同义）', () => {
  const parsed = parseQs('agent=&after=0&sid=abc');
  assert.equal(qsGet(parsed, 'sid'), 'abc');
  assert.equal(qsGet(parsed, 'agent', 'main'), 'main', '空值被丢弃 ⇒ 用默认值');
  assert.equal(qsGet(parsed, 'after'), '0');
  assert.equal(qsGet(parsed, 'missing'), '');
  assert.equal(qsGet(parsed, 'missing', 'x'), 'x');
  assert.equal(qsGet(parseQs('a=1&a=2'), 'a'), '1', '同名取首值');
});

/** Python `unquote(s)` 的实测结果（注意 `+` 不转空格） */
const PY_UNQUOTE = [
  ['abc%2Fdef', 'abc/def'],
  ['a+b', 'a+b'],
  ['%E4%B8%AD', '中'],
  ['%ZZ', '%ZZ'],
  ['%E4%B8', '\ufffd'],
  ['%FF%FE', '\ufffd\ufffd'],
  ['100%', '100%'],
  ['%25', '%'],
  ['%C3%A9', 'é'],
  ['no-escape', 'no-escape'],
  ['%2B', '+'],
];

test('unquote：与 Python urllib.parse.unquote 逐例一致（11 组实测向量）', () => {
  for (const [input, expected] of PY_UNQUOTE) {
    assert.equal(unquote(input), expected, `unquote(${JSON.stringify(input)})`);
  }
});

test('unquote：混合段（转义 + 字面 + 多字节跨段）行为与 Python 同构', () => {
  assert.equal(unquote('/a/b%20c/d'), '/a/b c/d');
  assert.equal(unquote('中%E6%96%87'), '中文');
  assert.equal(unquote('%E4%B8%ADabc%E6%96%87'), '中abc文');
  assert.equal(unquote('%E4%B8%FF%AD'), '\ufffd\ufffd\ufffd', '中间夹非法字节 ⇒ 三段各自替换');
});

test('unquotePlus：+ 转空格（查询串口径），且与 unquote 的差别仅此一点', () => {
  assert.equal(unquotePlus('a+b'), 'a b');
  assert.equal(unquotePlus('%2B'), '+');
  assert.equal(unquotePlus('x%20y'), 'x y');
  assert.equal(unquote('a+b'), 'a+b');
});

test('quote：安全字符集与 UTF-8 百分号编码（safe 缺省 "/"）', () => {
  assert.equal(quote('a b/c?d=e&f'), 'a%20b/c%3Fd%3De%26f');
  assert.equal(quote('中文'), '%E4%B8%AD%E6%96%87');
  assert.equal(quote('/a/b'), '/a/b');
  assert.equal(quote('a/b', ''), 'a%2Fb', 'safe="" 时斜杠也编码（driver 端点口径）');
  assert.equal(quote("!'()*"), '%21%27%28%29%2A', 'encodeURIComponent 不转义但 Python 转义');
  assert.equal(quote('AZaz09_.-~'), 'AZaz09_.-~', '永不转义集');
  assert.equal(quote(undefined), '');
});
