/**
 * M6-6 前置：`lib.js` 新增的**案例库写口与固化判定**单测
 * （`lib.set_md_field` / `mark_cases_retest` / `cases_all_passed` / `bug_cases_scripted` /
 * `ensure_gitignore`；`VERIFY_SCRIPT_NAME` 同时从 `export-cases.js` re-export）。
 *
 * 期望值来自 `lib.py` 原文：
 *   - `set_md_field`（`lib.py:50-77`）：命中既有行**保留前缀**（`- ` 或空）、未命中在文末追加
 *     `\n\n- **字段**: 值\n`；`read_text` 空 ⇒ False；
 *   - `mark_cases_retest`（`lib.py:102-109`）：只回**改成功**的 id；
 *   - `cases_all_passed`（`lib.py:112-124`）：空集合 False、**有 id 定位不到目录也 False**、
 *     任一非「通过」False；
 *   - `bug_cases_scripted`（`lib.py:180-189`）：`verify.py` 必须是**文件**（目录不算）、
 *     有空 id / 未固化 / 集合为空 ⇒ False；
 *   - `ensure_gitignore`（`lib.py:192-212`）：幂等追加、已有内容不动。
 *
 * 夹具一律 `mkdtemp` 临时目录（`FS####_名` 目录才是用例，见 `lib.CASE_DIR_RE`）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import * as lib from '../lib/lib.js';
import { VERIFY_SCRIPT_NAME } from '../lib/export-cases.js';

function tmpCases(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-${tag}-`));
  const write = (rel, text, { asDir = false } = {}) => {
    const p = path.join(dir, rel);
    if (asDir) {
      fs.mkdirSync(p, { recursive: true });
      return p;
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return p;
  };
  return { dir, write };
}

test('VERIFY_SCRIPT_NAME 归位 lib.js 且 export-cases.js 仍 re-export 同一常量', () => {
  assert.equal(VERIFY_SCRIPT_NAME, 'verify.py');
  assert.equal(lib.VERIFY_SCRIPT_NAME, 'verify.py');
});

test('set_md_field：命中行保留前缀改写、未命中文末追加、空文件 False（返回值＝写成功）', () => {
  const fx = tmpCases('lib-setmd');
  const a = fx.write('a.md', '- **状态**: 未执行\n- **结果摘要**: x\n');
  assert.equal(lib.setMdField(a, '状态', '需要复测'), true);
  assert.equal(fs.readFileSync(a, 'utf8'), '- **状态**: 需要复测\n- **结果摘要**: x\n',
    '命中行保留 `- ` 前缀、只换值');

  const b = fx.write('b.md', '**状态**: 通过\n');
  assert.equal(lib.setMdField(b, '状态', '已拒绝'), true);
  assert.equal(fs.readFileSync(b, 'utf8'), '**状态**: 已拒绝\n', '无 `- ` 前缀的行同样改写');

  // ★ 返回值口径照 oracle：`lib.py:72-77` 在**写成功**后 return True（**不是**「是否命中既有行」）。
  // 这一条是「凭直觉写期望」的又一例：我第一版断言 False，实跑才发现 oracle 是 True。
  const c = fx.write('c.md', '只有正文\n');
  assert.equal(lib.setMdField(c, '状态', '通过'), true, '未命中 ⇒ 追加后写成功 ⇒ True');
  assert.equal(fs.readFileSync(c, 'utf8'), '只有正文\n\n- **状态**: 通过\n',
    '未命中在文末追加（先剥尾部空行再加 `\\n\\n`）');

  const d = fx.write('d.md', '');            // read_text 读空 ⇒ 直接 False（不写、不建内容）
  assert.equal(lib.setMdField(d, '状态', '通过'), false);
  assert.equal(fs.readFileSync(d, 'utf8'), '');
  assert.equal(lib.setMdField(path.join(fx.dir, 'nope.md'), '状态', '通过'), false,
    '文件不存在（read_text 空）⇒ False，不顺手建文件');
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test('mark_cases_retest：只回改成功的 id；找不到目录的 id 不进结果', () => {
  const fx = tmpCases('lib-mark');
  fx.write('FS0001_甲/status.md', '- **状态**: 通过\n');
  const ids = lib.markCasesRetest(fx.dir, ['FS0001', 'FS9999']);
  assert.deepEqual(ids, ['FS0001'], 'FS9999 定位不到目录 ⇒ 不进结果');
  assert.equal(fs.readFileSync(path.join(fx.dir, 'FS0001_甲/status.md'), 'utf8'),
    '- **状态**: 需要复测\n');
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test('cases_all_passed：空集合/缺目录/任一非通过 都 False；全通过 True', () => {
  const fx = tmpCases('lib-passed');
  fx.write('FS0001_甲/status.md', '- **状态**: 通过\n');
  fx.write('FS0002_乙/status.md', '- **状态**: 通过 / 未执行\n');
  assert.equal(lib.casesAllPassed(fx.dir, []), false);
  assert.equal(lib.casesAllPassed(fx.dir, ['FS0001']), true);
  assert.equal(lib.casesAllPassed(fx.dir, ['FS0001', 'FS0002']), true, '「通过 / 未执行」取 `/` 前 = 通过');
  assert.equal(lib.casesAllPassed(fx.dir, ['FS0001', 'FS9999']), false,
    '有 id 定位不到目录 ⇒ 整体未通过（不许静默忽略）');
  fx.write('FS0003_丙/status.md', '- **状态**: 失败\n');
  assert.equal(lib.casesAllPassed(fx.dir, ['FS0001', 'FS0003']), false);
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test('bug_cases_scripted：verify.py 必须是文件；目录同名不算固化', () => {
  const fx = tmpCases('lib-scripted');
  fx.write('FS0001_甲/verify.py', 'print(1)\n');
  fx.write('FS0002_乙/case.md', 'x\n');                     // 无 verify.py ⇒ 未固化
  fx.write('FS0003_丙/verify.py', '', { asDir: true });      // 目录同名 ⇒ **不算**
  assert.equal(lib.bugCasesScripted(fx.dir, ['FS0001']), true);
  assert.equal(lib.bugCasesScripted(fx.dir, ['FS0002']), false);
  assert.equal(lib.bugCasesScripted(fx.dir, ['FS0003']), false, 'os.path.isfile 口径');
  assert.equal(lib.bugCasesScripted(fx.dir, ['FS0001', 'FS0002']), false);
  assert.equal(lib.bugCasesScripted(fx.dir, []), false);
  assert.equal(lib.bugCasesScripted(fx.dir, ['FS0001', 'FS9999']), false);
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test('ensure_gitignore：幂等追加、已有内容不动、缺目录顺带创建', () => {
  const fx = tmpCases('lib-gi');
  const base = path.join(fx.dir, 'new-dir');
  lib.ensureGitignore(base, '.live/');
  assert.equal(fs.readFileSync(path.join(base, '.gitignore'), 'utf8'), '.live/\n');
  lib.ensureGitignore(base, '.live/');                      // 幂等
  assert.equal(fs.readFileSync(path.join(base, '.gitignore'), 'utf8'), '.live/\n');
  lib.ensureGitignore(base, '.web/');
  assert.equal(fs.readFileSync(path.join(base, '.gitignore'), 'utf8'), '.live/\n.web/\n');
  // 已有用户内容（无尾换行）⇒ 先补一个换行再追加
  fs.writeFileSync(path.join(base, '.gitignore'), '用户规则');
  lib.ensureGitignore(base, '.live/');
  assert.equal(fs.readFileSync(path.join(base, '.gitignore'), 'utf8'), '用户规则\n.live/\n');
  fs.rmSync(fx.dir, { recursive: true, force: true });
});
