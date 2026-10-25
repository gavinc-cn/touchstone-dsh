/**
 * `backend/lib/casescan.js` 单测（node --test，零依赖）。
 *
 * 覆盖判据：
 *   ① **INDEX/status/ROUNDS 解析**：表格行、`—` 占位、目录说明、明细小节统计；
 *   ② **扫描聚合**：`scan_dir` 的树形状（隐藏目录跳过、无 status.md 的 FS 目录两边都不进）、
 *      `collect_stats` 的状态映射、`scan_bugs` 的 `_FS_` 过滤/倒序/50 条上限；
 *   ③ **缓存**：`cachedFile` 的 mtime 失效（同尺寸改内容也必须失效）、缺失文件不缓存；
 *   ④ **StateCache 的 TTL 与指纹**：TTL 内返回同一对象、过期重建、指纹剔除 `generated_at`、
 *      指纹不含事后写入的 `project` 段（这正是 `/api/stream` 每拍比较的对象）；
 *   ⑤ **bug 关联任务**：`bugLastTask` 的四类任务白名单、坏 payload 跳过、`listProjectBugs` 的
 *      「已闭环沉底」稳定排序（真 SQL 造行，走 m3fixture 的临时库）。
 *
 * 全部数据都在 mkdtemp 目录/临时库里造，不碰生产库与真实案例库。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as db from '../lib/db.js';
import * as lib from '../lib/lib.js';
import * as cs from '../lib/casescan.js';
import { freshDb, insertProject } from './m3fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BILINGUAL = path.join(HERE, '..', '..', 'tests', 'fixtures', 'bilingual');

/** 建临时目录 */
function tmpDir(tag = 'ts-casescan-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), tag));
}

/** 写文件（自动建父目录） */
function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

/**
 * 造一个「案例库 + bug 报告 + live.json」三件套。
 * @returns {{dir: string, work: string, cases: string, bugs: string}}
 */
function makeScanFixture() {
  const dir = tmpDir();
  const work = path.join(dir, 'work');
  const cases = path.join(work, 'free_style');
  const bugs = path.join(work, 'bug_report');
  fs.mkdirSync(cases, { recursive: true });
  fs.mkdirSync(bugs, { recursive: true });
  return { dir, work, cases, bugs };
}

// --------------------------------------------------------------------------
// ① INDEX / status / ROUNDS
// --------------------------------------------------------------------------

test('parseIndexCases：取 INDEX 表格里的名称与测试点（`—` 与空名整条忽略）', () => {
  const text = [
    '# INDEX',
    '',
    '| 用例 ID | 名称 | 测试点（一句话） | 状态 | 关联 bug_report |',
    '|---------|------|------------------|------|-----------------|',
    '| FS0001 | cli_help | 帮助退出码 | 通过 | - |',
    '| FS0002 | 目录名 | — | 失败 | 20260829_0635_FS_x |',
    '| FS0003 | — | 不该进 | 通过 | - |',
    '| FS0004 |  带空格  |  点  | 通过 | - |',
    '非表格行 FS0005 | x | y | z | w |',
    '',
  ].join('\n');
  const out = cs.parseIndexCases(text);
  assert.deepEqual(Object.keys(out), ['FS0001', 'FS0002', 'FS0004']);
  assert.deepEqual(out.FS0001, ['cli_help', '帮助退出码']);
  assert.deepEqual(out.FS0002, ['目录名', '']);          // 测试点为 — ⇒ 空串
  assert.deepEqual(out.FS0004, ['带空格', '点']);        // 两侧空白被 strip
});

test('scanDir：树形状（隐藏目录跳过、无 status.md 的 FS 目录两边都不进、INDEX 覆盖名称）', () => {
  const { cases } = makeScanFixture();
  write(path.join(cases, 'INDEX.md'), '# 根\n\n> 根说明\n\n| FS0001 | 索引名 | 索引点 | 通过 | - |\n');
  fs.mkdirSync(path.join(cases, '.live'), { recursive: true });
  write(path.join(cases, '.live', 'live.json'), '{}');
  fs.mkdirSync(path.join(cases, '.hidden_cases', 'FS0009_hidden'), { recursive: true });
  write(path.join(cases, '.hidden_cases', 'FS0009_hidden', 'status.md'), '');
  fs.mkdirSync(path.join(cases, 'cat_a', 'FS0002_beta'), { recursive: true });
  fs.mkdirSync(path.join(cases, 'cat_a', 'FS0008_nostatus'), { recursive: true });
  write(path.join(cases, 'cat_a', 'INDEX.md'), '> 分类说明\n\n| FS0003 | 索引名3 | 点3 | 通过 | - |\n');
  write(path.join(cases, 'cat_a', 'FS0002_beta', 'status.md'), '- **状态**: 通过\n');
  fs.mkdirSync(path.join(cases, 'cat_a', 'sub', 'FS0003_gamma'), { recursive: true });
  write(path.join(cases, 'cat_a', 'sub', 'FS0003_gamma', 'status.md'), '- **状态**: 失败 / 通过\n');
  fs.mkdirSync(path.join(cases, 'FS0001_alpha'), { recursive: true });
  write(path.join(cases, 'FS0001_alpha', 'status.md'), '- **状态**: 需要复测\n');

  const tree = cs.scanDir(cases, '.');
  assert.equal(tree.name, path.basename(cases));
  assert.equal(tree.path, '.');
  assert.equal(tree.desc, '根说明');
  // 根下：FS0001 是用例，cat_a 是子目录；隐藏目录与隐藏用例目录都不出现
  assert.deepEqual(tree.cases.map((c) => c.id), ['FS0001']);
  assert.deepEqual(tree.children.map((c) => c.name), ['cat_a']);
  // 索引覆盖：名称/测试点以 INDEX.md 为准；relpath 保留 `./` 前缀（Python os.path.join(".")）
  assert.equal(tree.cases[0].name, '索引名');
  assert.equal(tree.cases[0].point, '索引点');
  assert.equal(tree.cases[0].relpath, `./FS0001_alpha`);
  assert.equal(tree.cases[0].status, '需要复测');
  // cat_a：FS0002 是用例；FS0008 有 FS 前缀但缺 status.md ⇒ children 与 cases 都不进
  const catA = tree.children[0];
  assert.equal(catA.desc, '分类说明');
  assert.deepEqual(catA.cases.map((c) => c.id), ['FS0002']);
  assert.deepEqual(catA.children.map((c) => c.name), ['sub']);
  assert.equal(catA.cases[0].name, 'beta');              // 该 id 不在 cat_a 的 INDEX 里 ⇒ 保留目录名
  // sub：FS0003 的目录在 cat_a 层，但 INDEX.md 只对**当层**子项生效（Python 同）⇒ 保留目录名
  assert.deepEqual(catA.children[0].cases.map((c) => c.id), ['FS0003']);
  assert.equal(catA.children[0].cases[0].name, 'gamma');
  assert.equal(catA.children[0].cases[0].status, '失败'); // norm_status 取第一段
  // 目录不可读（不存在）⇒ 返回空壳节点而不是抛异常
  const empty = cs.scanDir(path.join(cases, 'nope'), 'nope');
  assert.deepEqual(empty, { name: 'nope', path: 'nope', desc: '', children: [], cases: [] });
});

test('collectStats：状态映射（通过/失败/需要复测/跳过，其余 pending）', () => {
  const node = {
    cases: [
      { status: '通过' }, { status: '通过' }, { status: '失败' },
      { status: '需要复测' }, { status: '跳过' }, { status: '未执行' },
    ],
    children: [{ cases: [{ status: '失败' }, { status: '莫名状态' }], children: [] }],
  };
  const stats = cs.collectStats(node, { total: 0, passed: 0, failed: 0, retest: 0, skipped: 0, pending: 0 });
  assert.deepEqual(stats, { total: 8, passed: 2, failed: 2, retest: 1, skipped: 1, pending: 2 });
  assert.deepEqual(Object.keys(stats), ['total', 'passed', 'failed', 'retest', 'skipped', 'pending']);
});

// --------------------------------------------------------------------------
// ② 缓存
// --------------------------------------------------------------------------

test('cachedFile：命中不重读；同尺寸改内容只要 mtime 变就失效；缺失文件不缓存', () => {
  cs.clearFileCache();
  const dir = tmpDir();
  const file = write(path.join(dir, 'x.md'), 'aaaa');
  let calls = 0;
  const loader = (p) => { calls += 1; return lib.readText(p); };
  assert.equal(cs.cachedFile(file, loader), 'aaaa');
  assert.equal(cs.cachedFile(file, loader), 'aaaa');
  assert.equal(calls, 1);
  assert.equal(cs.fileCacheSize(), 1);

  // 同尺寸、仅 mtime 变：必须失效（纳秒戳的意义就在这里）
  fs.writeFileSync(file, 'bbbb');
  fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.equal(cs.cachedFile(file, loader), 'bbbb');
  assert.equal(calls, 2);

  // 缺失文件：loader 每次都被调用，且不留缓存条目（否则「文件已删」会读成「还在」）
  const missing = path.join(dir, 'gone.md');
  const before = cs.fileCacheSize();
  assert.equal(cs.cachedFile(missing, (p) => `L:${path.basename(p)}`), 'L:gone.md');
  assert.equal(cs.cachedFile(missing, (p) => `L:${path.basename(p)}`), 'L:gone.md');
  assert.equal(cs.fileCacheSize(), before);
  cs.clearFileCache();
  assert.equal(cs.fileCacheSize(), 0);
});

// --------------------------------------------------------------------------
// ③ bug 扫描与关联任务
// --------------------------------------------------------------------------

test('scanBugs：`_FS_` 过滤、目录名倒序、标题取 `_FS_` 后段、关联用例去重排序截 20', () => {
  const { bugs } = makeScanFixture();
  fs.mkdirSync(path.join(bugs, '20260829_0635_FS_cli_config_load'), { recursive: true });
  write(path.join(bugs, '20260829_0635_FS_cli_config_load', 'bug_report.md'),
    '- **状态**: 已修复\n- **严重程度**: High\n\n关联 FS0002、FS0001、FS0002、FS0003\n');
  fs.mkdirSync(path.join(bugs, '20260901_1010_FS_other'), { recursive: true });
  write(path.join(bugs, '20260901_1010_FS_other', 'bug_report.md'), '- **状态**: 待修复\n');
  fs.mkdirSync(path.join(bugs, '20260901_1011_no_fs_marker'), { recursive: true });   // 无 _FS_ ⇒ 跳过
  fs.mkdirSync(path.join(bugs, '20260901_1012_FS_missing_report'), { recursive: true });
  write(path.join(bugs, '20260901_1013_FS_a_file'), 'not a dir');                     // 文件 ⇒ 跳过
  const list = cs.scanBugs(bugs);
  assert.deepEqual(list.map((b) => b.dir),
    ['20260901_1012_FS_missing_report', '20260901_1010_FS_other', '20260829_0635_FS_cli_config_load']);
  assert.equal(list[2].title, 'FS_cli_config_load');      // 只剥掉 `YYYYmmdd_HHMM_` 前缀
  assert.equal(list[2].status, '已修复');
  assert.equal(list[2].severity, '高');                   // 英文 High 归一到中文 canonical
  assert.deepEqual(list[2].cases, ['FS0001', 'FS0002', 'FS0003']);
  assert.equal(list[0].status, '');                       // 缺报告 ⇒ 空状态
  assert.equal(list[0].severity, '');                     // 缺等级 ⇒ 空串（界面「未分级」）
  assert.deepEqual(list[0].cases, []);
  // 目录不存在 ⇒ 空列表（不抛）
  assert.deepEqual(cs.scanBugs(path.join(bugs, 'nope')), []);
});

test('scanBugs：严重程度归一（zh 高/中/低、en 大小写、未知自定义值 → 空串）', () => {
  const { bugs } = makeScanFixture();
  const seeds = {
    '20260901_0001_FS_zh_high': '- **严重程度**: 高\n',
    '20260901_0002_FS_zh_medium': '- **严重程度**: 中\n',
    '20260901_0003_FS_en_low': '- **Severity**: low\n',
    '20260901_0004_FS_custom': '- **严重程度**: 紧急\n',
    '20260901_0005_FS_none': '无等级字段\n',
  };
  for (const [name, text] of Object.entries(seeds)) {
    write(path.join(bugs, name, 'bug_report.md'), text);
  }
  const byDir = Object.fromEntries(cs.scanBugs(bugs).map((b) => [b.dir, b.severity]));
  assert.deepEqual(byDir, {
    '20260901_0001_FS_zh_high': '高',
    '20260901_0002_FS_zh_medium': '中',
    '20260901_0003_FS_en_low': '低',
    '20260901_0004_FS_custom': '',
    '20260901_0005_FS_none': '',
  });
});

test('scanBugs：最多 50 条（倒序截断）', () => {
  const { bugs } = makeScanFixture();
  for (let i = 0; i < 55; i += 1) {
    fs.mkdirSync(path.join(bugs, `20260901_${String(i).padStart(4, '0')}_FS_b${String(i).padStart(2, '0')}`));
  }
  const list = cs.scanBugs(bugs);
  assert.equal(list.length, 50);
  assert.equal(list[0].dir, '20260901_0054_FS_b54');      // 目录名倒序 ⇒ 最大在前
});

test('bugLastTask：四类任务白名单、payload 解析、第一条命中即最近', () => {
  const tasks = [
    { id: 5, task_type: 'normal', name: 'n', status: 'done', created_at: 't', payload: '{"bug_dir":"B"}' },
    { id: 4, task_type: 'fix', name: 'f2', status: 'done', created_at: 't4', payload: '{"bug_dir":"A"}' },
    { id: 3, task_type: 'retest_bug', name: 'r', status: 'running', created_at: 't3', payload: '坏 JSON' },
    { id: 2, task_type: 'script_retest', name: 's', status: 'queued', created_at: 't2', payload: '["not-an-object"]' },
    { id: 1, task_type: 'reject', name: 'j', status: 'done', created_at: 't1', payload: '{"bug_dir":"A"}' },
  ];
  assert.deepEqual(cs.bugLastTask(tasks, 'A'),
    { id: 4, task_type: 'fix', name: 'f2', status: 'done', created_at: 't4' });
  assert.equal(cs.bugLastTask(tasks, 'B'), null);         // normal 不在白名单
  assert.equal(cs.bugLastTask([], 'A'), null);
  // payload 为 NULL/空串 ⇒ Python `t["payload"] or "{}"` ⇒ 空 dict ⇒ 不匹配
  assert.equal(cs.bugLastTask([{ id: 9, task_type: 'fix', name: 'x', status: 'done', created_at: 't', payload: null }], 'A'), null);
});

test('listProjectBugs：已闭环（复测通过/已拒绝）沉底且保持组内相对序、逐个挂 last_task', () => {
  const fx = freshDb('casescan');
  try {
    const work = path.join(fx.dir, 'work');
    const pid = insertProject(fx.db, { userId: 1, name: 'p', projectDir: path.join(fx.dir, 'p'), workDir: work });
    const bugs = path.join(work, 'bug_report');
    for (const name of ['20260903_0003_FS_c', '20260901_0001_FS_a', '20260902_0002_FS_b']) {
      fs.mkdirSync(path.join(bugs, name), { recursive: true });
      write(path.join(bugs, name, 'bug_report.md'), '- **状态**: 待修复\n');
    }
    // 目录名倒序：c(待修复) / b(复测通过) / a(已拒绝)；排序后 c 在前，b、a 沉底且 b 仍在 a 前
    write(path.join(bugs, '20260902_0002_FS_b', 'bug_report.md'), '- **状态**: 复测通过\n');
    write(path.join(bugs, '20260901_0001_FS_a', 'bug_report.md'), '- **状态**: 已拒绝（误报）\n');
    const insert = fx.db.prepare(
      'INSERT INTO tasks(project_id, name, task_type, status, current_round, session_id, error,'
      + ' payload, created_at) VALUES(?,?,?,?,?,?,?,?,?)');
    insert.run(pid, 'fix任务', 'fix', 'done', 1, '', '', '{"bug_dir":"20260902_0002_FS_b"}', '2026-09-04 00:00:00');
    insert.run(pid, '复测任务', 'retest_bug', 'done', 1, '', '', '{"bug_dir":"20260902_0002_FS_b"}', '2026-09-05 00:00:00');
    const project = db.getProject(pid, { db: fx.db });
    const list = cs.listProjectBugs(project, { db: fx.db });
    assert.deepEqual(list.map((b) => b.dir),
      ['20260903_0003_FS_c', '20260902_0002_FS_b', '20260901_0001_FS_a']);
    // 任务列表 id DESC ⇒ 复测任务（后插入、id 大）在前 ⇒ last_task 取它
    assert.deepEqual(list[1].last_task,
      { id: 2, task_type: 'retest_bug', name: '复测任务', status: 'done', created_at: '2026-09-05 00:00:00' });
    assert.equal(list[0].last_task, null);
    // 键序与 Python 一致：dir/title/status/severity/cases 之后才追加 last_task
    assert.deepEqual(Object.keys(list[0]), ['dir', 'title', 'status', 'severity', 'cases', 'last_task']);
  } finally {
    fx.close();
  }
});

test('listProjectBugs：历史沉底 → 高→中→低→未分级，同级保持目录名倒序（与 Python 同序）', () => {
  const fx = freshDb('casescan-sev');
  try {
    const work = path.join(fx.dir, 'work');
    const pid = insertProject(fx.db, {
      userId: 1, name: 'p', projectDir: path.join(fx.dir, 'p'), workDir: work,
    });
    const bugs = path.join(work, 'bug_report');
    const seeds = {
      '20260101_0000_FS_low_old': '- **严重程度**: 低\n',
      '20260101_0100_FS_high_new': '- **严重程度**: High\n',
      '20260101_0200_FS_low_new': '- **严重程度**: 低\n',
      '20260101_0300_FS_none_new': '无等级\n',
      '20260101_0400_FS_medium_new': '- **状态**: 待分析\n- **严重程度**: 中\n',
      '20260101_0500_FS_hist_pass': '- **状态**: 复测通过\n- **严重程度**: 高\n',
      '20260101_0600_FS_hist_reject': '- **状态**: 已拒绝\n- **严重程度**: 中\n',
    };
    for (const [name, text] of Object.entries(seeds)) {
      write(path.join(bugs, name, 'bug_report.md'), text);
    }
    const project = db.getProject(pid, { db: fx.db });
    const list = cs.listProjectBugs(project, { db: fx.db });
    assert.deepEqual(list.map((b) => b.dir), [
      '20260101_0100_FS_high_new',
      '20260101_0400_FS_medium_new',
      '20260101_0200_FS_low_new',      // 同级（低）内目录名倒序：02:00 在 00:00 前
      '20260101_0000_FS_low_old',
      '20260101_0300_FS_none_new',     // 未分级在最后
      '20260101_0500_FS_hist_pass',    // 历史组：高在前
      '20260101_0600_FS_hist_reject',
    ]);
    assert.deepEqual(list.map((b) => b.severity), ['高', '中', '低', '低', '', '高', '中']);
  } finally {
    fx.close();
  }
});

// --------------------------------------------------------------------------
// ④ ROUNDS / live / 聚合 / StateCache
// --------------------------------------------------------------------------

test('parseRounds：角度表 + 明细小节统计（时间/角度 strip、入库数取「（N 条）」）', () => {
  const { cases } = makeScanFixture();
  write(path.join(cases, 'ROUNDS.md'), [
    '# ROUNDS',
    '',
    '| 轮次 | 时间 | 阅读范围 | 角度 | 入库用例 | 新 bug |',
    '|------|------|----------|------|----------|--------|',
    '| 第 1 轮 | 2026-08-22 10:00 | 全部 | 冒烟 | FS0001~FS0015（15 条） | 2 |',
    '| 第 2 轮 | 2026-08-23 11:00 | diff | 边界 | （0 条） | 0 |',
    '',
    '### 第 1 轮（2026-08-22）',
    '',
    '- 执行统计：通过 16 / 失败 1 / 跳过 2',
    '',
    '### 第 2 轮（2026-08-23）',
    '',
    '- 执行统计：通过 3 / 失败 0',
    '',
  ].join('\n'));
  const rounds = cs.parseRounds(cases);
  assert.deepEqual(rounds, [
    { round: 1, time: '2026-08-22 10:00', angle: '冒烟', cases: 15, new_bugs: 2, passed: 16, failed: 1, skipped: 2 },
    { round: 2, time: '2026-08-23 11:00', angle: '边界', cases: 0, new_bugs: 0, passed: 3, failed: 0, skipped: 0 },
  ]);
  assert.deepEqual(Object.keys(rounds[0]),
    ['round', 'time', 'angle', 'cases', 'new_bugs', 'passed', 'failed', 'skipped']);
  assert.deepEqual(cs.parseRounds(path.join(cases, 'nope')), []);
});

test('parseRounds：英文统计行 + 角度表行端到端（与 Python 共享同一 ROUNDS 夹具）', () => {
  const { cases } = makeScanFixture();
  fs.copyFileSync(path.join(BILINGUAL, 'rounds_en.md'), path.join(cases, 'ROUNDS.md'));
  assert.deepEqual(cs.parseRounds(cases), [{
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

test('loadLive：live.json 内容 + mtime（Python 浮点口径）；缺失/坏 JSON ⇒ 双 null', () => {
  const { work } = makeScanFixture();
  assert.deepEqual(cs.loadLive(work), { live: null, mtime: null });
  const file = write(path.join(work, '.live', 'live.json'), '{"task_id": 7, "round": 2}');
  const loaded = cs.loadLive(work);
  assert.deepEqual(loaded.live, { task_id: 7, round: 2 });
  const st = fs.statSync(file, { bigint: true });
  assert.equal(loaded.mtime, lib.pyMtimeFloat(st.mtimeNs));
  write(path.join(work, '.live', 'live.json'), '{oops');
  assert.deepEqual(cs.loadLive(work), { live: null, mtime: null });
});

test('buildState：键序与各段形状（generated_at / live / library / bugs / rounds）', () => {
  const { work, cases, bugs } = makeScanFixture();
  write(path.join(cases, 'FS0001_a', 'status.md'), '- **状态**: 通过\n');
  fs.mkdirSync(path.join(cases, 'FS0001_a'), { recursive: true });
  write(path.join(cases, 'FS0001_a', 'status.md'), '- **状态**: 通过\n');
  fs.mkdirSync(path.join(bugs, '20260901_0001_FS_x'), { recursive: true });
  write(path.join(bugs, '20260901_0001_FS_x', 'bug_report.md'), '- **状态**: 待修复\n');
  write(path.join(work, '.live', 'live.json'), '{"task_id": 1}');
  const state = cs.buildState(cases, bugs, work);
  assert.deepEqual(Object.keys(state),
    ['generated_at', 'live', 'live_mtime', 'library', 'bugs', 'rounds']);
  assert.match(state.generated_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.deepEqual(state.live, { task_id: 1 });
  assert.equal(typeof state.live_mtime, 'number');
  assert.deepEqual(Object.keys(state.library), ['tree', 'stats']);
  assert.deepEqual(state.library.stats,
    { total: 1, passed: 1, failed: 0, retest: 0, skipped: 0, pending: 0 });
  assert.equal(state.bugs.length, 1);
  assert.deepEqual(state.rounds, []);
});

test('StateCache：TTL 内同一对象、过期重建；指纹剔除 generated_at 与事后写入的 project', () => {
  const { work, cases, bugs } = makeScanFixture();
  write(path.join(cases, 'FS0001_a', 'status.md'), '- **状态**: 通过\n');
  let clock = 1000;
  const cache = new cs.StateCache({ ttl: 1.0, now: () => clock });
  const s1 = cache.get(1, cases, bugs, work);
  assert.deepEqual(s1.library.stats,
    { total: 1, passed: 1, failed: 0, retest: 0, skipped: 0, pending: 0 });
  const f1 = cache.fingerprint(1);
  assert.equal(typeof f1, 'string');
  assert.ok(!f1.includes('generated_at'), '指纹里不该出现 generated_at');
  // ① TTL 内：同一对象（Python 也是就地改缓存对象，故必须是同一引用）
  clock += 0.5;
  assert.equal(cache.get(1, cases, bugs, work), s1);
  // ② 事后写入 project 段（`/api/state`、`/api/stream` 都这么干）不影响缓存指纹
  s1.project = { id: 1, name: 'p' };
  assert.equal(cache.fingerprint(1), f1);
  // ③ 过期 + 无文件变化 ⇒ 重建但指纹相同（证明 generated_at 确实被剔除）
  clock += 1.0;
  const s2 = cache.get(1, cases, bugs, work);
  assert.notEqual(s2, s1);
  assert.equal(cache.fingerprint(1), f1);
  // ④ 用例状态变化 ⇒ 指纹变。
  //    显式把 mtime 推后：文件缓存按 `(mtime_ns, size)` 失效，而「通过」→「失败」字节数相同，
  //    本机实测同一 tick（~2-4ms）内连写 200 次有 190 次 mtime_ns 完全相同 ⇒ 只改内容不加
  //    mtime 的话这条判据会变成「赌文件系统时钟粒度」（Python 的 cached_file 同样如此，
  //    不是 Node 侧的实现问题；见 test/casescan.test.mjs 的 cachedFile 用例）。
  const statusFile = path.join(cases, 'FS0001_a', 'status.md');
  write(statusFile, '- **状态**: 失败\n');
  fs.utimesSync(statusFile, new Date(Date.now() + 10000), new Date(Date.now() + 10000));
  clock += 1.0;
  cache.get(1, cases, bugs, work);
  assert.notEqual(cache.fingerprint(1), f1);
  // ⑤ 未构建过的项目 ⇒ fingerprint 为 null（Python 同）
  assert.equal(cache.fingerprint(999), null);
  cache.clear();
  assert.equal(cache.fingerprint(1), null);
});

test('pyJsonDumpsSorted：与 Python `json.dumps(..., sort_keys=True)` 同形（递归排序 + 码点序）', () => {
  const value = { b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } };
  assert.equal(cs.pyJsonDumpsSorted(value), '{"a": {"c": [3, {"y": 2, "z": 1}], "d": 2}, "b": 1}');
  assert.equal(cs.pyJsonDumpsSorted({ '\u{1F600}': 1, '\uE000': 2 }), '{"\uE000": 2, "\u{1F600}": 1}');
});
