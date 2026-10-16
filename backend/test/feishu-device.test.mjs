/**
 * 飞书 Device Flow（RFC 8628）客户端单测：`backend/lib/feishu_device.js`。
 *
 * ══ 判据纪律：期望**只来自 oracle** ══════════════════════════════════════════════════
 * 本文件的期望值不是从 Node 实现反推的，而是**驱动真 oracle 类**跑出来的轨迹：
 *  - 协议实现 = `lark_oapi/scene/registration/__init__.py` 的 `_SyncFlow`(`:273-325`)、
 *    `_encode_addons`(`:108-112`)、`_build_qr_url`(`:177-187`)、
 *    `_handle_poll_response`(`:197-232`)；
 *  - 取法：`backend/test/derive-feishu-device-expectations.py` —— 它**实例化真的
 *    `_SyncFlow`**，把 `_post` 换成脚本化响应序列、把 `time.sleep` 换成 no-op，
 *    再 `run()`，把 `posted / qr / status / out / err / base_url` 原样打出来。
 *    本文件下方所有常量即那次运行的输出（`python3.12` + lark-oapi 1.7.3，本机）。
 *  - 驱动方式：`/opt/miniconda3/envs/my_pyenv/bin/python3
 *    backend/test/derive-feishu-device-expectations.py`
 *
 * 代跑说明：`_SyncFlow` 是包内私有类，但它是**协议的唯一真源**；直接用真类（而不是
 * 手抄一份等价逻辑）才能保证「期望 = oracle 行为」而不是「期望 = 我对 oracle 的转述」。
 *
 * ══ 替身 fetch ════════════════════════════════════════════════════════════════════════
 * 本文件**不发任何真实网络请求**：`globalThis.fetch` 被换成记录器，未脚本化的调用立刻抛错
 * （漏网请求把用例打红），每个用例 `finally` 还原。响应是真 `Response`（undici），
 * 故 `resp.json()` 语义与真机一致。
 *
 * ══ 已登记的**不可逐字节**项（见模块头「已知分歧」）══════════════════════════════════
 * addons 的 **DEFLATE 码流**与 CPython 不同（Node 内置 zlib 是被打过补丁的
 * `1.3.2.1-motley`，CPython 是 `1.3.2`）：同一输入下两者 LZ77 解析不同 ⇒ 压缩字节不同。
 * 因此「逐字节对拍」在本文件里分成三层，各钉各的：
 *  ① **明文载荷**逐字节（`_addonsPayload` 与 oracle `_addons_payload` 全等）；
 *  ② **gzip 容器头**逐字节（`1f8b0800000000000002`，mtime=0 + XFL=2）；
 *  ③ **oracle 那一串 base64url 必须能被本模块解开**并还原出 ①（反向可解性），
 *     即两种码流解码后**同一份字节**——这才是服务端真正吃到的语义。
 */
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { test } from 'node:test';

import {
  DEFAULT_EXPIRES_IN_S, DEFAULT_INTERVAL_S, DEVICE_ENDPOINT, FEISHU_DOMAIN, LARK_DOMAIN,
  LARK_MIN_VERSION, SLOW_DOWN_STEP_S, SOURCE_SDK_NAME, _addonsPayload, _buildQrUrl,
  _encodeAddons, _provisionAddons, _quotePlus, createCancelEvent, makeDeviceFlow,
  registerApp, supportedAuthMethods,
} from '../lib/feishu_device.js';
// `_registerAppImpl` / `_setSourceForTest` 是 `feishu.py:2957` 那一层的对应物（在 provison 里）
import { _registerAppImpl, _setSourceForTest } from '../lib/feishu_provision.js';
import { REQUIRED_CALLBACKS, REQUIRED_EVENTS, REQUIRED_SCOPES } from '../lib/feishu_provision.js';

// --------------------------------------------------------------------------
// 测试台
// --------------------------------------------------------------------------

const REAL_FETCH = globalThis.fetch;

/** oracle `_SyncFlow` 的 `_post` 打的是 `{base}{_ENDPOINT}`（registration/__init__.py:14,261-267） */
const ENDPOINT_PATH = '/oauth/v1/app/registration';
const FEISHU_URL = `${FEISHU_DOMAIN}${ENDPOINT_PATH}`;
const LARK_URL = `${LARK_DOMAIN}${ENDPOINT_PATH}`;

/**
 * 把 url 拆成「addons 之前的部分」+「addons 值」。
 * 为什么要拆：`addons` 是 gzip 码流，Node 内置 zlib（1.3.2.1-motley）与 CPython 的 1.3.2
 * 对同一明文产出**不同的 deflate 字节**（见文件头）；拆开之后，「键序 + 逐字节编码」
 * 钉在稳定的前半段，「载荷语义」钉在解压后的明文上 —— 两条都是真判据，不掺水。
 */
function splitAddons(url) {
  const at = url.indexOf('&addons=');
  assert.notEqual(at, -1, `url 里必须有 addons 参数：${url}`);
  return { head: url.slice(0, at), encoded: url.slice(at + '&addons='.length) };
}

/** 断言 url 的「addons 之前」与 oracle 逐字节相同，且 addons 解压后等于 oracle 明文 */
function assertUrlMatchesOracle(url) {
  assert.equal(splitAddons(url).head, splitAddons(ORACLE_QR_URL).head);
  assert.equal(gunzipSync(Buffer.from(splitAddons(url).encoded, 'base64url')).toString('utf8'),
    ORACLE_ADDONS_PAYLOAD);
}

/**
 * oracle 轨迹里的拼装原料（`derive-feishu-device-expectations.py` 的输入）：
 * 原样的 `verification_uri_complete`，键序 device_code/verification_uri/user_code/expires_in。
 */
const VERIFICATION_URI = 'https://accounts.feishu.cn/qrcode?device_code=DC-abc123'
  + '&verification_uri=https%3A%2F%2Faccounts.feishu.cn%2Fverify'
  + '&user_code=WDJB-MJHT&expires_in=600';

/** oracle `_encode_addons`(108-112) 对 `_provision_addons()` 的输出（真类跑出来的原串） */
const ORACLE_ADDONS_ENCODED = 'H4sIAAAAAAACA4WP3QrCMAyF3yXXY6CXfRWRkrWxFvtHEicyfHe7gTAQ8S6c75zk'
  + 'ZIHGJKRgLpiEBhBXGwmYBZQKlg5OELPJJIKBxnZsNkswTOhrSU8Y9jRwvTeL-ttihIq3KHaq2gG2lqJDjbWYPltJKFf'
  + 'ras5Y_Lbhr-nBUQnOrwFopqJb9a7krx_GT0smR3EmOx96rOccpjShu-2jp66yH9GtV0flGALxan8D2oEjljEBAAA';

/** oracle `_normalize_addons` + `json.dumps(..., ensure_ascii=False, separators=(",",":"))` 的**明文** */
const ORACLE_ADDONS_PAYLOAD = '{"preset":false,"scopes":{"tenant":["im:message.p2p_msg:readonly",'
  + '"im:message.group_at_msg:readonly","im:message:send_as_bot",'
  + '"application:app_slash_command:read","application:app_slash_command:write"]},'
  + '"events":{"items":{"tenant":["im.message.receive_v1"]}},'
  + '"callbacks":{"items":["card.action.trigger"]}}';

/** oracle `_build_qr_url`(177-187) 的输出（happy 轨迹的 `qr[0].url`，逐字节） */
const ORACLE_QR_URL = `${VERIFICATION_URI}&from=sdk&tp=sdk&source=python-sdk`
  + `&addons=${ORACLE_ADDONS_ENCODED}`;

const INIT_OK = { supported_auth_methods: ['client_secret', 'something_else'] };
const BEGIN_OK = {
  device_code: 'DC-abc123', interval: 5, expires_in: 600,
  verification_uri_complete: VERIFICATION_URI,
};

/** oracle 轨迹里 poll 请求体恒是 `{"action":"poll","device_code":...}` ⇒ 等价表单串 */
const POLL_BODY = 'action=poll&device_code=DC-abc123';
const INIT_BODY = 'action=init';
const BEGIN_BODY = 'action=begin&archetype=PersonalAgent&auth_method=client_secret'
  + '&request_user_info=open_id';

function resp(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

/** 装上脚本化 fetch。`script(seq, call)` 返回响应体对象；用尽即抛错（漏网请求立刻打红）。 */
function installFetch(script) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const call = {
      url: String(input),
      method: init.method,
      headers: init.headers,
      body: init.body,
      index: calls.length,
    };
    calls.push(call);
    const step = script(call.index, call);
    if (step === undefined) throw new Error(`未脚本化的请求 #${call.index}: ${call.url}`);
    return resp(step);
  };
  return { calls, urls: () => calls.map((c) => c.url) };
}

/**
 * 跑一次 flow，永远还原真 fetch。
 *
 * 时钟替身：真睡觉会让「slow_down +5 且持续生效」这条判据变成秒级用例，故用**假时钟**——
 * `sleep(s)` 只记一笔并把内部 now 推进 s 秒。这同时让 `expires_in` 的兜底变成**确定性**读数
 * （真钟下受调度抖动影响，判据会变成 flaky）。`sleeps` 记录的就是 oracle 里
 * `time.sleep(interval)`(:322) 每次拿到的秒数。
 */
async function runFlow(script, { addons, source, cancelEvent, options } = {}) {
  const step = typeof script === 'function' ? script : (i) => script[i];
  const harness = installFetch(step);
  const qr = [];
  const status = [];
  const clock = { now: 0, sleeps: [] };
  try {
    const flow = makeDeviceFlow({
      defaults: options && options.defaults,
      now: () => clock.now,
      sleep: async (seconds) => { clock.sleeps.push(seconds); clock.now += seconds; },
    }, {
      addons,
      source,
      cancelEvent,
      onQrCode: (info) => { qr.push(info); },
      onStatusChange: (info) => { status.push(info); },
    });
    flow.sleeps = clock.sleeps;
    let out = null;
    let err = null;
    try {
      out = await flow.run();
    } catch (error) {
      err = error;
    }
    return { out, err, qr, status, flow, harness, clock };
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
}

/** `err` 的 oracle 形态串：`{类名}|{code}: {description}` */
function errShape(error) {
  return error === null ? null : `${error.name}|${error.message}`;
}

// --------------------------------------------------------------------------
// ① addons / 确认链接：逐字节
// --------------------------------------------------------------------------

test('_addonsPayload：明文逐字节 = oracle `_normalize_addons` + 紧凑 JSON（ensure_ascii=False）', () => {
  assert.equal(_addonsPayload(), ORACLE_ADDONS_PAYLOAD);
  // 清单取自**唯一真源** REQUIRED_SCOPES/EVENTS/CALLBACKS（feishu.py:1263-1271）
  const parsed = JSON.parse(_addonsPayload());
  assert.equal(parsed.preset, false, 'preset=False（不要官方智能体模板）');
  assert.deepEqual(parsed.scopes.tenant, REQUIRED_SCOPES.map(([n]) => n));
  assert.deepEqual(parsed.events.items.tenant, REQUIRED_EVENTS.map(([e]) => e));
  assert.deepEqual(parsed.callbacks.items, REQUIRED_CALLBACKS.map(([c]) => c));
});

test('_encodeAddons：明文可还原（oracle 串能解开 = 两种码流同一份字节）', () => {
  // ③ 反向可解性：oracle 的 base64url 用本模块的口径解开，必须还原出 ① 的明文
  const oracleBytes = Buffer.from(ORACLE_ADDONS_ENCODED, 'base64url');
  assert.equal(gunzipSync(oracleBytes).toString('utf8'), _addonsPayload());
  // 本模块自己的输出：同一明文、且是合法 base64url（`-`/`_`、无 `=` 补位）
  const mine = _encodeAddons();
  assert.equal(gunzipSync(Buffer.from(mine, 'base64url')).toString('utf8'), ORACLE_ADDONS_PAYLOAD);
  assert.doesNotMatch(mine, /[+/=]/, 'base64url 不许含 + / =（`rstrip("=")`，:111）');
});

test('_encodeAddons：gzip 容器头逐字节（`\\x1f\\x8b\\x08\\x00` + mtime=0 + XFL=2）', () => {
  const gz = Buffer.from(_encodeAddons(), 'base64url');
  // oracle：gzip.compress(mtime=0) ⇒ flags=0、MTIME=0、XFL=2（gzip.py `_write_gzip_header`）
  assert.equal(gz.subarray(0, 6).toString('hex'), '1f8b08000000');
  assert.equal(gz.readUInt32LE(4), 0, 'mtime 必须为 0（否则同一输入每次编码都不同）');
  assert.equal(gz[8], 2, 'XFL=2（compressor 用最高压缩档）；CPython 亦为 2');
});

test('_buildQrUrl：查询串**逐字节** = oracle `_build_qr_url`（键序 + quote_plus）', () => {
  // 期望串来自真 `_SyncFlow` 的 `on_qr_code`（happy 轨迹 `qr[0].url`）。
  // `addons` 之前的整段（含键序 from/tp/source 与 percent-encode 形态）**逐字节**相同；
  // addons 本身是 gzip 码流，见文件头②——单独钉在解压后的明文上。
  const actual = _buildQrUrl(VERIFICATION_URI);
  assert.equal(splitAddons(actual).head, splitAddons(ORACLE_QR_URL).head);
  assert.equal(gunzipSync(Buffer.from(splitAddons(actual).encoded, 'base64url')).toString('utf8'),
    ORACLE_ADDONS_PAYLOAD);
  // 原查询串的键必须**在前**且顺序不变，新键按 oracle 赋值序追加（from/tp/source/addons）
  assert.equal(splitAddons(actual).head,
    `${VERIFICATION_URI}&from=sdk&tp=sdk&source=${SOURCE_SDK_NAME}`);
  assert.equal(actual.indexOf('&addons=') > actual.indexOf('&source='), true);
  // `quote_plus` 的**特有字符**要真的走到 URL 拼装路径上（只在 `_quotePlus` 单测里钉不够：
  // 样例 URI 的字符集恰好绕开了 `! ' ( ) *` 与空格）。期望值取自
  // `python3 -c "from urllib.parse import urlencode,parse_qs,urlparse,urlunparse; ..."`。
  const tricky = 'https://accounts.feishu.cn/q?q=a b&t=!\'()*&u=%E4%B8%AD';
  const built = _buildQrUrl(tricky, { addons: null });
  assert.equal(built, 'https://accounts.feishu.cn/q?q=a+b&t=%21%27%28%29%2A&u=%E4%B8%AD'
    + '&from=sdk&tp=sdk&source=python-sdk');
});

test('_quotePlus：逐字节等价 `urllib.parse.quote_plus`（Python 的 always-safe 是 `~`）', () => {
  // 期望值取自 `/opt/miniconda3/.../python3 -c "from urllib.parse import quote_plus"` 的逐字符表
  const table = [
    ['AZaz09', 'AZaz09'], ['~', '~'], ['!', '%21'], ['*', '%2A'], ["'", '%27'],
    ['(', '%28'], [')', '%29'], ['-._', '-._'], ['/', '%2F'], [':', '%3A'],
    ['?', '%3F'], ['#', '%23'], ['[', '%5B'], [']', '%5D'], ['@', '%40'],
    ['$', '%24'], ['&', '%26'], ['+', '%2B'], [',', '%2C'], [';', '%3B'],
    ['=', '%3D'], ['%', '%25'], [' ', '+'], ['中', '%E4%B8%AD'], ['"', '%22'],
    ['<', '%3C'], ['>', '%3E'], ['\\', '%5C'], ['^', '%5E'], ['`', '%60'],
    ['|', '%7C'], ['{', '%7B'], ['}', '%7D'],
  ];
  for (const [input, expected] of table) {
    assert.equal(_quotePlus(input), expected, `quote_plus(${JSON.stringify(input)})`);
  }
  // 关键分歧点：JS 的 encodeURIComponent 放行 !'()*，Python 不放行 ⇒ 必须显式补
  assert.equal(_quotePlus("!'()*"), '%21%27%28%29%2A');
  // 空白必须是 `+` 而不是 `%20`（doseq urlencode / parse_qs 的往返约定）
  assert.equal(_quotePlus('a b'), 'a+b');
});

test('_buildQrUrl：source 缺省 `python-sdk` 且留可覆盖入口（`_source` 拼接，:182）', () => {
  assert.equal(SOURCE_SDK_NAME, 'python-sdk');
  // oracle 的 `_register_app_impl` 不传 source ⇒ `self._source` 为 None ⇒ 取裸 `_SDK_NAME`
  const bare = _buildQrUrl(VERIFICATION_URI, { addons: null });
  assert.match(bare, /&source=python-sdk(&|$)/);
  // 可覆盖入口：opts.source = 'x' ⇒ `f"{_SDK_NAME}/{self._source}"` = `python-sdk/x`
  // （斜杠走 quote_plus ⇒ `%2F`）
  assert.match(_buildQrUrl(VERIFICATION_URI, { addons: null, source: 'x' }),
    /&source=python-sdk%2Fx(&|$)/);
  // `addons: null` 表达的是 oracle 的 `self._addons is None`（`if self._addons is not None`，:168）
  // ⇒ **整个 addons 键都不出现**（不是空串）；不传（`undefined`）才是缺省带 `_provisionAddons()`。
  assert.equal(bare, splitAddons(ORACLE_QR_URL).head, 'addons=null ⇒ 与 oracle 串的 addons 之前全等');
  assert.doesNotMatch(bare, /addons=/);
  assert.match(_buildQrUrl(VERIFICATION_URI), /&addons=/);
  // source=null ≡ 缺省（`_source` 为 None ⇒ 裸 `_SDK_NAME`）；空串也是假值（Python `if self._source`）
  assert.equal(_buildQrUrl(VERIFICATION_URI, { addons: null, source: null }), bare);
  assert.equal(_buildQrUrl(VERIFICATION_URI, { addons: null, source: '' }), bare);
});

// --------------------------------------------------------------------------
// ② 轮询全分支（期望 = oracle 轨迹）
// --------------------------------------------------------------------------

test('happy：init → begin → poll(pending) → poll(success)；请求体/URL/qr/status 全对拍', async () => {
  const { out, err, qr, status, harness } = await runFlow((i) => [
    INIT_OK, BEGIN_OK, { error: 'authorization_pending' },
    { client_id: 'cli_new', client_secret: 'sec-new' },
  ][i]);
  assert.equal(err, null);
  assert.deepEqual(out, { client_id: 'cli_new', client_secret: 'sec-new' });
  // 三次 POST 报文的字节形态（oracle `_post` 的 urlencode(data)）
  assert.deepEqual(harness.calls.map((c) => c.body), [INIT_BODY, BEGIN_BODY, POLL_BODY, POLL_BODY]);
  assert.deepEqual(harness.urls(), [FEISHU_URL, FEISHU_URL, FEISHU_URL, FEISHU_URL]);
  for (const c of harness.calls) {
    assert.equal(c.method, 'POST');
    assert.equal(c.headers['Content-Type'], 'application/x-www-form-urlencoded');
  }
  // `on_qr_code({"url":..., "expire_in":...})`（:298）
  assert.equal(qr.length, 1);
  assert.equal(qr[0].expire_in, 600);
  assertUrlMatchesOracle(qr[0].url);
  // `authorization_pending` ⇒ `_notify_status("polling")`（:218-220）
  assert.deepEqual(status, [{ status: 'polling' }]);
});

test('success：`user_info` 存在才带上（`if data.get("user_info")`，:204-205）', async () => {
  const a = await runFlow((i) => [INIT_OK, BEGIN_OK,
    { client_id: 'cli_new', client_secret: 'sec-new' }][i]);
  assert.deepEqual(a.out, { client_id: 'cli_new', client_secret: 'sec-new' });
  const b = await runFlow((i) => [INIT_OK, BEGIN_OK,
    { client_id: 'cli_new', client_secret: 'sec-new', user_info: { open_id: 'ou_1' } }][i]);
  assert.deepEqual(b.out,
    { client_id: 'cli_new', client_secret: 'sec-new', user_info: { open_id: 'ou_1' } });
});

test('slow_down：间隔 +5（RFC 8628 §3.5 MUST）**且对后续请求持续生效**', async () => {
  // oracle：`interval += 5`（:319）改的是**循环外**的变量，之后每次 `time.sleep(interval)`(:322)
  // 都用新值 ⇒ 首个慢速请求把间隔从 5 提到 10，**当轮就按 10 睡**；再次慢速 → 15；
  // 之后即使转回 pending 也仍按 15 睡（这就是「持续生效」）。
  const { out, err, status, harness, flow } = await runFlow((i) => [
    INIT_OK, BEGIN_OK, { error: 'slow_down' }, { error: 'slow_down' },
    { error: 'authorization_pending' },
    { client_id: 'cli_new', client_secret: 'sec-new' },
  ][i]);
  assert.equal(err, null);
  assert.deepEqual(out, { client_id: 'cli_new', client_secret: 'sec-new' });
  assert.deepEqual(flow.sleeps, [10, 15, 15],
    'slow_down 后的间隔必须累加且对后续每轮生效；不是回到 5，也不是只加一次');
  assert.deepEqual(harness.calls.map((c) => c.body),
    [INIT_BODY, BEGIN_BODY, POLL_BODY, POLL_BODY, POLL_BODY, POLL_BODY]);
  // 每次 slow_down 后立刻 notify 新间隔（`_notify_status("slow_down", interval)`，:320）
  assert.deepEqual(status, [{ status: 'slow_down', interval: 10 },
    { status: 'slow_down', interval: 15 }, { status: 'polling' }]);
});

test('slow_down：`interval` 增量的**绝对值**是 +5（不是翻倍/回到缺省）', async () => {
  // 起点显式给 1 ⇒ 两次慢速后必须是 6 / 11（+5 的语义，且累加在**响应给的**起点上）。
  // 成功那轮**不吃 sleep**：oracle 在 `if action == "success": return result`(:311-312)
  // 处直接返回，`time.sleep`(:322) 在它下面 ⇒ 不在返回路径上。
  const { flow } = await runFlow((i) => [INIT_OK,
    { device_code: 'DC-1', interval: 1, expires_in: 600,
      verification_uri_complete: VERIFICATION_URI },
    { error: 'slow_down' }, { error: 'slow_down' },
    { client_id: 'c', client_secret: 's' }][i]);
  assert.deepEqual(flow.sleeps, [6, 11]);
});

test('域切换：`tenant_brand == "lark"` ⇒ 基址换 larksuite.com，**只切一次**且不 sleep', async () => {
  const { out, err, status, harness, flow } = await runFlow((i) => [
    INIT_OK, BEGIN_OK,
    { user_info: { tenant_brand: 'lark' } },                    // 第一次：切域
    { user_info: { tenant_brand: 'lark' }, error: 'authorization_pending' }, // 已切过
    { client_id: 'cli_new', client_secret: 'sec-new' },
  ][i]);
  assert.equal(err, null);
  assert.deepEqual(out, { client_id: 'cli_new', client_secret: 'sec-new' });
  // 切域后**后续请求打到 lark 域**（`self._base_url = self._lark_url`，:211）
  assert.deepEqual(harness.urls(),
    [FEISHU_URL, FEISHU_URL, FEISHU_URL, LARK_URL, LARK_URL]);
  // `_notify_status("domain_switched")` 只发一次（`domain_switched = True` 后不再进该分支，
  // 第二轮即使 `tenant_brand` 仍是 lark 也只落回 pending）
  assert.deepEqual(status, [{ status: 'domain_switched' }, { status: 'polling' }]);
  // 切域当轮 `continue` ⇒ **不吃 sleep**（:314-316）；只有第二轮落 pending 才睡一次
  assert.deepEqual(flow.sleeps, [5]);
});

test('域切换后 `polling`/慢速仍走 lark 域，且 `admin` 域不再被访问', async () => {
  const { harness } = await runFlow((i) => [INIT_OK, BEGIN_OK,
    { user_info: { tenant_brand: 'lark' } }, { error: 'slow_down' },
    { error: 'authorization_pending' },
    { client_id: 'c', client_secret: 's' }][i]);
  const urls = harness.urls();
  assert.equal(urls[2], FEISHU_URL);
  assert.deepEqual(urls.slice(3), [LARK_URL, LARK_URL, LARK_URL]);
});

test('`tenant_brand` 非 lark 不切域（严格 `== "lark"`，:210）', async () => {
  const { harness } = await runFlow((i) => [INIT_OK, BEGIN_OK,
    { user_info: { tenant_brand: 'feishu' }, error: 'authorization_pending' },
    { client_id: 'c', client_secret: 's' }][i]);
  assert.deepEqual(harness.urls(), [FEISHU_URL, FEISHU_URL, FEISHU_URL, FEISHU_URL]);
  // `"lark "`（带尾空格）/ 大写 / 非串：Python `==` 不做类型强转 ⇒ 都不切
  for (const brand of ['lark ', 'Lark', 'LARK', true, 1]) {
    const r = await runFlow((i) => [INIT_OK, BEGIN_OK,
      { user_info: { tenant_brand: brand }, error: 'authorization_pending' },
      { client_id: 'c', client_secret: 's' }][i]);
    assert.deepEqual(r.harness.urls(),
      [FEISHU_URL, FEISHU_URL, FEISHU_URL, FEISHU_URL], JSON.stringify(brand));
  }
});

test('四类错误映射：access_denied / expired_token / 其它（error + error_description）', async () => {
  const cases = [
    ['access_denied', 'user said no', 'AppAccessDeniedError',
      'access_denied: user said no'],
    ['expired_token', 'code expired', 'AppExpiredError', 'expired_token: code expired'],
    ['weird', 'desc', 'RegisterAppError', 'weird: desc'],
  ];
  for (const [code, desc, name, message] of cases) {
    const { out, err } = await runFlow((i) => [INIT_OK, BEGIN_OK,
      { error: code, error_description: desc }][i]);
    assert.equal(out, null);
    assert.equal(errShape(err), `${name}|${message}`, `error=${code}`);
    // oracle `RegisterAppError.__init__`：`code` / `description` 两个属性都在
    assert.equal(err.code, code);
    assert.equal(err.description, desc);
    // 且**不是** RegisterAppError 以外的东西（`instanceof` 链要对得上）
    assert.ok(err instanceof Error);
  }
  // 子类关系照抄 errors.py：AppAccessDenied/AppExpired 都是 RegisterAppError
  const denied = await runFlow((i) => [INIT_OK, BEGIN_OK,
    { error: 'access_denied', error_description: 'x' }][i]);
  assert.equal(denied.err.name, 'AppAccessDeniedError');
});

test('错误文案缺 `error_description` ⇒ 空串（`data.get(..., "")`，:216）', async () => {
  const { err } = await runFlow((i) => [INIT_OK, BEGIN_OK, { error: 'weird' }][i]);
  assert.equal(errShape(err), 'RegisterAppError|weird: ');
  assert.equal(err.description, '');
});

test('init：`supported_auth_methods` 不含 client_secret ⇒ unsupported_auth_method，且**不再发 begin**', async () => {
  const { out, err, qr, harness } = await runFlow((i) => [
    { supported_auth_methods: ['something_else'] }][i]);
  assert.equal(out, null);
  assert.equal(errShape(err),
    'RegisterAppError|unsupported_auth_method: client_secret not in supported_auth_methods');
  assert.equal(err.code, 'unsupported_auth_method');
  assert.deepEqual(harness.calls.map((c) => c.body), [INIT_BODY], '第二条 POST 不许发出');
  assert.deepEqual(qr, []);
});

test('init：缺 `supported_auth_methods` / 非数组 ⇒ 都按「不支持」拒绝（`or []`，:278）', async () => {
  for (const body of [{}, { supported_auth_methods: null },
    { supported_auth_methods: [] }, { supported_auth_methods: 'client_secret' }]) {
    const { err, harness } = await runFlow((i) => [body][i]);
    assert.equal(err.code, 'unsupported_auth_method', JSON.stringify(body));
    assert.equal(harness.calls.length, 1);
  }
  // 辅助函数本身也对拍
  assert.deepEqual(supportedAuthMethods({ supported_auth_methods: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(supportedAuthMethods({}), []);
  assert.deepEqual(supportedAuthMethods(null), []);
  assert.equal(LARK_MIN_VERSION, '1.5.5');
});

test('begin：`interval` 缺省 5、`expires_in` 缺省 600（`.get(k, 默认)`，:294-295）', async () => {
  const { qr, flow, harness } = await runFlow((i) => [INIT_OK,
    { device_code: 'DC-1', verification_uri_complete: VERIFICATION_URI },
    { error: 'authorization_pending' },
    { client_id: 'c', client_secret: 's' }][i]);
  // 缺省 interval=5 落到第一次 sleep；缺省 expires_in=600 进 qr.expire_in
  assert.deepEqual(flow.sleeps, [5], '成功那轮不吃 sleep（:311-312 直接 return）');
  assert.equal(harness.calls.length, 4);
  assert.equal(qr[0].expire_in, 600);
  assert.equal(DEFAULT_INTERVAL_S, 5);
  // 显式值优先：interval=11 ⇒ 睡眠用 11；expires_in=42 ⇒ 透传给 qr
  const b = await runFlow((i) => [INIT_OK,
    { device_code: 'DC-1', interval: 11, expires_in: 42,
      verification_uri_complete: VERIFICATION_URI },
    { error: 'authorization_pending' },
    { client_id: 'c', client_secret: 's' }][i]);
  assert.equal(b.qr[0].expire_in, 42);
  assert.deepEqual(b.flow.sleeps, [11], '成功那轮不吃 sleep（:311-312 直接 return）');
  // `interval` 缺省 5 落到 sleep；上面第一次 run 的 [5] 就是它
  assert.deepEqual(qr.length, 1);
});

test('超时：`expires_in` 兜底 ⇒ AppExpiredError("expired_token", "polling timed out")', async () => {
  // oracle：`deadline = time.monotonic() + expire_in`，循环条件不满足 ⇒ 抛 AppExpiredError（:301,324）。
  // 用假时钟 ⇒ 这条判据是**确定性**读数（真钟下受调度抖动影响，会变成 flaky）。
  // `defaults` 只覆盖 `begin` 响应的字段（等价于「服务端给了这个 expires_in」）。
  const pending = (i) => (i === 0 ? INIT_OK
    : i === 1 ? { device_code: 'DC-1', verification_uri_complete: VERIFICATION_URI }
      : { error: 'authorization_pending' });
  const { out, err, flow, harness } = await runFlow(pending,
    { options: { defaults: { expires_in: 12 } } });
  assert.equal(out, null);
  assert.equal(errShape(err), 'AppExpiredError|expired_token: polling timed out');
  assert.equal(err.code, 'expired_token');
  assert.equal(err.description, 'polling timed out');
  // 12s 预算 / 每次 5s ⇒ 恰好 3 轮（t=0,5,10 各 poll 一次；15 > 12 出循环）——**expires_in 在兜底**
  assert.deepEqual(flow.sleeps, [5, 5, 5]);
  assert.equal(harness.calls.length, 2 + 3);
  // 换 5s 预算 ⇒ 轮数随之变（证明上面那个 3 不是巧合）
  const small = await runFlow(pending, { options: { defaults: { expires_in: 5 } } });
  assert.deepEqual(small.flow.sleeps, [5]);
  assert.equal(small.harness.calls.length, 2 + 1);
  // expires_in 极短（0.05s）⇒ poll 一轮后即出循环（不再补发第二轮）
  const tiny = await runFlow(pending, { options: { defaults: { expires_in: 0.05 } } });
  assert.equal(errShape(tiny.err), 'AppExpiredError|expired_token: polling timed out');
  assert.deepEqual(tiny.flow.sleeps, [5]);
  assert.equal(tiny.harness.calls.length, 2 + 1, 'init + begin + 一轮 poll');
  // `begin` 没给 expires_in ⇒ 走缺省 600（`begin_res.get("expires_in", 600)`，:295），
  // 且它会进 `on_qr_code.expire_in`（这一条不需要真等到 600s：用 defaults 压到 5s 再验同一件事）
  const dflt = await runFlow(pending, { options: { defaults: { expires_in: 5 } } });
  assert.equal(dflt.qr[0].expire_in, 5);
  assert.equal(DEFAULT_EXPIRES_IN_S, 600);
  // 真缺省宽度：begin 完全不给 expires_in ⇒ qr.expire_in = 600，且此时**不会**超时退出
  // （600s 预算 / 5s 间隔 ⇒ 需要 120 轮才到 deadline；脚本只给 3 轮就成功）
  const wide = await runFlow((i) => [INIT_OK,
    { device_code: 'DC-1', verification_uri_complete: VERIFICATION_URI },
    { client_id: 'c', client_secret: 's' }][i]);
  assert.equal(wide.qr[0].expire_in, 600);
  assert.equal(errShape(wide.err), null);
});

// --------------------------------------------------------------------------
// ③ 取消（RFC 8628 §3.5「SHOULD」+ oracle `_check_cancelled`）
// --------------------------------------------------------------------------

test('取消：**每次 POST 之前**都查——已取消的流程连 init 都不发', async () => {
  const cancel = createCancelEvent();
  cancel.set();
  const { err, harness } = await runFlow((i) => [INIT_OK][i], { cancelEvent: cancel });
  assert.equal(errShape(err), 'RegisterAppError|abort: cancelled by caller');
  assert.equal(err.code, 'abort');
  assert.equal(harness.calls.length, 0, '取消后一个请求都不许发');
});

test('取消：外部在 begin 之后置位 ⇒ 下一次 poll **不再发出**（逐轮前置检查）', async () => {
  const cancel = createCancelEvent();
  const harness = installFetch((i) => [INIT_OK, BEGIN_OK,
    { error: 'authorization_pending' }][i]);
  const qr = [];
  // `expires_in` 压到 5s：若取消失效，流程最多再跑一轮就超时退出，
  // 不会真的等到 600s 缺省预算（假时钟让这条判据快且确定）。
  const clock = { now: 0, sleeps: [] };
  try {
    const flow = makeDeviceFlow({
      now: () => clock.now,
      sleep: async (s) => { clock.sleeps.push(s); clock.now += s; },
      defaults: { expires_in: 5 },
    }, {
      cancelEvent: cancel,
      onQrCode: (info) => { qr.push(info); cancel.set(); },   // 拿到链接即「用户取消」
    });
    await assert.rejects(() => flow.run(),
      (e) => errShape(e) === 'RegisterAppError|abort: cancelled by caller');
    // init + begin 已发；poll 一次都没发
    assert.deepEqual(harness.calls.map((c) => c.body), [INIT_BODY, BEGIN_BODY]);
    assert.equal(qr.length, 1);
    assert.deepEqual(clock.sleeps, []);
  } finally { globalThis.fetch = REAL_FETCH; }
});

test('取消事件：`set`/`isSet`/`is_set`/`cancelled` 四种读法一致（对齐 threading.Event 调用面）', () => {
  const ev = createCancelEvent();
  assert.equal(ev.isSet(), false);
  assert.equal(ev.is_set(), false);
  assert.equal(ev.cancelled, false);
  ev.set();
  assert.equal(ev.isSet(), true);
  assert.equal(ev.is_set(), true);
  assert.equal(ev.cancelled, true);
});

// --------------------------------------------------------------------------
// ④ POST 报文形态 + 会话级 defaults
// --------------------------------------------------------------------------

test('POST 报文：Content-Type 表单头 + 纯 ASCII 表单体（逐字节 = urlencode(data)）', async () => {
  const { harness } = await runFlow((i) => [INIT_OK, BEGIN_OK,
    { client_id: 'c', client_secret: 's' }][i]);
  for (const c of harness.calls) {
    assert.equal(c.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.match(c.body, /^[\x20-\x7e]*$/, '表单体必须 ASCII（中文也走 percent-encode）');
  }
});

test('域基址常量照抄 oracle 缺省（`domain` / `lark_domain`，:392-393）', () => {
  assert.equal(FEISHU_DOMAIN, 'https://accounts.feishu.cn');
  assert.equal(LARK_DOMAIN, 'https://accounts.larksuite.com');
  assert.equal(DEVICE_ENDPOINT, ENDPOINT_PATH);
});

test('registerApp：一步到位的入口（等价 `lark_oapi.register_app`），成功回凭据', async () => {
  const h = installFetch((i) => [INIT_OK, BEGIN_OK,
    { client_id: 'cli_new', client_secret: 'sec-new' }][i]);
  try {
    const out = await registerApp({ onQrCode: () => {} });
    assert.deepEqual(out, { client_id: 'cli_new', client_secret: 'sec-new' });
    assert.equal(h.calls.length, 3);
  } finally { globalThis.fetch = REAL_FETCH; }
});

test('registerApp：默认自动带 `_provision_addons` 清单（不传 addons 时）', async () => {
  const h = installFetch((i) => [INIT_OK, BEGIN_OK,
    { client_id: 'c', client_secret: 's' }][i]);
  try {
    await registerApp({ onQrCode: () => {} });
    assert.equal(h.calls.length, 3);
  } finally { globalThis.fetch = REAL_FETCH; }
  // 传了 addons 就用传的（`if self._addons is not None`，:168）
  const qr = [];
  const h2 = installFetch((i) => [INIT_OK, BEGIN_OK,
    { client_id: 'c', client_secret: 's' }][i]);
  try {
    await registerApp({ addons: null, onQrCode: (info) => qr.push(info) });
    assert.equal(qr[0].url, _buildQrUrl(VERIFICATION_URI, { addons: null }));
  } finally { globalThis.fetch = REAL_FETCH; }
});

test('_registerAppImpl：oracle 那个被 `_provision_worker` 调起的封装（source 缺省 / addons 缺省）', async () => {
  // oracle `_register_app_impl(on_qr_code, on_status_change, cancel_event, addons)`(feishu.py:2957-2964)
  // 调 `lark_oapi.register_app(on_qr_code=..., on_status_change=..., cancel_event=..., addons=...)`
  // ——**不传 source** ⇒ `self._source is None` ⇒ `source=python-sdk`（无斜杠后缀）。
  const h = installFetch((i) => [INIT_OK, BEGIN_OK,
    { error: 'authorization_pending' },
    { client_id: 'cli_new', client_secret: 'sec-new' }][i]);
  const qr = [];
  const status = [];
  try {
    // 假时钟：`now` 必须随 `sleep` **一起前进**，否则 `while (now < deadline)` 永真、
    // 流程会一直轮询到真的 600s 预算（用例变分钟级）。同理，pending 那轮也不真睡。
    const clock = { now: 0 };
    const out = await _registerAppImpl(
      (info) => { qr.push(info); }, (info) => { status.push(info); },
      createCancelEvent(), _provisionAddons(),
      { now: () => clock.now, sleep: async (s) => { clock.now += s; } });
    assert.deepEqual(out, { client_id: 'cli_new', client_secret: 'sec-new' });
    assert.equal(h.calls.length, 4);
    assert.equal(splitAddons(qr[0].url).head,
      `${VERIFICATION_URI}&from=sdk&tp=sdk&source=python-sdk`);
    assert.equal(gunzipSync(Buffer.from(splitAddons(qr[0].url).encoded, 'base64url')).toString('utf8'),
      ORACLE_ADDONS_PAYLOAD);
    assert.equal(qr[0].expire_in, 600);
    assert.deepEqual(status, [{ status: 'polling' }]);
  } finally { globalThis.fetch = REAL_FETCH; }
});

test('_registerAppImpl：`_setSourceForTest` 是可覆盖入口（缺省恒 null＝生产路径）', async () => {
  const run = async (source) => {
    const h = installFetch((i) => [INIT_OK, BEGIN_OK,
      { client_id: 'c', client_secret: 's' }][i]);
    const qr = [];
    try {
      _setSourceForTest(source);
      await _registerAppImpl((info) => { qr.push(info); }, null, createCancelEvent(), null);
      assert.equal(h.calls.length, 3);
      return qr[0].url;
    } finally { globalThis.fetch = REAL_FETCH; }
  };
  try {
    assert.match(await run(undefined), /&source=python-sdk(&|$)/, '缺省（undefined）⇒ 裸 python-sdk');
    assert.match(await run('x'), /&source=python-sdk%2Fx(&|$)/, '覆盖 ⇒ python-sdk/x');
  } finally { _setSourceForTest(null); }
  // 还原后回到缺省
  assert.match(await run(null), /&source=python-sdk(&|$)/);
  _setSourceForTest(null);
});

test('成功判据是**两个都要**：只回 client_id 不算成功（继续轮询）', async () => {
  // oracle `_handle_poll_response`(:199)：`if data.get("client_id") and data.get("client_secret")`
  // —— 任一缺失就**不**进成功分支，落到后面的错误码判定（本例 error 为空 ⇒ 抛 RegisterAppError）。
  const onlyId = await runFlow((i) => [INIT_OK, BEGIN_OK, { client_id: 'cli_only' }][i]);
  assert.equal(onlyId.out, null, '只有 client_id 不许当成功返回');
  assert.equal(errShape(onlyId.err), 'RegisterAppError|: ',
    '落回错误码判定：error/error_description 都缺 ⇒ 空串（不是 success）');
  const onlySecret = await runFlow((i) => [INIT_OK, BEGIN_OK, { client_secret: 'sec_only' }][i]);
  assert.equal(onlySecret.out, null, '只有 client_secret 不许当成功返回');
  assert.equal(errShape(onlySecret.err), 'RegisterAppError|: ');
  // 服务端先回半个、下一轮回全 ⇒ 必须在下一轮成功（证明「半个」那轮只是没成功，不是终止）
  const half = await runFlow((i) => [INIT_OK, BEGIN_OK,
    { client_id: 'cli_only', error: 'authorization_pending' },
    { client_id: 'cli_new', client_secret: 'sec-new' }][i]);
  assert.deepEqual(half.out, { client_id: 'cli_new', client_secret: 'sec-new' });
  // 同时带 client_id 与 error 的响应 ⇒ **算成功**（成功判定在错误码之前，:199 vs :215）
  const both = await runFlow((i) => [INIT_OK, BEGIN_OK,
    { client_id: 'cli_new', client_secret: 'sec-new', error: 'access_denied' }][i]);
  assert.deepEqual(both.out, { client_id: 'cli_new', client_secret: 'sec-new' },
    '判定顺序：成功先于错误码');
});

test('init/begin 的响应若不是对象 ⇒ 不静默成功（响亮失败）', async () => {
  const a = await runFlow((i) => [null][i]);
  assert.equal(a.out, null);
  assert.match(String(a.err && a.err.message), /unsupported_auth_method/);
  const b = await runFlow((i) => [INIT_OK, null][i]);
  assert.equal(b.out, null);
  assert.notEqual(b.err, null);
});
