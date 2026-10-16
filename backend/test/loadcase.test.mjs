/**
 * M6-5 单测：`loadcase.js`（路径族 / 四级回落 / 图表校验 / 资产读取 / 指标归一 / 最小报告）。
 *
 * 期望值口径：
 *   - 纯算法/文本的向量来自 `loadcase.py` 原文与 CPython 现跑（`str.isdigit()` 的 Unicode 口径、
 *     `text[:N]` 按**码点**切片、`json.dump(indent=1)` 的逐字节形态）；
 *   - 「与 Python 一致」由量具 `tools/parity/mod-run.mjs --case loadcase` 覆盖；本文件覆盖
 *     量具表达不了的部分：**共享常量同一性**（`load_charts` 回落必须返回同一个 DEFAULT_CHARTS）、
 *     「分位算法只有一份」（loadcase 必须 import loadgen 的实现）、>64KiB 行的流式读取、
 *     非 BMP 字符的截断口径、只读/畸形路径的报错分支。
 *
 * 夹具一律 `mkdtemp` 临时目录，**绝不碰真实案例库**。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as lc from '../lib/loadcase.js';
import { _pct_from_buckets } from '../lib/loadgen.js';

/** 临时目录夹具 */
function tmpTree(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-loadcase-${tag}-`));
  const write = (rel, text) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return p;
  };
  return { dir, write };
}

const VALID_SCENARIO = JSON.stringify({
  name: '甲', base_url: 'http://127.0.0.1:9',
  groups: [{ name: 'g', path: '/' }], stages: [{ conc: 1, seconds: 5 }],
});

// --------------------------------------------------------------------------
// 路径族与运行键
// --------------------------------------------------------------------------

test('路径族：运行键切分与存量回落（含 .web 目录约定）', () => {
  assert.equal(lc.metrics_path('/w', 7, '20260101_120000'),
    '/w/.web/task_7_metrics_20260101_120000.jsonl');
  assert.equal(lc.metrics_path('/w', 7), '/w/.web/task_7_metrics.jsonl');
  assert.equal(lc.metrics_path('/w', 7, ''), '/w/.web/task_7_metrics.jsonl');
  assert.equal(lc.snapshot_path('/w', 7, 'K'), '/w/.web/task_7_load_K.jsonl');
  assert.equal(lc.snapshot_path('/w', 7), '/w/.web/task_7_load.jsonl');
  assert.equal(lc.legacy_snapshot_path('/w', 7), '/w/.web/task_7_load.jsonl');
  assert.equal(lc.load_log_path('/w', 7, 'K'), '/w/.web/task_7_load_K.log');
  assert.equal(lc.load_log_path('/w', 7), '/w/.web/task_7_load.log');
  assert.equal(lc.stop_file_path('/w', 7), '/w/.web/task_7_load.stop');
  assert.equal(lc.report_dir('/cases'), '/cases/load/report');
  assert.equal(lc.report_stem('/r', 7, 'K'), '/r/task7_K');
  assert.equal(lc.case_dir('/cases', 7), '/cases/load/task_7');
  assert.equal(lc.LOAD_DIR, 'load');
  assert.equal(lc.RUN_KEY_FMT, '%Y%m%d_%H%M%S');
});

test('parse_report_run_key：4/6 位时间戳 + 非法形态；new_run_key 能被自己解析', () => {
  assert.equal(lc.parse_report_run_key('task7_20260101_120000.json', 7), '20260101_120000');
  assert.equal(lc.parse_report_run_key('task7_20260101_1200.json', 7), '20260101_1200');
  for (const name of [
    'task7_20260101_120000.md', 'task8_20260101_120000.json', 'task7_2026010_120000.json',
    'task7_20260101_12000.json', 'task7_20260101_1200000.json', 'task7_20260101-120000.json',
    'task7_20260101_1200_00.json', 'task7_ab_120000.json', 'task77_20260101_120000.json',
    'task7_20260101_120000.txt', '',
  ]) {
    assert.equal(lc.parse_report_run_key(name, 7), null, name);
  }
  assert.equal(lc.parse_report_run_key('task7_20260101_120000.json', 8), null);
  // `str.isdigit()` 是 Unicode 口径（Nd + Digit 属性的 No），不是 ASCII
  assert.equal(lc.parse_report_run_key('task7_٢٠٢٦٠١٠١_١٢٠٠٠٠.json', 7), '٢٠٢٦٠١٠١_١٢٠٠٠٠');
  assert.equal(lc.parse_report_run_key('task7_٢٠٢٦٠١٠١_١٢٠٠٠٠.json', 7).split('_')[0].length >= 8, true);
  // 运行键与报告名互相印证（两侧都靠这个约定找报告）
  const key = lc.new_run_key();
  assert.match(key, /^\d{8}_\d{6}$/);
  assert.equal(lc.parse_report_run_key(`task7_${key}.json`, 7), key);
});

test('list_reports：目录缺失/空/混合形态与倒序（mtime 用 st_mtime 口径）', () => {
  const t = tmpTree('rep');
  assert.deepEqual(lc.list_reports(t.dir, 7), []);          // 连 load/report 都没有
  const rep = path.join(t.dir, 'load/report');
  fs.mkdirSync(rep, { recursive: true });
  assert.deepEqual(lc.list_reports(t.dir, 7), []);          // 空目录
  t.write('load/report/task7_20260101_120000.json', '{}');
  t.write('load/report/task7_20260101_120000.md', '# m');
  t.write('load/report/task7_20260101_1300.json', '{}');
  t.write('load/report/task8_20260101_120000.json', '{}');
  t.write('load/report/task7_2026010_120000.json', '{}');
  t.write('load/report/task7_20260101_140000.md', '# only md');
  const rows = lc.list_reports(t.dir, 7);
  // Python：sort(key=(run_key, mtime), reverse=True) ⇒ 运行键按**字符串**倒序
  assert.deepEqual(rows.map((r) => r.run_key), ['20260101_1300', '20260101_120000']);
  assert.deepEqual(rows.map((r) => r.legacy), [true, false]);
  assert.deepEqual(rows.map((r) => r.has_md), [false, true]);
  assert.deepEqual(rows.map((r) => r.md_path), [
    '', path.join(rep, 'task7_20260101_120000.md'),
  ]);
  assert.equal(rows[1].json_path, path.join(rep, 'task7_20260101_120000.json'));
  const st = fs.statSync(rows[1].json_path, { bigint: true });
  assert.equal(rows[1].mtime, Number(st.mtimeNs / 1000000000n) + Number(st.mtimeNs % 1000000000n) * 1e-9);
  assert.deepEqual(lc.list_reports(t.dir, 8).map((r) => r.run_key), ['20260101_120000']);
  assert.deepEqual(lc.list_reports('/nonexistent-cases-root', 7), []);
});

// --------------------------------------------------------------------------
// 四级回落与资产读取
// --------------------------------------------------------------------------

test('resolve：script > scenario > legacy > none；缺位一律 null（不是空串）', () => {
  const t = tmpTree('res');
  fs.mkdirSync(path.join(t.dir, 'load/task_1'), { recursive: true });
  t.write('load/task_1/run.py', "print('x')\n");
  t.write('load/task_1/plan.md', '# 甲\n');
  t.write('load/task_1/charts.json', '{"panels":[{"id":"a","type":"table","source":"summary"}]}');
  t.write('load/task_1/panel.html', '<p>x</p>');
  t.write('load/task_2/scenario.json', VALID_SCENARIO);
  t.write('load/scenario_3.json', VALID_SCENARIO);
  fs.mkdirSync(path.join(t.dir, 'load/task_4'), { recursive: true });
  t.write('load/task_4/plan.md', '# 只有方案\n');
  // task_2 同时有 run.py 时必须以 run.py 为准（优先级）
  t.write('load/task_2/run.py', "print('y')\n");

  const r1 = lc.resolve(t.dir, 1);
  assert.equal(r1.driver, lc.DRIVER_SCRIPT);
  assert.equal(r1.script_path, path.join(t.dir, 'load/task_1/run.py'));
  assert.equal(r1.scenario_path, null);
  assert.equal(r1.plan_path, path.join(t.dir, 'load/task_1/plan.md'));
  assert.equal(r1.charts_path, path.join(t.dir, 'load/task_1/charts.json'));
  assert.equal(r1.html_path, path.join(t.dir, 'load/task_1/panel.html'));

  const r2 = lc.resolve(t.dir, 2);
  assert.equal(r2.driver, lc.DRIVER_SCRIPT);
  assert.equal(r2.script_path, path.join(t.dir, 'load/task_2/run.py'));
  assert.equal(r2.plan_path, null);

  fs.rmSync(path.join(t.dir, 'load/task_2/run.py'));
  const r2b = lc.resolve(t.dir, 2);
  assert.equal(r2b.driver, lc.DRIVER_SCENARIO);
  assert.equal(r2b.scenario_path, path.join(t.dir, 'load/task_2/scenario.json'));
  assert.equal(r2b.script_path, null);

  const r3 = lc.resolve(t.dir, 3);                          // 存量布局：load/scenario_3.json
  assert.equal(r3.driver, lc.DRIVER_LEGACY);
  assert.equal(r3.scenario_path, path.join(t.dir, 'load/scenario_3.json'));
  assert.equal(r3.case_dir, path.join(t.dir, 'load/task_3'));

  const r4 = lc.resolve(t.dir, 4);
  assert.equal(r4.driver, null);
  assert.equal(r4.script_path, null);
  assert.equal(r4.scenario_path, null);
  assert.equal(r4.plan_path, path.join(t.dir, 'load/task_4/plan.md'));
  assert.equal(r4.charts_path, null);
  assert.deepEqual(lc.resolve(t.dir, 99), {
    driver: null,
    case_dir: path.join(t.dir, 'load/task_99'),
    plan_path: null,
    script_path: null,
    scenario_path: null,
    charts_path: null,
    html_path: null,
  });
});

test('read_assets：载体/方案/图表/逃生舱与 200KB 截断（按码点）', () => {
  const t = tmpTree('assets');
  t.write('load/task_1/scenario.json', VALID_SCENARIO);
  t.write('load/task_1/plan.md', '# 方案甲\n目标\n');
  const a1 = lc.read_assets(t.dir, 1);
  assert.deepEqual(a1, {
    found: true,
    driver: lc.DRIVER_SCENARIO,
    plan_md: '# 方案甲\n目标\n',
    plan_found: true,
    script_name: 'scenario.json',
    script_text: VALID_SCENARIO,
    charts: lc.DEFAULT_CHARTS,
    charts_error: '',
    has_html: false,
    case_dir: path.join(t.dir, 'load/task_1'),
    html_path: null,
  });
  const a99 = lc.read_assets(t.dir, 99);
  assert.equal(a99.found, false);
  assert.equal(a99.driver, '');
  assert.equal(a99.plan_md, '');
  assert.equal(a99.plan_found, false);
  assert.equal(a99.script_name, '');
  assert.equal(a99.charts, lc.DEFAULT_CHARTS);

  // 200KB 上限：截断按**码点**（Python 的 text[:N]），不是 UTF-16 码元
  const big = `${'a'.repeat(lc.ASSET_TEXT_MAX - 1)}😀${'b'.repeat(10)}`;
  t.write('load/task_2/plan.md', big);
  t.write('load/task_2/scenario.json', VALID_SCENARIO);
  const a2 = lc.read_assets(t.dir, 2);
  assert.equal([...a2.plan_md].length, lc.ASSET_TEXT_MAX + '\n\n…（内容过长已截断）'.length);
  assert.ok(a2.plan_md.startsWith('a'.repeat(lc.ASSET_TEXT_MAX - 1)));
  assert.ok(a2.plan_md.endsWith('\n\n…（内容过长已截断）'));
  assert.ok(a2.plan_md.includes('😀'));                     // 代理对没被劈开
  assert.equal(a2.plan_found, true);
});

test('_read_text_capped：缺失/目录/非法 UTF-8/CRLF 的读侧口径', () => {
  const t = tmpTree('cap');
  assert.equal(lc._read_text_capped(path.join(t.dir, 'nope.md')), '');
  const d = path.join(t.dir, 'adir');
  fs.mkdirSync(d);
  assert.equal(lc._read_text_capped(d), '');                // Python: IsADirectoryError → ""
  const crlf = t.write('crlf.md', 'a\r\nb\rc\n');
  assert.equal(lc._read_text_capped(crlf), 'a\nb\nc\n');    // 通用换行（newline=None）同 Python
  const bad = path.join(t.dir, 'bad.md');
  fs.writeFileSync(bad, Buffer.from([0x61, 0xff, 0x62]));
  assert.equal(lc._read_text_capped(bad), 'a\uFFFDb');      // errors="replace"
  assert.equal(lc.ASSET_TEXT_MAX, 200 * 1024);
});

// --------------------------------------------------------------------------
// 图表声明
// --------------------------------------------------------------------------

test('load_charts：回落必须返回**同一个** DEFAULT_CHARTS 对象，错误原因逐条给', () => {
  const t = tmpTree('charts');
  const [c0, e0] = lc.load_charts('');
  assert.equal(c0, lc.DEFAULT_CHARTS);                      // 同一性：Python 返回共享常量
  assert.equal(e0, '');
  assert.equal(lc.load_charts(null)[0], lc.DEFAULT_CHARTS);
  const [c1, e1] = lc.load_charts(path.join(t.dir, 'nope.json'));
  assert.equal(c1, lc.DEFAULT_CHARTS);
  assert.equal(e1, `图表声明读取失败: [Errno 2] No such file or directory: '${path.join(t.dir, 'nope.json')}'`);
  const [c2, e2] = lc.load_charts(t.write('bad.json', '{bad'));
  assert.equal(c2, lc.DEFAULT_CHARTS);
  assert.match(e2, /^图表声明不是合法 JSON: /);
  const [c3, e3] = lc.load_charts(t.write('bad2.json', '{"panels":[{"id":"a","type":"pie"}]}'));
  assert.equal(c3, lc.DEFAULT_CHARTS);
  assert.equal(e3, 'panels[0].type 非法: pie');
  // 目录：Python 是 IsADirectoryError（文案带文件名）
  const dirPath = path.join(t.dir, 'd');
  fs.mkdirSync(dirPath);
  const [c4, e4] = lc.load_charts(dirPath);
  assert.equal(c4, lc.DEFAULT_CHARTS);
  assert.equal(e4, `图表声明读取失败: [Errno 21] Is a directory: '${dirPath}'`);
  // 合法声明：回传规范化后的新对象（不是 DEFAULT_CHARTS）
  const [c5, e5] = lc.load_charts(t.write('ok.json', JSON.stringify({
    panels: [{ id: 'a', type: 'bar', metric: 'rps' }],
  })));
  assert.equal(e5, '');
  assert.notEqual(c5, lc.DEFAULT_CHARTS);
  assert.deepEqual(c5, {
    version: 1, title: '压测指标',
    panels: [{ id: 'a', type: 'bar', title: 'a', width: 'half', metric: 'rps', by: 'time' }],
  });
  // 非法 UTF-8 也走「不是合法 JSON」（CPython 里 UnicodeDecodeError 是 ValueError 子类）
  const enc = path.join(t.dir, 'enc.json');
  fs.writeFileSync(enc, Buffer.from([0xff, 0xfe]));
  assert.match(lc.load_charts(enc)[1],
    /^图表声明不是合法 JSON: 'utf-8' codec can't decode byte 0xff in position 0: invalid start byte$/);
});

test('validate_charts：条目数边界 24/25、12/13、8/9 与默认面板口径', () => {
  const line = (n) => ({
    panels: [{
      id: 'a', type: 'line', series: Array.from({ length: n }, (_, i) => ({ metric: `m${i}` })),
    }],
  });
  const stat = (n) => ({
    panels: [{
      id: 'a', type: 'stat', stats: Array.from({ length: n }, (_, i) => ({ metric: `m${i}` })),
    }],
  });
  const panelsN = (n) => ({ panels: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, type: 'table', source: 'summary' })) });
  assert.equal(lc.validate_charts(line(lc.MAX_SERIES))[1], null);
  assert.equal(lc.validate_charts(line(lc.MAX_SERIES + 1))[1], 'panels[0].series 必须是 1~12 项数组');
  assert.equal(lc.validate_charts(stat(lc.MAX_STATS))[1], null);
  assert.equal(lc.validate_charts(stat(lc.MAX_STATS + 1))[1], 'panels[0].stats 必须是 1~8 项数组');
  assert.equal(lc.validate_charts(panelsN(lc.MAX_PANELS))[1], null);
  assert.equal(lc.validate_charts(panelsN(lc.MAX_PANELS + 1))[1], 'panels 必须是 1~24 项数组');
  assert.equal(lc.MAX_PANELS, 24);
  assert.equal(lc.MAX_SERIES, 12);
  assert.equal(lc.MAX_STATS, 8);
  assert.deepEqual(lc.PANEL_TYPES, ['line', 'bar', 'stacked_bar', 'donut', 'stat', 'table']);
  assert.deepEqual(lc.PANEL_WIDTHS, ['half', 'full']);
  assert.deepEqual(lc.SAMPLE_TYPES, ['gauge', 'counter']);
  // 默认面板本身必须过自己的校验（否则回落就是坏数据）
  const [norm, err] = lc.validate_charts(lc.DEFAULT_CHARTS);
  assert.equal(err, null);
  assert.equal(norm.title, '压测指标');
  assert.equal(norm.panels.length, 5);
  assert.deepEqual(norm.panels.map((p) => p.type), ['line', 'line', 'line', 'stat', 'table']);
});

// --------------------------------------------------------------------------
// 指标行归一（分位算法**只有一份**）
// --------------------------------------------------------------------------

test('分位算法只有一份：loadcase 必须 import loadgen 的 _pct_from_buckets', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../lib/loadcase.js', import.meta.url)), 'utf8');
  assert.match(src, /import\s*\{[^}]*_pct_from_buckets[^}]*\}\s*from\s*'\.\/loadgen\.js'/s);
  // 剥掉注释再查「有没有第二份实现」（文件头的说明里就提到 bisect，不剥会误伤）
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /function\s+_pct_from_buckets/);
  assert.doesNotMatch(code, /bisect|LAT_BOUNDS/);
  // 语义一致：legacy 归一的 p95 必须与 loadgen 的分位函数逐值相同
  const buckets = { 1: 4, 2: 6, 5: 9 };
  const line = {
    ts: 1000.0, stage: 1, conc: 1, rps: 3.5, err: 0.5,
    groups: { g: { rps: 3.5, err: 0.5, lat: buckets } },
  };
  const samples = lc._legacy_samples(line);
  const gP95 = samples.find((s) => s.metric === 'lat.p95');
  assert.equal(gP95.value, _pct_from_buckets(buckets, 95));
  assert.deepEqual(gP95.labels, { group: 'g' });
  assert.deepEqual(samples.find((s) => s.metric === 'lat.p50').value,
    _pct_from_buckets(buckets, 50));
});

test('normalize_line：新格式透传、控制行原样、旧快照映射、其余空表', () => {
  const fresh = { ts: 1, metric: 'rps', value: 2.5, type: 'gauge' };
  assert.deepEqual(lc.normalize_line(fresh), [fresh]);
  const meta = { kind: 'meta', ts: 1, target: 'http://x' };
  assert.deepEqual(lc.normalize_line(meta), [meta]);
  const summary = { kind: 'summary', ts: 1, values: { A: 1 } };
  assert.deepEqual(lc.normalize_line(summary), [summary]);
  for (const bad of [[1, 2], 'x', null, 5, { rps: 1.0 }, { other: 1 }]) {
    assert.deepEqual(lc.normalize_line(bad), []);
  }
  const legacy = {
    ts: 1000.0, stage: 2, conc: 3, rps: 12.0, err: 2.0,
    groups: { 下单: { rps: 8.0, err: 1.0, lat: { 10: 3, 20: 5 } }, 查询: '坏数据' },
  };
  const out = lc.normalize_line(legacy);
  assert.deepEqual(out.slice(0, 3), [
    { ts: 1000.0, metric: 'rps', value: 12.0, type: 'gauge' },
    { ts: 1000.0, metric: 'err.rate', value: 2 / 12, type: 'gauge' },
    { ts: 1000.0, metric: 'conc', value: 3, type: 'gauge' },
  ]);
  assert.deepEqual(out[3], {
    ts: 1000.0, metric: 'rps', value: 8.0, type: 'gauge', labels: { group: '下单' },
  });
  // 坏组被跳过，但它的 lat 不参与合并（照 Python：continue 在合并之前）
  assert.equal(out.filter((s) => s.labels).length, 3);   // rps / err.rate / lat.p95
  // 合并桶只有 {10:3, 20:5}：target=4 → "10" 不够(3) → 落 "20"：10 + 10*(4-3)/5 = 12
  assert.equal(out.find((s) => s.metric === 'lat.p50').value, 12);
  // 缺 ts 时取挂钟（两侧不可能同值 ⇒ 只钉「约等于现在」与其余字段）
  const noTs = lc.normalize_line({ stage: 1, rps: 0.0, groups: {} });
  assert.equal(noTs[0].metric, 'rps');
  assert.ok(Math.abs(noTs[0].ts - Math.floor(Date.now() / 1000)) <= 1);
  assert.equal(noTs[1].value, 0.0);
  // rps 为 0 时不除零
  assert.equal(lc.normalize_line({ ts: 1, rps: 0.0, err: 1.0, groups: {} })[1].value, 0.0);
});

test('read_summary：最后一条 summary 胜出、非 dict values 跳过、流式跨块', () => {
  const t = tmpTree('sum');
  const lines = [
    '{"ts": 1.0, "metric": "rps", "value": 1.5, "type": "gauge"}',
    '不是 JSON',
    '{"kind": "summary", "ts": 3.0, "values": {"A": 1.5}}',
    '{"kind": "summary", "ts": 4.0, "values": "不是 dict"}',
    '{"kind": "summary", "ts": 5.0, "values": {"C": 2.5}}',
    '{"metric": "x", "note": "\\"summary\\" 出现在字符串里"}',
  ];
  const p = t.write('m.jsonl', `${lines.join('\n')}\n`);
  assert.deepEqual(lc.read_summary(p), { C: 2.5 });
  assert.deepEqual(lc.read_summary(t.write('n.jsonl', '{"kind":"meta"}\n')), {});
  assert.deepEqual(lc.read_summary(path.join(t.dir, 'nope.jsonl')), {});
  assert.deepEqual(lc.read_summary(t.dir), {});             // 目录：Python 是 IsADirectoryError
  // 行跨 64KiB 读块：StringDecoder 必须把多字节字符接起来（否则 summary 行会被判成坏 JSON）
  const pad = `${'中'.repeat(40000)}`;                      // 120KB 的合法字符串行
  const split = t.write('big.jsonl', [
    `{"kind": "meta", "ts": 1.0, "pad": "${pad}"}`,
    '{"kind": "summary", "ts": 2.0, "values": {"尾": "中文"}}',
  ].join('\n') + '\n');
  assert.deepEqual(lc.read_summary(split), { 尾: '中文' });
});

// --------------------------------------------------------------------------
// 脚本驱动的最小报告
// --------------------------------------------------------------------------

test('write_minimal_report：json(indent=1) 逐字节 + md 两种分支 + 失败也抛 OSError', () => {
  const t = tmpTree('min');
  const payload = {
    case: '方案甲', driver: 'script', started_at: '2026-01-01 00:00:00',
    duration_sec: 2.5, stopped: false, summary: { 总请求: 12.5, 备注: '无' },
  };
  const [jsonPath, mdPath] = lc.write_minimal_report(payload, path.join(t.dir, 'rep'), 7, '20260101_120000');
  assert.equal(jsonPath, path.join(t.dir, 'rep/task7_20260101_120000.json'));
  assert.equal(mdPath, path.join(t.dir, 'rep/task7_20260101_120000.md'));
  assert.equal(fs.readFileSync(jsonPath, 'utf8'), [
    '{',
    ' "case": "方案甲",',
    ' "driver": "script",',
    ' "started_at": "2026-01-01 00:00:00",',
    ' "duration_sec": 2.5,',
    ' "stopped": false,',
    ' "summary": {',
    '  "总请求": 12.5,',
    '  "备注": "无"',
    ' }',
    '}',
  ].join('\n'));
  assert.equal(fs.readFileSync(mdPath, 'utf8'), [
    '# 压测报告：方案甲', '',
    '- 驱动：自定义脚本（script）',
    '- 开始：2026-01-01 00:00:00 · 时长 2.5s', '',
    '## 关键指标', '', '| 指标 | 值 |', '|---|---|',
    '| 总请求 | 12.5 |', '| 备注 | 无 |', '',
  ].join('\n'));
  // 无 summary ⇒ 提示行；stopped ⇒ 后缀
  const [json2, md2] = lc.write_minimal_report(
    { ...payload, stopped: true, summary: {} }, path.join(t.dir, 'rep'), 7, '20260101_1200',
  );
  assert.equal(json2, path.join(t.dir, 'rep/task7_20260101_1200.json'));
  const mdText = fs.readFileSync(md2, 'utf8');
  assert.ok(mdText.includes('（用户停止，部分结果）'));
  assert.ok(mdText.includes('本次压测未上报收尾指标（summary 行缺失）'));
  // 目标被文件占住：os.makedirs(exist_ok=True) 抛 OSError（Python 侧同）
  const blocker = t.write('blocker', 'x');
  assert.throws(() => lc.write_minimal_report(payload, blocker, 7, 'k'),
    (e) => e.code === 'EEXIST' || e.code === 'ENOTDIR');
});

test('summarize_values：前 8 项、空表提示、LOAD 前缀', () => {
  assert.equal(lc.summarize_values({ A: 1.5, B: 'x' }), 'LOAD A=1.5 LOAD B=x');
  assert.equal(lc.summarize_values({}), 'LOAD 无指标数据');
  assert.equal(lc.summarize_values(null), 'LOAD 无指标数据');
  const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i + 0.5]));
  assert.equal(lc.summarize_values(many).split('LOAD ').length - 1, 8);
});

test('camelCase 别名与 Python 名指向同一实现（M6-6 调用侧要用）', () => {
  for (const [alias, py] of [
    ['newRunKey', 'new_run_key'], ['metricsPath', 'metrics_path'],
    ['snapshotPath', 'snapshot_path'], ['legacySnapshotPath', 'legacy_snapshot_path'],
    ['loadLogPath', 'load_log_path'], ['stopFilePath', 'stop_file_path'],
    ['reportDir', 'report_dir'], ['reportStem', 'report_stem'],
    ['parseReportRunKey', 'parse_report_run_key'], ['listReports', 'list_reports'],
    ['caseDir', 'case_dir'], ['validateCharts', 'validate_charts'],
    ['loadCharts', 'load_charts'], ['readAssets', 'read_assets'],
    ['normalizeLine', 'normalize_line'], ['readSummary', 'read_summary'],
    ['writeMinimalReport', 'write_minimal_report'], ['summarizeValues', 'summarize_values'],
    ['_readTextCapped', '_read_text_capped'], ['_validateSeries', '_validate_series'],
    ['_validateStatItems', '_validate_stat_items'], ['_legacySamples', '_legacy_samples'],
    ['_minimalMd', '_minimal_md'],
  ]) {
    assert.equal(lc[alias], lc[py], alias);
  }
  assert.equal(lc.DEFAULT_CHARTS.version, 1);
});
