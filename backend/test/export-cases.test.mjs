/**
 * M6-2 单测：`export_cases.js`（`scan_cases` / `extract_code_files` / `_norm` / `_match_level` /
 * 两个 CLI 子命令）与 `pyjson.js` 新增的 **indent 形态**。
 *
 * 期望值口径：
 *   - `pyJsonDumpsIndent` 的向量**由 CPython 现跑产出**（`json.dumps(..., ensure_ascii=False, indent=2)`
 *     的 `repr`），不是照着 Node 实现反推——反推只能证明「自己跟自己一致」；
 *   - `scan_cases` / CLI 的期望值来自 `export_cases.py` 原文（字段名、顺序、stdout/stderr 分流、
 *     退出码）；
 *   - 对拍量具（`tools/parity/mod-run.mjs --case export_cases`）覆盖的是「与 Python 逐字节一致」，
 *     本文件覆盖它测不到的**边界与 IO 细节**（原子写、无残留、退出码、字节级 4096 截断等）。
 *
 * 夹具一律 `mkdtemp` 临时目录，**绝不碰真实案例库**。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import * as ec from '../lib/export-cases.js';
import { pyJsonDumpsIndent } from '../lib/pyjson.js';

/** 临时目录夹具（测试末尾由调用方 rmSync；进程退出时 OS 也会清 /tmp） */
function tmpTree(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-${tag}-`));
  const write = (rel, text) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return p;
  };
  return { dir, write };
}

/** 临时把 `process.stdout/stdout` 换成捕获器（CLI 面测试用） */
function captureStreams(fn) {
  const out = [];
  const err = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  try {
    const ret = fn();
    return { ret, out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

// --------------------------------------------------------------------------
// pyJsonDumpsIndent（向量由 CPython 产出）
// --------------------------------------------------------------------------

test('pyJsonDumpsIndent：与 CPython json.dumps(indent=2) 逐字节一致（含空容器/嵌套/中文）', () => {
  const vec = [
    [{ a: 1, b: [1, 2], c: { d: [] }, e: '中文', f: 1.5 }, 2,
      '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ],\n  "c": {\n    "d": []\n  },\n  "e": "中文",\n  "f": 1.5\n}'],
    [[], 2, '[]'],
    [{}, 2, '{}'],
    [[{ x: null, y: true }], 2, '[\n  {\n    "x": null,\n    "y": true\n  }\n]'],
    [{ nested: { deep: [1, [2, 3]] } }, 2,
      '{\n  "nested": {\n    "deep": [\n      1,\n      [\n        2,\n        3\n      ]\n    ]\n  }\n}'],
    [{ a: [1, 2] }, 1, '{\n "a": [\n  1,\n  2\n ]\n}'],
  ];
  for (const [value, indent, expected] of vec) {
    assert.equal(pyJsonDumpsIndent(value, indent), expected,
      `indent=${indent} 形态不符：${JSON.stringify(value)}`);
  }
  // 缩进串（CPython 允许 indent 为字符串）
  assert.equal(pyJsonDumpsIndent({ a: 1 }, '\t'), '{\n\t"a": 1\n}');
  // 非普通对象照样抛（与无缩进版同一条边界）
  assert.throws(() => pyJsonDumpsIndent({ d: new Date() }, 2), TypeError);
});

// --------------------------------------------------------------------------
// 纯函数
// --------------------------------------------------------------------------

test('extract_code_files：去行号、**保序**去重、中文夹带不误吞', () => {
  assert.deepEqual(ec.extractCodeFiles('src/a.py:12-34, lib/b.js（中文夹带）src/a.py'),
    ['src/a.py', 'lib/b.js']);
  assert.deepEqual(ec.extractCodeFiles(''), []);
  assert.deepEqual(ec.extractCodeFiles(null), []);
  // 多后缀白名单 + 行号形态；不在白名单里的后缀不抽
  assert.deepEqual(ec.extractCodeFiles('a.cpp b.tar.gz c.tsx:9 d.rs'),
    ['a.cpp', 'c.tsx', 'd.rs']);
  // 去重是「保序」的（先出现的先留）
  assert.deepEqual(ec.extractCodeFiles('b.py a.py b.py'), ['b.py', 'a.py']);
});

test('_norm / _match_level：前导 `./` 按字符集剥离；path > name > 无匹配', () => {
  assert.equal(ec.norm('./a/b'), 'a/b');
  assert.equal(ec.norm('..x'), 'x');                       // lstrip('./') 是按字符集剥
  assert.equal(ec.norm('a\\b\\c'), 'a/b/c');
  assert.equal(ec.norm('a/./b'), 'a/./b');                 // 只剥前导
  assert.equal(ec.matchLevel('src/a.py', '/x/src/a.py'), 'path');
  assert.equal(ec.matchLevel('src/a.py', 'other/a.py'), 'name');
  assert.equal(ec.matchLevel('src/a.py', 'x/b.py'), null);
  assert.equal(ec.matchLevel('a.py', 'a.py'), 'path');
});

// --------------------------------------------------------------------------
// scan_cases
// --------------------------------------------------------------------------

test('scan_cases：隐藏目录跳过、非 FS 目录仍下钻、字段与排序照 oracle', () => {
  const fx = tmpTree('ec-scan');
  fx.write('FS0002_支付/case.md', '- **接口**: POST /api/pay\n- **依据代码**: pay.py\n');
  fx.write('FS0002_支付/status.md', '- **状态**: 未执行\n');
  fx.write('FS0001_登录/case.md', '- **接口**: POST /api/login\n- **message_id**: m1\n'
    + '- **所属模块/功能**: 认证\n- **依据代码**: src/a.py:1-2, src/a.py\n');
  fx.write('FS0001_登录/status.md', '- **状态**: 通过 / 未执行\n- **关联 bug_report**: bugs/9\n');
  fx.write('FS0001_登录/verify.py', 'print(1)\n');
  fx.write('nested/FS0003_深/case.md', '- **接口**: GET /x\n');
  fx.write('nested/FS0003_深/status.md', '- **状态**: 失败 / 通过\n');
  fx.write('.live/FS0009_隐藏/case.md', '- **接口**: GET /hidden\n');

  const recs = ec.scanCases(fx.dir);
  assert.deepEqual(recs.map((r) => r.id), ['FS0001', 'FS0002', 'FS0003'],
    '按 id 升序；隐藏目录 .live 里的 FS0009 必须不出现');
  const [r1, r2, r3] = recs;
  assert.deepEqual(Object.keys(r1), ['id', 'name', 'dir', 'interface', 'message_id', 'module',
    'status', 'bug_report', 'code_files', 'code_refs', 'has_script'], '键序即 jsonl 键序');
  assert.equal(r1.name, '登录');
  assert.equal(r1.dir, 'FS0001_登录');
  assert.equal(r1.interface, 'POST /api/login');
  assert.equal(r1.message_id, 'm1');
  assert.equal(r1.module, '认证');
  assert.equal(r1.status, '通过', 'norm_status 取 `/` 前第一项');
  assert.equal(r1.bug_report, 'bugs/9');
  assert.deepEqual(r1.code_files, ['src/a.py'], '重复引用按保序去重');
  assert.equal(r1.code_refs, 'src/a.py:1-2, src/a.py');
  assert.equal(r1.has_script, true);
  assert.equal(r2.status, '未执行', '未填写回落 norm_status 缺省');
  assert.equal(r2.has_script, false);
  assert.equal(r3.dir, 'nested/FS0003_深', '非 FS 的中间目录仍要下钻');
  assert.equal(r3.status, '失败');
  assert.equal(r3.interface, 'GET /x');
  assert.equal(r3.code_refs, '', '缺「依据代码」⇒ 空串');
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test('scan_cases：根不存在返回空列表（不抛）', () => {
  assert.deepEqual(ec.scanCases('/tmp/ts-no-such-cases-root-xyz'), []);
});

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

test('cmd_export：落 .live/cases.jsonl（逐行 JSON、无 .tmp 残留）、stdout/stderr 照 oracle', () => {
  const fx = tmpTree('ec-export');
  fx.write('FS0001_a/case.md', '- **接口**: x\n- **依据代码**: a.py\n');
  fx.write('FS0001_a/status.md', '- **状态**: 通过\n');
  fx.write('FS0002_b/case.md', '- **接口**: y\n');
  fx.write('FS0002_b/status.md', '- **状态**: 未执行\n');

  const { ret, out, err } = captureStreams(() => ec.cmdExport({ root: fx.dir }));
  assert.equal(ret, 0);
  const outFile = path.join(fx.dir, '.live', 'cases.jsonl');
  assert.equal(out, `导出 2 条用例 -> ${outFile}\n`);
  assert.equal(err, '警告：1 条未提取到依据代码文件：FS0002\n',
    '未提取到依据代码的 id 走 stderr，且只列 id');
  const lines = fs.readFileSync(outFile, 'utf8').split('\n').filter((l) => l !== '');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '{"id": "FS0001", "name": "a", "dir": "FS0001_a", "interface": "x", '
    + '"message_id": "", "module": "", "status": "通过", "bug_report": "", '
    + '"code_files": ["a.py"], "code_refs": "a.py", "has_script": false}',
  '每行是 json.dumps(ensure_ascii=False) 形态（键序 = 插入序）');
  assert.equal(fs.existsSync(`${outFile}.tmp`), false, '原子写不留临时文件');
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test('cmd_retest_candidates：等级优先级（path 压过 name）、--json 保键序、非 json 分流', async () => {
  const fx = tmpTree('ec-retest');
  // FS0001 有两条「依据代码」：`src/a.py` 与 `other/a.py`——同一个变更文件 `d/other/a.py`
  // 对前者只能判 name、对后者判 path；Python 的 `matched.get(changed) != "path"` 要求保留 path。
  fx.write('FS0001_a/case.md', '- **接口**: x\n- **依据代码**: src/a.py, other/a.py\n');
  fx.write('FS0001_a/status.md', '- **状态**: 通过\n');
  fx.write('FS0002_b/case.md', '- **接口**: y\n- **依据代码**: zzz/b.py\n');
  fx.write('FS0002_b/status.md', '- **状态**: 未执行\n');

  const plain = await captureStreamsAsync(() => ec.cmdRetestCandidates(
    { root: fx.dir, files: ['src/a.py'], json: false, semantic: false }));
  assert.equal(plain.ret, 0);
  assert.equal(plain.out, 'FS0001 [通过] FS0001_a  <- src/a.py(path)\n');
  assert.equal(plain.err, '共 1 条候选（path=路径匹配，name=仅同名需确认）\n');

  const priority = await captureStreamsAsync(() => ec.cmdRetestCandidates(
    { root: fx.dir, files: ['d/other/a.py'], json: true, semantic: false }));
  const got = JSON.parse(priority.out);
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].matched, { 'd/other/a.py': 'path' },
    '先判出 name、后判出 path ⇒ 最终是 path（不许降级）');

  // matched 键序 = 首次赋值序（不是排序序）：zzz 先于 aaa
  const order = await captureStreamsAsync(() => ec.cmdRetestCandidates(
    { root: fx.dir, files: ['zzz/b.py', 'aaa/b.py'], json: true, semantic: false }));
  const rows = JSON.parse(order.out);
  assert.deepEqual(Object.keys(rows[0].matched), ['zzz/b.py', 'aaa/b.py']);
  assert.ok(order.out.startsWith('[\n  {\n    "id": "FS0002"'), 'indent=2 形态');
  assert.equal(order.err, '', '--json 分支不打 stderr 汇总');
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

/** `captureStreams` 的 async 版（cmd_retest_candidates 是 async） */
async function captureStreamsAsync(fn) {
  const out = [];
  const err = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  try {
    const ret = await fn();
    return { ret, out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

test('main：退出码照 oracle（成功 0 / 用法错 2），且用法错不写 stdout', async () => {
  const fx = tmpTree('ec-main');
  fx.write('FS0001_a/case.md', '- **接口**: x\n- **依据代码**: a.py\n');
  const ok = await captureStreamsAsync(() => ec.main(['export', fx.dir]));
  assert.equal(ok.ret, 0);
  assert.match(ok.out, /^导出 1 条用例 -> /);

  for (const argv of [[], ['nope'], ['export'], ['retest-candidates', fx.dir]]) {
    const bad = await captureStreamsAsync(() => ec.main(argv));
    assert.equal(bad.ret, 2, `argv=${JSON.stringify(argv)} 必须是 argparse 的退出码 2`);
    assert.equal(bad.out, '', '用法错只写 stderr');
    assert.match(bad.err, /usage: /);
  }
  fs.rmSync(fx.dir, { recursive: true, force: true });
});
