/**
 * T14 机器契约双语解析器单测（Node 侧）。
 *
 * 与 `tests/test_contract_bilingual.py` **读取同一组 fixture 与同一份 expected.json**
 * （`tests/fixtures/bilingual/`）：zh 旧文件 = 改前基线、en 新文件、mixed 混写，三档都必须
 * 归一到同一套中文 canonical（字段名/状态值）；`set_md_field` 按文件已有语言写回。
 * 另读 `tests/fixtures/bilingual/rounds_stats_cases.json`（ROUNDS.md 执行统计行的唯一
 * 语法真源）：Python `server.EXEC_STAT_RE` 与 Node `casescan.EXEC_STAT_RE` 接受集合逐字一致。
 * 两端任何语义分叉都会在同一行失败。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as casescan from '../lib/casescan.js';
import * as lib from '../lib/lib.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.join(HERE, '..', '..', 'tests', 'fixtures', 'bilingual');
const EXPECTED = JSON.parse(fs.readFileSync(path.join(BASE, 'expected.json'), 'utf8'));
const ROUNDS_STATS = JSON.parse(
  fs.readFileSync(path.join(BASE, 'rounds_stats_cases.json'), 'utf8'));
const readFixture = (rel) => fs.readFileSync(path.join(BASE, rel), 'utf8');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ts-contract-'));

// --------------------------------------------------------------------------
// 解析：zh / en / mixed 三档
// --------------------------------------------------------------------------

for (const rel of Object.keys(EXPECTED.parseStatus).sort()) {
  test(`parseStatusMd：${rel} → 中文 canonical`, () => {
    assert.deepEqual(lib.parseStatusMd(path.join(BASE, rel)), EXPECTED.parseStatus[rel]);
  });
}

for (const rel of Object.keys(EXPECTED.parseFields).sort()) {
  test(`parseFields：${rel} → 中文 canonical 键与状态值`, () => {
    assert.deepEqual(lib.parseFields(readFixture(rel)), EXPECTED.parseFields[rel]);
  });
}

for (const item of EXPECTED.normStatus) {
  test(`normStatus：${JSON.stringify(item.input)} → ${item.expected}`, () => {
    assert.equal(lib.normStatus(item.input), item.expected);
  });
}

test('zh 多选项模板值：parseFields 保留原文、normStatus 取第一项（存量行为）', () => {
  assert.deepEqual(lib.parseFields('- **状态**: 未执行 / 通过 / 失败\n'),
    { 状态: '未执行 / 通过 / 失败' });
  assert.equal(lib.normStatus('未执行 / 通过 / 失败'), '未执行');
});

for (const item of EXPECTED.severityLevels) {
  test(`severityLevel：${JSON.stringify(item.input)} → ${JSON.stringify(item.expected)}`, () => {
    assert.equal(lib.severityLevel(item.input), item.expected);
  });
}

test('parseFields 不归一严重程度值（英文档原样 High），归一发生在展示层 severityLevel', () => {
  assert.equal(lib.parseFields(readFixture('en/bug_report.md'))['严重程度'], 'High');
  assert.equal(lib.severityLevel('High'), '高');
});

// --------------------------------------------------------------------------
// 写回：按文件已有语言
// --------------------------------------------------------------------------

for (const item of EXPECTED.setMdField) {
  test(`setMdField：${item.fixture} 写 ${item.field}=${item.value}`, () => {
    const dir = tmpDir();
    const target = path.join(dir, path.basename(item.fixture));
    if (item.expectedText !== null) fs.copyFileSync(path.join(BASE, item.fixture), target);
    assert.equal(lib.setMdField(target, item.field, item.value), item.expectedHit);
    if (item.expectedText === null) {
      assert.equal(fs.existsSync(target), false);
      return;
    }
    assert.equal(fs.readFileSync(target, 'utf8'), item.expectedText);
  });
}

test('setMdField：文件不存在返回 false 且不创建文件', () => {
  const target = path.join(tmpDir(), 'nope.md');
  assert.equal(lib.setMdField(target, '状态', '通过'), false);
  assert.equal(fs.existsSync(target), false);
});

// --------------------------------------------------------------------------
// 端到端：英文文件走真实消费链路
// --------------------------------------------------------------------------

test('英文 status.md → casesAllPassed / markCasesRetest 读回 canonical', () => {
  const root = path.join(tmpDir(), 'free_style');
  const caseDir = path.join(root, 'mod_login', 'FS0001_Login timeout');
  fs.mkdirSync(caseDir, { recursive: true });
  const sp = path.join(caseDir, 'status.md');
  fs.writeFileSync(sp,
    '# FS0001 Status\n\n- **Status**: Pass\n- **Last run time**: 2026-10-01 10:00\n');

  assert.equal(lib.casesAllPassed(root, ['FS0001']), true);
  assert.deepEqual(lib.markCasesRetest(root, ['FS0001']), ['FS0001']);

  const text = fs.readFileSync(sp, 'utf8');
  assert.ok(text.includes('- **Status**: Needs retest'));
  assert.ok(!text.includes('- **状态**'));
  assert.equal(lib.parseStatusMd(sp).status, '需要复测');
  assert.equal(lib.casesAllPassed(root, ['FS0001']), false);
});

// --------------------------------------------------------------------------
// ROUNDS.md 执行统计行：双端共享用例表（zh 原语法 + en 同义写法）
// --------------------------------------------------------------------------

const roundsStatsLabel = (item, i) => `EXEC_STAT_RE：case-${i} ${item.line}`;
for (const [i, item] of ROUNDS_STATS.entries()) {
  test(roundsStatsLabel(item, i), () => {
    const m = casescan.EXEC_STAT_RE.exec(item.line);
    if (item.passed === null) {
      assert.equal(m, null, `不应匹配: ${item.line}`);
      return;
    }
    assert.ok(m, `应匹配: ${item.line}`);
    assert.equal(Number(m[1]), item.passed);
    assert.equal(Number(m[2]), item.failed);
    assert.equal(m[3] === undefined ? null : Number(m[3]), item.skipped);
  });
}

test('parseRounds：英文统计行 + 角度表行端到端（双端共享 ROUNDS 夹具）', () => {
  const root = tmpDir();
  fs.copyFileSync(path.join(BASE, 'rounds_en.md'), path.join(root, 'ROUNDS.md'));
  assert.deepEqual(casescan.parseRounds(root), [{
    round: 1,
    time: '2026-10-24 10:00',
    angle: '边界',
    cases: 5,
    new_bugs: 1,
    passed: 16,
    failed: 0,
    skipped: 2,
  }]);
});
