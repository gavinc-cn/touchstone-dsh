/**
 * 飞书长连接（pbbp2.Frame ↔ WebSocket）**零依赖**实现。
 *
 * 契约来源是量出来的，不是查文档：
 *   - 帧结构 `lark_oapi.ws.pb.pbbp2_pb2.Frame`（proto2）：`SeqID(1)/LogID(2)` uint64、
 *     `service(3)/method(4)` int32、`headers(5)` repeated `Header{key=1,value=2}`（**两个子字段都是
 *     required**）、`payload_encoding(6)/payload_type(7)/LogIDNew(9)` optional string、
 *     `payload(8)` optional bytes。
 *   - 量具一（逐字节）：`tools/parity/probe/pb_frames.py` 用**真 protobuf** 生成 fixture，
 *     `tools/parity/test/pbbp2.test.mjs` 双向断言（编码逐字节 / 解码后再编码回到原字节）。
 *   - 量具二（客户端）：`tools/parity/probe/fake_ws_gateway.py` + `tools/parity/probe/ws_selftest.py`
 *     （独立实现的 Python 服务端，逐条校验 ping/合包/ACK）。
 *
 * proto2 的四个坑（每条都有量具钉住，别按直觉"优化"）：
 *   1. required **取 0 也必须上线**：Python `Frame()` 缺 required 时 `SerializeToString()` 抛
 *      `EncodeError: Message pbbp2.Frame is missing required fields: ...`
 *      ⇒ 本文件 `encodeFrame` 缺 required 同样抛。
 *   2. `payload` **未设** vs **显式空 bytes** 是两种线上字节（后者是 `42 00`）：JS 侧 `null`/`undefined`
 *      表示未设、`Buffer.alloc(0)` 表示显式空。空 payload 塌成 null 会让 ACK 少两个字节。
 *   3. `Header.key/value` 也是 **required**：显式空串照样写（`0a 00 12 00`）；而 Python 里
 *      "`headers.add()` 之后什么都不设"会抛 EncodeError（实测）⇒ 本文件要求每个 header 两个字段都在。
 *   4. `SeqID/LogID` 是 uint64：> 2^53 时 JS Number 会**静默丢精度** ⇒ 解码给 BigInt，
 *      编码**拒绝**不安全的 Number（要求 BigInt 或十进制字符串）。
 *
 * 实测行为（2026-10-15，`Frame.DESCRIPTOR` + 逐字节探针，全部与 Python 对过）：
 *   - 编码按**字段号升序**规范化（乱序输入解析后再序列化回到字段号顺序）；
 *   - **未知字段会被保留**，追加在**所有已知字段之后**（按遇到顺序），wire type 0/1/2/5 都保留；
 *   - 非 repeated 字段重复出现 ⇒ **后者胜**（重复的 payload 只留最后一个）；
 *   - `ParseFromString` 对"缺 required"是**宽容**的（不抛，`IsInitialized()==False`），只在
 *     `SerializeToString` 时抛 ⇒ 本文件 decode 同样宽容（缺的记进 `_missingRequired`），encode 才抛；
 *   - wire type 3/4（group）Python 抛 `DecodeError: Truncated message.` ⇒ 本文件抛；
 *   - 截断的 varint/长度前缀 Python 抛 `DecodeError` ⇒ 本文件抛。
 *
 * 已知差异（已登记，不许悄悄"补上"）：
 *   - 未知字段的**相对位置**：Python 追加到末尾，本文件同样追加到末尾，但 Python 是
 *     "已知字段按字段号 + 未知字段按遇到顺序"，本文件完全同构；两者对**同一条输入**输出一致（已测）。
 *   - 缺 required 的帧：Python 解析成功、序列化抛；本文件解码成功并记 `_missingRequired`，
 *     编码时抛 —— 形状一致（都是"解析宽容、序列化严格"），但**错误文案不同**（跨运行时文案本就不对拍）。
 */

// ACK 的 payload 走 `pyJsonDumps`（Python `json.dumps(ensure_ascii=False)` 的默认分隔符 `", "`/`": "`）：
// 用 `JSON.stringify` 少两个空格就是逐字节分叉（`{"code":200}` vs `{"code": 200}`）。
import { pyJsonDumps } from './pyjson.js';

/** 帧方法（`lark_oapi.ws.enum.FrameType`） */
export const FRAME_TYPE_CONTROL = 0;
export const FRAME_TYPE_DATA = 1;

/** 头里的 `type` 取值（`lark_oapi.ws.enum.MessageType`） */
export const MESSAGE_TYPE_PING = 'ping';
export const MESSAGE_TYPE_PONG = 'pong';
export const MESSAGE_TYPE_EVENT = 'event';
export const MESSAGE_TYPE_CARD = 'card';

/** 头名（`lark_oapi.ws.const`） */
export const HEADER_TYPE = 'type';
export const HEADER_MESSAGE_ID = 'message_id';
export const HEADER_SUM = 'sum';
export const HEADER_SEQ = 'seq';
export const HEADER_TRACE_ID = 'trace_id';
export const HEADER_BIZ_RT = 'biz_rt';

/** 字段号（写死在 proto 里，改不了） */
const F_SEQ_ID = 1;
const F_LOG_ID = 2;
const F_SERVICE = 3;
const F_METHOD = 4;
const F_HEADERS = 5;
const F_PAYLOAD_ENCODING = 6;
const F_PAYLOAD_TYPE = 7;
const F_PAYLOAD = 8;
const F_LOG_ID_NEW = 9;

const WT_VARINT = 0;
const WT_FIXED64 = 1;
const WT_LEN = 2;
const WT_FIXED32 = 5;

const MAX_U64 = (1n << 64n) - 1n;
const MIN_I32 = -2147483648n;
const MAX_I32 = 2147483647n;
const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);

/** 编解码失败（对应 Python 的 `DecodeError` / `EncodeError`；文案跨运行时不保证一致） */
export class FeishuWsCodecError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FeishuWsCodecError';
  }
}

// ------------------------------------------------------------------ varint / 原始写
/** 无符号 varint（入参必须是 0..2^64-1 的 BigInt） */
function varintBytes(value) {
  const out = [];
  let v = value;
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if (v === 0n) { out.push(b); return Buffer.from(out); }
    out.push(b | 0x80);
  }
}

function tagBytes(field, wire) {
  return varintBytes((BigInt(field) << 3n) | BigInt(wire));
}

function lenDelimBytes(field, payload) {
  return Buffer.concat([tagBytes(field, WT_LEN), varintBytes(BigInt(payload.length)), payload]);
}

function utf8(s) {
  return Buffer.from(s, 'utf8');
}

/** required 数值字段 → BigInt（Number 必须是安全整数，否则丢精度） */
function requiredBig(value, name, { min, max }) {
  if (value === undefined || value === null) {
    throw new FeishuWsCodecError(`missing required field: ${name}`);
  }
  let v;
  if (typeof value === 'bigint') v = value;
  else if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new FeishuWsCodecError(`${name} 必须是整数，实际 ${value}`);
    }
    if (!Number.isSafeInteger(value)) {
      // 正是计划里点名的那条红线：静默丢精度比抛错危险得多（雪花号量级会错号）
      throw new FeishuWsCodecError(
        `${name}=${value} 超过 2^53，JS Number 已丢精度 ⇒ 请传 BigInt 或十进制字符串`);
    }
    v = BigInt(value);
  } else if (typeof value === 'string') {
    if (!/^-?[0-9]+$/.test(value)) throw new FeishuWsCodecError(`${name} 不是十进制整数：${value}`);
    v = BigInt(value);
  } else {
    throw new FeishuWsCodecError(`${name} 类型不接受：${typeof value}`);
  }
  if (v < min || v > max) throw new FeishuWsCodecError(`${name}=${v} 越界（${min}..${max}）`);
  return v;
}

/** optional string 字段：`undefined`/`null` = 未设；`''` = 显式空串（线上 `xx 00`） */
function optionalString(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new FeishuWsCodecError(`${name} 必须是字符串，实际 ${typeof value}`);
  }
  return value;
}

function headerBytes(h, index) {
  if (h === null || typeof h !== 'object') {
    throw new FeishuWsCodecError(`headers[${index}] 必须是 {key,value} 对象`);
  }
  const key = h.key;
  const value = h.value;
  // 两个子字段都是 required ⇒ 缺一个就是 Python 的 EncodeError（实测：headers[0].key/headers[0].value）
  if (typeof key !== 'string') {
    throw new FeishuWsCodecError(`missing required field: headers[${index}].key`);
  }
  if (typeof value !== 'string') {
    throw new FeishuWsCodecError(`missing required field: headers[${index}].value`);
  }
  return Buffer.concat([
    lenDelimBytes(1, utf8(key)),   // 空串照样写：0a 00
    lenDelimBytes(2, utf8(value)), // 12 00
  ]);
}

// ------------------------------------------------------------------ 编码
/**
 * frame → 线上字节。
 *
 * 冻结接口（`tools/parity/test/pbbp2.test.mjs` 按此断言）：
 *   `{ SeqID, LogID, service, method, headers: [{key,value}], payload: Buffer|null }`
 * 可选：`payload_encoding` / `payload_type` / `LogIDNew`（string；`undefined`/`null` = 未设）
 * 以及 `_unknown`（decode 保留的未知字段原始字节数组，追加在所有已知字段之后）。
 */
export function encodeFrame(frame) {
  if (frame === null || typeof frame !== 'object') {
    throw new FeishuWsCodecError('encodeFrame 需要帧对象');
  }
  const seq = requiredBig(frame.SeqID, 'SeqID', { min: 0n, max: MAX_U64 });
  const log = requiredBig(frame.LogID, 'LogID', { min: 0n, max: MAX_U64 });
  const service = requiredBig(frame.service, 'service', { min: MIN_I32, max: MAX_I32 });
  const method = requiredBig(frame.method, 'method', { min: MIN_I32, max: MAX_I32 });

  // 一律按**字段号升序**写（Python 解析后重新序列化也是这个顺序，实测）
  const parts = [];
  parts.push(tagBytes(F_SEQ_ID, WT_VARINT), varintBytes(seq));
  parts.push(tagBytes(F_LOG_ID, WT_VARINT), varintBytes(log));
  // int32 负数：proto2 线上是**符号扩展到 64 位**后的 varint（-1 ⇒ 10 字节 ff…01）
  parts.push(tagBytes(F_SERVICE, WT_VARINT), varintBytes(BigInt.asUintN(64, service)));
  parts.push(tagBytes(F_METHOD, WT_VARINT), varintBytes(BigInt.asUintN(64, method)));

  const headers = frame.headers === undefined || frame.headers === null ? [] : frame.headers;
  if (!Array.isArray(headers)) throw new FeishuWsCodecError('headers 必须是数组');
  headers.forEach((h, i) => parts.push(lenDelimBytes(F_HEADERS, headerBytes(h, i))));

  const enc = optionalString(frame.payload_encoding, 'payload_encoding');
  if (enc !== null) parts.push(lenDelimBytes(F_PAYLOAD_ENCODING, utf8(enc)));
  const ptype = optionalString(frame.payload_type, 'payload_type');
  if (ptype !== null) parts.push(lenDelimBytes(F_PAYLOAD_TYPE, utf8(ptype)));

  const payload = frame.payload;
  if (payload !== undefined && payload !== null) {
    if (!Buffer.isBuffer(payload) && !(payload instanceof Uint8Array)) {
      throw new FeishuWsCodecError(`payload 必须是 Buffer/Uint8Array，实际 ${typeof payload}`);
    }
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    parts.push(lenDelimBytes(F_PAYLOAD, buf)); // 显式空 ⇒ 42 00
  }
  const logIdNew = optionalString(frame.LogIDNew, 'LogIDNew');
  if (logIdNew !== null) parts.push(lenDelimBytes(F_LOG_ID_NEW, utf8(logIdNew)));

  const missing = frame._missingRequired;
  if (Array.isArray(missing) && missing.length > 0) {
    throw new FeishuWsCodecError(
      `missing required fields: ${missing.join(',')}（帧解析自缺失 required 的字节，不许回写）`);
  }
  const unknown = frame._unknown;
  if (Array.isArray(unknown)) {
    for (const raw of unknown) {
      if (!Buffer.isBuffer(raw)) throw new FeishuWsCodecError('_unknown 只接受 Buffer');
      parts.push(raw);
    }
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ 解码
function readVarint(bytes, start) {
  let shift = 0n;
  let val = 0n;
  let i = start;
  for (;;) {
    if (i >= bytes.length) throw new FeishuWsCodecError(`truncated varint at offset ${start}`);
    const b = bytes[i];
    i += 1;
    val |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [val, i];
    shift += 7n;
    if (shift > 63n) throw new FeishuWsCodecError(`varint too long at offset ${start}`);
  }
}

/** uint64 → Number 或 BigInt（> 2^53 才用 BigInt，普通帧仍是 Number，免得到处踩 1n !== 1） */
function u64(v) {
  return v <= MAX_SAFE_BIG ? Number(v) : v;
}

/**
 * 跳过一段未知字段并返回其**原始字节**（含 tag）。wire type 3/4（group）不支持。
 * 注意 `tagStart` 是 tag 的起点（保留原始字节要用它），`afterTag` 才是值起点。
 */
function rawField(bytes, tagStart, afterTag, wt) {
  if (wt === WT_VARINT) {
    const [, end] = readVarint(bytes, afterTag);
    return [bytes.subarray(tagStart, end), end];
  }
  if (wt === WT_FIXED64 || wt === WT_FIXED32) {
    const size = wt === WT_FIXED64 ? 8 : 4;
    const end = afterTag + size;
    if (end > bytes.length) throw new FeishuWsCodecError(`truncated fixed field at offset ${tagStart}`);
    return [bytes.subarray(tagStart, end), end];
  }
  if (wt === WT_LEN) {
    const [len, afterLen] = readVarint(bytes, afterTag);
    const end = afterLen + Number(len);
    if (end > bytes.length) {
      throw new FeishuWsCodecError(`truncated length-delimited field at offset ${tagStart}`);
    }
    return [bytes.subarray(tagStart, end), end];
  }
  // group（3/4）：Python 侧实测抛 DecodeError: Truncated message.
  throw new FeishuWsCodecError(`unsupported wire type ${wt} at offset ${tagStart}`);
}

function decodeHeader(buf) {
  let key = '';
  let value = '';
  let i = 0;
  while (i < buf.length) {
    const [tag, afterTag] = readVarint(buf, i);
    const field = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (field === 0) throw new FeishuWsCodecError('field number 0 in Header');
    if (wt === WT_LEN && (field === 1 || field === 2)) {
      const [len, afterLen] = readVarint(buf, afterTag);
      const end = afterLen + Number(len);
      if (end > buf.length) throw new FeishuWsCodecError('truncated Header string');
      const s = buf.toString('utf8', afterLen, end);
      if (field === 1) key = s; else value = s; // 重复出现 ⇒ 后者胜
      i = end;
      continue;
    }
    const [, end] = rawField(buf, i, afterTag, wt);
    i = end;
  }
  return { key, value };
}

/**
 * 线上字节 → frame。宽容（照 Python `ParseFromString`）：缺 required 不抛，记进 `_missingRequired`。
 * `payload`：未设 ⇒ `null`；显式空 ⇒ `Buffer.alloc(0)`。
 * 未知字段按遇到顺序原样留在 `_unknown`（编码时追加在已知字段之后，与 Python 实测一致）。
 */
export function decodeFrame(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input ?? Buffer.alloc(0));
  let seq;
  let log;
  let service;
  let method;
  const headers = [];
  let payloadEncoding = null;
  let payloadType = null;
  let payload = null;
  let logIdNew = null;
  const unknown = [];
  const seen = new Set();

  let i = 0;
  while (i < bytes.length) {
    const start = i;
    const [tag, afterTag] = readVarint(bytes, i);
    const field = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (field === 0) throw new FeishuWsCodecError(`field number 0 at offset ${start}`);

    let handled = false;
    if (field === F_SEQ_ID || field === F_LOG_ID || field === F_SERVICE || field === F_METHOD) {
      if (wt === WT_VARINT) {
        const [raw, end] = readVarint(bytes, afterTag);
        if (field === F_SEQ_ID) seq = u64(raw);
        else if (field === F_LOG_ID) log = u64(raw);
        // int32：低 32 位按有符号解释（负数是 10 字节符号扩展 varint）
        else if (field === F_SERVICE) service = Number(BigInt.asIntN(32, raw));
        else method = Number(BigInt.asIntN(32, raw));
        seen.add(field);
        i = end;
        handled = true;
      }
    } else if (field === F_HEADERS && wt === WT_LEN) {
      const [len, afterLen] = readVarint(bytes, afterTag);
      const end = afterLen + Number(len);
      if (end > bytes.length) throw new FeishuWsCodecError('truncated headers field');
      headers.push(decodeHeader(bytes.subarray(afterLen, end)));
      seen.add(field);
      i = end;
      handled = true;
    } else if ((field === F_PAYLOAD_ENCODING || field === F_PAYLOAD_TYPE || field === F_LOG_ID_NEW)
               && wt === WT_LEN) {
      const [len, afterLen] = readVarint(bytes, afterTag);
      const end = afterLen + Number(len);
      if (end > bytes.length) throw new FeishuWsCodecError(`truncated field ${field}`);
      const s = bytes.toString('utf8', afterLen, end);
      if (field === F_PAYLOAD_ENCODING) payloadEncoding = s;
      else if (field === F_PAYLOAD_TYPE) payloadType = s;
      else logIdNew = s;
      seen.add(field);
      i = end;
      handled = true;
    } else if (field === F_PAYLOAD && wt === WT_LEN) {
      const [len, afterLen] = readVarint(bytes, afterTag);
      const end = afterLen + Number(len);
      if (end > bytes.length) throw new FeishuWsCodecError('truncated payload');
      payload = Buffer.from(bytes.subarray(afterLen, end)); // 显式空 ⇒ 长度 0 的 Buffer（不是 null）
      seen.add(field);
      i = end;
      handled = true;
    }

    if (!handled) {
      // wire type 与字段号不匹配、或压根不认识的字段号 ⇒ Python 也走"未知字段"分支
      const [raw, end] = rawField(bytes, start, afterTag, wt);
      unknown.push(Buffer.from(raw));
      i = end;
    }
  }

  const missing = [];
  if (!seen.has(F_SEQ_ID)) missing.push('SeqID');
  if (!seen.has(F_LOG_ID)) missing.push('LogID');
  if (!seen.has(F_SERVICE)) missing.push('service');
  if (!seen.has(F_METHOD)) missing.push('method');

  return {
    SeqID: seq === undefined ? 0 : seq,
    LogID: log === undefined ? 0 : log,
    service: service === undefined ? 0 : service,
    method: method === undefined ? 0 : method,
    headers,
    payload_encoding: payloadEncoding,
    payload_type: payloadType,
    payload,
    LogIDNew: logIdNew,
    _unknown: unknown,
    _missingRequired: missing,
  };
}

// ------------------------------------------------------------------ 取值助手
/**
 * 按头名取值 —— 语义照抄 SDK `client.py:38 _get_by_key`：
 * **返回第一个命中**，一个都没有时**抛**（Python 侧 `HeaderNotFoundException`，
 * 抛出后被 `_handle_message` 的 `except` 吃掉 ⇒ **不回 ACK、连接不断**）。
 * 不要"顺手"改成返回空串：那会把"缺头"从"丢帧"变成"按空值处理"，行为不同。
 */
export function getHeader(frame, key) {
  const headers = frame && Array.isArray(frame.headers) ? frame.headers : [];
  for (const h of headers) {
    if (h.key === key) return h.value;
  }
  throw new FeishuWsHeaderError(key);
}

/** 缺头（对应 Python `HeaderNotFoundException`） */
export class FeishuWsHeaderError extends Error {
  constructor(key) {
    super(`HeaderNotFoundException: ${key}`);
    this.name = 'FeishuWsHeaderError';
    this.key = key;
  }
}

// ============================================================================================
// WS 客户端 —— 等价 `lark_oapi.ws.client.Client`（含 feishu.py `_CardAwareClient` 的卡片分派覆写）
//
// 契约出处（逐行读出来的，不是查文档）：
//   - 发现：`POST {domain}/callback/ws/endpoint`，头 `{locale: zh, User-Agent: oapi-sdk-python/v<ver>}`，
//     体 `{"AppID":…,"AppSecret":…}` ⇒ `{"code":0,"data":{"URL":…,"ClientConfig":{…}}}`（client.py:232-289）
//   - 握手：`websockets.connect(conn_url, proxy=None)` —— **不带自定义头**；`device_id`/`service_id`
//     从 URL query 取（client.py:198-208）
//   - 心跳：连上后**立刻**发第一帧 `CONTROL/ping`（`service=int(service_id)`，SeqID=LogID=0），
//     之后每 `PingInterval` 秒一次（client.py:181-191）
//   - 控制帧：`type=ping` 忽略；`type=pong` 且 payload 非空 ⇒ 当 ClientConfig 更新连接参数（client.py:310-321）
//   - 数据帧：先按序取 message_id/trace_id/sum/seq/type 五个头（**缺一个就丢帧且不回 ACK**，因为
//     `_get_by_key` 抛 HeaderNotFoundException 被 `_handle_message` 吃掉）；`sum>1` 走 5s 合包；
//     `type=event` ⇒ 同步跑 handler、按耗时写 `biz_rt` 头、回 ACK；`type=card` ⇒ **SDK 直接 return**，
//     但产品子类把它接进 cardHandler 并**先 ACK**（biz_rt="0"）；其余 type ⇒ 什么都不做（client.py:323-359、
//     feishu.py:1673-1713）
//   - ACK = **把收到的原帧回写**：追加 `biz_rt` 头、payload 换成 `{"code": 200}`（handler 返回非 None 时
//     多一个 `"data"` = base64(marshal(结果))；handler 抛异常则 `{"code": 500}` 且**不加** biz_rt 头）
//   - 重连：首次抖动 `random()*ReconnectNonce`；`ReconnectCount>=0` 时最多试 N 次、间隔
//     `ReconnectInterval`，否则一直试（client.py:361-408）
//   - `ClientException`（code 非 0/1/1000040343、无凭据）**不重连**，直接上抛（start() 里 client.py:167-168）
//
// 与 Python 的**已知差异**（登记，不掩盖）：
//   1. 失败握手的细分错误码拿不到：Python 从 `InvalidHandshake` 的响应头读
//      `handshake-status`/`handshake-msg`/`handshake-autherrcode`，据此分 514/403/1000040350；
//      Node 内建 WebSocket 的 error 事件不给任何响应头 ⇒ 只能抛通用错误。**产品可观测差异**
//      = feishu.py `_ws_run` 兜底 print 出来的那一行文案。
//   2. SDK 内部 logger 的格式（`_fmt_log` + `[conn_id=…]`）不复刻：那是 `logging` 输出，不在
//      stderr 的 `print` 对拍面上；可见行由 R2 的 glue 负责。
//   3. 发现请求的传输头（`Accept-Encoding`/`Accept`/`Connection`）由 `fetch`/`requests` 各自决定，
//      不逐字节对齐；被对齐的是方法、路径、`locale`、`User-Agent`、body 字节。
//   4. 追加能力 `close()`：Python SDK 没有干净的停止接口（feishu.py:1631 明说），产品侧不会调它，
//      只有量具用。
// ============================================================================================

/** 发现端点（`lark_oapi.ws.const.GEN_ENDPOINT_URI`） */
export const FS_WS_ENDPOINT_URI = '/callback/ws/endpoint';
/** 默认域名（`lark_oapi.core.const.FEISHU_DOMAIN`；SDK 的 ctor 参数，feishu.py 从不覆盖） */
export const FEISHU_DOMAIN = 'https://open.feishu.cn';
/** User-Agent：**刻意照抄** `oapi-sdk-python/v1.7.3`（`build_user_agent()` 实测值）。
 *  理由是这条请求是与第三方网关的协议交互，UA 是线上字节的一部分；升级 lark-oapi 后要复核。 */
export const FS_WS_USER_AGENT = 'oapi-sdk-python/v1.7.3';
/** 网关 code（`lark_oapi.ws.const`） */
export const FS_OK = 0;
export const FS_SYSTEM_BUSY = 1;
export const FS_INTERNAL_ERROR = 1000040343;
export const FS_NO_CREDENTIAL = 1000040344;
/** 发现失败分级（对应 SDK 的 ServerException / ClientException） */
export class FeishuWsServerError extends Error {
  constructor(code, msg) {
    super(`server error (code=${code}): ${msg}`);
    this.name = 'FeishuWsServerError';
    this.code = code;
    this.msg = msg;
  }
}
export class FeishuWsClientError extends Error {
  constructor(code, msg) {
    super(`client error (code=${code}): ${msg}`);
    this.name = 'FeishuWsClientError';
    this.code = code;
    this.msg = msg;
  }
}

/** Python `int(str)` 的近似（失败要抛，不能像 parseInt 那样静默给 NaN） */
function pyInt(raw, what) {
  const t = String(raw).trim();
  if (!/^[+-]?[0-9](?:_?[0-9])*$/.test(t)) {
    throw new FeishuWsCodecError(`invalid literal for int() with base 10: ${JSON.stringify(raw)}（${what}）`);
  }
  return Number(t.replace(/_/g, ''));
}

/** 照 `requests` 的 `json=` 口径：`json.dumps(obj)` 的默认分隔符 `", "`/`": "` + `ensure_ascii=True` */
function jsonBodyEnsureAscii(obj) {
  return pyJsonDumps(obj).replace(/[\u007f-\uffff]/g, (ch) => {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) {
      const s = cp - 0x10000;
      const hi = 0xd800 + (s >> 10);
      const lo = 0xdc00 + (s & 0x3ff);
      return `\\u${hi.toString(16).padStart(4, '0')}\\u${lo.toString(16).padStart(4, '0')}`;
    }
    return `\\u${cp.toString(16).padStart(4, '0')}`;
  });
}

/** `lark_oapi.core.cache.ExpiringCache`（ttl 判定 + 30s 清扫） */
class ExpiringCache {
  constructor(clearInterval = 30) {
    this._m = new Map();
    this._clearInterval = clearInterval;
    this._timer = null;
  }

  get(key) {
    const e = this._m.get(key);
    if (e === undefined) return null;
    if (e.expire < Date.now() / 1000) { this._m.delete(key); return null; }
    return e.value;
  }

  set(key, value, ttl) {
    this._m.set(key, { value, expire: Date.now() / 1000 + ttl });
    if (this._timer === null) {
      this._timer = setTimeout(() => { this._timer = null; this._clear(); }, this._clearInterval * 1000);
      if (typeof this._timer.unref === 'function') this._timer.unref();
    }
  }

  _clear() {
    const now = Date.now() / 1000;
    for (const [k, v] of this._m) if (v.expire < now) this._m.delete(k);
  }

  stop() {
    if (this._timer !== null) clearTimeout(this._timer);
    this._timer = null;
  }
}

export class FeishuWsClient {
  /**
   * @param {object} options
   *   appId / appSecret      应用凭据（缺一 ⇒ 发现阶段直接抛 NO_CREDENTIAL）
   *   domain                 发现域名（SDK ctor 参数，默认 FEISHU_DOMAIN；产品侧不覆盖）
   *   eventHandler(payload)  `type=event` 的 handler，入参是**合包后的 payload 字节**；
   *                          返回值非 null 时会被 marshal+base64 塞进 ACK 的 data
   *   cardHandler(payload)   `type=card` 的 handler，入参同上；**不等待**（照 feishu.py 的线程语义），
   *                          返回值丢弃
   *   autoReconnect          默认 true（照 SDK）
   *   log(level, msg)        诊断日志（默认丢弃；SDK 的 logging 格式不复刻）
   *   fetch / random / userAgent / pingTimer  量具用注入点
   */
  constructor(options = {}) {
    this.appId = options.appId === undefined ? '' : String(options.appId);
    this.appSecret = options.appSecret === undefined ? '' : String(options.appSecret);
    this.domain = options.domain === undefined ? FEISHU_DOMAIN : options.domain;
    this.eventHandler = options.eventHandler || null;
    this.cardHandler = options.cardHandler || null;
    this.autoReconnect = options.autoReconnect !== false;
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this._fetch = options.fetch || ((...a) => globalThis.fetch(...a));
    this._random = options.random || Math.random;
    this._userAgent = options.userAgent === undefined ? FS_WS_USER_AGENT : options.userAgent;

    // 本地缺省值 —— 每次握手都会被网关的 ClientConfig 覆盖（client.py:145-152）
    this._reconnectNonce = 30;
    this._reconnectCount = -1;
    this._reconnectInterval = 120;
    this._pingInterval = 120;

    this._cache = new ExpiringCache(30);
    this._conn = null;
    this._connUrl = '';
    this._connId = '';
    this._serviceId = '';
    this._queue = [];
    this._waiters = [];
    this._closed = false;
    this._pingStopped = false;
    this._finish = null;
    this._donePromise = null;
    /** 量具可观测面：连接次数 / 收帧数 / 发帧数 */
    this.stats = { connects: 0, framesIn: 0, framesOut: 0, reconnects: 0 };
  }

  /** 等价 SDK `start()`：连接（失败按 ClientException 与否分流），继而心跳 + 收帧直到 close() */
  async start() {
    try {
      await this._connect();
    } catch (e) {
      if (e instanceof FeishuWsClientError) {
        this.log('error', `connect failed, err: ${e.message}`);
        throw e; // ClientException：不重连，直接上抛（client.py:167-168）
      }
      this.log('error', `connect failed, err: ${e && e.message ? e.message : e}`);
      await this._disconnect();
      if (this.autoReconnect) await this._reconnect();
      else throw e;
    }
    void this._pingLoop();
    this._donePromise = new Promise((resolve) => { this._finish = resolve; });
    return this._donePromise;
  }

  /** 量具用：Python SDK 没有干净的停止接口（feishu.py:1631 已说明） */
  async close() {
    this._closed = true;
    this._pingStopped = true;
    this._cache.stop();
    await this._disconnect();
    this._wakeAll();
    if (this._finish !== null) { this._finish(); this._finish = null; }
  }

  // ------------------------------------------------------------------ 心跳 / 收帧
  async _pingLoop() {
    while (!this._pingStopped && !this._closed) {
      try {
        if (this._conn !== null) {
          await this._writeMessage(encodeFrame({
            SeqID: 0, LogID: 0, service: pyInt(this._serviceId, 'service_id'),
            method: FRAME_TYPE_CONTROL, headers: [{ key: HEADER_TYPE, value: MESSAGE_TYPE_PING }],
            payload: null,
          }));
          this.log('debug', 'ping success');
        }
      } catch (e) {
        this.log('warn', `ping failed, err: ${e && e.message ? e.message : e}`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => {
        const t = setTimeout(r, this._pingInterval * 1000);
        if (typeof t.unref === 'function') t.unref();
      });
    }
  }

  _wakeAll() {
    const ws = this._waiters;
    this._waiters = [];
    for (const w of ws) w.resolve(null);
  }

  _pushMessage(buf) {
    if (buf === null) { this._wakeAll(); return; }
    const w = this._waiters.shift();
    if (w !== undefined) w.resolve(buf);
    else this._queue.push(buf);
  }

  _nextMessage() {
    if (this._queue.length > 0) return Promise.resolve(this._queue.shift());
    return new Promise((resolve) => { this._waiters.push({ resolve }); });
  }

  async _receiveMessageLoop() {
    try {
      for (;;) {
        if (this._conn === null) throw new Error('connection is closed');
        // eslint-disable-next-line no-await-in-loop
        const msg = await this._nextMessage();
        if (msg === null) throw new Error('connection is closed');
        this.stats.framesIn += 1;
        void this._handleMessage(msg); // 照 SDK：create_task，不 await
      }
    } catch (e) {
      if (this._closed) return;
      this.log('error', `receive message loop exit, err: ${e && e.message ? e.message : e}`);
      await this._disconnect();
      if (this.autoReconnect && !this._closed) { await this._reconnect(); return; }
      // 照 SDK：收帧循环是 create_task 出去的，异常只进任务日志、不回到 start()（auto_reconnect=False
      // 时 Python 是 "Task exception was never retrieved"）⇒ 这里只留痕，**不许**上抛成未处理拒绝。
      if (!this._closed) this.log('error', `receive loop 终止：${e && e.message ? e.message : e}`);
    }
  }

  // ------------------------------------------------------------------ 帧分发
  async _handleMessage(raw) {
    try {
      const frame = decodeFrame(raw);
      if (frame.method === FRAME_TYPE_CONTROL) await this._handleControlFrame(frame);
      else if (frame.method === FRAME_TYPE_DATA) await this._handleDataFrame(frame);
      else throw new FeishuWsCodecError(`unknown FrameType ${frame.method}`);
    } catch (e) {
      this.log('error', `handle message failed, err: ${e && e.message ? e.message : e}`);
    }
  }

  async _handleControlFrame(frame) {
    const type = getHeader(frame, HEADER_TYPE);
    if (type === MESSAGE_TYPE_PING) return;
    if (type === MESSAGE_TYPE_PONG) {
      if (!frame.payload || frame.payload.length === 0) return; // `if not frame.payload`
      this._configure(JSON.parse(frame.payload.toString('utf8')));
      return;
    }
    throw new FeishuWsCodecError(`unknown MessageType ${type}`); // Python `MessageType(type_)` 抛 ValueError
  }

  /**
   * `type=event` 的 ACK 路径。
   *
   * ⚠️ **返回值到底进不进 `data`，是"分派层"的语义，不是本客户端的自由**（2026-10-15 与真 SDK
   * 逐字节对拍实测，见 `tools/parity/probe/ws_oracle_diff.py`）：
   *   `lark_oapi/event/dispatcher_handler.py:159-178` 只对**注册进 `_callback_processor_map`**
   *   的类型（即 `register_p2_card_action_trigger` → `p2.card.action.trigger`）把
   *   `processor.do(data)` 的返回值 **return** 出去；走 `_processorMap` 的普通事件（如
   *   `im.message.receive_v1`）调用完 `processor.do(data)` **丢弃返回值** ⇒
   *   `_do_without_validation` 返回 None ⇒ ACK 只有 `{"code": 200}`、**没有 `data`**。
   *   没注册的类型还会抛 `EventException("processor not found")` ⇒ ACK `{"code": 500}`。
   * ⇒ R2 的 glue（`feishu_inbound.js`）必须照这个分派：普通消息事件 **return null**，
   *   `card.action.trigger` 才返回 toast 对象，未注册类型要**抛**。
   *   本客户端只负责"handler 返回非 null 就塞进 data"这一层（等价 client.py:337-359）。
   */
  async _handleDataFrame(frame) {
    // 头部取值顺序照 client.py:324-330（缺任何一个 ⇒ 抛 ⇒ 丢帧且不回 ACK）
    const msgId = getHeader(frame, HEADER_MESSAGE_ID);
    const traceId = getHeader(frame, HEADER_TRACE_ID);
    const sum = pyInt(getHeader(frame, HEADER_SUM), 'sum');
    const seq = pyInt(getHeader(frame, HEADER_SEQ), 'seq');
    const type = getHeader(frame, HEADER_TYPE);

    if (type === MESSAGE_TYPE_CARD) { await this._handleCardFrame(frame); return; }
    if (type !== MESSAGE_TYPE_EVENT) return; // 其余 type：什么都不做（client.py:344-345）

    let pl = frame.payload;
    if (sum > 1) {
      pl = this._combine(msgId, sum, seq, pl);
      if (pl === null) return;
    }
    this.log('debug', `receive message, message_type: ${type}, message_id: ${msgId}, `
      + `trace_id: ${traceId}, payload: ${pl === null || pl === undefined ? '' : pl.toString('utf8')}`);

    let resp = { code: 200 };
    try {
      const start = Date.now();
      const result = this.eventHandler === null ? null : await this.eventHandler(pl);
      const end = Date.now();
      frame.headers.push({ key: HEADER_BIZ_RT, value: String(end - start) });
      if (result !== null && result !== undefined) {
        resp.data = Buffer.from(pyJsonDumps(result), 'utf8').toString('base64');
      }
    } catch (e) {
      this.log('error', `handle message failed, message_type: ${type}, message_id: ${msgId}, `
        + `trace_id: ${traceId}, err: ${e && e.message ? e.message : e}`);
      resp = { code: 500 };
    }
    frame.payload = Buffer.from(pyJsonDumps(resp), 'utf8');
    await this._writeMessage(encodeFrame(frame));
  }

  /** 产品覆写（feishu.py:1685-1702）：卡片帧**先 ACK**（biz_rt="0"），handler 另起一路不等它 */
  async _handleCardFrame(frame) {
    const msgId = getHeader(frame, HEADER_MESSAGE_ID);
    const sum = pyInt(getHeader(frame, HEADER_SUM), 'sum');
    const seq = pyInt(getHeader(frame, HEADER_SEQ), 'seq');
    let pl = frame.payload;
    if (sum > 1) {
      pl = this._combine(msgId, sum, seq, pl);
      if (pl === null) return;
    }
    if (this.cardHandler !== null) {
      // 照 `threading.Thread(...).start()`：不 await；handler 自己吞异常（R2 的 glue 负责那行 print）
      Promise.resolve()
        .then(() => this.cardHandler(pl))
        .catch((e) => this.log('error', `card handler error: ${e && e.message ? e.message : e}`));
    }
    frame.headers.push({ key: HEADER_BIZ_RT, value: '0' });
    frame.payload = Buffer.from(pyJsonDumps({ code: 200 }), 'utf8');
    await this._writeMessage(encodeFrame(frame));
  }

  /** 照 `Client._combine`（client.py:430-446）：5s 缓存、缺片返回 None、负下标按 Python 语义回绕 */
  _combine(msgId, sum, seq, bs) {
    const val = this._cache.get(msgId);
    if (val === null) {
      const buf = new Array(sum).fill(null);
      buf[this._seqIndex(seq, sum)] = bs;
      this._cache.set(msgId, buf, 5);
      return null;
    }
    val[this._seqIndex(seq, sum)] = bs;
    const parts = [];
    for (const v of val) {
      if (!v || v.length === 0) { this._cache.set(msgId, val, 5); return null; }
      parts.push(v);
    }
    return Buffer.concat(parts);
  }

  _seqIndex(seq, sum) {
    const idx = seq < 0 ? sum + seq : seq;
    if (idx < 0 || idx >= sum) throw new FeishuWsCodecError(`list index out of range（seq=${seq} sum=${sum}）`);
    return idx;
  }

  _configure(conf) {
    const pick = (v) => (v === undefined ? null : v);
    this._reconnectCount = pick(conf.ReconnectCount);
    this._reconnectInterval = pick(conf.ReconnectInterval);
    this._reconnectNonce = pick(conf.ReconnectNonce);
    this._pingInterval = pick(conf.PingInterval);
  }

  // ------------------------------------------------------------------ 连接
  async _connect() {
    if (this._conn !== null) return;
    const connUrl = await this._getConnUrl();
    const u = new URL(connUrl);
    // Python `parse_qs`（keep_blank_values=False）：空串等于没有 ⇒ KeyError
    const pick = (name) => {
      const v = u.searchParams.get(name);
      if (v === null || v === '') throw new Error(`missing query param ${name}`);
      return v;
    };
    const connId = pick('device_id');
    const serviceId = pick('service_id');

    const ws = new WebSocket(connUrl);
    ws.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      // 差异 1（见文件头）：Node 的 error 事件不带握手响应头 ⇒ 细分错误码拿不到
      ws.addEventListener('error', () => reject(new Error('websocket connect failed')), { once: true });
    });
    this._conn = ws;
    this._connUrl = connUrl;
    this._connId = connId;
    this._serviceId = serviceId;
    this.stats.connects += 1;
    ws.addEventListener('message', (ev) => {
      const d = ev.data;
      this._pushMessage(Buffer.isBuffer(d) ? d : Buffer.from(d));
    });
    ws.addEventListener('close', () => { this._pushMessage(null); });
    ws.addEventListener('error', (ev) => this.log('error', `websocket error: ${ev && ev.message}`));
    this.log('info', `connected to ${connUrl}`);
    void this._receiveMessageLoop();
  }

  async _disconnect() {
    const cur = this._conn;
    this._conn = null;
    this._connUrl = '';
    this._connId = '';
    this._serviceId = '';
    this._queue = [];
    this._wakeAll();
    if (cur !== null) {
      try { cur.close(); } catch { /* 已关 */ }
      this.log('info', 'disconnected');
    }
  }

  async _writeMessage(data) {
    if (this._conn === null) throw new Error('connection is closed, write message failed');
    this._conn.send(data);
    this.stats.framesOut += 1;
  }

  async _reconnect() {
    this.stats.reconnects += 1;
    if (this._reconnectNonce !== null && this._reconnectNonce > 0) {
      const nonce = this._random() * this._reconnectNonce;
      await new Promise((r) => setTimeout(r, nonce * 1000));
    }
    if (this._reconnectCount !== null && this._reconnectCount >= 0) {
      for (let i = 0; i < this._reconnectCount; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        if (await this._tryConnect(i)) return;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, this._reconnectInterval * 1000));
      }
      throw new FeishuWsServerError(0, `unable to connect to the server after trying ${this._reconnectCount} times`);
    }
    for (let i = 0; ; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (await this._tryConnect(i)) return;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, this._reconnectInterval * 1000));
    }
  }

  async _tryConnect(cnt) {
    this.log('info', `trying to reconnect for the ${cnt + 1} time`);
    try {
      await this._connect();
      return true;
    } catch (e) {
      if (e instanceof FeishuWsClientError) throw e; // 照 SDK：ClientException 直接上抛
      this.log('error', `connect failed, err: ${e && e.message ? e.message : e}`);
      return false;
    }
  }

  /** 发现端点（client.py:232-289）；`domain` 是 SDK 自带的 ctor 参数，产品侧保持默认 */
  async _getConnUrl() {
    if (this.appId === '' || this.appSecret === '') {
      throw new FeishuWsClientError(
        FS_NO_CREDENTIAL,
        'app_id is required and either app_secret or client_assertion_provider is required');
    }
    const url = this.domain + FS_WS_ENDPOINT_URI;
    const res = await this._fetch(url, {
      method: 'POST',
      headers: {
        locale: 'zh',
        'User-Agent': this._userAgent,
        'Content-Type': 'application/json',
      },
      body: jsonBodyEnsureAscii({ AppID: this.appId, AppSecret: this.appSecret }),
    });
    const text = await res.text();
    if (res.status !== 200) {
      let msg = 'system busy';
      try { const p = JSON.parse(text); if (p && p.msg) msg = p.msg; } catch { /* 保持缺省 */ }
      throw new FeishuWsServerError(res.status, msg);
    }
    const resp = JSON.parse(text);
    if (resp.code === FS_OK) { /* ok */ } else if (resp.code === FS_SYSTEM_BUSY) {
      throw new FeishuWsServerError(resp.code, 'system busy');
    } else if (resp.code === FS_INTERNAL_ERROR) {
      throw new FeishuWsServerError(resp.code, resp.msg);
    } else {
      throw new FeishuWsClientError(resp.code, resp.msg);
    }
    const data = resp.data === undefined || resp.data === null ? {} : resp.data;
    if (data.ClientConfig !== undefined && data.ClientConfig !== null) this._configure(data.ClientConfig);
    return data.URL;
  }

  /** 当前连接参数（量具断言用） */
  config() {
    return {
      reconnectCount: this._reconnectCount, reconnectInterval: this._reconnectInterval,
      reconnectNonce: this._reconnectNonce, pingInterval: this._pingInterval,
      connId: this._connId, serviceId: this._serviceId, connUrl: this._connUrl,
    };
  }
}
