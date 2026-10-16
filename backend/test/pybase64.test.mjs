/**
 * `backend/lib/pybase64.js` 的契约测试：**逐条对齐 `base64.b64decode` 的报错口径**。
 *
 * 表里的期望值**全部来自 Python 实跑**（`python3 -c "import base64; ..."`），不是读本模块
 * 实现反推——这是「oracle 说什么就是什么」的常规做法（同 `board-write-route.test.mjs` 的
 * 期望值来源说明）。
 *
 * 两组判据：
 *   ① **表驱动**：40 条入参（含 6 处「反直觉」的 `=` 语义、非 ASCII、空白/杂字符）逐条比
 *      字节与「是否报错」；
 *   ② **负对照**：证明本模块不是 `Buffer.from(s,'base64')` 的换名——后者在 Python 会报错的
 *      输入上**永不报错**（那正是「坏 base64 静默变成垃圾附件 + 200」的生产成因）。
 *
 * 保真度证据（不计入本文件，见 M5 实施记录）：与 `base64.b64decode` 做过 160,030 条差分
 * （四种偏置字母表 + 人工语料，含非 ASCII 与空白），零不一致。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PyB64Error, b64decode } from '../lib/pybase64.js';

/**
 * `{in: 入参, out: hex 或 null（Python 抛异常）}`。
 *
 * 六处反直觉语义（注释里点明，防以后有人「顺手修正」）：
 *   · `'aGVsbG8=extra'` —— `=` 前 3 个数据字符 ⇒ 出 2 字节后**忽略其后全部输入**；
 *   · `'0x= ==0A'` / `'/x==+x=0'` / `'B Z\n==/='` —— `=` 前 2 个数据字符且紧跟第二个 `=` ⇒
 *     出 1 字节并停止（只跟着一个 `=` 时那个 `=` 被跳过、继续攒：`'AA=AA'` 出 3 字节）；
 *   · `'AAA=A'` —— 同上（`AAA` + `=` ⇒ 2 字节，尾部 `A` 被忽略）；
 *   · `'AA='` 报错而 `'AA=='` 成功（余数 2 要**两个**尾 `=`）；`'AAA='` 成功（余数 3 要一个）；
 *   · `'=aGVsbG8='` / `'===='` —— 前导 `=` 在空 quad 位置被跳过，不是「空输入」；
 *   · `'!!!!'` / `"'"` / `'\t\n'` —— 杂字符全被滤掉 ⇒ 空输入 ⇒ 0 字节（**不报错**，
 *     上报端点再按「empty file」拦）。
 */
const TABLE = [
  { in: '', out: '' },
  { in: 'aGVsbG8=', out: '68656c6c6f' },
  { in: 'AAAA', out: '000000' },
  { in: 'AB==', out: '00' },
  { in: 'AAA=', out: '0000' },
  { in: 'aGVsbG8=extra', out: '68656c6c6f' },
  { in: 'Bxx=q', out: '071c' },
  { in: 'AA=AA', out: '000000' },
  { in: 'AAA=A', out: '0000' },
  { in: '=Bx= x\t=', out: '071c' },
  { in: '0x= ==0A', out: 'd3' },
  { in: 'YQ===', out: '61' },
  { in: '====', out: '' },
  { in: '!!!!', out: '' },
  { in: "'", out: '' },
  { in: '\t\n', out: '' },
  { in: 'aGVs bG8=', out: '68656c6c6f' },
  { in: '=aGVsbG8=', out: '68656c6c6f' },
  { in: '8888', out: 'f3cf3c' },
  { in: 'ABC=', out: '0010' },
  { in: 'ABCD==', out: '001083' },
  { in: 'B Z\n==/=', out: '05' },
  { in: '/x==+x=0', out: 'ff' },
  { in: 'A=AAA', out: '000000' },
  // 以下 Python 一律抛 ValueError/binascii.Error ⇒ 本模块抛 PyB64Error
  { in: 'aGVsbG8', out: null },
  { in: 'not-base64', out: null },
  { in: 'Q', out: null },
  { in: 'QQ', out: null },
  { in: 'QQQ', out: null },
  { in: 'Bxxq=q', out: null },
  { in: '//=', out: null },
  { in: '=//', out: null },
  { in: 'AA=', out: null },
  { in: 'AA=A', out: null },
  { in: 'A=', out: null },
  { in: '=A==', out: null },
  { in: 'AB=C', out: null },
  { in: 'AA=E', out: null },
  { in: '中文', out: null },
  { in: 'é', out: null },
];

test('b64decode：40 条表驱动（期望值取自 Python 实跑）', () => {
  for (const { in: input, out } of TABLE) {
    if (out === null) {
      assert.throws(() => b64decode(input), PyB64Error,
        `应报错但成功了: ${JSON.stringify(input)}`);
    } else {
      let got;
      try {
        got = b64decode(input).toString('hex');
      } catch (e) {
        assert.fail(`不应报错却抛了 ${e.name}: ${JSON.stringify(input)}`);
      }
      assert.equal(got, out, `字节不符: ${JSON.stringify(input)}`);
    }
  }
});

test('b64decode：负对照 —— Node 原生解码器在这些输入上**永不报错**（本模块才有守卫）', () => {
  // 三例分别覆盖 Python 的三类错误：余数 1 / 余数 2 缺尾 `=` / 余数 3 缺尾 `=`
  for (const bad of ['not-base64', 'QQ', 'aGVsbG8']) {
    assert.doesNotThrow(() => Buffer.from(bad, 'base64'));         // 原生：静默出垃圾字节
    assert.throws(() => b64decode(bad), PyB64Error);               // 本模块：报错
  }
});

test('b64decode：非 ASCII 按**码位**判（不是按能否编码成 latin-1）', () => {
  assert.throws(() => b64decode('é'), PyB64Error);          // U+00E9
  assert.throws(() => b64decode('\u00ff'), PyB64Error);
  assert.throws(() => b64decode('aG\u4e2d'), PyB64Error);
  assert.doesNotThrow(() => b64decode('\u007f'));           // DEL 仍是 ASCII ⇒ 滤掉 ⇒ 空输入
});

test('b64decode：返回 Buffer，长度与 Python 一致（含 0 字节的空结果）', () => {
  assert.equal(Buffer.isBuffer(b64decode('aGVsbG8=')), true);
  assert.equal(b64decode('').length, 0);
  assert.equal(b64decode('====').length, 0);
  assert.equal(b64decode('aGVsbG8=').toString('utf8'), 'hello');
});
