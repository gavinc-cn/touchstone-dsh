/**
 * 飞书**单聊截图**单测（2026-10-22 批次）：`backend/lib/feishu_rest.js` 的 `restBytes` +
 * `backend/lib/feishu_inbound.js` 的截图接收族 + `backend/lib/feishu_conv.js` 的存图扩展。
 *
 * 契约真源（唯一判据）：
 *   `doc_ai/plan/202610/20261022_0837_飞书单聊截图支持（图片与图文消息转投绑定会话）.md`
 *   §三（常量/行为顺序/文案）、§四（Node 实现清单）、§五（用例矩阵 1-16）。
 * 本文件按 §五 的矩阵逐条落 Node 半边（表里 #1~#16 与下方 `矩阵 #n` 注释一一对应）；
 * 期望字符串**逐字抄契约 §3.1/§3.6**，不从 Node 实现反推。
 *
 * 零真实网络：模块加载即把 `globalThis.fetch` 换成**抛错哨兵**（任何漏网出站都会打红
 * 对应的用例），只有 `restBytes` 的用例在 `withFetch()` 里装脚本化替身并计数；
 * 末尾用例断言「真实 fetch 调用数 = 0」。其余所有下载/投递都走注入的 `options.rest` /
 * `options.conv` / `options.chat` 替身——与 Python `tests/test_feishu_media.py` 的
 * monkeypatch 口径同义。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import * as conv from '../lib/feishu_conv.js';
import * as db from '../lib/db.js';
import * as inbound from '../lib/feishu_inbound.js';
import { FeishuRestError, _TOKEN_CACHE, restBytes } from '../lib/feishu_rest.js';
import { freshDb, insertProject } from './m3fixture.mjs';

// ==========================================================================
// 零真实网络哨兵 + 脚本化 fetch 台
// ==========================================================================

const REAL_FETCH = globalThis.fetch;
/** `real` = 哨兵被调用次数（必须为 0）；`scripted` = restBytes 用例的替身调用次数 */
const net = { real: 0, scripted: 0 };
globalThis.fetch = () => {
  net.real += 1;
  throw new Error('单测禁止真实网络（globalThis.fetch 被未打桩的代码调用）');
};
after(() => { globalThis.fetch = REAL_FETCH; });

const CFG = { app_id: 'cli_app', app_secret: 'sec' };
const TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';

/** 真响应替身（undici `Response`，`.json()`/`.arrayBuffer()` 语义与真机一致） */
function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

function bytesResp(data, contentType) {
  const headers = {};
  if (contentType !== undefined) headers['content-type'] = contentType;
  return new Response(data, { status: 200, headers });
}

/** 装脚本化 fetch：handler(url, init) 返回 Response；计数进 `net.scripted` */
async function withFetch(handler, fn) {
  const prev = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    net.scripted += 1;
    calls.push([String(url), init]);
    return handler(String(url), init);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = prev;
  }
}

/** token 端点固定成功（restBytes 会先换 token）；其余交给 `resource` */
function tokenThen(resource) {
  return (url, init) => {
    if (url === TOKEN_URL) {
      return jsonResp({ code: 0, tenant_access_token: 't-1', expire: 7200 });
    }
    return resource(url, init);
  };
}

// ==========================================================================
// 图片字节夹具（魔数真实：PNG / JPEG / WEBP / 未知）
// ==========================================================================

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489',
  'hex');
const JPEG = Buffer.from('ffd8ffe000104a4649460001010000010001000000ffd9', 'hex');
const GIF = Buffer.from('474946383961010001000000c00000ffffff21f90401000000002c00000000010001000002014400',
  'hex');
const WEBP = Buffer.concat([
  Buffer.from('52494646', 'hex'), Buffer.from('24000000', 'hex'),
  Buffer.from('57454250', 'hex'), Buffer.from('56503820', 'hex'), Buffer.alloc(20, 0),
]);
const UNKNOWN = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

// ==========================================================================
// ① 常量（§3.1，逐字）
// ==========================================================================

test('常量：§3.1 全部 MEDIA_* 逐字（env 名/上限/张数/六条固定文案/header 格式）', () => {
  assert.equal(inbound.MEDIA_ENV, 'TS_FEISHU_MEDIA');
  assert.equal(inbound.MEDIA_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(inbound.MEDIA_MAX_COUNT, 9);
  assert.equal(inbound.MEDIA_TYPE_HINT, '暂不支持该消息类型，请发送文字指令');
  assert.equal(inbound.MEDIA_SCOPE_HINT,
    '截图功能需要飞书应用额外开通「获取单聊、群组消息（im:message:readonly）」'
    + '权限：在「接入」卡片点「补齐配置」→「发布」，或到开发者后台「权限管理」'
    + '添加该权限并发布新版本后重试。');
  assert.equal(inbound.MEDIA_FAIL_PREFIX, '截图接收失败：');
  assert.equal(inbound.MEDIA_TOO_LARGE, '图片过大（单张上限 10MB），请压缩后重发');
  assert.equal(inbound.MEDIA_NO_IMAGE, '消息里没有可下载的图片');
  assert.equal(inbound.MEDIA_SAVE_FAIL_PREFIX, '截图保存失败：');
  assert.equal(inbound.MEDIA_HEADER_FMT, '[飞书截图] 用户从飞书发送了 %d 张截图');
  assert.equal(inbound.MEDIA_HEADER_NOTE, '（未附文字说明）');
  // 未绑定引导：与文字路径同一串（§3.2 步骤 4；「在这里回复」不是「在单聊回复」）
  assert.equal(inbound.UNBOUND_DM_MSG,
    '尚未绑定 Touchstone 账号：登录站点 → 侧栏「设置」→ 飞书设置，'
    + '生成绑定码后在这里回复「绑定 <码>」完成绑定');
  // mime → 落盘扩展名（§3.4）
  assert.deepEqual({ ...inbound.MEDIA_MIME_EXT }, {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
    'image/gif': 'gif', 'image/webp': 'webp',
  });
});

// ==========================================================================
// ② mediaEnabled（§3.8：TS_FEISHU_MEDIA=0 回滚；与 TS_FEISHU_CONV 同款精确语义）
// ==========================================================================

test('mediaEnabled：只有 strip 后恰好 "0" 才关（缺省开；"0 "/" 0" 关，"00"/"false" 开）', () => {
  const cases = [
    ['0', false], ['0 ', false], [' 0', false], ['\t0\n', false],
    ['00', true], ['0.0', true], ['false', true], ['FALSE', true], ['no', true],
    ['', true], ['1', true], [' off ', true],
  ];
  for (const [value, want] of cases) {
    assert.equal(inbound.mediaEnabled({ env: { TS_FEISHU_MEDIA: value } }), want,
      `TS_FEISHU_MEDIA=${JSON.stringify(value)}`);
  }
  assert.equal(inbound.mediaEnabled({ env: {} }), true, '未设置 ⇒ 开（默认开）');
  assert.equal(inbound.mediaEnabled({}), true, '不传 options ⇒ 走真 process.env（未设置 ⇒ 开）');
});

// ==========================================================================
// ③ restBytes（§3.4 底层；feishu_rest.js）
// ==========================================================================

test('restBytes：GET 资源 → Buffer + contentType；只带 Authorization、timeout 30s、不重试', async () => {
  _TOKEN_CACHE.clear();
  await withFetch(tokenThen((url) => {
    assert.equal(url, 'https://open.feishu.cn/open-apis/im/v1/messages/om_1/resources/img_v3_1'
      + '?type=image');
    return bytesResp(PNG, 'image/png');
  }), async (calls) => {
    const out = await restBytes('GET',
      '/open-apis/im/v1/messages/om_1/resources/img_v3_1',
      { params: { type: 'image' }, cfg: CFG });
    assert.deepEqual(out.data, PNG);
    assert.equal(Buffer.isBuffer(out.data), true);
    assert.equal(out.contentType, 'image/png');
    // token 一次 + 资源一次（**不重试**：成功路径没有第三次）
    assert.equal(calls.length, 2, `fetch 次数=${calls.length}`);
    const [url, init] = calls[1];
    assert.equal(init.method, 'GET');
    // 契约 §3.4：资源下载**不要**带 Content-Type 请求头
    assert.deepEqual(init.headers, { Authorization: 'Bearer t-1' });
    assert.ok(init.signal instanceof AbortSignal, '缺省 timeout=30s ⇒ 必须有超时信号');
  });
  _TOKEN_CACHE.clear();
});

test('restBytes：路径规范化与 rest() 同口径（缺 /open-apis 前缀自动补一层、多斜杠归一）', async () => {
  _TOKEN_CACHE.clear();
  await withFetch(tokenThen((url) => {
    assert.equal(url, 'https://open.feishu.cn/open-apis/im/v1/messages/om_1/resources/k1?type=image');
    return bytesResp(PNG, 'image/png');
  }), async () => {
    for (const p of [
      'im/v1/messages/om_1/resources/k1',
      '/im/v1/messages/om_1/resources/k1',
      '//open-apis/im/v1/messages/om_1/resources/k1',
    ]) {
      const out = await restBytes('GET', p, { params: { type: 'image' }, cfg: CFG });
      assert.deepEqual(out.data, PNG, `path=${p}`);
    }
  });
  _TOKEN_CACHE.clear();
});

test('restBytes：2xx 无 content-type ⇒ contentType 空串（Python `or ""`）', async () => {
  _TOKEN_CACHE.clear();
  await withFetch(tokenThen(() => bytesResp(Buffer.alloc(0))), async () => {
    const out = await restBytes('GET', '/open-apis/x', { cfg: CFG });
    assert.equal(out.contentType, '');
    assert.equal(out.data.length, 0);
  });
  _TOKEN_CACHE.clear();
});

test('restBytes：非 2xx + JSON 错误体 ⇒ FeishuRestError 带业务码（缺权限三码由上层判定）', async () => {
  _TOKEN_CACHE.clear();
  await withFetch(tokenThen(() => jsonResp({ code: 99991672, msg: 'no scope' }, 403)), async () => {
    await assert.rejects(
      () => restBytes('GET', '/open-apis/im/v1/messages/om_1/resources/k1',
        { params: { type: 'image' }, cfg: CFG }),
      (e) => {
        assert.ok(e instanceof FeishuRestError);
        assert.equal(e.code, 99991672);
        assert.equal(e.message,
          'REST /open-apis/im/v1/messages/om_1/resources/k1 code=99991672 no scope');
        return true;
      },
    );
  });
  _TOKEN_CACHE.clear();
});

test('restBytes：非 2xx + 非 JSON ⇒ 只报 status（不重试、不谎称业务错）', async () => {
  _TOKEN_CACHE.clear();
  await withFetch(tokenThen(() => new Response('gateway blew up', {
    status: 502, headers: { 'content-type': 'text/plain' },
  })), async (calls) => {
    await assert.rejects(
      () => restBytes('GET', '/open-apis/im/v1/messages/om_1/resources/k1', { cfg: CFG }),
      (e) => {
        assert.ok(e instanceof FeishuRestError);
        assert.equal(e.code, null);
        assert.equal(e.message, 'REST /open-apis/im/v1/messages/om_1/resources/k1 status=502');
        return true;
      },
    );
    assert.equal(calls.length, 2, '非 2xx 不重试（token + 资源各一次）');
  });
  _TOKEN_CACHE.clear();
});

test('restBytes：网络异常 ⇒「REST GET <path> 失败: {e}」（code=null）；cfg 缺失先抛', async () => {
  _TOKEN_CACHE.clear();
  await withFetch(tokenThen(() => { throw new TypeError('fetch failed'); }), async () => {
    await assert.rejects(
      () => restBytes('GET', '/open-apis/im/v1/messages/om_1/resources/k1', { cfg: CFG }),
      (e) => {
        assert.ok(e instanceof FeishuRestError);
        assert.equal(e.code, null);
        assert.equal(e.message,
          'REST GET /open-apis/im/v1/messages/om_1/resources/k1 失败: fetch failed');
        return true;
      },
    );
  });
  // cfg 缺失：**不发任何请求**直接抛（同 `rest()`）
  const before = net.scripted;
  await assert.rejects(() => restBytes('GET', '/open-apis/x', {}), (e) => {
    assert.ok(e instanceof FeishuRestError);
    assert.equal(e.message, '应用未配置（app_id/app_secret 缺失）');
    return true;
  });
  assert.equal(net.scripted, before, 'cfg 缺失零出站');
  _TOKEN_CACHE.clear();
});

// ==========================================================================
// ④ mediaItems（§3.3 解析）
// ==========================================================================

test('mediaItems：image ⇒ text 恒空 + 单个 image_key（非空字符串才算）', () => {
  assert.deepEqual(inbound.mediaItems({
    message_type: 'image', content: '{"image_key": "img_v3_1"}',
  }), ['', ['img_v3_1']]);
  for (const content of ['{}', '{"image_key": ""}', '{"image_key": 7}', 'not-json', '']) {
    assert.deepEqual(inbound.mediaItems({ message_type: 'image', content }), ['', []],
      `content=${content}`);
  }
  // 已是 dict 的 content 也接受（Python `isinstance(raw, dict)` 分支同义）
  assert.deepEqual(inbound.mediaItems({
    message_type: 'image', content: { image_key: 'img_v3_2' },
  }), ['', ['img_v3_2']]);
});

test('mediaItems：post 扁平形态（title 首行 + text/a 取显示文字、img 按序收 key、其它 tag 忽略）', () => {
  const evt = {
    message_type: 'post',
    content: JSON.stringify({
      title: '  报错截图  ',
      content: [
        [{ tag: 'text', text: '看这个 ' }, { tag: 'a', href: 'https://x/y', text: '链接' }],
        [{ tag: 'img', image_key: 'img_1' }, { tag: 'text', text: '' }],
        [{ tag: 'at', user_id: 'ou_x' }, { tag: 'emotion', emoji_type: 'SMILE' }],
        [{ tag: 'img', image_key: 'img_2' }],
      ],
    }),
  };
  assert.deepEqual(inbound.mediaItems(evt),
    ['报错截图\n看这个 链接', ['img_1', 'img_2']]);
});

test('mediaItems：post 纯图片 / 空段落不产生空行；12 张全收（截断在上层）', () => {
  const many = Array.from({ length: 12 }, (_, i) => [{ tag: 'img', image_key: `img_${i}` }]);
  const evt = {
    message_type: 'post',
    content: JSON.stringify({ title: '', content: [[{ tag: 'text', text: '   ' }], ...many] }),
  };
  const [text, keys] = inbound.mediaItems(evt);
  assert.equal(text, '', '空段落/纯图片段落不产生空行');
  assert.equal(keys.length, 12);
  assert.deepEqual(keys, Array.from({ length: 12 }, (_, i) => `img_${i}`));
});

test('mediaItems：post 的 locale 包裹（zh_cn → en_us → ja_jp 取第一个 dict）', () => {
  const wrapped = {
    message_type: 'post',
    content: JSON.stringify({
      en_us: { title: 'en', content: [[{ tag: 'text', text: 'hello' }]] },
      zh_cn: { title: '中文', content: [[{ tag: 'text', text: '你好' }]] },
      ja_jp: { title: 'ja', content: [[{ tag: 'text', text: 'こんにちは' }]] },
    }),
  };
  assert.deepEqual(inbound.mediaItems(wrapped), ['中文\n你好', []]);
  const enOnly = {
    message_type: 'post',
    content: JSON.stringify({ en_us: { title: 'en', content: [[{ tag: 'img', image_key: 'k' }]] } }),
  };
  assert.deepEqual(inbound.mediaItems(enOnly), ['en', ['k']]);
});

test('mediaItems：其它类型 / JSON 非法 / 形状不对 ⇒ ["", []]', () => {
  for (const evt of [
    { message_type: 'file', content: '{"file_key": "f1"}' },
    { message_type: 'post', content: 'not-json' },
    { message_type: 'post', content: '[]' },
    { message_type: 'post', content: '{"content": "not-a-list"}' },
    { message_type: 'post' },
  ]) {
    assert.deepEqual(inbound.mediaItems(evt), ['', []], JSON.stringify(evt));
  }
});

// ==========================================================================
// ⑤ downloadImage（§3.4：路径/超时/去 Content-Type/大小上限/mime 归一 + 魔数嗅探）
// ==========================================================================

/** downloadImage 的 rest 替身：记录调用并返回脚本化结果 */
function stubDownload(resource) {
  const calls = [];
  return {
    calls,
    rest: {
      async restBytes(...a) {
        calls.push(a);
        return resource(...a);
      },
    },
  };
}

test('downloadImage：路径 urlquote（safe=""）、params={type:image}、timeout=30；mime 去参数转小写', async () => {
  const s = stubDownload(() => ({ data: PNG, contentType: 'IMAGE/PNG; charset=binary' }));
  const out = await inbound.downloadImage('om_1', 'img_v3/a b', CFG, { rest: s.rest });
  assert.deepEqual(out.data, PNG);
  assert.equal(out.mime, 'image/png');
  assert.equal(s.calls.length, 1);
  const [method, p, opts] = s.calls[0];
  assert.equal(method, 'GET');
  assert.equal(p, '/open-apis/im/v1/messages/om_1/resources/img_v3%2Fa%20b');
  assert.deepEqual(opts.params, { type: 'image' });
  assert.equal(opts.cfg, CFG);
  assert.equal(opts.timeout, 30);
});

test('downloadImage：四类 mime 映射 + 魔数嗅探兜底 + 仍未知 ⇒ application/octet-stream', async () => {
  const cases = [
    ['image/png', PNG, 'image/png'],
    ['image/jpeg', JPEG, 'image/jpeg'],
    ['image/jpg', JPEG, 'image/jpg'],
    ['image/gif', GIF, 'image/gif'],
    ['image/webp', WEBP, 'image/webp'],
    // Content-Type 不可信时的嗅探（真机实测 contentType 干净，仍按契约兜底）
    ['application/octet-stream', PNG, 'image/png'],
    ['text/plain', JPEG, 'image/jpeg'],
    ['', GIF, 'image/gif'],
    ['application/octet-stream', WEBP, 'image/webp'],
    ['application/octet-stream', UNKNOWN, 'application/octet-stream'],
    ['', UNKNOWN, 'application/octet-stream'],
  ];
  for (const [ctype, data, want] of cases) {
    const s = stubDownload(() => ({ data, contentType: ctype }));
    const out = await inbound.downloadImage('om_1', 'k', CFG, { rest: s.rest });
    assert.equal(out.mime, want, `content-type=${JSON.stringify(ctype)}`);
  }
});

test('downloadImage：字节数 > 10MB ⇒ 抛 MediaTooLarge（恰 10MB 放行）', async () => {
  const exact = stubDownload(() => ({
    data: Buffer.alloc(inbound.MEDIA_MAX_BYTES), contentType: 'image/png',
  }));
  assert.equal((await inbound.downloadImage('om_1', 'k', CFG, { rest: exact.rest })).mime,
    'image/png', '恰 10MB 不超限（判据是严格 >）');
  const over = stubDownload(() => ({
    data: Buffer.alloc(inbound.MEDIA_MAX_BYTES + 1), contentType: 'image/png',
  }));
  await assert.rejects(
    () => inbound.downloadImage('om_1', 'k', CFG, { rest: over.rest }),
    (e) => {
      assert.equal(e.name, 'MediaTooLarge');
      assert.equal(e.message, `图片 ${inbound.MEDIA_MAX_BYTES + 1} 字节超过上限 `
        + `${inbound.MEDIA_MAX_BYTES} 字节`);
      return true;
    },
  );
});

// ==========================================================================
// ⑥ handleMediaMessage 决策矩阵（§五 #3~#11；全注入替身，零网络）
// ==========================================================================

/**
 * `handleMediaMessage` 替身台：db/conv/rest 全注入并记流水。
 * `restBytes` 未打桩却被调用 ⇒ 直接抛错（防「不该下载的用例偷偷下载」）。
 */
function mhHarness(tag, over = {}) {
  const calls = { reply: [], conv: [], restBytes: [] };
  const log = [];
  const rest = {
    async restReply(mid, text, cfg) { calls.reply.push([mid, text, cfg]); },
    async restBytes(...a) {
      calls.restBytes.push(a);
      if (over.restBytesErr !== undefined) throw over.restBytesErr;
      if (over.restBytes === undefined) throw new Error('意外下载：用例未打桩 restBytes');
      return over.restBytes(a);
    },
    async botOpenId() { return over.botOpenId === undefined ? 'ou_bot' : over.botOpenId; },
  };
  const convStub = {
    async enabled() { calls.conv.push(['enabled']); return over.convEnabled !== false; },
    async routeText(...a) {
      calls.conv.push(['routeText', ...a]);
      return over.routeReply === undefined ? '已投递到「T」（执行中），跑完把答复发回这里'
        : over.routeReply;
    },
  };
  const binding = over.unbound ? null : {
    open_id: 'ou_a', user_id: 1, cur_sid: '', cur_project_id: 0, cur_title: '',
    cur_bound_at: '', default_project_id: 0,
  };
  const options = {
    // 只读空库句柄：`feishu_cfg.userLang` 在 options 无 `db` 时会落到默认库（真实
    // `~/.touchstone/touchstone.db`）——用户把界面切成 en 后，本文件的「默认中文」
    // 断言会随真实偏好变红。注入空库恢复文件头「依赖全注入、不碰真库」的合同
    // （不改任何断言；en 档仍由显式 options.lang 覆盖）。
    db: { prepare: () => ({ all: () => [], get: () => undefined }) },
    dbmod: { getFeishuBindingByOpen: () => binding },
    rest, conv: convStub, env: over.env ? { ...over.env } : {},
    log: (line) => log.push(line), now: () => 1000,
  };
  return { tag, calls, log, options };
}

/** 消息事件骨架（与 `onMessageEvent` 的 6 键同形） */
function mediaEvt(over = {}) {
  return {
    message_id: 'om_1', message_type: 'image', content: '{"image_key": "img_v3_1"}',
    chat_type: 'p2p', mentions: [], sender_open_id: 'ou_a', ...over,
  };
}

test('矩阵 #2：post（文字 + 2 图）⇒ 文案顺序保持、下载 2 次、routeText 收 [文字, images]', async () => {
  const h = mhHarness('media-post-text', {
    restBytes: (args) => ({ data: Buffer.concat([PNG, Buffer.from(args[1])]),
      contentType: 'image/png' }),
  });
  const evt = mediaEvt({
    message_type: 'post',
    content: JSON.stringify({
      title: '标题',
      content: [
        [{ tag: 'text', text: '第一段 ' }, { tag: 'a', href: 'https://x', text: '链接文字' }],
        [{ tag: 'img', image_key: 'img_1' }, { tag: 'img', image_key: 'img_2' }],
      ],
    }),
  });
  await inbound.handleMediaMessage(evt, CFG, h.options);
  assert.equal(h.calls.restBytes.length, 2);
  assert.match(h.calls.restBytes[0][1], /resources\/img_1$/);
  assert.match(h.calls.restBytes[1][1], /resources\/img_2$/);
  const route = h.calls.conv.filter((c) => c[0] === 'routeText');
  assert.equal(route.length, 1);
  assert.equal(route[0][2], '标题\n第一段 链接文字', '原文字（title 首行 + 段落 \n 连接）');
  assert.equal(route[0][5].length, 2, 'images 按解析顺序');
  assert.ok(route[0][5][0].data.subarray(0, 4).equals(PNG.subarray(0, 4)));
  assert.deepEqual(h.calls.reply.map((r) => r[1]),
    ['已投递到「T」（执行中），跑完把答复发回这里']);
  assert.ok(h.log.includes('feishu inbound: 媒体消息 type=post images=2'));
});

test('矩阵 #3：post 纯文字无图 ⇒ 走 routeText 纯文本路径（4 参、零下载、不落盘）', async () => {
  const h = mhHarness('media-post-pure');
  await inbound.handleMediaMessage(mediaEvt({
    message_type: 'post',
    content: JSON.stringify({ title: '', content: [[{ tag: 'text', text: '纯文字' }]] }),
  }), CFG, h.options);
  assert.deepEqual(h.calls.restBytes, [], '无图不下载');
  const route = h.calls.conv.filter((c) => c[0] === 'routeText');
  assert.equal(route.length, 1);
  assert.equal(route[0].length, 5, 'routeText(binding, text, cfg, options)——无 images');
  assert.equal(route[0][2], '纯文字');
  assert.deepEqual(h.calls.reply.map((r) => r[1]),
    ['已投递到「T」（执行中），跑完把答复发回这里']);
});

test('矩阵 #4：未绑定 ⇒ 回 UNBOUND_DM_MSG；零下载、零 routeText', async () => {
  const h = mhHarness('media-unbound', { unbound: true });
  await inbound.handleMediaMessage(mediaEvt(), CFG, h.options);
  assert.deepEqual(h.calls.reply.map((r) => r[1]), [inbound.UNBOUND_DM_MSG]);
  assert.deepEqual(h.calls.restBytes, []);
  assert.equal(h.calls.conv.filter((c) => c[0] === 'routeText').length, 0);
  assert.equal(h.calls.conv.filter((c) => c[0] === 'enabled').length, 1, '先过 conv 开关');
});

test('矩阵 #5：TS_FEISHU_CONV=0 ⇒ 回 MEDIA_TYPE_HINT；零下载', async () => {
  const h = mhHarness('media-conv-off', { convEnabled: false });
  await inbound.handleMediaMessage(mediaEvt(), CFG, h.options);
  assert.deepEqual(h.calls.reply.map((r) => r[1]), [inbound.MEDIA_TYPE_HINT]);
  assert.deepEqual(h.calls.restBytes, []);
  assert.equal(h.calls.conv.filter((c) => c[0] === 'routeText').length, 0);
});

test('矩阵 #6：TS_FEISHU_MEDIA=0 ⇒ 回 MEDIA_TYPE_HINT；零下载、连 conv 开关都不问', async () => {
  const h = mhHarness('media-off', { env: { TS_FEISHU_MEDIA: '0' } });
  await inbound.handleMediaMessage(mediaEvt(), CFG, h.options);
  assert.deepEqual(h.calls.reply.map((r) => r[1]), [inbound.MEDIA_TYPE_HINT]);
  assert.deepEqual(h.calls.restBytes, []);
  assert.deepEqual(h.calls.conv, [], '回滚阀先于 conv.enabled');
});

test('矩阵 #7：群聊 @机器人 发图 ⇒ 静默（零回复/零下载）', async () => {
  const h = mhHarness('media-group');
  await inbound.handleMessageEvent(mediaEvt({
    message_id: 'om_g', chat_type: 'group',
    mentions: [{ key: '@_user_1', open_id: 'ou_bot' }],
  }), CFG, h.options);
  assert.deepEqual(h.calls.reply, []);
  assert.deepEqual(h.calls.restBytes, []);
  assert.deepEqual(h.calls.conv, [], '群聊媒体消息不落会话');
});

test('矩阵 #8：下载抛缺权限码（99991672/99991640/99991679）⇒ MEDIA_SCOPE_HINT；零 routeText', async () => {
  for (const code of [99991640, 99991672, 99991679]) {
    const h = mhHarness(`media-scope-${code}`, {
      restBytesErr: new FeishuRestError(`REST 缺权限 code=${code}`, code),
    });
    await inbound.handleMediaMessage(mediaEvt(), CFG, h.options);
    assert.deepEqual(h.calls.reply.map((r) => r[1]), [inbound.MEDIA_SCOPE_HINT], `code=${code}`);
    assert.equal(h.calls.conv.filter((c) => c[0] === 'routeText').length, 0, '缺权限一张都不投递');
  }
});

test('矩阵 #9：其它 REST 错误 / 网络异常 ⇒ MEDIA_FAIL_PREFIX+原因；零 routeText；全有或全无', async () => {
  const h = mhHarness('media-rest-err', {
    restBytesErr: new FeishuRestError('boom', 40000000),
  });
  await inbound.handleMediaMessage(mediaEvt(), CFG, h.options);
  assert.deepEqual(h.calls.reply.map((r) => r[1]), ['截图接收失败：boom']);
  assert.equal(h.calls.conv.filter((c) => c[0] === 'routeText').length, 0);

  const h2 = mhHarness('media-net-err', { restBytesErr: new TypeError('net down') });
  await inbound.handleMediaMessage(mediaEvt(), CFG, h2.options);
  assert.deepEqual(h2.calls.reply.map((r) => r[1]), ['截图接收失败：net down']);

  // 全有或全无：两张图，第二张失败 ⇒ 一张都不投递
  let n = 0;
  const h3 = mhHarness('media-partial', {});
  h3.options.restBytesErr = undefined;
  h3.options.rest = {
    ...h3.options.rest,
    async restReply(mid, text, cfg) { h3.calls.reply.push([mid, text, cfg]); },
    async restBytes(...a) {
      h3.calls.restBytes.push(a);
      n += 1;
      if (n === 2) throw new FeishuRestError('第二张坏了', 40000000);
      return { data: PNG, contentType: 'image/png' };
    },
  };
  await inbound.handleMediaMessage(mediaEvt({
    message_type: 'post',
    content: JSON.stringify({ content: [[{ tag: 'img', image_key: 'a' },
      { tag: 'img', image_key: 'b' }]] }),
  }), CFG, h3.options);
  assert.equal(h3.calls.restBytes.length, 2);
  assert.deepEqual(h3.calls.reply.map((r) => r[1]), ['截图接收失败：第二张坏了']);
  assert.equal(h3.calls.conv.filter((c) => c[0] === 'routeText').length, 0, '禁止半截图文');
});

test('矩阵 #10：下载字节 > 10MB ⇒ 回过大文案；零 routeText', async () => {
  const h = mhHarness('media-too-large', {
    restBytes: () => ({ data: Buffer.alloc(inbound.MEDIA_MAX_BYTES + 1),
      contentType: 'image/png' }),
  });
  await inbound.handleMediaMessage(mediaEvt(), CFG, h.options);
  assert.deepEqual(h.calls.reply.map((r) => r[1]),
    ['截图接收失败：' + inbound.MEDIA_TOO_LARGE]);
  assert.equal(h.calls.conv.filter((c) => c[0] === 'routeText').length, 0);
});

test('矩阵 #11：post 含 12 张图 ⇒ 只下载/投递前 9 张（静默丢弃多余）', async () => {
  const content = {
    content: [Array.from({ length: 12 }, (_, i) => ({
      tag: 'img', image_key: `img_${i}`,
    }))],
  };
  const h = mhHarness('media-12', {
    restBytes: () => ({ data: PNG, contentType: 'image/png' }),
  });
  await inbound.handleMediaMessage(mediaEvt({
    message_type: 'post', content: JSON.stringify(content),
  }), CFG, h.options);
  assert.equal(h.calls.restBytes.length, inbound.MEDIA_MAX_COUNT, '只下载前 9 张');
  assert.deepEqual(h.calls.restBytes.map((a) => a[1].split('/').pop()),
    Array.from({ length: 9 }, (_, i) => `img_${i}`));
  const route = h.calls.conv.filter((c) => c[0] === 'routeText');
  assert.equal(route[0][5].length, 9, '投递 9 张');
  assert.ok(h.log.includes('feishu inbound: 媒体消息 type=post images=12'),
    '入站日志报解析到的总张数（12）');
});

test('矩阵 #3b：post 无图且无文字 ⇒ MEDIA_FAIL_PREFIX + MEDIA_NO_IMAGE', async () => {
  const h = mhHarness('media-no-image');
  await inbound.handleMediaMessage(mediaEvt({
    message_type: 'post', content: JSON.stringify({ title: '  ', content: [] }),
  }), CFG, h.options);
  assert.deepEqual(h.calls.reply.map((r) => r[1]),
    ['截图接收失败：' + inbound.MEDIA_NO_IMAGE]);
  assert.deepEqual(h.calls.restBytes, []);
});

// ==========================================================================
// ⑦ ∫ 集成：handleMediaMessage → 真 conv.routeText → board_media 落盘 + chat.submit
//    （矩阵 #1/#12/#14 用真库 + 真 FS + 真 routeText；chat.submit 为替身）
// ==========================================================================

/**
 * 集成台：真 `db` 模块（临时库）+ 真 `feishu_conv` 模块 + 真文件系统（临时 work_dir）。
 * 只把「会出站/会建会话」的四件换成替身：`chat.submit` / `sessparse` / `dshdriver` /
 * `rest`；`agents.agentFamily` 返回单族名（本批不涉及 dsh 驱动）。
 */
function integrationHarness(tag, over = {}) {
  const fx = freshDb(tag);
  inbound.resetInboundState();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `ts-media-${tag}-`));
  const workDir = over.workDir !== undefined ? over.workDir : path.join(base, 'work');
  const projectDir = path.join(base, 'proj');
  const pid = insertProject(fx.db, {
    userId: 1, name: over.projectName || 'P1', projectDir, workDir,
  });
  if (over.binding !== false) {
    db.setFeishuBinding('ou_a', 1,
      over.defaultProjectId === undefined ? pid : over.defaultProjectId, { db: fx.db });
    if (over.curSid !== false) {
      db.setFeishuCurSession('ou_a', pid, 'sess-1', 'T', { db: fx.db });
    }
  }
  const calls = { reply: [], cards: [], dm: [], submit: [], restBytes: [] };
  const logs = [];
  const rest = {
    async restReply(mid, text, cfg) { calls.reply.push([mid, text, cfg]); },
    async restSendCard(...a) { calls.cards.push(a); },
    async restSendText(...a) { calls.dm.push(a); },
    async restBytes(...a) {
      calls.restBytes.push(a);
      if (over.restBytesErr !== undefined) throw over.restBytesErr;
      if (over.restBytes === undefined) throw new Error('意外下载：用例未打桩 restBytes');
      return over.restBytes(a);
    },
    async botOpenId() { return over.botOpenId === undefined ? 'ou_bot' : over.botOpenId; },
  };
  const chat = {
    MESSAGE_MAX: 20000,
    async submit(projectId, sid, message, submitOpts) {
      calls.submit.push([projectId, sid, message, submitOpts]);
      return { queued: false, state: 'running' };
    },
  };
  const sessparse = {
    session_exists: (family, sid) => sid === 'sess-1',
    load: () => ({ total: 0, found: true, entries: [] }),
  };
  const options = {
    db: fx.db, dbPath: fx.dbPath, dbmod: db, conv, chat, sessparse,
    agents: { agentFamily: () => 'dsh_plugin' },
    waitq: {
      KIND_CARD: 'card', KIND_MSG: 'msg', KIND_ANSWER: 'answer', KIND_EXT: 'ext',
      activeItems: () => [],
    },
    dshdriver: { configured: () => true }, dshevents: {},
    feishu: { appConfig: () => CFG },
    rest, env: over.env ? { ...over.env } : {},
    log: (line) => logs.push(line), now: () => 1000,
  };
  return {
    fx, base, workDir, projectDir, pid, calls, logs, options,
    mediaDir: path.join(workDir, 'board_media'),
    close() {
      fx.close();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

/** 读出 board_media 下的文件（不存在回 []） */
function mediaFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

const FID_RE = /^m\d+_[0-9a-f]{10}\.[A-Za-z0-9]{1,10}$/;

test('矩阵 #1：p2p + 绑定 + image（1 张）⇒ 下载 1 次、落 1 个 m<ts>_<hex10>.png、文案=header+markdown、回执 已投递到', async () => {
  const h = integrationHarness('media-e2e-image', {
    restBytes: () => ({ data: PNG, contentType: 'image/png' }),
  });
  try {
    await inbound.handleMediaMessage(mediaEvt(), CFG, h.options);
    // ① 下载 1 次（路径/参数走真 inbound → 真 rest 替身）
    assert.equal(h.calls.restBytes.length, 1);
    assert.equal(h.calls.restBytes[0][1],
      '/open-apis/im/v1/messages/om_1/resources/img_v3_1');
    // ② board_media 落 1 个合法 fid；文件字节 = 下载字节
    const files = mediaFiles(h.mediaDir);
    assert.equal(files.length, 1, `files=${JSON.stringify(files)}`);
    assert.match(files[0], FID_RE, 'fid 必须匹配看板附件正则（现有媒体端点直接可用）');
    assert.match(files[0], /\.png$/);
    assert.deepEqual(fs.readFileSync(path.join(h.mediaDir, files[0])), PNG, '文件字节=下载字节');
    // ③ chat.submit 文案 = §3.6（无文字 ⇒ header 带 NOTE、无前导空行）
    assert.equal(h.calls.submit.length, 1);
    const [pid, sid, message, submitOpts] = h.calls.submit[0];
    assert.equal(pid, h.pid);
    assert.equal(sid, 'sess-1');
    const abs = path.join(h.mediaDir, files[0]);
    assert.equal(message, `[飞书截图] 用户从飞书发送了 1 张截图（未附文字说明）：\n`
      + `![飞书截图1.png](${abs})`);
    // ④ 投递载荷与文字路径同形（baseline/open_id/user_id/project_id/title）
    assert.equal(submitOpts.extraMeta.feishu.open_id, 'ou_a');
    assert.equal(submitOpts.extraMeta.feishu.project_id, h.pid);
    assert.equal(submitOpts.extraMeta.feishu.baseline, 0);
    assert.equal(submitOpts.extraMeta.feishu.title, 'T');
    // ⑤ 回执（§3.6-5，文案不变）与投递日志（§3.2）
    assert.deepEqual(h.calls.reply.map((r) => r[1]),
      ['已投递到「T」（执行中），跑完把答复发回这里']);
    assert.ok(h.logs.includes(`[feishu] 截图 1 张已存 board_media 并投递 sid=sess-1`
      + `（project=${h.pid}）`), `logs=${JSON.stringify(h.logs)}`);
  } finally { h.close(); }
});

test('矩阵 #1b：p2p image 全链路（handleMessageEvent → onMessageEvent 形态）只下载一次、零真实网络', async () => {
  const h = integrationHarness('media-e2e-entry', {
    restBytes: () => ({ data: JPEG, contentType: 'image/jpeg' }),
  });
  try {
    await inbound.handleMessageEvent(mediaEvt(), CFG, h.options);
    assert.equal(h.calls.restBytes.length, 1);
    const files = mediaFiles(h.mediaDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /\.jpg$/, 'content-type image/jpeg ⇒ ext jpg');
    assert.equal(h.calls.submit.length, 1);
  } finally { h.close(); }
});

test('矩阵 #12：直接调 routeText(images=…) ⇒ fid 正则通过、文案 §3.6 逐字、回执不变', async () => {
  const h = integrationHarness('media-direct-route');
  try {
    const binding = db.getFeishuBindingByOpen('ou_a', { db: h.fx.db });
    const reply = await conv.routeText(binding, '这是说明', CFG, h.options, [
      { data: PNG, mime: 'image/png' },
      { data: JPEG, mime: 'image/jpeg' },
    ]);
    const files = mediaFiles(h.mediaDir);
    assert.equal(files.length, 2);
    for (const f of files) assert.match(f, FID_RE);
    assert.ok(files.some((f) => /\.png$/.test(f)) && files.some((f) => /\.jpg$/.test(f)),
      '两张不同 mime 各自扩展名');
    const pngFid = files.find((f) => /\.png$/.test(f));
    const jpgFid = files.find((f) => /\.jpg$/.test(f));
    assert.equal(h.calls.submit.length, 1);
    const composed = h.calls.submit[0][2];
    assert.equal(composed, `这是说明\n\n[飞书截图] 用户从飞书发送了 2 张截图：\n`
      + `![飞书截图1.png](${path.join(h.mediaDir, pngFid)})`
      + `\n![飞书截图2.jpg](${path.join(h.mediaDir, jpgFid)})`);
    assert.equal(reply, '已投递到「T」（执行中），跑完把答复发回这里');
    assert.deepEqual(h.calls.reply, [], 'direct routeText 不发 restReply（回执由调用方发）');
  } finally { h.close(); }
});

test('矩阵 #12b：routeText(images=…) 的既有文字路径零改动（images 省略/[] ⇒ 原文字投递、不落盘）', async () => {
  for (const images of [undefined, null, []]) {
    const h = integrationHarness(`media-text-regress-${images === undefined ? 'u' : images === null ? 'n' : 'e'}`);
    try {
      const binding = db.getFeishuBindingByOpen('ou_a', { db: h.fx.db });
      const reply = await (images === undefined
        ? conv.routeText(binding, '你好', CFG, h.options)
        : conv.routeText(binding, '你好', CFG, h.options, images));
      assert.equal(h.calls.submit.length, 1);
      assert.equal(h.calls.submit[0][2], '你好', `images=${JSON.stringify(images)}`);
      assert.deepEqual(mediaFiles(h.mediaDir), [], '文字路径不落盘');
      assert.equal(reply, '已投递到「T」（执行中），跑完把答复发回这里');
    } finally { h.close(); }
  }
});

test('矩阵 #13：routeText(images=…) 且无默认项目 ⇒ 回引导文案；不落盘、不 submit', async () => {
  // 两个项目 + 未设默认项目 ⇒ `locate_project` 回「请指明项目…」（项目总览卡照发）
  const fx = freshDb('media-no-project');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-media-noproj-'));
  const dirs = [path.join(base, 'p1'), path.join(base, 'p2')];
  try {
    const ids = dirs.map((d) => insertProject(fx.db, {
      userId: 1, name: path.basename(d), projectDir: d, workDir: d,
    }));
    db.setFeishuBinding('ou_a', 1, 0, { db: fx.db });
    const calls = { submit: [], cards: [], reply: [] };
    const options = {
      db: fx.db, dbPath: fx.dbPath, dbmod: db, conv,
      chat: { MESSAGE_MAX: 20000, async submit(...a) { calls.submit.push(a); } },
      sessparse: { session_exists: () => true, load: () => ({ total: 0 }) },
      agents: { agentFamily: () => 'dsh_plugin' },
      waitq: {
        KIND_CARD: 'card', KIND_MSG: 'msg', KIND_ANSWER: 'answer', KIND_EXT: 'ext',
        activeItems: () => [],
      },
      dshdriver: { configured: () => true }, dshevents: {},
      feishu: { appConfig: () => CFG },
      rest: {
        async restSendCard(...a) { calls.cards.push(a); },
        async restSendText(...a) { calls.reply.push(a); },
      },
      env: {}, log: () => {}, now: () => 1000,
    };
    const binding = db.getFeishuBindingByOpen('ou_a', { db: fx.db });
    const reply = await conv.routeText(binding, '', CFG, options, [
      { data: PNG, mime: 'image/png' },
    ]);
    // routeText 的无项目分支固定回 NO_DEFAULT_GUIDE（`located[1]` 的「请指明项目…」被丢弃）
    assert.equal(reply, conv.NO_DEFAULT_GUIDE);
    assert.deepEqual(calls.submit, [], '无项目不投递');
    for (const d of dirs) {
      assert.equal(fs.existsSync(path.join(d, 'board_media')), false,
        `无项目分支不许落盘（会产生孤儿文件）：${d}`);
    }
    assert.equal(ids.length, 2);
  } finally {
    fx.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('矩阵 #14：存盘 OSError ⇒ MEDIA_SAVE_FAIL_PREFIX+原因；不投递（note 照旧拼接）', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-media-oserr-'));
  const blocker = path.join(base, 'blocker');
  fs.writeFileSync(blocker, 'not a dir');        // work_dir 是普通文件 ⇒ mkdir ENOTDIR
  const h = integrationHarness('media-oserr', { workDir: blocker });
  try {
    const binding = db.getFeishuBindingByOpen('ou_a', { db: h.fx.db });
    const reply = await conv.routeText(binding, '说明', CFG, h.options, [
      { data: PNG, mime: 'image/png' },
    ]);
    assert.ok(reply.startsWith(inbound.MEDIA_SAVE_FAIL_PREFIX),
      `回执必须以「${inbound.MEDIA_SAVE_FAIL_PREFIX}」开头：${reply}`);
    assert.ok(reply.length > inbound.MEDIA_SAVE_FAIL_PREFIX.length, '要带具体原因');
    assert.deepEqual(h.calls.submit, [], '存盘失败不投递');
    assert.deepEqual(h.calls.reply, [], 'direct routeText 不发 restReply');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    h.close();
  }
});

// ==========================================================================
// ⑧ 矩阵 #16：零真实网络（真实 fetch 调用计数必须为 0）
// ==========================================================================

test('矩阵 #16：零真实网络——全局 fetch 哨兵零调用（所有下载/投递都是注入替身）', () => {
  assert.equal(net.real, 0, `真实 fetch 被调用 ${net.real} 次（单测必须零出站）`);
  assert.ok(net.scripted > 0, 'restBytes 用例确实跑过脚本化 fetch（防空对空假绿）');
});
