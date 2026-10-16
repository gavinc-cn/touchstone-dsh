/**
 * M6-5 单测：`loadgen.js`（场景校验 / 分桶统计 / 报告 / MetricsWriter / run 子命令）。
 *
 * 期望值口径：
 *   - 纯算法的向量来自 `loadgen.py` 原文与 CPython 现跑（例如 `round(1.25, 1) == 1.2`、
 *     `format(0.125, ".2f") == "0.12"`、`bisect_left` 对 NaN 回 0）——不是照着 Node 实现反推；
 *   - 「与 Python 逐字节一致」由量具 `tools/parity/mod-run.mjs --case loadgen` 覆盖；
 *     本文件覆盖它测不到的**降级与 IO 细节**：worker 线程死亡的等价物、超时后连接停在半开
 *     状态产生的 conn_err、快速失败、只读/畸形文件系统、MetricsWriter 写失败静默。
 *
 * 夹具一律 `mkdtemp` 临时目录；发压只打 127.0.0.1 上本测试自己起的罐头服务（或确定无人
 * 监听的 9 端口），**不出网**。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MetricsWriter, QuickFailError, UnicodeEncodeError, _Agg, _bucket_of, _emit_tick,
  _fmt_errs, _max_from_buckets, _metrics, _pct_from_buckets, _pick_group, _report_md, main,
  py_error_str, py_field_str, py_float, read_json_file, run_load, validate_scenario,
  write_report_files,
} from '../lib/loadgen.js';

/** CLI 入口与仓库根（子进程里跑真入口，含 import.meta.url 守卫与 process.exitCode） */
const CLI = fileURLToPath(new URL('../lib/loadgen.js', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 临时目录夹具 */
function tmpTree(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-loadgen-${tag}-`));
  const write = (rel, text) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return p;
  };
  return { dir, write };
}

/** 起一个罐头 HTTP 服务；返回 {url, close, state} */
async function canned(handler) {
  const state = { count: 0 };
  const server = http.createServer((req, res) => {
    state.count += 1;
    req.resume();
    handler(req, res);
  });
  await new Promise((res) => { server.listen(0, '127.0.0.1', res); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () => new Promise((res) => { server.close(() => res()); }),
  };
}

/** 场景骨架（打给定 base_url） */
function scenario(baseUrl, extra = {}) {
  return {
    name: '单测场景',
    base_url: baseUrl,
    groups: [{ name: 'g', path: '/x', weight: 1 }],
    stages: [{ conc: 1, seconds: 5 }],
    timeout_ms: 1000,
    ...extra,
  };
}

/** 真起子进程跑 CLI 入口（比在测试进程里劫持 process.stdout 干净：
 *  node:test 自己的报告也写 stdout，劫持会把报告一起吞掉） */
function runCli(args, env = {}) {
  const p = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
  });
  return { exit: p.status, stdout: p.stdout ?? '', stderr: p.stderr ?? '' };
}

// --------------------------------------------------------------------------
// 场景校验（边界：Node 的 new URL() 与 Python 的 urlsplit 语义不同，必须手写）
// --------------------------------------------------------------------------

test('validate_scenario：端口与 host 的 Python 口径', () => {
  const t = tmpTree('sc');
  const ok = (base) => {
    const p = t.write(`s_${Buffer.from(base).toString('hex').slice(0, 12)}.json`, JSON.stringify(
      { name: 'n', base_url: base, groups: [{ name: 'g', path: '/' }], stages: [{ conc: 1, seconds: 5 }] },
    ));
    return validate_scenario(p);
  };
  // 端口 0 / 空端口 / IPv6 都是 Python 认的形态（`u.port` 不抛）
  assert.equal(ok('http://h:0')[1], null);
  assert.equal(ok('http://h:')[1], null);
  assert.equal(ok('http://[::1]:8080')[1], null);
  assert.equal(ok('http://127.0.0.1:65535')[1], null);
  // `port.isdigit() and port.isascii()`：+80 / 空格 / 下划线 / 越界都不是端口
  for (const base of ['http://h:+80', 'http://h: 80', 'http://h:1_0', 'http://h:-1',
    'http://h:abc', 'http://h:65536', 'http://h:99999999999999999999']) {
    assert.equal(ok(base)[1], 'base_url 端口非法（必须是 1~65535 的整数）', base);
  }
  // 不带方括号的 IPv6：`_hostinfo` 在第一个 ':' 处切开 ⇒ hostname 为空 ⇒ **hostname 分支**先命中
  // （CPython 的校验顺序也是 scheme/hostname/username/path/query/fragment 先于 port）
  assert.equal(ok('http://::1:8080')[1],
    'base_url 必须是 http(s)://host[:port] 形式（不支持 user:pass@，鉴权走 headers）');
  // 括号不成对时 urlsplit 直接抛 ValueError（照 CPython，validate_scenario 不吞它）
  assert.throws(() => ok('http://[::1'), /Invalid IPv6 URL/);
});

test('validate_scenario：JSON/文本层面的错误分支', () => {
  const t = tmpTree('sc2');
  const bad = t.write('bad.json', '{bad json');
  assert.match(validate_scenario(bad)[1], /^场景不是合法 JSON: /);
  const bom = t.write('bom.json', `\uFEFF${JSON.stringify({ name: 'n' })}`);
  // Python 的 utf-8 编解码器**不剥 BOM** ⇒ BOM 开头的 JSON 也是「不是合法 JSON」
  assert.match(validate_scenario(bom)[1], /^场景不是合法 JSON: /);
  const raw = path.join(t.dir, 'raw.json');
  fs.writeFileSync(raw, Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d]));
  assert.equal(validate_scenario(raw)[1],
    "场景不是合法 JSON: 'utf-8' codec can't decode byte 0xff in position 5: invalid start byte");
  // 目录：Python 是 IsADirectoryError，文案带文件名
  const dirPath = path.join(t.dir, 'adir');
  fs.mkdirSync(dirPath);
  const [sc, err] = validate_scenario(dirPath);
  assert.equal(sc, null);
  assert.equal(err, `场景文件不存在或不可读: [Errno 21] Is a directory: '${dirPath}'`);
});

test('validate_scenario：规范化写回（method 大写 / 补 weight 与 timeout_ms）', () => {
  const t = tmpTree('sc3');
  const p = t.write('s.json', JSON.stringify({
    name: '  甲  ', base_url: '  http://127.0.0.1:9/  ',
    groups: [{ name: ' g ', path: ' /a ', method: 'post', headers: { 'X-N': 2 } }],
    stages: [{ conc: 2, seconds: 5 }],
  }));
  const [sc, err] = validate_scenario(p);
  assert.equal(err, null);
  assert.equal(sc.base_url, 'http://127.0.0.1:9/');
  assert.equal(sc.timeout_ms, 10000);
  assert.deepEqual(sc.groups[0], {
    name: 'g', path: '/a', method: 'POST', headers: { 'X-N': 2 }, weight: 1,
  });
});

// --------------------------------------------------------------------------
// 分桶与统计
// --------------------------------------------------------------------------

test('_bucket_of：首个 >= 耗时的边界；NaN 照 bisect_left 回首个桶', () => {
  assert.equal(_bucket_of(0), '1');
  assert.equal(_bucket_of(1), '1');
  assert.equal(_bucket_of(1.0001), '2');
  assert.equal(_bucket_of(10000), '10000');
  assert.equal(_bucket_of(10000.5), 'over');
  // CPython: bisect.bisect_left(LAT_BOUNDS, nan) == 0（所有比较为 False）
  assert.equal(_bucket_of(NaN), '1');
});

test('_pct_from_buckets：插值 + round(...,1) 半偶舍入 + 空桶', () => {
  assert.equal(_pct_from_buckets({}, 50), null);
  assert.equal(_pct_from_buckets({ 1: 0, over: 0 }, 50), null);
  // target = 6*50/100 = 3；"1" 桶 2 不够，落 "2" 桶：1 + (2-1)*(3-2)/4 = 1.25 → round 半偶 → 1.2
  assert.equal(_pct_from_buckets({ 1: 2, 2: 4 }, 50), 1.2);
  assert.equal(_pct_from_buckets({ 10: 3 }, 50), 7.5);
  assert.equal(_pct_from_buckets({ over: 4 }, 50), 10000);
  // 桶外键只进 total 不进插值（照 Python：遍历的是固定边界表）
  assert.equal(_pct_from_buckets({ 1: 1, 诡异: 99 }, 50), null);
});

test('_max_from_buckets / _fmt_errs / _metrics', () => {
  assert.equal(_max_from_buckets({}), null);
  assert.equal(_max_from_buckets({ 1: 0, 5: 2, 20: 1 }), 20);
  assert.equal(_max_from_buckets({ over: 1 }), 10000);
  assert.equal(_fmt_errs({ '4xx': 1, '5xx': 0, timeout: 2, conn_err: 3 }), '4xx=1 5xx=0 超时=2 连接=3');
  assert.equal(_fmt_errs({}), '4xx=0 5xx=0 超时=0 连接=0');
  const stat = {
    count: 32,
    err: 5,
    err_cls: { '4xx': 5, '5xx': 0, timeout: 0, conn_err: 0 },
    buckets: { 1: 4, 2: 8, 5: 16, over: 4 },
  };
  const m = _metrics(stat, 8.0);
  // round(5/32, 4)：0.15625 是可精确表示的二进制小数 ⇒ 半偶舍入到 0.1562（不是 0.1563）
  assert.equal(m.err_rate, 0.1562);
  assert.equal(m.rps_avg, 4.0);
  assert.equal(m.total, 32);
  assert.equal(m.errors, 5);
  assert.equal('rps_peak' in m, false);
  assert.equal(_metrics(stat, 8.0, 12.5).rps_peak, 12.5);
  assert.equal(_metrics(stat, 0.0).rps_avg, 0.0);
  const zero = _metrics({ count: 0, err: 0, err_cls: {}, buckets: {} }, 3.0);
  assert.deepEqual(zero.p50, null);
  assert.equal(zero.err_rate, 0.0);
});

test('_report_md / 报告文本：None、int 字段与 `.2f` 的 CPython 口径', () => {
  const report = {
    scenario: '甲', base_url: 'http://h', started_at: '2026-01-01 00:00:00',
    duration_sec: 2.5, stopped: true,
    stages: [{ conc: 2, seconds: 5, total: 3, errors: 1, err_rate: 0.00125, rps_avg: 2.0, p50: 1.5, p90: null, p99: null, max: 50 }],
    overall: {
      total: 3, errors: 1, err_rate: 0.00125, rps_avg: 2.0,
      err_breakdown: { '4xx': 1, '5xx': 0, timeout: 0, conn_err: 0 },
      p50: 1.5, p90: null, p99: null, max: 50,
    },
    groups: { 下单: {
      total: 3, errors: 1, err_rate: 0.00125, rps_avg: 2.0, p50: 1.5, p90: null, p99: null, max: 50,
    } },
  };
  const md = _report_md(report);
  // 0.00125*100 = 0.125：CPython format(0.125, ".2f") = "0.12"（半偶），toFixed 会给 "0.13"
  assert.ok(md.includes('| 错误率 | 0.12% |'), md);
  // 整数值浮点：Python 侧是 round() 产物（float）⇒ `f"{2.0}"` = "2.0"
  assert.ok(md.includes('| 平均 RPS | 2.0 |'));
  // int 型字段（max）不能补 .0；None 按 Python 的 str 渲染
  assert.ok(md.includes('| max（近似） | 50 ms |'));
  assert.ok(md.includes('| P50 / P90 / P99 | 1.5 / None / None ms |'));
  assert.ok(md.includes('- 开始：2026-01-01 00:00:00 · 时长 2.5s（用户停止，部分结果）'));
  assert.ok(md.endsWith('\n'));
  // rps_peak 缺失时回落 '-'（`o.get("rps_peak", "-")`）
  const noPeak = { ...report, overall: { ...report.overall } };
  assert.ok(_report_md(noPeak).includes('| 峰值 RPS | - |'));
  assert.equal(py_field_str(2.0), '2.0');
  assert.equal(py_field_str(0.0), '0.0');
  assert.equal(py_field_str(null), 'None');
  assert.equal(py_field_str('x'), 'x');
});

test('write_report_files：json(indent=1)/md 落盘与返回路径', () => {
  const t = tmpTree('rep');
  const report = {
    scenario: '落盘', base_url: 'http://h', started_at: '2026-01-01 00:00:00',
    duration_sec: 2.5, stopped: false, stages: [],
    overall: {
      total: 0, errors: 0, err_rate: 0.0, rps_avg: 0.5,
      err_breakdown: { '4xx': 0, '5xx': 0, timeout: 0, conn_err: 0 },
      p50: null, p90: null, p99: null, max: null, rps_peak: 1.5,
    },
    groups: {},
  };
  const [jsonPath, mdPath] = write_report_files(report, path.join(t.dir, 'rep'), 7, '20260101_000000');
  assert.equal(jsonPath, path.join(t.dir, 'rep/task7_20260101_000000.json'));
  assert.equal(mdPath, path.join(t.dir, 'rep/task7_20260101_000000.md'));
  const text = fs.readFileSync(jsonPath, 'utf8');
  assert.ok(text.startsWith('{\n "scenario": "落盘",\n "base_url": "http://h",'));
  assert.ok(text.includes(' "p50": null,'));
  assert.ok(!text.endsWith('\n'));                    // json.dump 不补尾换行
  assert.ok(fs.readFileSync(mdPath, 'utf8').endsWith('\n'));
  // 报告目录被一个**文件**占住：os.makedirs(exist_ok=True) 抛 FileExistsError（OSError）
  const blocker = t.write('blocker', 'x');
  assert.throws(() => write_report_files(report, blocker, 7, 'k'), (e) => e.code === 'EEXIST'
    || e.code === 'ENOTDIR');
});

// --------------------------------------------------------------------------
// MetricsWriter
// --------------------------------------------------------------------------

test('MetricsWriter：写失败静默、close 幂等、labels 过滤、ts 不是标签', () => {
  const t = tmpTree('mw');
  // 通道不可写（父目录不存在）⇒ 不抛，静默降级
  const w = new MetricsWriter(path.join(t.dir, 'nodir/m.jsonl'));
  assert.doesNotThrow(() => w.sample('a', 1.5, { ts: 1 }));
  w.close();
  w.close();                                          // 幂等

  const p = t.write('m.jsonl', '');
  const w2 = new MetricsWriter(p);
  w2.sample('plain', 1.5, { ts: 1000.5 });
  w2.sample('bad', 'abc', { ts: 1 });                 // float("abc") → ValueError ⇒ 丢弃
  w2.sample('none', null, { ts: 1 });                 // float(None) → TypeError ⇒ 丢弃
  w2.sample('bool', true, { ts: 1 });                 // float(True) = 1.0 ⇒ 收下
  w2.sample('t', 3.5, { type: 'bogus', ts: 1 });      // 非法 type 回落 gauge
  w2.sample('lab', 4.5, {
    labels: {
      g: 'x', n: 7, f: 1.5, ok: true, none: null, obj: {},
    },
    ts: 1,
  });
  w2.sample('tslab', 5.5, { labels: { ts: 9.75 }, ts: 1.25 });
  w2.gauge('gg', 6.5, { ts: 2.5, group: '下单' });
  w2.counter('cc', 7.5, { ts: 2.5 });
  w2.meta({ target: 'http://x', nil: null });
  w2.summary({ A: 1 });
  w2.summary({});                                     // 空 dict 忽略
  w2.summary('nope');                                 // 非 dict 忽略
  w2.close();
  w2.sample('after', 9.5, { ts: 1 });                 // 关掉后不再写
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], {
    ts: 1000.5, metric: 'plain', value: 1.5, type: 'gauge',
  });
  assert.deepEqual(lines[1], {
    ts: 1, metric: 'bool', value: 1.0, type: 'gauge',
  });
  assert.deepEqual(lines[2], {
    ts: 1, metric: 't', value: 3.5, type: 'gauge',
  });
  assert.deepEqual(lines[3], {
    ts: 1, metric: 'lab', value: 4.5, type: 'gauge', labels: { g: 'x', n: 7, f: 1.5 },
  });
  // 标签里可以**有**名为 ts 的维度，但形参 ts 绝不落进 labels（bug_report/20261004_2040）
  assert.deepEqual(lines[4].labels, { ts: 9.75 });
  assert.equal(lines[4].ts, 1.25);
  assert.deepEqual(lines[5], {
    ts: 2.5, metric: 'gg', value: 6.5, type: 'gauge', labels: { group: '下单' },
  });
  assert.equal(lines[6].type, 'counter');
  assert.equal(lines[7].kind, 'meta');
  assert.equal(lines[7].target, 'http://x');
  assert.equal('nil' in lines[7], false);
  assert.equal(lines[8].kind, 'summary');
  assert.deepEqual(lines[8].values, { A: 1 });
  assert.equal(lines.length, 9);
});

test('_Agg：未知组/未知桶抛 KeyError；窗口取走即清零；copy_total 是深拷贝', () => {
  const bad = new _Agg(['a']);
  assert.throws(() => bad.add('zzz', true, '5', null), (e) => e.name === 'KeyError');
  assert.equal(bad.total.__all__.count, 0);          // 组名先查 ⇒ 还没碰 __all__
  // 桶名非法时 Python 是「先 g["count"] += 1 再抛 KeyError」⇒ 这里必须同形（半更新）
  assert.throws(() => bad.add('a', true, '7', null), (e) => e.name === 'KeyError');
  assert.equal(bad.total.a.count, 1);
  assert.equal(bad.total.a.buckets['7'], undefined);
  // err 同理：Python 先 `g["err"] += 1` 再 `g["err_cls"][cls] += 1`
  assert.throws(() => bad.add('a', false, null, '3xx'), (e) => e.name === 'KeyError');
  assert.equal(bad.total.a.count, 2);
  assert.equal(bad.total.a.err, 1);
  assert.equal(bad.total.a.err_cls['3xx'], undefined);   // 键根本没写进去（Python 侧同）

  const agg = new _Agg(['a', 'b']);
  agg.add('a', true, '5', null);
  agg.add('b', false, null, '5xx');
  const win = agg.take_window();
  assert.equal(win.a.count, 1);
  assert.equal(win.a.buckets['5'], 1);
  assert.equal(win.b.err, 1);
  assert.equal(win.b.err_cls['5xx'], 1);
  assert.equal(win.__all__.count, 2);
  assert.equal(win.__all__.err, 1);
  assert.equal(agg.take_window().__all__.count, 0);   // 取走即换新
  const total = agg.copy_total();
  assert.equal(total.__all__.count, 2);
  total.a.count = 999;                                // 改拷贝不影响原件
  assert.equal(agg.total.a.count, 1);
  assert.deepEqual(Object.keys(total.a.buckets).slice(-2), ['10000', 'over']);
});

test('_emit_tick：全局/分接口样本与累计计数（口径与默认面板一致）', () => {
  const t = tmpTree('tick');
  const w = new MetricsWriter(t.write('m.jsonl', ''));
  const win = {
    __all__: {
      count: 10, err: 2, err_cls: { '4xx': 2, '5xx': 0, timeout: 0, conn_err: 0 }, buckets: { 1: 4, 2: 6 },
    },
    g: {
      count: 10, err: 2, err_cls: { '4xx': 2, '5xx': 0, timeout: 0, conn_err: 0 }, buckets: { 1: 4, 2: 6 },
    },
  };
  const total = {
    __all__: {
      count: 30, err: 3, err_cls: { '4xx': 3, '5xx': 0, timeout: 0, conn_err: 0 }, buckets: { 1: 30 },
    },
  };
  _emit_tick(w, 1000.0, 4, win, total);
  w.close();
  const lines = fs.readFileSync(path.join(t.dir, 'm.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const byKey = (metric, group) => lines.find((l) => l.metric === metric
    && (group === undefined ? !l.labels : l.labels && l.labels.group === group));
  assert.equal(byKey('rps').value, 10);
  assert.equal(byKey('err.rate').value, 0.2);
  assert.equal(byKey('conc').value, 4);
  // buckets {1:4, 2:6} ⇒ p50: 1 + (2-1)*(5-4)/6 = 1.1667 → 1.2；p95: 1 + (9.5-4)/6 = 1.9167 → 1.9
  assert.equal(byKey('lat.p50').value, 1.2);
  assert.equal(byKey('rps', 'g').value, 10);
    assert.equal(byKey('lat.p95', 'g').value, 1.9);
  assert.equal(byKey('req.total').type, 'counter');
  assert.equal(byKey('req.total').value, 30);
  assert.equal(byKey('req.errors').value, 3);
  assert.equal(byKey('req.errors').ts, 1000.0);
});

// --------------------------------------------------------------------------
// 发压：连接/线程模型的降级语义
// --------------------------------------------------------------------------

test('run_load：成功路径（分类、分桶、报告、指标通道）', async () => {
  const t = tmpTree('live');
  const srv = await canned((req, res) => {
    if (req.url === '/bad') { res.writeHead(404); res.end('no\n'); return; }
    if (req.url === '/boom') { res.writeHead(500); res.end('x\n'); return; }
    if (req.url === '/redir') { res.writeHead(302, { location: '/x' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok\n');
  });
  try {
    const sc = scenario(srv.url, {
      groups: [{ name: 'ok', path: '/x', weight: 1 }, { name: 'nf', path: '/bad', weight: 1 }],
      stages: [{ conc: 2, seconds: 5 }],
      timeout_ms: 1000,
    });
    const t0 = Date.now();
    const [report, line] = await run_load(sc, {
      log_path: path.join(t.dir, 'l.log'),
      snap_path: path.join(t.dir, 's.jsonl'),
      should_stop: () => Date.now() - t0 > 2500,
      metrics_path: path.join(t.dir, 'm.jsonl'),
    });
    assert.equal(report.stopped, true);
    assert.ok(report.overall.total > 0);
    assert.equal(report.overall.errors, report.overall.err_breakdown['4xx']);
    assert.equal(report.overall.err_breakdown['5xx'], 0);
    assert.ok(report.overall.p50 !== null);            // 有成功请求 ⇒ 分位可算（值本身是挂钟产物）
    assert.ok(report.overall.max !== null);            // 最大非空桶存在（同样不钉具体桶）
    assert.ok(line.startsWith('LOAD 总请求=') && line.endsWith('（用户停止）'));
    assert.equal(report.groups.ok.total + report.groups.nf.total, report.overall.total);
    assert.equal(report.stages.length, 1);
    assert.equal(report.stages[0].conc, 2);
    const snaps = fs.readFileSync(path.join(t.dir, 's.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(snaps.length >= 1);
    assert.equal(snaps[0].stage, 1);
    assert.equal(snaps[0].conc, 2);
    assert.ok(snaps[0].groups.ok.rps >= 0);
    const meta = fs.readFileSync(path.join(t.dir, 'm.jsonl'), 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(meta[0].kind, 'meta');
    assert.equal(meta[0].case, '单测场景');
    assert.deepEqual(meta[0].stages, [{ conc: 2, seconds: 5 }]);
    assert.ok(meta.some((l) => l.metric === 'lat.p50'));   // _emit_tick 真被 ticker 走到
    assert.ok(meta.some((l) => l.metric === 'req.total' && l.type === 'counter'));
    assert.equal(meta[meta.length - 1].kind, 'summary');
    assert.equal(meta[meta.length - 1].values['总请求'], report.overall.total);
  } finally {
    await srv.close();
  }
});

test('run_load：3xx 记成功、5xx 记 5xx、超时记 timeout 并在下一次请求补一次 conn_err', async () => {
  const t = tmpTree('cls');
  const srv = await canned((req, res) => {
    if (req.url === '/boom') { res.writeHead(503); res.end(); return; }
    if (req.url === '/redir') { res.writeHead(304); res.end(); return; }
    // /hang：连接建立但不回响应（客户端 100ms 超时）
    setTimeout(() => { try { res.writeHead(200); res.end('late\n'); } catch { /* 已断 */ } }, 5000);
  });
  try {
    const t0 = Date.now();
    const stop = () => Date.now() - t0 > 900;
    const [ok] = await run_load(scenario(srv.url, {
      groups: [{ name: 'r', path: '/redir', weight: 1 }], timeout_ms: 200,
    }), { log_path: path.join(t.dir, 'l.log'), snap_path: path.join(t.dir, 's.jsonl'), should_stop: stop });
    assert.equal(ok.overall.errors, 0);
    assert.ok(ok.overall.total > 0);

    const t1 = Date.now();
    const [boom] = await run_load(scenario(srv.url, {
      groups: [{ name: 'b', path: '/boom', weight: 1 }], timeout_ms: 200,
    }), {
      log_path: path.join(t.dir, 'l2.log'),
      snap_path: path.join(t.dir, 's2.jsonl'),
      should_stop: () => Date.now() - t1 > 600,
    });
    assert.equal(boom.overall.err_breakdown['5xx'], boom.overall.total);
    assert.equal(boom.overall.p50, null);

    const t2 = Date.now();
    const [hang] = await run_load(scenario(srv.url, {
      groups: [{ name: 'h', path: '/hang', weight: 1 }],
      stages: [{ conc: 1, seconds: 5 }],
      timeout_ms: 100,
    }), {
      log_path: path.join(t.dir, 'l3.log'),
      snap_path: path.join(t.dir, 's3.jsonl'),
      should_stop: () => Date.now() - t2 > 700,
    });
    // 每次超时后，Python 的连接停在 _CS_REQ_SENT ⇒ 下一次 request() 抛 CannotSendRequest
    // （记一次 conn_err）再重建；两侧必须同形，否则 err_breakdown 会分叉
    assert.ok(hang.overall.err_breakdown.timeout > 0, JSON.stringify(hang.overall));
    assert.ok(hang.overall.err_breakdown.conn_err > 0, JSON.stringify(hang.overall));
    assert.ok(Math.abs(hang.overall.err_breakdown.timeout - hang.overall.err_breakdown.conn_err) <= 1);
  } finally {
    await srv.close();
  }
});

test('run_load：非 latin-1 body 只让该 worker 退出（照 Python 的线程死亡），其余档位照跑', async () => {
  const t = tmpTree('latin');
  const srv = await canned((req, res) => { res.writeHead(200); res.end('ok\n'); });
  try {
    const t0 = Date.now();
    const [cn] = await run_load(scenario(srv.url, {
      groups: [{ name: 'c', path: '/x', method: 'POST', body: '下单' }],
      stages: [{ conc: 2, seconds: 5 }],
    }), {
      log_path: path.join(t.dir, 'l.log'),
      snap_path: path.join(t.dir, 's.jsonl'),
      should_stop: () => Date.now() - t0 > 400,
    });
    assert.equal(cn.overall.total, 0);                 // 两个 worker 都在首个请求上死掉
    assert.equal(srv.state.count, 0);                  // 一个包都没发出去
    assert.equal(cn.stages.length, 1);                 // 档位照常收尾（join 立刻返回）

    const t1 = Date.now();
    const [ascii] = await run_load(scenario(srv.url, {
      groups: [{ name: 'a', path: '/x', method: 'POST', body: 'ok' }],
      stages: [{ conc: 2, seconds: 5 }],
    }), {
      log_path: path.join(t.dir, 'l2.log'),
      snap_path: path.join(t.dir, 's2.jsonl'),
      should_stop: () => Date.now() - t1 > 400,
    });
    assert.ok(ascii.overall.total > 0);
    assert.equal(ascii.overall.errors, 0);
  } finally {
    await srv.close();
  }
});

test('run_load：目标全拒连 ⇒ 第 10 秒快速失败，抛 QuickFailError 且指标通道收尾为「快速失败」', async () => {
  const t = tmpTree('qf');
  const [sc, err] = validate_scenario((() => {
    const p = path.join(t.dir, 'qf.json');
    fs.writeFileSync(p, JSON.stringify({
      name: 'qf', base_url: 'http://127.0.0.1:9',     // 无人监听：ECONNREFUSED
      groups: [{ name: 'g', path: '/x' }],
      stages: [{ conc: 2, seconds: 30 }], timeout_ms: 500,
    }));
    return p;
  })());
  assert.equal(err, null);
  const metrics = path.join(t.dir, 'm.jsonl');
  await assert.rejects(
    run_load(sc, {
      log_path: path.join(t.dir, 'l.log'),
      snap_path: path.join(t.dir, 's.jsonl'),
      metrics_path: metrics,
    }),
    (e) => e instanceof QuickFailError && e.name === 'QuickFailError'
      && /目标服务可能不可达/.test(e.message),
  );
  const lines = fs.readFileSync(metrics, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines[0].kind, 'meta');
  assert.equal(lines[lines.length - 1].kind, 'summary');
  assert.equal(lines[lines.length - 1].values['结果'], '快速失败');
  assert.ok(lines[lines.length - 1].values['总请求'] > 0);
  assert.equal(lines[lines.length - 1].values['错误数'],
    lines[lines.length - 1].values['总请求']);
});

// --------------------------------------------------------------------------
// CLI 面（退出码 0/2/3/4 与 stdin/stdout 分流）
// --------------------------------------------------------------------------

test('CLI 入口（子进程）：退出码 0/2/3/4 与 stdout/stderr 分流', () => {
  const t = tmpTree('cli');
  const bad = t.write('bad.json', JSON.stringify({
    name: 'n', base_url: 'http://h/path', groups: [{ name: 'g', path: '/' }],
    stages: [{ conc: 1, seconds: 5 }],
  }));
  const r2 = runCli(['run', '--scenario', bad]);
  assert.equal(r2.exit, 2);
  assert.equal(r2.stdout, '');
  assert.ok(r2.stderr.startsWith('场景校验失败：base_url 必须是'));

  // 快照路径是**目录** ⇒ open(...,"ab") 抛 IsADirectoryError ⇒ 兜底退出码 4
  const ok = t.write('ok.json', JSON.stringify(scenario('http://127.0.0.1:9')));
  const dirAsSnap = path.join(t.dir, 'dir');
  fs.mkdirSync(dirAsSnap);
  const r4 = runCli(['run', '--scenario', ok, '--snapshot', dirAsSnap]);
  assert.equal(r4.exit, 4);
  assert.equal(r4.stdout, '');
  assert.ok(r4.stderr.startsWith('发压异常：'));

  // 报告目录被文件占住 ⇒ 只警告不改退出码（照 Python：OSError 被吞、正常收尾）
  const stopFile = t.write('stop.flag', '1\n');
  const blocker = t.write('blocker', 'x');
  const r0 = runCli(['run', '--scenario', ok, '--stop-file', stopFile,
    '--metrics', path.join(t.dir, 'm.jsonl'), '--snapshot', path.join(t.dir, 's.jsonl'),
    '--report-dir', blocker, '--task-id', '7', '--run-key', 'k']);
  assert.equal(r0.exit, 0);
  assert.equal(r0.stdout, 'LOAD 总请求=0 错误率=0.0% P50=Nonems P99=Nonems 平均RPS=0.0（用户停止）\n');
  assert.ok(r0.stderr.startsWith('报告写盘失败：'));
  assert.deepEqual(fs.readdirSync(dirAsSnap), []);     // 快照路径失败时不留半成品

  // 无子命令 / 未知参数 / 缺 --scenario / 非整数 --task-id ⇒ 一律 2，且 stdout 为空
  for (const argv of [[], ['nope'], ['run'], ['run', '--scenario', ok, '--zzz', '1'],
    ['run', '--scenario', ok, '--task-id', 'x']]) {
    const r = runCli(argv);
    assert.equal(r.exit, 2, JSON.stringify(argv));
    assert.equal(r.stdout, '', JSON.stringify(argv));
    assert.ok(r.stderr.length > 0, JSON.stringify(argv));
  }
  // `--flag=value` 形态与 -h（用法文案两侧各自成型，只钉退出码与 stdout 形状）
  assert.equal(runCli(['run', `--scenario=${ok}`, `--stop-file=${stopFile}`]).exit, 0);
  const help = runCli(['run', '--help']);
  assert.equal(help.exit, 0);
  assert.ok(help.stdout.includes('usage: loadgen.js run'));
});

test('main(argv) 直接调用也返回退出码（不 sys.exit；平台发压轮按返回值判）', async () => {
  const t = tmpTree('cli2');
  const bad = t.write('bad.json', JSON.stringify({
    name: 'n', base_url: 'http://h/path', groups: [{ name: 'g', path: '/' }],
    stages: [{ conc: 1, seconds: 5 }],
  }));
  const realErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;                   // 只吞本函数自己那两行
  try {
    assert.equal(await main(['run', '--scenario', bad]), 2);
    assert.equal(await main([]), 2);
    assert.equal(await main(['nope']), 2);
  } finally {
    process.stderr.write = realErr;
  }
});

// --------------------------------------------------------------------------
// Node 侧共用 shim（复刻 CPython 语义）
// --------------------------------------------------------------------------

test('py_float：Python float() 的口径（bool/空白/下划线/inf/nan/报错类型）', () => {
  assert.equal(py_float(true), 1.0);
  assert.equal(py_float(false), 0.0);
  assert.equal(py_float(' 1_0 '), 10.0);
  assert.equal(py_float('1e3'), 1000.0);
  assert.equal(py_float('-inf'), -Infinity);
  assert.ok(Number.isNaN(py_float('nan')));
  assert.equal(py_float('.5'), 0.5);
  assert.equal(py_float(2.5), 2.5);
  assert.throws(() => py_float('abc'), (e) => e.name === 'ValueError');
  assert.throws(() => py_float(''), (e) => e.name === 'ValueError');
  assert.throws(() => py_float(null), (e) => e.name === 'TypeError');
  assert.throws(() => py_float([]), (e) => e.name === 'TypeError');
});

test('py_error_str / read_json_file：OSError 文案与严格 UTF-8', () => {
  const t = tmpTree('err');
  try {
    fs.readFileSync(path.join(t.dir, 'nope'));
    assert.fail('应当抛');
  } catch (e) {
    assert.equal(py_error_str(e), `[Errno 2] No such file or directory: '${path.join(t.dir, 'nope')}'`);
  }
  const dirPath = path.join(t.dir, 'd');
  fs.mkdirSync(dirPath);
  try {
    fs.readFileSync(dirPath);
    assert.fail('应当抛');
  } catch (e) {
    // EISDIR 来自 read()：Node 不带 path ⇒ 必须靠调用方兜底补文件名
    assert.equal(py_error_str(e), "[Errno 21] Is a directory");
    assert.equal(py_error_str(e, dirPath), `[Errno 21] Is a directory: '${dirPath}'`);
  }
  assert.equal(read_json_file(t.write('ok.json', '{"a": [1, 2.5]}')).a[1], 2.5);
  // 严格 UTF-8：非法字节按 CPython 的 UnicodeDecodeError 文案抛 ValueError
  const bad = path.join(t.dir, 'bad.json');
  fs.writeFileSync(bad, Buffer.from([0x5b, 0x31, 0xe4, 0xb8, 0x78, 0x5d]));
  assert.throws(() => read_json_file(bad),
    (e) => e.name === 'ValueError'
      && e.message === "'utf-8' codec can't decode bytes in position 2-3: invalid continuation byte");
  const trunc = path.join(t.dir, 'trunc.json');
  fs.writeFileSync(trunc, Buffer.from([0xf0, 0x9f]));
  assert.throws(() => read_json_file(trunc),
    (e) => e.message === "'utf-8' codec can't decode bytes in position 0-1: unexpected end of data");
  // BOM 不剥（Python 的 utf-8 编解码器保留 U+FEFF）
  const bom = path.join(t.dir, 'bom.json');
  fs.writeFileSync(bom, Buffer.from(`\uFEFF{}`, 'utf8'));
  assert.throws(() => read_json_file(bom), (e) => e.name === 'ValueError');
});

test('_pick_group：单组恒定；权重区间决定命中（吃满 sum(weight)）', () => {
  assert.equal(_pick_group([{ name: 'only', weight: 1 }]).name, 'only');
  assert.equal(_pick_group([{ name: 'only', weight: 7 }]).name, 'only');
  const groups = [{ name: 'a', weight: 1 }, { name: 'b', weight: 3 }];
  const hits = { a: 0, b: 0 };
  for (let i = 0; i < 4000; i += 1) hits[_pick_group(groups).name] += 1;
  assert.ok(hits.b > hits.a * 2, JSON.stringify(hits));
});

test('UnicodeEncodeError 的文案照 CPython（单字符/连续区间）', () => {
  const e = new UnicodeEncodeError("'latin-1' codec can't encode characters in position 0-1: "
    + 'ordinal not in range(256)');
  assert.equal(e.name, 'UnicodeEncodeError');
});

test('camelCase 别名与 Python 名指向同一实现（M6-6 调用侧要用）', async () => {
  const m = await import('../lib/loadgen.js');
  for (const [alias, py] of [
    ['validateScenario', 'validate_scenario'], ['writeReportFiles', 'write_report_files'],
    ['runLoad', 'run_load'], ['_cmdRun', '_cmd_run'], ['_bucketOf', '_bucket_of'],
    ['_pctFromBuckets', '_pct_from_buckets'], ['_maxFromBuckets', '_max_from_buckets'],
    ['_fmtErrs', '_fmt_errs'], ['_reportMd', '_report_md'], ['_pickGroup', '_pick_group'],
    ['_emitTick', '_emit_tick'],
  ]) {
    assert.equal(m[alias], m[py], alias);
  }
  assert.equal(m._metricsOf, m._metrics);
  assert.equal(typeof m.MetricsWriter, 'function');
  assert.equal(typeof m._Agg, 'function');
  assert.equal(m.LAT_BOUNDS.length, 13);
  assert.equal(m.MAX_CONC, 512);
  assert.equal(m.QUICK_FAIL_SECONDS, 10);
  assert.deepEqual(m.ERR_CLASSES, ['4xx', '5xx', 'timeout', 'conn_err']);
});
