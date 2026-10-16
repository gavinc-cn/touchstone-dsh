/**
 * 飞书 REST 客户端单测（M7-R4）：`lib/feishu_rest.js` ↔ `feishu.py:1039-1183`。
 *
 * 期望值来源（**不读 Node 实现反推**）：
 *   ① `feishu.py` 原文逐行对照（行号见各用例）；
 *   ② **真 oracle 探针**（`/tmp` 脚本：把 `feishu.requests` 换成桩后实跑 `_rest`/`_tenant_token`）。
 *      本文件逐条引用的 oracle 实测文案：
 *        · token 成功响应 `{"code":0,"msg":"ok","tenant_access_token":"t-abc","expire":7200}`；
 *        · `code!=0` ⇒ `REST /open-apis/application/v7/app_slash_commands code=99991640 no permission`
 *          （`code` 属性 99991640）；缺 code 字段 ⇒ `REST /open-apis/y code=None no code field`（code None）；
 *        · 非 JSON(`<html>502 Bad Gateway</html>`, status 502) ×3 ⇒ 留痕三行
 *          `feishu rest: 非 JSON 响应(n/3) POST /open-apis/im/v1/messages status=502 raw=b'<html>502 Bad Gateway</html>'`，
 *          末行抛 `REST POST /open-apis/im/v1/messages 响应非 JSON status=502（已重试 3 次）`，**request 恰好 3 次**；
 *        · 非 dict(`[1, 2, 3]`) ×3 ⇒ `raw='[1, 2, 3]'` + `响应非对象（已重试 3 次）`；
 *        · 第 1 次非 JSON、第 2 次合法 ⇒ 成功返回，留痕 1 行，request 2 次；
 *        · **HTTP 500 + `{"code":0,…}` ⇒ 成功返回**（`_rest` 只看 `body.code`，不看状态码）；
 *        · 路径规范化：`/open-apis/bot/v3/info`、`open-apis/bot/v3/info`、`bot/v3/info`
 *          三种写法都拼出 `https://open.feishu.cn/open-apis/bot/v3/info`；`//open-apis//a` ⇒
 *          `https://open.feishu.cn/open-apis//a`（只 lstrip 一次前缀）；
 *        · `urlencode`：`{a:'x y~z/中', receive_id_type:'open_id', n:None}` ⇒
 *          `a=x+y~z%2F%E4%B8%AD&receive_id_type=open_id&n=None`；
 *        · token 请求体逐字节 `{"app_id": "cli_abc", "app_secret": "s3cret"}`（CPython `json=` 的
 *          `", "` 分隔符；hex 见下）；
 *        · token 成功但 `requests.request` 抛 OSError ⇒ `REST GET /open-apis/n 失败: conn refused`；
 *          token 自身失败 ⇒ `token 请求失败: …`（**不套 REST 外壳**）；假凭据真响应 ⇒
 *          `token 获取失败 code=10003 invalid param`；
 *        · 令牌缓存：2 次 `_tenant_token` + 2 次 `_rest` 只发 **1 次** token POST。
 *
 * 替身 fetch：本文件**不发任何真实网络请求**。`globalThis.fetch` 被换成记录器，未脚本化的 URL
 * 一律抛错（漏网请求立刻把用例打红），每个用例 `finally` 还原。响应是**真 `Response`**（undici），
 * 故 `resp.text()`/`resp.status` 语义与真机一致。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pyJsonDumps } from '../lib/pyjson.js';
import {
  FEISHU_DOMAIN, FEISHU_HOST, FeishuRestError, _BOT_OPEN_ID, _TOKEN_CACHE,
  botOpenId, rest, restPatchText, restReply, restSendCard, restSendText, tenantToken,
} from '../lib/feishu_rest.js';

// --------------------------------------------------------------------------
// 测试台
// --------------------------------------------------------------------------

const REAL_FETCH = globalThis.fetch;
const TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal';
const TOKEN_URL = `${FEISHU_HOST}${TOKEN_PATH}`;
/** oracle 探针实测的 token 请求体（CPython `json.dumps`：`", "` / `": "`） */
const TOKEN_BODY = '{"app_id": "cli_abc", "app_secret": "s3cret"}';
const TOKEN_BODY_HEX = '7b226170705f6964223a2022636c695f616263222c2022'
  + '6170705f736563726574223a2022733363726574227d';
const CFG = { app_id: 'cli_abc', app_secret: 's3cret' };

/** 造一个真 `Response`（对象体走 pyJsonDumps，与 requests 的 `json=` 序列化同口径） */
function resp(body, status = 200) {
  const text = typeof body === 'string' ? body : pyJsonDumps(body);
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** oracle 实测的成功 token 响应 */
function okToken(token = 't-abc') {
  return resp({ code: 0, msg: 'ok', tenant_access_token: token, expire: 7200 });
}

/**
 * 装上记录器替身：`script(call, index)` 返回 `Response`；返回 `undefined` ⇒ 未脚本化 ⇒ 抛错。
 * @returns {Array<{url: string, method: string, headers: object, body: any, hasSignal: boolean}>}
 */
function installFetch(script) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const call = {
      url: String(input),
      method: init.method,
      headers: init.headers,
      body: init.body,
      hasSignal: init.signal !== undefined,
    };
    calls.push(call);
    const reply = script(call, calls.length - 1);
    if (reply === undefined) {
      throw new Error(`替身 fetch 收到未脚本化请求 #${calls.length}：${call.method} ${call.url}`);
    }
    return reply;
  };
  return calls;
}

/** 只认 token 路由的脚本（其余 URL 未脚本化 ⇒ 抛错） */
function tokenOnly(token = 't-abc') {
  return (call) => (call.url === TOKEN_URL ? okToken(token) : undefined);
}

/** 预热 token 缓存（省掉 token 请求，便于数 REST 请求次数） */
function warmToken(token = 't-abc') {
  _TOKEN_CACHE.set(CFG.app_id, { token, expire: Date.now() / 1000 + 3600 });
}

/** 用例间的模块级内存态隔离（Python 侧测试同样 `_TOKEN_CACHE.clear()`） */
function freshCaches() {
  _TOKEN_CACHE.clear();
  _BOT_OPEN_ID.clear();
}

/** 抓 stderr 留痕（Python `print(..., file=sys.stderr, flush=True)` 的对位） */
function captureStderr() {
  const real = process.stderr.write;
  const lines = [];
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  return { lines, restore() { process.stderr.write = real; } };
}

/** 证据打印（`node --test` 会带进输出；断言之外另留一份原文） */
function evidence(tag, text) {
  process.stdout.write(`[证据${tag}] ${text}\n`);
}

/** 跑一个用例体：无论成败都还原 fetch 与内存态 */
async function withStub(script, body) {
  freshCaches();
  const calls = installFetch(script);
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = REAL_FETCH;
    freshCaches();
  }
}

// --------------------------------------------------------------------------
// 常量
// --------------------------------------------------------------------------

test('FEISHU_HOST/FEISHU_DOMAIN：硬编码 origin，无 env 覆盖点', async () => {
  assert.equal(FEISHU_HOST, 'https://open.feishu.cn');
  assert.equal(FEISHU_DOMAIN, 'https://open.feishu.cn');
  const saved = { FEISHU_HOST: process.env.FEISHU_HOST, TS_FEISHU_HOST: process.env.TS_FEISHU_HOST };
  process.env.FEISHU_HOST = 'http://127.0.0.1:1';
  process.env.TS_FEISHU_HOST = 'http://127.0.0.1:1';
  try {
    await withStub(() => resp({ code: 0 }), async (calls) => {
      warmToken();
      await rest('GET', 'bot/v3/info', { cfg: CFG });
      assert.equal(calls[0].url, 'https://open.feishu.cn/open-apis/bot/v3/info');
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

// --------------------------------------------------------------------------
// token
// --------------------------------------------------------------------------

test('tenantToken：请求逐字节（", " 分隔符 + hex）+ 缓存命中不再请求 + expire-300', async () => {
  const before = Date.now() / 1000;
  await withStub(tokenOnly('t-abc'), async (calls) => {
    assert.equal(await tenantToken(CFG), 't-abc');
    assert.equal(await tenantToken(CFG), 't-abc');
    assert.equal(calls.length, 1, '第二次必须命中缓存（oracle：2 次 _tenant_token 只发 1 次 POST）');

    const call = calls[0];
    assert.equal(call.url, TOKEN_URL);
    assert.equal(call.method, 'POST');
    assert.deepEqual(call.headers, { 'Content-Type': 'application/json' });
    assert.equal(call.body, TOKEN_BODY);
    assert.equal(call.body, pyJsonDumps({ app_id: 'cli_abc', app_secret: 's3cret' }));
    assert.ok(call.body.includes('", "'), 'token 体必须带 ", " 分隔符（JSON.stringify 紧凑形态会缺它）');
    assert.equal(Buffer.from(call.body, 'utf8').toString('hex'), TOKEN_BODY_HEX);
    assert.equal(call.hasSignal, true, 'timeout=10 ⇒ AbortSignal.timeout');

    const entry = _TOKEN_CACHE.get('cli_abc');
    assert.equal(entry.token, 't-abc');
    // `expire = 取值时刻 + out.expire - 300`（过期前 5 分钟刷新），取值时刻在请求之前
    assert.ok(Math.abs(entry.expire - (before + 7200 - 300)) < 2,
      `expire=${entry.expire} 应 ≈ now+6900`);

    evidence('①', `token 请求体 utf8=${call.body}`);
    evidence('①', `token 请求体 hex=${Buffer.from(call.body, 'utf8').toString('hex')}`
      + '（oracle json.dumps 原文 = {"app_id": "cli_abc", "app_secret": "s3cret"}，逐字节一致）');
  });
});

test('tenantToken：过期判定（未到期用缓存 / 已过期重取）+ expire 缺省 7200', async () => {
  await withStub(tokenOnly('t-new'), async (calls) => {
    const now = Date.now() / 1000;
    _TOKEN_CACHE.set('cli_abc', { token: 't-fresh', expire: now + 10 });
    assert.equal(await tenantToken(CFG), 't-fresh', '未到期（含 5 分钟余量内）⇒ 用缓存');
    assert.equal(calls.length, 0);

    _TOKEN_CACHE.set('cli_abc', { token: 't-stale', expire: now - 1 });
    assert.equal(await tenantToken(CFG), 't-new', '已过期 ⇒ 重新请求');
    assert.equal(calls.length, 1);
  });

  // `expire` 缺省 ⇒ 7200（响应里没有该字段的形态）
  await withStub(() => resp({ code: 0, msg: 'ok', tenant_access_token: 't-def' }), async (calls) => {
    const before = Date.now() / 1000;
    assert.equal(await tenantToken(CFG), 't-def');
    assert.equal(calls.length, 1);
    assert.ok(Math.abs(_TOKEN_CACHE.get('cli_abc').expire - (before + 7200 - 300)) < 2);
  });
});

test('tenantToken：假凭据真响应 ⇒ token 获取失败 code=10003 invalid param（不写缓存）', async () => {
  await withStub(() => resp({ code: 10003, data: {}, msg: 'invalid param' }), async (calls) => {
    await assert.rejects(() => tenantToken({ app_id: 'cli_fake', app_secret: 'bad' }), (e) => {
      assert.ok(e instanceof FeishuRestError);
      assert.equal(e.message, 'token 获取失败 code=10003 invalid param');
      assert.equal(e.code, 10003);
      return true;
    });
    assert.equal(calls.length, 1);
    assert.equal(_TOKEN_CACHE.size, 0, '失败不写缓存');
  });
});

test('tenantToken：网络异常 ⇒ token 请求失败: {e}（不套 REST 外壳、code=null）', async () => {
  await withStub(() => { throw new TypeError('fetch failed'); }, async () => {
    await assert.rejects(() => tenantToken(CFG), (e) => {
      assert.equal(e.message, 'token 请求失败: fetch failed');
      assert.equal(e.code, null);
      return true;
    });
  });
});

// --------------------------------------------------------------------------
// rest：URL / 头 / 体
// --------------------------------------------------------------------------

test('rest：路径规范化恰好一层前缀（四种写法，oracle 实测 URL）', async () => {
  const cases = [
    ['/open-apis/bot/v3/info', `${FEISHU_HOST}/open-apis/bot/v3/info`],
    ['open-apis/bot/v3/info', `${FEISHU_HOST}/open-apis/bot/v3/info`],
    ['bot/v3/info', `${FEISHU_HOST}/open-apis/bot/v3/info`],
    ['//open-apis//a', `${FEISHU_HOST}/open-apis//a`],
  ];
  for (const [input, expected] of cases) {
    await withStub(() => resp({ code: 0 }), async (calls) => {
      warmToken();
      await rest('GET', input, { cfg: CFG });
      assert.equal(calls.length, 1, `${input} 只应发一次请求`);
      assert.equal(calls[0].url, expected, `path=${input}`);
    });
  }
});

test('rest：Authorization/Content-Type 头、查询串（quote_plus 口径）、json 体逐字节', async () => {
  await withStub(() => resp({ code: 0 }), async (calls) => {
    warmToken();
    // oracle urlencode 实测：`a=x+y~z%2F%E4%B8%AD&receive_id_type=open_id&n=None`
    await rest('POST', '/open-apis/im/v1/messages', {
      params: { a: 'x y~z/中', receive_id_type: 'open_id', n: null },
      jsonBody: { receive_id: 'ou_x', msg_type: 'text' },
      cfg: CFG,
    });
    const call = calls[0];
    assert.equal(call.url, `${FEISHU_HOST}/open-apis/im/v1/messages`
      + '?a=x+y~z%2F%E4%B8%AD&receive_id_type=open_id&n=None');
    assert.equal(call.method, 'POST');
    assert.deepEqual(call.headers, {
      Authorization: 'Bearer t-abc',
      'Content-Type': 'application/json',
    });
    assert.equal(call.body, pyJsonDumps({ receive_id: 'ou_x', msg_type: 'text' }));

    // GET 无 params/json_body ⇒ 无查询串、无请求体（Python `json=None` 不序列化体）
    await rest('GET', 'bot/v3/info', { cfg: CFG });
    assert.equal(calls[1].url, `${FEISHU_HOST}/open-apis/bot/v3/info`);
    assert.equal(calls[1].body, undefined);
    assert.equal(calls[1].method, 'GET');
  });
});

test('rest：timeout 可收敛（M6 建方案文档 8s；缺省 10s；None = 不限时）', async () => {
  await withStub(() => resp({ code: 0 }), async (calls) => {
    warmToken();
    await rest('GET', 'bot/v3/info', { cfg: CFG, timeout: 8 });
    assert.equal(calls[0].hasSignal, true);
    await rest('GET', 'bot/v3/info', { cfg: CFG, timeout: null });
    assert.equal(calls[1].hasSignal, false, 'timeout=None ⇒ 不限时（Python None 语义）');
  });
});

// --------------------------------------------------------------------------
// rest：错误分支
// --------------------------------------------------------------------------

test('rest：cfg 缺失 ⇒ 固定文案、零网络', async () => {
  await withStub(() => undefined, async (calls) => {
    await assert.rejects(() => rest('GET', 'x', {}), (e) => {
      assert.ok(e instanceof FeishuRestError);
      assert.equal(e.message, '应用未配置（app_id/app_secret 缺失）');
      assert.equal(e.code, null);
      return true;
    });
    await assert.rejects(() => rest('GET', 'x', { cfg: null }), /应用未配置/);
    assert.equal(calls.length, 0, '未配置不许触网');
  });
});

test('rest：code != 0 ⇒ 立即抛（文案含规范化路径与 msg），code 字段透传', async () => {
  await withStub(() => resp({ code: 99991640, msg: 'no permission' }), async (calls) => {
    warmToken();
    await assert.rejects(
      () => rest('POST', '/open-apis/application/v7/app_slash_commands', { cfg: CFG }),
      (e) => {
        assert.equal(e.message,
          'REST /open-apis/application/v7/app_slash_commands code=99991640 no permission');
        assert.equal(e.code, 99991640);
        return true;
      },
    );
    assert.equal(calls.length, 1, '业务码非 0 不重试');
  });
});

test('rest：缺 code 字段 ⇒ code=None 文案 + code 属性 null（oracle 实测）', async () => {
  await withStub(() => resp({ msg: 'no code field' }), async () => {
    warmToken();
    await assert.rejects(() => rest('GET', 'y', { cfg: CFG }), (e) => {
      assert.equal(e.message, 'REST /open-apis/y code=None no code field');
      assert.equal(e.code, null);
      return true;
    });
  });
});

test('rest：只看 body.code 不看 HTTP 状态码 —— 500 + {"code":0} 当成功；503/200 + code!=0 抛错', async () => {
  // ① HTTP 500 + 合法 JSON code=0 ⇒ 成功返回（oracle 探针实测：_rest 原样返回该 dict）
  await withStub((call) => (call.url === TOKEN_URL ? okToken() : undefined), async () => {
    warmToken();
    const seen = [];
    globalThis.fetch = async (input) => {
      seen.push(String(input));
      return resp({ code: 0, msg: 'ok', data: { items: [] } }, 500);
    };
    const out = await rest('GET', 'x', { cfg: CFG });
    assert.deepEqual(out, { code: 0, msg: 'ok', data: { items: [] } });
    assert.deepEqual(seen, [`${FEISHU_HOST}/open-apis/x`]);
    evidence('②', 'HTTP 500 + {"code":0} ⇒ 成功返回 '
      + `${pyJsonDumps(out)}（未抛错；resp.status 未参与判定，只出现在非 JSON 留痕文案里）`);
  });

  // ② HTTP 503 + code!=0 ⇒ 抛错（状态码同样不参与判定）
  await withStub((call) => (call.url === TOKEN_URL ? okToken() : undefined), async () => {
    warmToken();
    globalThis.fetch = async () => resp({ code: 10003, msg: 'invalid param' }, 503);
    await assert.rejects(() => rest('GET', 'x', { cfg: CFG }), (e) => {
      assert.equal(e.message, 'REST /open-apis/x code=10003 invalid param');
      assert.equal(e.code, 10003);
      return true;
    });
  });

  // ③ HTTP 200 + code!=0 同样抛 —— 证明 ①② 不是「500 特判」
  await withStub((call) => (call.url === TOKEN_URL ? okToken() : undefined), async () => {
    warmToken();
    globalThis.fetch = async () => resp({ code: 99991672, msg: 'scope' }, 200);
    await assert.rejects(() => rest('GET', 'x', { cfg: CFG }), (e) => e.code === 99991672);
  });
});

test('rest：非 JSON 响应重试恰好 3 次（计数 + 留痕逐行 + 末次文案）', async () => {
  const err = captureStderr();
  let caught = null;
  try {
    await withStub((call) => (call.url === TOKEN_URL
      ? okToken()
      : new Response('<html>502 Bad Gateway</html>', { status: 502 })), async (calls) => {
      await assert.rejects(() => rest('POST', '/open-apis/im/v1/messages', { cfg: CFG }), (e) => {
        caught = e;
        assert.ok(e instanceof FeishuRestError);
        assert.equal(e.message,
          'REST POST /open-apis/im/v1/messages 响应非 JSON status=502（已重试 3 次）');
        assert.equal(e.code, null);
        return true;
      });
      const restCalls = calls.filter((c) => c.url !== TOKEN_URL);
      assert.equal(restCalls.length, 3, '非 JSON 必须重试到 3 次');
      assert.equal(calls.filter((c) => c.url === TOKEN_URL).length, 1,
        '三次尝试共用一次 token（缓存生效）');
      assert.equal(err.lines.length, 3, '每次非 JSON 都留痕');
      const expected = 'feishu rest: 非 JSON 响应(n/3) POST /open-apis/im/v1/messages '
        + "status=502 raw=b'<html>502 Bad Gateway</html>'";
      for (let i = 0; i < 3; i += 1) {
        assert.equal(err.lines[i], `${expected.replace('(n/3)', `(${i + 1}/3)`)}\n`);
      }
    });
  } finally {
    err.restore();
  }
  evidence('③', `非 JSON 重试计数：REST 请求 ${3} 次（另 1 次 token），stderr 留痕 ${err.lines.length} 行，`
    + `最终错误=${JSON.stringify(caught.message)}`);
});

test('rest：非 dict（合法 JSON 数组）重试 3 次 —— 文案与留痕走「响应非对象」分支', async () => {
  const err = captureStderr();
  try {
    await withStub((call) => (call.url === TOKEN_URL ? okToken() : resp('[1, 2, 3]')), async (calls) => {
      warmToken();
      await assert.rejects(() => rest('GET', 'z', { cfg: CFG }), (e) => {
        assert.equal(e.message, 'REST GET /open-apis/z 响应非对象（已重试 3 次）');
        return true;
      });
      assert.equal(calls.length, 3);
      assert.equal(err.lines.length, 3);
      assert.equal(err.lines[0], "feishu rest: 非 dict 响应(1/3) GET /open-apis/z raw='[1, 2, 3]'\n");
    });
  } finally {
    err.restore();
  }
});

test('rest：非 JSON 后恢复 —— 第 2 次成功即返回（留痕 1 行）', async () => {
  const err = captureStderr();
  try {
    let n = 0;
    await withStub((call) => {
      if (call.url === TOKEN_URL) return okToken();
      n += 1;
      return n === 1
        ? new Response('garbage', { status: 503 })
        : resp({ code: 0, data: { ok: 1 } });
    }, async (calls) => {
      warmToken();
      const out = await rest('GET', 'w', { cfg: CFG });
      assert.deepEqual(out, { code: 0, data: { ok: 1 } });
      assert.equal(calls.length, 2);
      assert.equal(err.lines.length, 1);
      assert.equal(err.lines[0],
        "feishu rest: 非 JSON 响应(1/3) GET /open-apis/w status=503 raw=b'garbage'\n");
    });
  } finally {
    err.restore();
  }
});

test('rest：网络异常 ⇒ REST {method} {path} 失败: {e}（oracle 实测外壳）', async () => {
  await withStub(() => { throw new TypeError('conn refused'); }, async () => {
    warmToken();
    await assert.rejects(() => rest('GET', 'n', { cfg: CFG }), (e) => {
      assert.equal(e.message, 'REST GET /open-apis/n 失败: conn refused');
      assert.equal(e.code, null);
      return true;
    });
  });
});

// --------------------------------------------------------------------------
// 四个包装 + botOpenId
// --------------------------------------------------------------------------

test('restSendText/restSendCard/restReply/restPatchText：URL/方法/体逐字节', async () => {
  await withStub(() => resp({ code: 0 }), async (calls) => {
    warmToken();
    const sent = await restSendText('ou_x', '你好', CFG);
    assert.equal(sent, undefined, 'Python 侧隐式 None ⇒ undefined');
    assert.equal(calls[0].url, `${FEISHU_HOST}/open-apis/im/v1/messages?receive_id_type=open_id`);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].body, pyJsonDumps({
      receive_id: 'ou_x',
      msg_type: 'text',
      content: '{"text": "你好"}',
    }));
    assert.equal(calls[0].body,
      '{"receive_id": "ou_x", "msg_type": "text", "content": "{\\"text\\": \\"你好\\"}"}');

    const card = { schema: '2.0', header: { title: { tag: 'plain_text', content: '标题' } } };
    await restSendCard('ou_x', card, CFG);
    assert.equal(calls[1].body, pyJsonDumps({
      receive_id: 'ou_x',
      msg_type: 'interactive',
      content: pyJsonDumps(card),
    }), 'content 是卡片 JSON **串**（{"data":…} 包裹会被 230099 拒绝）');

    await restReply('om_1', '好', CFG);
    assert.equal(calls[2].url, `${FEISHU_HOST}/open-apis/im/v1/messages/om_1/reply`);
    assert.equal(calls[2].body, '{"msg_type": "text", "content": "{\\"text\\": \\"好\\"}"}');

    await restPatchText('om_2', '改', CFG);
    assert.equal(calls[3].method, 'PUT', 'rest_patch_text 用 PUT');
    assert.equal(calls[3].url, `${FEISHU_HOST}/open-apis/im/v1/messages/om_2`);
    assert.equal(calls[3].body, '{"msg_type": "text", "content": "{\\"text\\": \\"改\\"}"}');
  });
});

test('botOpenId：GET /open-apis/bot/v3/info，按 app_id 缓存；取到 null 不构成命中', async () => {
  await withStub((call) => (call.url === `${FEISHU_HOST}/open-apis/bot/v3/info`
    ? resp({ code: 0, bot: { open_id: 'ou_bot' } }) : undefined), async (calls) => {
    warmToken();
    assert.equal(await botOpenId(CFG), 'ou_bot');
    assert.equal(await botOpenId(CFG), 'ou_bot');
    assert.equal(calls.length, 1, '第二次命中 _BOT_OPEN_ID');
    assert.equal(calls[0].url, `${FEISHU_HOST}/open-apis/bot/v3/info`);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].body, undefined);
  });

  // 回包无 bot 字段 ⇒ null；Python `if _BOT_OPEN_ID.get(app_id):` 判假 ⇒ 第二次仍请求
  await withStub((call) => (call.url === TOKEN_URL ? okToken() : resp({ code: 0 })), async (calls) => {
    warmToken();
    assert.equal(await botOpenId({ app_id: 'no-bot', app_secret: 'x' }), null);
    assert.equal(await botOpenId({ app_id: 'no-bot', app_secret: 'x' }), null);
    assert.equal(calls.filter((c) => c.url !== TOKEN_URL).length, 2,
      'null 不构成缓存命中（oracle 同：假值 ⇒ 再取）');
  });
});
