/**
 * `backend/lib/rag.js` 单测（`node --test`，零依赖）——**专打对拍量具测不到的分支**。
 *
 * 为什么需要这一层：`tools/parity/cases-mod/rag.json` 走的是「模块入口 + JSON 入参」，
 * 有三处结构上到不了：
 *   ① **真发 HTTP**：用例全程零网络（配置里的 api_base 指向 127.0.0.1:9），故
 *      `_post_embeddings` 的成功路径、重试计数、`test_connection` 的 ok 态、
 *      `refresh` 的**差量嵌入**与**嵌入失败降级**、`retrieve_detail` 的**向量路**都没被覆盖；
 *   ② **文件权限**：量具的 `state` 只能比内容/存在性，比不了 `0600`；
 *   ③ **BM25 原始得分**：`_bm25_search` 的入参是 `_bm25_build` 产出的 int 键 dict，过 JSON
 *      边界后 Python 侧必抛 TypeError（见用例 note），只能在这里用 Python 实跑值直接钉。
 *
 * 判据来源：所有 float/字符串 oracle 都是 **Python 实跑** `rag.py` 得到的（写在注释里），
 * 不是读本模块反推。假 embedding 服务只 `listen(0, '127.0.0.1')`，**绝不触网**；
 * `TS_RAG_CONFIG` 一律指向 `mkdtemp` 目录，且文件末尾有一条守卫断言「真实
 * `~/.touchstone/rag.json` 全程未被创建/改写」。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import * as rag from '../lib/rag.js';

// --------------------------------------------------------------------------
// 夹具小工具
// --------------------------------------------------------------------------

/** 每测一个独立临时目录（用例结束即删） */
function mkTmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ts-rag-${tag}-`));
}

/**
 * 起一个**本机**假 embedding 服务（`127.0.0.1:0`）。
 *
 * `handler({ req, res, body, requests, texts })` 自行回包；`requests` 记录每次请求的
 * 方法/头/原文（重试计数与请求体断言都用它）。`close()` 必须调用，否则测试进程不退出。
 */
async function startFakeServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* 允许坏体 */ }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler({ req, res, body, requests, texts: parsed && parsed.input });
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => { server.close(resolve); }),
  };
}

/** 按文本给一个确定的向量：含 gamma→[3,4]、含 alpha→[1,0]、其余→[0,1]（归一化后互不相同） */
function vecFor(text) {
  if (String(text).includes('gamma')) return [3, 4];
  if (String(text).includes('alpha')) return [1, 0];
  return [0, 1];
}

/** 成功响应：**按 index 倒序**回包（专门验证「按 index 还原顺序」） */
function replyEmbeddings(res, texts) {
  const data = texts.map((t, i) => ({ index: i, embedding: vecFor(t) })).reverse();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data }));
}

/** 写一棵案例库：`{id: [名称, case.md 正文]}` */
function makeLibrary(root, cases) {
  for (const [id, [name, body]] of Object.entries(cases)) {
    const dir = path.join(root, `${id}_${name}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'case.md'), `# ${name} 用例\n\n- **接口**: /api/${name}\n\n${body}\n`);
    fs.writeFileSync(path.join(dir, 'status.md'), '- **状态**: 通过\n');
  }
}

/** 指向临时配置的 RAG 配置对象（timeout 短一点，避免测试卡住） */
function cfgFor(server, extra = {}) {
  return {
    api_base: server.url, api_key: 'sk-unit', model: 'm1', timeout_s: 5, batch_size: 16, ...extra,
  };
}

/** 真实用户配置（守卫用）：全程不得被创建/改写 */
const REAL_CFG = path.join(os.homedir(), '.touchstone', 'rag.json');
const REAL_BEFORE = fs.existsSync(REAL_CFG) ? fs.readFileSync(REAL_CFG, 'utf8') : null;

// --------------------------------------------------------------------------
// 数值 oracle（Python 实跑 rag.py 的返回值，逐位钉住）
// --------------------------------------------------------------------------

test('pyRound 与 CPython round() 逐位一致（半偶，不是 toFixed 的半上）', () => {
  // oracle: python3 -c "print([round(v,4) for v in [...]])"
  const cases = [
    [0.15625, 0.1562],        // toFixed(4) 会给 0.1563 —— 这条就是半偶 vs 半上的分水岭
    [0.99995, 1.0],
    [1234.56785, 1234.5678],
    [-1.23455, -1.2346],
    [0.00005, 0.0001],
    [1 / 3, 0.3333],
    [1e-7, 0],
    [1.00005, 1.0001],
    [0.5, 0.5],
    [2.5, 2.5],
    [0, 0],
  ];
  for (const [input, want] of cases) {
    assert.equal(rag.pyRound(input, 4), want, `round(${input}, 4)`);
    assert.ok(Object.is(rag.pyRound(input, 4), want), `round(${input}, 4) 逐位`);
  }
  assert.ok(Object.is(rag.pyRound(-0, 4), -0), '-0.0 保持负零');
  assert.ok(Number.isNaN(rag.pyRound(NaN, 4)), 'NaN 原样');
});

test('tokenize / BM25 原始得分 / RRF 对齐 Python 实跑值', () => {
  // oracle: rag.tokenize('Aa_b1 中文😀') -> ['aa_b1','中文']（下划线是词字符、CJK 走 bigram）
  assert.deepEqual(rag.tokenize('Aa_b1 中文😀'), ['aa_b1', '中文']);
  assert.deepEqual(rag.tokenize('登录失败'), ['登录', '录失', '失败']);
  assert.deepEqual(rag.tokenize('单'), ['单']);
  assert.deepEqual(rag.tokenize(''), []);
  assert.deepEqual(rag.tokenize(null), []);          // None or "" → ""
  assert.throws(() => rag.tokenize(5), {
    name: 'TypeError', message: "expected string or bytes-like object, got 'int'",
  });

  // oracle: rag._bm25_build(['alpha alpha 登录失败','beta','alpha zh'])
  //   -> inv {alpha:{0:2,2:1}, 登录:{0:1}, 录失:{0:1}, 失败:{0:1}, beta:{1:1}, zh:{2:1}}
  //      doc_len [5,1,2] n 3 avgdl 2.6666666666666665
  const idx = rag._bm25_build(['alpha alpha 登录失败', 'beta', 'alpha zh']);
  assert.deepEqual(idx, {
    inv: {
      alpha: { 0: 2, 2: 1 },
      登录: { 0: 1 },
      录失: { 0: 1 },
      失败: { 0: 1 },
      beta: { 1: 1 },
      zh: { 2: 1 },
    },
    doc_len: [5, 1, 2],
    n: 3,
    avgdl: 2.6666666666666665,
  });

  // oracle: 上面 idx 的 _bm25_search 原始返回值（**逐位**；IDF 走正确舍入的 pyLog）
  assert.deepEqual(rag._bm25_search(idx, 'alpha', 3),
    [[2, 0.5295815540797022], [0, 0.5240458583924579]]);
  assert.deepEqual(rag._bm25_search(idx, 'zh', 3), [[2, 1.1051597217033535]]);
  assert.deepEqual(rag._bm25_search(idx, '登录失败', 3), [[0, 2.1112019795768098]]);
  // 多词查询且各命中**不相交**文档（无浮点累加次序问题，可逐位比）
  assert.deepEqual(rag._bm25_search(idx, 'alpha beta', 3),
    [[1, 1.3646320041902278], [2, 0.5295815540797022], [0, 0.5240458583924579]]);
  assert.deepEqual(rag._bm25_search(idx, '不存在', 3), []);
  assert.deepEqual(rag._bm25_search(idx, '', 3), []);

  // oracle: rag._rrf_merge({'bm25':[[0,0.5]],'vec':[[0,0.9]]}, 3)
  assert.deepEqual(rag._rrf_merge({ bm25: [[0, 0.5]], vec: [[0, 0.9]] }, 3),
    [[0, 0.03278688524590164, 'bm25+vec']]);
  assert.deepEqual(rag._rrf_merge({}, 3), []);
  assert.deepEqual(rag._rrf_merge({ bm25: [[0, 1.5]] }, 0), []);

  // oracle: rag._norm([3,4]) -> [0.6,0.8]；零向量安全回落到 1.0
  assert.deepEqual(rag._norm([3, 4]), [0.6, 0.8]);
  assert.deepEqual(rag._norm([0, 0]), [0, 0]);
  assert.deepEqual(rag._norm([]), []);
  assert.equal(rag._dot([1, 2, 3], [4, 5]), 14);     // zip 截断
  assert.equal(rag._dot([], []), 0);

  // oracle: rag._similar_rows({'a':{'name':'甲','vec':[1,0]},'b':{'name':'B','vec':[0.6,0.8]}})
  assert.deepEqual(rag._similar_rows({ a: { name: '甲', vec: [1, 0] }, b: { name: 'B', vec: [0.6, 0.8] } }), [
    { id: 'a', name: '甲', similar: [{ id: 'b', name: 'B', score: 0.6 }] },
    { id: 'b', name: 'B', similar: [{ id: 'a', name: '甲', score: 0.6 }] },
  ]);
});

test('pyLog 与本地 libm 一致（Math.log 在 1.6 上差 1 ULP，V8 全可达域 7.5% 差 1 ULP）', () => {
  // oracle: python3 -c "import math; print(repr(math.log(1.6)))" -> 0.47000362924573563
  assert.equal(rag.pyLog(1.6), 0.47000362924573563);
  assert.notEqual(Math.log(1.6), rag.pyLog(1.6));     // 这一条就是 pyLog 存在的理由
  assert.equal(rag.pyLog(2), 0.6931471805599453);     // oracle: math.log(2)
  assert.equal(rag.pyLog(1), 0);
  assert.equal(rag.pyLog(Infinity), Infinity);
  assert.ok(Number.isNaN(rag.pyLog(NaN)));
  assert.throws(() => rag.pyLog(0), { name: 'ValueError', message: 'math domain error' });
  assert.throws(() => rag.pyLog(-1), { name: 'ValueError', message: 'math domain error' });
});

// --------------------------------------------------------------------------
// `_post_embeddings`：请求体/顺序/重试/条数
// --------------------------------------------------------------------------

test('_post_embeddings 成功：请求体是 json.dumps 默认形态、返回按 index 还原顺序', async () => {
  const server = await startFakeServer(({ res, texts }) => replyEmbeddings(res, texts));
  try {
    const texts = ['alpha 中文😀', 'gamma'];
    const vecs = await rag._post_embeddings(cfgFor(server), texts);
    // 服务端是**倒序**回的；结果必须与入参同序
    assert.deepEqual(vecs, [[1, 0], [3, 4]]);
    assert.equal(server.requests.length, 1, '成功只发一次');

    const req = server.requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/embeddings');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(req.headers.authorization, 'Bearer sk-unit');
    // oracle: json.dumps({'model':'m1','input':['alpha 中文😀','gamma']}) —— 默认 ensure_ascii=True
    assert.equal(req.body,
      '{"model": "m1", "input": ["alpha \\u4e2d\\u6587\\ud83d\\ude00", "gamma"]}');
  } finally {
    await server.close();
  }
});

test('_post_embeddings 条数不符 / 缺 data：抛 ValueError 且**重试 1 次**（共 2 次请求）', async () => {
  const short = await startFakeServer(({ res }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
  });
  try {
    await assert.rejects(() => rag._post_embeddings(cfgFor(short), ['a', 'b']),
      { name: 'ValueError', message: 'embeddings 返回条数不符' });
    assert.equal(short.requests.length, 2, 'HTTP_RETRY=1 ⇒ 首次 + 重试 1 次');
  } finally {
    await short.close();
  }

  const nodata = await startFakeServer(({ res }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'quota exceeded' }));
  });
  try {
    await assert.rejects(() => rag._post_embeddings(cfgFor(nodata), ['a']),
      { name: 'ValueError', message: 'embeddings 响应缺 data' });
    assert.equal(nodata.requests.length, 2);
  } finally {
    await nodata.close();
  }
});

test('_post_embeddings HTTP 500：抛错且恰好重试 1 次（请求计数 = 2）', async () => {
  const server = await startFakeServer(({ res }) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('boom');
  });
  try {
    await assert.rejects(() => rag._post_embeddings(cfgFor(server), ['a']), /HTTP Error 500/);
    assert.equal(server.requests.length, 2, '不允许无限重试');
  } finally {
    await server.close();
  }
});

// --------------------------------------------------------------------------
// `test_connection`：ok / 异常（含「校验先于请求」）
// --------------------------------------------------------------------------

test('test_connection：ok 态回 dim；异常态回 error 且不抛', async () => {
  const server = await startFakeServer(({ res, texts }) => {
    if (texts && texts[0] === 'ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }));
      return;
    }
    replyEmbeddings(res, texts || []);
  });
  try {
    const ok = await rag.test_connection(cfgFor(server));
    assert.deepEqual(ok, { ok: true, dim: 3 });
    assert.deepEqual(server.requests[0].body, '{"model": "m1", "input": ["ping"]}');

    // 半填配置 / 非法 timeout：在**发请求之前**就报错（这两条对拍用例覆盖不到「不发请求」）
    const before = server.requests.length;
    assert.deepEqual(await rag.test_connection({ api_base: server.url, model: 'm1', api_key: '' }),
      { ok: false, error: 'api_base / model / api_key 尚未填写完整' });
    assert.deepEqual(await rag.test_connection(cfgFor(server, { timeout_s: 0 })),
      { ok: false, error: 'timeout_s 须在 1~300 之间' });
    assert.deepEqual(await rag.test_connection(null),
      { ok: false, error: "'NoneType' object has no attribute 'get'" });
    assert.equal(server.requests.length, before, '校验失败不得发请求');
  } finally {
    await server.close();
  }

  // 真失败态：HTTP 500（test_connection 绝不抛，把原因文本回给调用方）
  const bad = await startFakeServer(({ res }) => {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('down');
  });
  try {
    const r = await rag.test_connection(cfgFor(bad));
    assert.equal(r.ok, false);
    assert.match(r.error, /HTTP Error 503/);
    assert.equal(bad.requests.length, 2);
  } finally {
    await bad.close();
  }
});

// --------------------------------------------------------------------------
// `save_config` / `disable`
// --------------------------------------------------------------------------

test('save_config：原子写、0600、内容逐字节 = json.dump(indent=2) + "\\n"', () => {
  const dir = mkTmp('cfg');
  const cfgPath = path.join(dir, 'nested', 'rag.json');
  const prev = process.env.TS_RAG_CONFIG;
  process.env.TS_RAG_CONFIG = cfgPath;
  try {
    const ret = rag.save_config({
      api_base: '  http://127.0.0.1:9/v1///  ',
      api_key: ' sk-x ',
      model: ' m1 ',
      timeout_s: '12',
      batch_size: 8,
    });
    assert.equal(ret, undefined, 'Python 返回 None');
    // oracle: json.dump({...}, ensure_ascii=False, indent=2) + "\n"（Python 实跑逐字节）
    assert.equal(fs.readFileSync(cfgPath, 'utf8'),
      '{\n'
      + '  "api_base": "http://127.0.0.1:9/v1",\n'
      + '  "api_key": "sk-x",\n'
      + '  "model": "m1",\n'
      + '  "timeout_s": 12,\n'
      + '  "batch_size": 8\n'
      + '}\n');
    assert.equal(fs.statSync(cfgPath).mode & 0o777, 0o600, '含明文 api_key，必须 0600');
    assert.equal(fs.existsSync(`${cfgPath}.tmp`), false, 'tmp 必须已被 rename 掉');
    assert.deepEqual(rag.load_config(), {
      api_base: 'http://127.0.0.1:9/v1', api_key: 'sk-x', model: 'm1',
      timeout_s: 12, batch_size: 8,
    });
    assert.deepEqual(rag.raw_config(), rag.load_config());

    // 原子替换：第二次写入覆盖旧文件，且不残留 tmp
    rag.save_config({ api_base: 'https://api.example.com/v1', api_key: 'k2', model: 'm2' });
    assert.equal(fs.readFileSync(cfgPath, 'utf8').includes('"api_key": "k2"'), true);
    assert.equal(fs.existsSync(`${cfgPath}.tmp`), false);
    assert.deepEqual(rag.load_config(), {
      api_base: 'https://api.example.com/v1', api_key: 'k2', model: 'm2',
      timeout_s: 30, batch_size: 16,          // 走 DEF_* 兜底
    });

    // 校验错误文案逐字照 Python
    assert.throws(() => rag.save_config({ api_base: 'ftp://x', api_key: 'k', model: 'm' }), {
      name: 'ValueError',
      message: 'api_base 须为 http(s):// 开头的 OpenAI 兼容服务地址（含 /v1，不含 /embeddings）',
    });
    assert.throws(() => rag.save_config({ api_base: 'http://x', api_key: '', model: 'm' }), {
      name: 'ValueError', message: 'api_key 不能为空',
    });
    assert.throws(() => rag.save_config({ api_base: 'http://x', api_key: 'k', model: ' ' }), {
      name: 'ValueError', message: 'model 不能为空（须为嵌入模型，非对话模型）',
    });
    assert.throws(() => rag.save_config({ api_base: 'http://x', api_key: 'k', model: 'm', timeout_s: 301 }), {
      name: 'ValueError', message: 'timeout_s 须在 1~300 之间',
    });
    // 校验失败不得留下半个文件（内容仍是上一次成功写入的）
    assert.equal(fs.readFileSync(cfgPath, 'utf8').includes('"api_key": "k2"'), true);
  } finally {
    if (prev === undefined) delete process.env.TS_RAG_CONFIG;
    else process.env.TS_RAG_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('disable：存在则删并回 true，再删回 false（幂等）', () => {
  const dir = mkTmp('disable');
  const cfgPath = path.join(dir, 'rag.json');
  const prev = process.env.TS_RAG_CONFIG;
  process.env.TS_RAG_CONFIG = cfgPath;
  try {
    assert.equal(rag.disable(), false, '文件不存在 → False（Python 只吞 FileNotFoundError）');
    fs.writeFileSync(cfgPath, '{}\n');
    assert.equal(rag.disable(), true);
    assert.equal(fs.existsSync(cfgPath), false);
    assert.equal(rag.disable(), false);
    assert.equal(rag.load_config(), null);
    assert.equal(rag.raw_config(), null);
  } finally {
    if (prev === undefined) delete process.env.TS_RAG_CONFIG;
    else process.env.TS_RAG_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// `refresh`：差量嵌入（成功 / 失败降级）
// --------------------------------------------------------------------------

test('refresh：差量嵌入按 batch_size 分批、写索引与 similar（对拍测不到的路径）', async () => {
  const dir = mkTmp('refresh');
  const lib = path.join(dir, 'lib');
  makeLibrary(lib, {
    FS0001: ['alpha', '登录失败排查。'],
    FS0002: ['beta', '订单超时处理。'],
    FS0003: ['gamma', '缓存击穿分析。'],
  });
  const server = await startFakeServer(({ res, texts }) => replyEmbeddings(res, texts));
  const prev = process.env.TS_RAG_CONFIG;
  process.env.TS_RAG_CONFIG = path.join(dir, 'rag.json');
  try {
    rag.save_config(cfgFor(server, { batch_size: 2 }));
    const stat = await rag.refresh(lib);
    assert.deepEqual(stat, { enabled: true, embedded: 3, total: 3 });
    assert.equal(server.requests.length, 2, 'batch_size=2 ⇒ 2 批');
    assert.equal(JSON.parse(server.requests[0].body).input.length, 2);
    assert.equal(JSON.parse(server.requests[1].body).input.length, 1);

    const rows = rag._load_jsonl(rag._index_path(lib));
    assert.deepEqual(rows.map((r) => r.id), ['FS0001', 'FS0002', 'FS0003'], '按 id 升序落盘');
    assert.equal(rows[0].model, 'm1');
    assert.equal(rows[0].dim, 2);
    assert.deepEqual(rows[0].vec, [1, 0]);
    assert.equal(rows[0].hash, rag.text_hash(rag.embedding_text(lib, { dir: 'FS0001_alpha' }), 'm1'));

    const similar = rag._load_jsonl(rag._similar_path(lib));
    assert.equal(similar.length, 3);
    assert.deepEqual(similar[0].id, 'FS0001');
    assert.equal(typeof similar[0].similar[0].score, 'number');

    // 第二次 refresh：索引完整 + similar 已在 ⇒ 不写盘、不再发请求
    const before = server.requests.length;
    const again = await rag.refresh(lib);
    assert.deepEqual(again, { enabled: true, embedded: 0, total: 3 });
    assert.equal(server.requests.length, before, '无 stale 不得再嵌入');
  } finally {
    if (prev === undefined) delete process.env.TS_RAG_CONFIG;
    else process.env.TS_RAG_CONFIG = prev;
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refresh：嵌入失败保留旧索引、不写 similar，两条日志文案照 Python', async () => {
  const dir = mkTmp('refreshfail');
  const lib = path.join(dir, 'lib');
  makeLibrary(lib, { FS0001: ['alpha', '一。'], FS0002: ['beta', '二。'] });
  const server = await startFakeServer(({ res }) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('x');
  });
  const prev = process.env.TS_RAG_CONFIG;
  process.env.TS_RAG_CONFIG = path.join(dir, 'rag.json');
  try {
    rag.save_config(cfgFor(server));
    const logs = [];
    const stat = await rag.refresh(lib, (m) => logs.push(m));
    assert.deepEqual(stat, { enabled: true, embedded: 0, total: 2 });
    assert.equal(logs.length, 2);
    assert.match(logs[0], /^RAG 嵌入失败（保留旧索引，待嵌 2 条）：HTTP Error 500/);
    // oracle 的**误导性文案**（stale_left 为 0 时也走 elif log）——这里 stale_left=2，文案是对的
    assert.equal(logs[1], 'RAG 索引不完整（待嵌 2 条），本轮不更新 similar.jsonl');
    assert.equal(fs.existsSync(rag._index_path(lib)), false, '一条都没嵌成 ⇒ 不写索引');
    assert.equal(fs.existsSync(rag._similar_path(lib)), false, '索引不完整 ⇒ 不动 similar');
    assert.equal(server.requests.length, 2, '单批失败：重试 1 次后放弃');
  } finally {
    if (prev === undefined) delete process.env.TS_RAG_CONFIG;
    else process.env.TS_RAG_CONFIG = prev;
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// `retrieve_detail` 的向量路（对拍用例全程零网络，覆盖不到）
// --------------------------------------------------------------------------

test('retrieve_detail：配置了 RAG → meta.configured/vec_ok 与 bm25+vec 融合', async () => {
  const dir = mkTmp('vec');
  const lib = path.join(dir, 'lib');
  makeLibrary(lib, {
    FS0001: ['alpha', '登录失败排查。'],
    FS0002: ['beta', '订单超时处理。'],
    FS0003: ['gamma', '缓存击穿分析。'],
  });
  let mode = 'ok';
  const server = await startFakeServer(({ res, texts }) => {
    if (mode === 'fail') {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('down');
      return;
    }
    replyEmbeddings(res, texts);
  });
  const prev = process.env.TS_RAG_CONFIG;
  process.env.TS_RAG_CONFIG = path.join(dir, 'rag.json');
  try {
    rag.save_config(cfgFor(server));
    await rag.refresh(lib);                       // 先把三篇的向量灌进索引

    const [rows, meta] = await rag.retrieve_detail(lib, 'gamma', 8);
    assert.deepEqual(meta, { configured: true, vec_ok: true, vec_error: null });
    assert.equal(rows.length, 3);
    // gamma 在 BM25 与向量两路都是 rank 0 ⇒ 1/61 + 1/61（oracle：round(1/61+1/61,4)=0.0328）
    assert.equal(rows[0].id, 'FS0003');
    assert.equal(rows[0].via, 'bm25+vec');
    assert.equal(rows[0].score, 0.0328);
    assert.deepEqual(rows.map((r) => r.via), ['bm25+vec', 'vec', 'vec']);
    assert.deepEqual(rows.map((r) => r.id), ['FS0003', 'FS0002', 'FS0001']);

    // 向量路失败（服务端 500）⇒ 只降级向量路，BM25 结果照常；原因进 meta 且**文案与 urllib 同形**
    mode = 'fail';
    const [rows2, meta2] = await rag.retrieve_detail(lib, 'gamma', 8);
    assert.equal(meta2.configured, true);
    assert.equal(meta2.vec_ok, false);
    assert.equal(meta2.vec_error, 'HTTP Error 500: Internal Server Error');
    assert.equal(rows2.length, 1, '纯 BM25：只有 gamma 命中');
    assert.equal(rows2[0].id, 'FS0003');
    assert.equal(rows2[0].via, 'bm25');
    assert.equal(rows2[0].score, 0.0164);

    // 服务直接不可达（连接被拒）：Python 是 `<urlopen error [Errno 111] Connection refused>`、
    // Node 是 `fetch failed` —— **文案两侧不同**（模块文件头已列为残余差异），只断言「降级 + 有原因」
    mode = 'down';
    await server.close();
    const [rows3, meta3] = await rag.retrieve_detail(lib, 'gamma', 8);
    assert.equal(meta3.vec_ok, false);
    assert.equal(typeof meta3.vec_error, 'string');
    assert.ok(meta3.vec_error.length > 0);
    assert.equal(rows3[0].id, 'FS0003');
  } finally {
    if (prev === undefined) delete process.env.TS_RAG_CONFIG;
    else process.env.TS_RAG_CONFIG = prev;
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// 索引读取 / 码点截断 / 永不抛出
// --------------------------------------------------------------------------

test('_load_index：坏行/非 dict/无 id 跳过，重复 id 后者覆盖', () => {
  const dir = mkTmp('idx');
  const live = path.join(dir, '.live');
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, 'rag_index.jsonl'), [
    '{"id": "A", "hash": "h1"}',
    '',
    '   ',
    'not json at all',
    '[1,2,3]',
    '"just a string"',
    '{"hash": "no-id"}',
    '{"id": "", "hash": "empty-id"}',
    '{"id": "A", "hash": "h2"}',
    '{"id": "\u4e2d\u6587", "hash": "h3"}',
    '',
  ].join('\n'));
  assert.deepEqual(rag._load_index(dir), {
    A: { id: 'A', hash: 'h2' },                       // 后者覆盖前者
    '中文': { id: '中文', hash: 'h3' },
  });
  assert.deepEqual(rag._load_index(path.join(dir, 'nope')), {});
  assert.deepEqual(rag._load_jsonl(path.join(dir, 'nope')), []);
});

test('码点截断：embedding_text 2000 / change_query 4000 都不切开代理对', () => {
  const dir = mkTmp('cp');
  const name = 'FS0005_emoji_测试';
  const body = `${'a'.repeat(2000 - (name.length + 1) - 1)}😀尾部`;
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'case.md'), body);
  const text = rag.embedding_text(dir, { dir: name });
  assert.equal([...text].length, 2000, '按码点截断');
  assert.equal(text.endsWith('😀'), true, '不切代理对（UTF-16 slice 会只剩半个 emoji）');

  const long = `${'f'.repeat(3999)}😀yz`;
  const q = rag.change_query({ files: [long] });
  assert.equal([...q].length, 4000);
  assert.equal(q.endsWith('😀'), true);
  assert.equal(rag.change_query({}), '');
  assert.equal(rag.change_query({ files: 'ab' }), 'a\nb');   // list("ab") = 逐字符
  assert.throws(() => rag.change_query({ files: [1] }), {
    name: 'TypeError', message: 'sequence item 0: expected str instance, int found',
  });
});

test('retrieve 永不抛出：根不存在 / 配置坏 JSON 都安静降级', async () => {
  const dir = mkTmp('robust');
  const prev = process.env.TS_RAG_CONFIG;
  process.env.TS_RAG_CONFIG = path.join(dir, 'rag.json');
  try {
    assert.deepEqual(await rag.retrieve(path.join(dir, 'no-such-root'), 'x', 3), []);
    const [rows, meta] = await rag.retrieve_detail(path.join(dir, 'no-such-root'), 'x', 3);
    assert.deepEqual(rows, []);
    assert.deepEqual(meta, { configured: false, vec_ok: false, vec_error: null });

    fs.writeFileSync(path.join(dir, 'rag.json'), '{ not json');
    assert.equal(rag.load_config(), null);
    assert.equal(rag.raw_config(), null);
    assert.deepEqual(await rag.retrieve(path.join(dir, 'no-such-root'), 'x', 3), []);

    fs.writeFileSync(path.join(dir, 'rag.json'), '[1, 2]');
    assert.equal(rag.load_config(), null, '非 dict 视为未配置');
    assert.equal(rag.raw_config(), null);
  } finally {
    if (prev === undefined) delete process.env.TS_RAG_CONFIG;
    else process.env.TS_RAG_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config_path：TS_RAG_CONFIG 覆盖默认 ~/.touchstone/rag.json', () => {
  const prev = process.env.TS_RAG_CONFIG;
  try {
    process.env.TS_RAG_CONFIG = '/tmp/x-rag.json';
    assert.equal(rag.config_path(), '/tmp/x-rag.json');
    delete process.env.TS_RAG_CONFIG;
    assert.equal(rag.config_path(), path.join(os.homedir(), '.touchstone', 'rag.json'));
    process.env.TS_RAG_CONFIG = '';
    assert.equal(rag.config_path(), path.join(os.homedir(), '.touchstone', 'rag.json'),
      '空串照 Python 的 or 口径回落默认值');
  } finally {
    if (prev === undefined) delete process.env.TS_RAG_CONFIG;
    else process.env.TS_RAG_CONFIG = prev;
  }
});

test('守卫：全程未创建/改写真实 ~/.touchstone/rag.json', () => {
  const now = fs.existsSync(REAL_CFG) ? fs.readFileSync(REAL_CFG, 'utf8') : null;
  assert.equal(now, REAL_BEFORE,
    `真实配置 ${REAL_CFG} 在测试期间被改动——本文件必须只碰 TS_RAG_CONFIG 指向的临时文件`);
});
