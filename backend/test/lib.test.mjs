/**
 * `backend/lib/lib.js` 单测（node --test，零依赖）。
 *
 * 覆盖判据分四层：
 *   ① **Python 语义等价**：`str.strip`/`normpath`/`join`/`int(str)`/`isdigit`/换行转换
 *      —— 这些是「照抄 Python」的部分，逐条给表驱动期望值；
 *   ② **文件系统行为**：`fs_browse` 的根列表/排序/上限/坏条目、`resolve_project_file` 的
 *      「双根 + 越界防护」、`read_text_preview` 的截断与二进制判定（含「截断切断多字节
 *      字符」这条最容易写成假二进制的分支）；
 *   ③ **案例库解析**：`parse_fields`/`parse_status_md`/`find_case_dirs`/`bug_cases`；
 *   ④ **跨语言实测**（末尾）：`st_mtime` 的浮点/整数形态与码点排序，用真 Python 解释器
 *      在同一批文件上对拍。缺 Python 时整条 skip（**不假绿**）。
 *
 * 全部用例都在 mkdtemp 目录里造数据，不碰生产库、不碰真实案例库。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import * as lib from '../lib/lib.js';

/** 建一个临时目录（用例内自造数据） */
function tmpDir(tag = 'ts-lib-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), tag));
}

/** 写文件（自动建父目录；`data` 给 Buffer 时按字节写） */
function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

// --------------------------------------------------------------------------
// ① Python 字符串/路径语义
// --------------------------------------------------------------------------

test('pyStrip：按 Python 的空白集合裁剪（含 U+00A0 / U+3000，不含 U+FEFF）', () => {
  assert.equal(lib.pyStrip('  a b \n'), 'a b');
  assert.equal(lib.pyStrip('\u00a0\u3000x\u2028'), 'x');
  // Python 的 str.strip() 不裁 U+FEFF（JS 的 trim() 会）——这条差异是有意的
  assert.equal(lib.pyStrip('\ufeff x'), '\ufeff x');
  assert.equal(lib.pyStrip(null), '');
});

test('pyNormpath：POSIX normpath 的六个关键形态（含保留双斜杠）', () => {
  const table = [
    ['//a/b', '//a/b'],          // 前导两个斜杠按 POSIX 保留
    ['///a', '/a'],              // 三个及以上按单个处理
    ['a//b', 'a/b'],
    ['./a', 'a'],
    ['a/b/', 'a/b'],
    ['/../x', '/x'],             // 根之上的 .. 被丢弃
    ['../../x', '../../x'],      // 相对路径的 .. 保留
    ['/a/./b/../c', '/a/c'],
    ['', '.'],
    ['.', '.'],
  ];
  for (const [input, want] of table) {
    assert.equal(lib.pyNormpath(input), want, `normpath(${JSON.stringify(input)})`);
  }
});

test('pyJoin：后段绝对路径覆盖前段（os.path.join 与 path.join 的分叉点）', () => {
  assert.equal(lib.pyJoin('/a/b', '/etc'), '/etc');
  assert.equal(lib.pyJoin('/a/b', 'c'), '/a/b/c');
  assert.equal(lib.pyJoin('/a/', 'c'), '/a/c');
  assert.equal(lib.pyJoin('.', 'sub'), './sub');       // path.join 会给 'sub'，这是可观察差异
  assert.equal(lib.pyJoin('a', ''), 'a/');
  assert.equal(lib.pyJoin('', ''), '');
  assert.equal(lib.pyJoin('', 'a'), 'a');
});

test('pyIsDigits / pyIntOr：ASCII 数字与 int(str) 的容错口径', () => {
  assert.equal(lib.pyIsDigits('123'), true);
  assert.equal(lib.pyIsDigits(' 1 '), false);         // isdigit 不吃空白（int() 才吃）
  assert.equal(lib.pyIsDigits(''), false);
  assert.equal(lib.pyIsDigits('-1'), false);
  assert.equal(lib.pyIntOr(' 8 ', 0), 8);             // int(' 8 ') == 8
  assert.equal(lib.pyIntOr('+8', 0), 8);
  assert.equal(lib.pyIntOr('-5', 0), -5);
  assert.equal(lib.pyIntOr('8.0', 0), 0);             // ValueError 分支
  assert.equal(lib.pyIntOr('', 0), 0);
  assert.equal(lib.pyIntOr('abc', 0), 0);
  assert.equal(lib.pyIntOr('abc', null), null);       // exclude 场景要能返回 null
});

test('pyStrCompare：按码点序（U+E000 与补充平面在 JS 的 UTF-16 序下会反过来）', () => {
  const emoji = '\u{1F600}';                          // U+1F600（代理对 D83D DE00）
  const bmp = '\uE000';                               // U+E000
  // Python: sorted([emoji, bmp]) == [bmp, emoji]（0xE000 < 0x1F600）
  assert.deepEqual(lib.pySorted([emoji, bmp]), [bmp, emoji]);
  // 而 JS 默认排序给的是 [emoji, bmp]（55357 < 57344 的反面）——证明这条不是空转
  assert.deepEqual([emoji, bmp].sort(), [emoji, bmp]);
  assert.equal(lib.pyStrCompare('a', 'a'), 0);
  assert.equal(lib.pyStrCompare('a', 'b'), -1);
  assert.equal(lib.pyStrCompare('ab', 'a'), 1);
});

test('pyStrCompare / pySortedReverse：reverse=True 仍是稳定序（相等元素不反转）', () => {
  const rows = [{ k: 'b', n: 1 }, { k: 'b', n: 2 }, { k: 'a', n: 3 }];
  // Python sorted(rows, key=k, reverse=True)：两个 'b' 保持 1,2 的相对次序
  const sorted = [...rows].sort((x, y) => lib.pyStrCompare(y.k, x.k));
  assert.deepEqual(sorted.map((r) => r.n), [1, 2, 3]);
  assert.deepEqual(lib.pySortedReverse(['b', 'a', 'c']), ['c', 'b', 'a']);
});

test('pyMtimeFloat / pyMtimeInt：CPython 的「秒 + 纳秒×1e-9」形态', () => {
  // 手工构造：1789251449.0189322 这条真实时间戳在「两次舍入」与「一次除法」下差 1 ULP
  const ns = 1789251449018932200n;
  assert.equal(lib.pyMtimeFloat(ns), 1789251449.018932);
  assert.equal(String(lib.pyMtimeFloat(ns)), '1789251449.018932');
  assert.equal(Number(ns) / 1e9 === lib.pyMtimeFloat(ns), false);   // 另一种算法确实不同
  assert.equal(lib.pyMtimeInt(ns), 1789251449);
  assert.equal(lib.pyMtimeInt(1n), 0);                              // 向零截断
});

// --------------------------------------------------------------------------
// ② 文件系统行为
// --------------------------------------------------------------------------

test('readText：Python 文本模式的 universal newlines（CRLF/CR → LF）', () => {
  const dir = tmpDir();
  assert.equal(lib.readText(write(path.join(dir, 'crlf.md'), 'a\r\nb\rc\nd')), 'a\nb\nc\nd');
  assert.equal(lib.readText(path.join(dir, 'nope.md')), '');        // 缺失 → 空串
  assert.equal(lib.readText(dir), '');                              // 目录 → 空串（IsADirectoryError）
});

test('readTextPreview：完整读、截断、NUL 二进制、坏 UTF-8 二进制', () => {
  const dir = tmpDir();
  const text = write(path.join(dir, 'a.txt'), 'hello 中文\n');
  const p1 = lib.readTextPreview(text);
  assert.deepEqual(p1, { text: 'hello 中文\n', size: 13, truncated: false, binary: false });

  const big = write(path.join(dir, 'big.txt'), 'abcdefghijklmnop');
  const p2 = lib.readTextPreview(big, 10);
  assert.equal(p2.text, 'abcdefghij');
  assert.equal(p2.size, 16);                                       // size 是**全文件**大小
  assert.equal(p2.truncated, true);
  assert.equal(p2.binary, false);

  const nul = write(path.join(dir, 'nul.bin'), Buffer.from([0x61, 0x00, 0x62]));
  assert.deepEqual(lib.readTextPreview(nul), { text: '', size: 3, truncated: false, binary: true });

  const bad = write(path.join(dir, 'bad.txt'), Buffer.from([0x61, 0xff, 0x62]));
  assert.deepEqual(lib.readTextPreview(bad), { text: '', size: 3, truncated: false, binary: true });
});

test('readTextPreview：截断切断多字节字符时「退 1~3 字节」重试（不是二进制）', () => {
  const dir = tmpDir();
  const file = write(path.join(dir, 'cjk.txt'), '中'.repeat(10));   // 每字 3 字节，共 30
  // limit=29 ⇒ 切在第 10 个字的第 2 个字节上：退 2 字节后是合法的 27 字节 = 9 个字
  const p = lib.readTextPreview(file, 29);
  assert.equal(p.truncated, true);
  assert.equal(p.binary, false);
  assert.equal(p.text, '中'.repeat(9));
  assert.equal(p.size, 30);
  // limit=30（正好整字）→ 不截断
  assert.deepEqual(lib.readTextPreview(file, 30), { text: '中'.repeat(10), size: 30, truncated: false, binary: false });
});

test('readTextPreview：保留 UTF-8 BOM（TextDecoder 默认会吃掉它，Python 不会）', () => {
  const dir = tmpDir();
  const file = write(path.join(dir, 'bom.md'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# t\n')]));
  const p = lib.readTextPreview(file);
  assert.equal(p.text, '\ufeff# t\n');
  assert.equal(p.binary, false);
});

test('readTextPreview：不做换行转换（Python 侧是 rb 二进制读）', () => {
  const dir = tmpDir();
  const file = write(path.join(dir, 'crlf.txt'), 'a\r\nb');
  assert.equal(lib.readTextPreview(file).text, 'a\r\nb');
});

test('withinRoot：等值 / 子路径 / 前缀陷阱 / 空值', () => {
  assert.equal(lib.withinRoot('/a/b', '/a/b'), true);
  assert.equal(lib.withinRoot('/a/b/c', '/a/b'), true);
  assert.equal(lib.withinRoot('/a/bc', '/a/b'), false);            // 前缀相同但不是子目录
  assert.equal(lib.withinRoot('/a', '/a/b'), false);
  assert.equal(lib.withinRoot('', '/a'), false);
  assert.equal(lib.withinRoot('/a/b', ''), false);
  assert.equal(lib.withinRoot('/a/b/', '/a/b'), true);
});

test('fsRoots：Linux/macOS/Windows 三档根列表', () => {
  const roots = lib.fsRoots();
  assert.ok(Array.isArray(roots) && roots.length >= 1);
  if (process.platform === 'win32') assert.ok(roots.every((r) => /^[A-Z]:\\$/.test(r)));
  else assert.deepEqual(roots, ['/']);
});

test('fsBrowse：根视角（path="" ⇒ dirs 即根列表，parent=null）', () => {
  const data = lib.fsBrowse('');
  assert.deepEqual(data.roots, lib.fsRoots());
  assert.equal(data.path, '');
  assert.equal(data.parent, null);
  assert.deepEqual(data.dirs, lib.fsRoots().map((r) => ({ name: r, path: r })));
  assert.equal(data.platform, process.platform === 'win32' ? 'windows'
    : process.platform === 'darwin' ? 'macos' : 'linux');
});

test('fsBrowse：文件系统根的 parent 为空串 ⇒「上级」进根视角（盘符/根列表）', () => {
  // 2026-10-22 卡 1044：Windows 盘符根（D:\）的 parent 曾是 null ⇒ 前端「上级」被禁用，
  // 从盘符内部永远回不到盘符列表（选不了盘符 / 切不到别的盘）。现在给空串 = 「上级」= 根视角；
  // 根视角自身仍是 null（见上一条）。本用例在 POSIX（"/"）与 Windows（首个盘符根）都能跑。
  for (const root of lib.fsRoots()) {
    const data = lib.fsBrowse(root);
    assert.ok(data, `文件系统根 ${root} 应可浏览`);
    assert.equal(data.path, lib.realpathOrResolve(root));
    assert.equal(data.parent, '');
    assert.deepEqual(data.roots, lib.fsRoots());
  }
});

test('fsBrowse：只列子目录（含隐藏目录与符号链接目录）、按名字码点序、给 parent', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'b_dir'));
  fs.mkdirSync(path.join(dir, 'a_dir'));
  fs.mkdirSync(path.join(dir, '.hidden'));
  fs.writeFileSync(path.join(dir, 'file.txt'), 'x');
  fs.symlinkSync(path.join(dir, 'b_dir'), path.join(dir, 'link_dir'));
  const data = lib.fsBrowse(dir);
  assert.deepEqual(data.dirs.map((d) => d.name), ['.hidden', 'a_dir', 'b_dir', 'link_dir']);
  assert.deepEqual(data.dirs.map((d) => d.path), ['.hidden', 'a_dir', 'b_dir', 'link_dir']
    .map((n) => path.join(fs.realpathSync(dir), n)));
  assert.equal(data.path, fs.realpathSync(dir));
  assert.equal(data.parent, path.dirname(fs.realpathSync(dir)));
});

test('fsBrowse：不存在 / 是文件 ⇒ null；坏符号链接被跳过而不中断', () => {
  const dir = tmpDir();
  assert.equal(lib.fsBrowse(path.join(dir, 'nope')), null);
  const file = write(path.join(dir, 'f.txt'), 'x');
  assert.equal(lib.fsBrowse(file), null);
  fs.symlinkSync(path.join(dir, 'gone'), path.join(dir, 'broken'));
  fs.mkdirSync(path.join(dir, 'ok'));
  assert.deepEqual(lib.fsBrowse(dir).dirs.map((d) => d.name), ['ok']);
});

test('fsBrowse：单目录上限 FS_BROWSE_LIMIT=500（防超大目录拖垮响应）', () => {
  const dir = tmpDir();
  for (let i = 0; i < 505; i += 1) fs.mkdirSync(path.join(dir, `d${String(i).padStart(3, '0')}`));
  const data = lib.fsBrowse(dir);
  assert.equal(data.dirs.length, lib.FS_BROWSE_LIMIT);
  // 上限截的是**扫描序**、随后才排序 ⇒ 结果仍是码点序，只是可能不含末尾若干目录
  assert.deepEqual(data.dirs.map((d) => d.name), [...data.dirs.map((d) => d.name)].sort());
});

test('resolveProjectFile：双根解析、项目目录优先、越界/目录/缺失/空 四档', () => {
  const dir = tmpDir();
  const projectDir = path.join(dir, 'proj');
  const workDir = path.join(dir, 'work');
  fs.mkdirSync(projectDir);
  fs.mkdirSync(workDir);
  write(path.join(projectDir, 'only_proj.txt'), 'p');
  write(path.join(workDir, 'only_work.txt'), 'w');
  write(path.join(projectDir, 'both.txt'), 'from-project');
  write(path.join(workDir, 'both.txt'), 'from-work');
  fs.mkdirSync(path.join(projectDir, 'adir'));
  const project = { project_dir: projectDir, work_dir: workDir };

  assert.deepEqual(lib.resolveProjectFile(project, '  '), { path: null, rootKey: '', err: 'empty' });
  assert.deepEqual(lib.resolveProjectFile(project, 'only_work.txt'),
    { path: fs.realpathSync(path.join(workDir, 'only_work.txt')), rootKey: 'work', err: '' });
  assert.deepEqual(lib.resolveProjectFile(project, 'only_proj.txt'),
    { path: fs.realpathSync(path.join(projectDir, 'only_proj.txt')), rootKey: 'project', err: '' });
  // 两侧同名 ⇒ 项目目录优先（agent 的 cwd 就是项目目录）
  assert.equal(fs.readFileSync(lib.resolveProjectFile(project, 'both.txt').path, 'utf8'), 'from-project');
  // 绝对路径命中：root 归属按包含它的根判定
  assert.deepEqual(lib.resolveProjectFile(project, path.join(workDir, 'only_work.txt')),
    { path: fs.realpathSync(path.join(workDir, 'only_work.txt')), rootKey: 'work', err: '' });
  // 目录 / 缺失 / 越界
  assert.deepEqual(lib.resolveProjectFile(project, 'adir'),
    { path: fs.realpathSync(path.join(projectDir, 'adir')), rootKey: 'project', err: 'dir' });
  assert.deepEqual(lib.resolveProjectFile(project, 'nope.txt'),
    { path: path.join(fs.realpathSync(projectDir), 'nope.txt'), rootKey: '', err: 'missing' });
  const outside = lib.resolveProjectFile(project, '/etc/hostname');
  assert.equal(outside.err, 'outside');
  // `..` 穿越但最终仍落在根内 ⇒ 允许（Python 的判定是 realpath 之后的包含关系，不是字面前缀）
  assert.deepEqual(lib.resolveProjectFile(project, 'sub/../only_proj.txt'),
    { path: fs.realpathSync(path.join(projectDir, 'only_proj.txt')), rootKey: 'project', err: '' });
});

test('resolveProjectFile：../ 穿越与任意系统路径一律 outside（含相对穿越）', () => {
  const dir = tmpDir();
  const projectDir = path.join(dir, 'proj');
  const workDir = path.join(dir, 'work');
  fs.mkdirSync(projectDir);
  fs.mkdirSync(workDir);
  write(path.join(dir, 'secret.txt'), 'top');
  const project = { project_dir: projectDir, work_dir: workDir };
  // ../secret.txt：两个根下都是 <dir>/secret.txt ⇒ 落在根之外
  const rel = lib.resolveProjectFile(project, '../secret.txt');
  assert.equal(rel.err, 'outside');
  assert.equal(rel.path, fs.realpathSync(path.join(dir, 'secret.txt')));
  assert.equal(lib.resolveProjectFile(project, '/etc/passwd').err, 'outside');
  // 项目未配置目录时：相对路径无候选 ⇒ outside，且 path 回显原串
  assert.deepEqual(lib.resolveProjectFile({ project_dir: '', work_dir: '' }, 'x.txt'),
    { path: 'x.txt', rootKey: '', err: 'outside' });
});

// --------------------------------------------------------------------------
// ③ 案例库解析
// --------------------------------------------------------------------------

test('parseFields：`- **字段**: 值` 与 `**字段**: 值` 两种形态（后写覆盖先写）', () => {
  const text = '标题\n- **状态**: 失败\n**状态**: 通过\n- **A**:  x \n非字段行: 忽略\n';
  assert.deepEqual(lib.parseFields(text), { 状态: '通过', A: 'x' });
  assert.deepEqual(lib.parseFields(''), {});
});

test('normStatus：空值回「未执行」，否则取 `/` 前第一段并 strip', () => {
  assert.equal(lib.normStatus(''), '未执行');
  assert.equal(lib.normStatus(undefined), '未执行');
  assert.equal(lib.normStatus('未执行 / 通过'), '未执行');
  assert.equal(lib.normStatus(' 通过 '), '通过');
});

test('parseStatusMd：六个字段的键集合与缺省值', () => {
  const dir = tmpDir();
  const file = write(path.join(dir, 'status.md'), [
    '# FS0001',
    '- **状态**: 失败 / 通过',
    '- **最近执行时间**: 2026-08-29 06:28',
    '- **执行轮次**: 第 2 轮',
    '- **失败原因**: 断言不符',
    '- **关联 bug_report**: 20260829_0635_FS_x',
    '- **结果摘要**: 摘要',
    '',
  ].join('\n'));
  assert.deepEqual(lib.parseStatusMd(file), {
    status: '失败',
    last_run: '2026-08-29 06:28',
    round: '第 2 轮',
    fail_reason: '断言不符',
    bug_report: '20260829_0635_FS_x',
    summary: '摘要',
  });
  // 缺失/空文件 ⇒ 全是缺省值（status 归一为「未执行」）
  assert.deepEqual(lib.parseStatusMd(path.join(dir, 'nope.md')), {
    status: '未执行', last_run: '', round: '', fail_reason: '', bug_report: '', summary: '',
  });
  // 键序也要与 Python 的 dict 一致（前端按序渲染）
  assert.deepEqual(Object.keys(lib.parseStatusMd(file)),
    ['status', 'last_run', 'round', 'fail_reason', 'bug_report', 'summary']);
});

test('findCaseDirs：递归定位、隐藏目录不深入、符号链接可命中、id 升序、找齐即收工', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, '.hidden', 'FS0001_hidden'), { recursive: true });
  write(path.join(root, '.hidden', 'FS0001_hidden', 'status.md'), '');
  fs.mkdirSync(path.join(root, 'a', 'FS0002_b'), { recursive: true });
  fs.mkdirSync(path.join(root, 'a', 'sub', 'FS0001_a'), { recursive: true });
  fs.mkdirSync(path.join(root, 'c', 'FS0003_c'), { recursive: true });
  // 符号链接目录：参与「用例目录匹配」但不被深入（Python os.walk followlinks=False 的语义）
  fs.symlinkSync(path.join(root, 'c', 'FS0003_c'), path.join(root, 'FS0004_linked'));

  const found = lib.findCaseDirs(root, ['FS0003', 'FS0001', 'FS0002']);
  assert.deepEqual(found.map(([id]) => id), ['FS0001', 'FS0002', 'FS0003']);
  assert.equal(found[0][1], path.join(root, 'a', 'sub', 'FS0001_a'));
  // 链接目录能被定位（返回的是链接路径本身，不 realpath）
  assert.deepEqual(lib.findCaseDirs(root, ['FS0004']),
    [['FS0004', path.join(root, 'FS0004_linked')]]);
  // 未找到的 id 不进结果；空 ids / 不存在的根 ⇒ []
  assert.deepEqual(lib.findCaseDirs(root, ['FS9999']), []);
  assert.deepEqual(lib.findCaseDirs(root, []), []);
  assert.deepEqual(lib.findCaseDirs(path.join(root, 'nope'), ['FS0001']), []);
});

test('bugCases：报告全文（换行归一）+ 关联用例去重排序', () => {
  const dir = tmpDir();
  write(path.join(dir, 'bug_report.md'), '关联 FS0002 与 FS0001\r\n再提 FS0002\nFS0010\n');
  const { content, ids } = lib.bugCases(dir);
  assert.equal(content, '关联 FS0002 与 FS0001\n再提 FS0002\nFS0010\n');
  assert.deepEqual(ids, ['FS0001', 'FS0002', 'FS0010']);
  assert.deepEqual(lib.bugCases(path.join(dir, 'nope')), { content: '', ids: [] });
});

test('runtimeDir：<工作目录>/<name>（os.path.join 口径）', () => {
  assert.equal(lib.runtimeDir('/w', '.live'), '/w/.live');
  assert.equal(lib.runtimeDir('/w/', '.live'), '/w/.live');
});

// --------------------------------------------------------------------------
// ④ 跨语言实测：Python 解释器在同一批文件上给出同一答案
// --------------------------------------------------------------------------

const PYTHON = process.env.TS_PYTHON || 'python3';
const PY_OK = (() => {
  try {
    return spawnSync(PYTHON, ['-c', 'pass'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
})();
const PY_SKIP = PY_OK ? false : `未找到可用的 Python 解释器: ${PYTHON}（TS_PYTHON 可指定）`;

test('跨语言：st_mtime 的 float/int 形态与 Python 相同（真实量级逐字符，全域数值相等）', { skip: PY_SKIP }, () => {
  const dir = tmpDir();
  const files = [];
  // 覆盖「秒 + 纳秒×1e-9 两次舍入」与「一次除法」会分叉的真实时间戳（取自本机真实文件）
  const stamps = [
    1789251449018932200n, 1791277634711376900n, 1789809959960877300n,
    1790548876215930600n, 1790716531266458600n, 1500000000000000000n,
    1n, 1000000000n,                                   // 极端量级：只比数值，不比 repr（见下）
  ];
  stamps.forEach((ns, i) => {
    const file = path.join(dir, `f${i}.bin`);
    fs.writeFileSync(file, 'x');
    fs.utimesSync(file, Number(ns) / 1e9, Number(ns) / 1e9);
    files.push(file);
  });
  const script = 'import os,json,sys\n'
    + "print(json.dumps([[str(os.stat(f).st_mtime_ns), repr(os.stat(f).st_mtime),"
    + ' int(os.stat(f).st_mtime)] for f in sys.argv[1:]]))';
  const proc = spawnSync(PYTHON, ['-c', script, ...files], { encoding: 'utf8' });
  assert.equal(proc.status, 0, proc.stderr);
  const rows = JSON.parse(proc.stdout);
  for (const [i, [, pyRepr, pyInt]] of rows.entries()) {
    const ns = fs.statSync(files[i], { bigint: true }).mtimeNs;
    const value = lib.pyMtimeFloat(ns);
    assert.equal(lib.pyMtimeInt(ns), pyInt, `int(mtime) @${files[i]}（ns=${ns}）`);
    assert.equal(value, JSON.parse(pyRepr), `mtime 数值 @${files[i]}（ns=${ns}）`);
    // repr 逐字符只在「真实时间戳（非整秒、≥1e-4）」上成立，两类固有偏差按 pyjson.js 文件头
    // 登记备案、不进本判据：① <1e-4 时 CPython 指数补零（1e-09 vs 1e-9）；
    // ② 恰好整秒时 Python 保 float 形态（1500000000.0 vs JS 1500000000）——JSON 数值仍相等。
    if (Math.abs(value) >= 1e-4 && !Number.isInteger(value)) {
      assert.equal(String(value), pyRepr, `repr(mtime) @${files[i]}（ns=${ns}）`);
    }
  }
});

test('跨语言：码点排序与 Python sorted() 相同（emoji / U+E000 / 中文混排）', { skip: PY_SKIP }, () => {
  const names = ['\u{1F600}z', '\uE000a', '中文', 'a', 'Z', 'a b', 'FS0001_x', ''];
  const proc = spawnSync(PYTHON, ['-c', 'import json,sys; print(json.dumps(sorted(json.loads(sys.argv[1]))))', JSON.stringify(names)],
    { encoding: 'utf8' });
  assert.equal(proc.status, 0, proc.stderr);
  assert.deepEqual(lib.pySorted(names), JSON.parse(proc.stdout));
});
