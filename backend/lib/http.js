/**
 * HTTP 响应工具（Node 后端的 `server.py:_respond()` / `_redirect()` 对应物）。
 *
 * 为什么统一走这里：Python 侧所有响应都由 `_respond()` 出，因此**每个**响应都带
 * Content-Type、Content-Length、Cache-Control: no-store（前端与 e2e 脚本已按此预期写）。
 * Node 侧若各端点自己 writeHead，这三条一定会漏 —— 对拍时就是成片的假差异。
 *
 * JSON 正文自 2026-10-11（M1 评审 P3-1）起用 `pyJsonDumps` 序列化：与 Python
 * `json.dumps(obj, ensure_ascii=False)` **逐字节相同**（含 `", "` / `": "` 分隔符与中文原样）。
 * 为什么值得：整套改造的哲学是字节级对齐（连数据层的 JSON 列都为此刻了 `pyjson.js`），
 * 而 M3 起要一次补几十个读端点——口径现在就定死，省得铺开后再回头改。
 * `pyJsonDumps` 对非普通 JSON 值（undefined/函数/Date/Map…）抛 TypeError：那种值本就是
 * 编码错误，这里兜底退回 `JSON.stringify` 并留一行日志，绝不让一个字段把响应打成 500。
 */
import { readFile } from 'node:fs/promises';

import { pyJsonDumps } from './pyjson.js';

/**
 * Python `int(text)` 的严格版（只认「两侧 ASCII 空白 + 可选正负号 + ASCII 数字（可带下划线分隔）」）。
 * 解析失败**抛错**——这正是 `_read_json` 里 `int(self.headers.get("Content-Length", 0) or 0)`
 * 在收到非数字长度时的行为（ValueError 逃出 do_POST ⇒ 该连接无响应即断）。
 * Unicode 数字/空白等边角与 `query.js:pyIntStrict` 同一处理口径（前端不产生，见 M3 记录）。
 */
function pyIntStrict(text) {
  const body = String(text).replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, '');
  if (!/^[+-]?\d(?:_?\d)*$/.test(body)) {
    throw new Error(`invalid literal for int() with base 10: ${JSON.stringify(String(text))}`);
  }
  return Number(body.replaceAll('_', ''));
}

/**
 * 读请求体（Python `server.py:_read_json`(5256) 的对应物）——**每个写端点都必须走它**。
 *
 * 逐条对齐 Python（任一条不同就是 bug，实例级对拍会照出来）：
 *  1. `Content-Length` 缺失或 ≤0 ⇒ 空对象，**不读流**；
 *  2. 长度头存在但不是十进制整数 ⇒ `int()` 抛错（调用方不补响应，连接直接断——Python 同形）；
 *  3. 读满 `length` 字节后 `JSON.parse`：解析失败（含 UTF-8 解码失败）⇒ 空对象；
 *  4. 合法 JSON 但**不是普通对象**（数组/字符串/数字/布尔/null）⇒ 空对象。Python 注释写明理由：
 *     各接口对 `data.get(...)` 无类型防护，非 dict 会抛 AttributeError 断连；
 *  5. 客户端提前断开导致字节不足 ⇒ 按已读内容解析（Python `rfile.read(n)` 返回短读，同形）。
 *
 * **必须 await**：不 await 时解析异常会变成 unhandledRejection 把整个后端带走（M3 的教训：
 * Node 侧没有 socketserver 那种「只断一条连接」的天然兜底，这是 `dispatchSafely` 存在的理由）。
 *
 * 关于「读体的时机」：Python 在 `do_POST` 里**固定一处**读体（1027→1048），顺序是
 * 鉴权 → 强制改密闸 → logout/change_password（**不读体**）→ 读体 → 各端点。
 * Node 侧因此**不许在 server.js 里无条件预读**：由 `ctx.readBody()` 记忆化，各 handler
 * 在 Python 读体的同一位置调用；未命中路径由 server.js 在回 404 之前补读一次（同 Python）。
 *
 * @param {object} req node:http IncomingMessage
 * @returns {Promise<object>} 普通对象（解析不出就是空对象）
 */
export function readJsonBody(req) {
  const header = req?.headers?.['content-length'];
  const text = header === undefined || header === null || header === '' ? '0' : String(header);
  let length;
  try {
    length = pyIntStrict(text);               // 非数字 ⇒ 抛（见 ②）
  } catch (error) {
    // **同步抛改成 rejected promise**：契约是「本函数永远返回 promise」，这样
    // `ctx.readBody()` 的记忆化对失败路径也成立（同步抛会让它每次调用都重新抛、
    // 且 `p1 === p2` 这条不变量失效）。
    return Promise.reject(error);
  }
  if (!(length > 0)) return Promise.resolve({});

  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      // UTF-8 解码必须**严格**：Python `rfile.read(n).decode("utf-8")` 遇非法字节抛
      // UnicodeDecodeError ⇒ 被 `except (ValueError, UnicodeDecodeError)` 吃成空对象。
      // Node 的 `buf.toString('utf8')` 会把非法字节**替换成 U+FFFD 而不报错**——那样
      // `{"a":"<非法字节>"}` 会解析成功并返回带替换符的对象，与 Python 的「空对象」分叉。
      let text2;
      try {
        text2 = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        resolve({});
        return;
      }
      let value = null;
      try {
        value = JSON.parse(text2);
      } catch {
        value = null;
      }
      // ④ 非普通对象（含 null/数组）一律空对象；`typeof null === 'object'` 要显式挡掉
      const plain = value !== null && typeof value === 'object' && !Array.isArray(value);
      resolve(plain ? value : {});
    };
    req.on('data', (chunk) => {
      if (settled) return;
      let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      // **只取前 `length` 字节**（= Python `rfile.read(length)`）：多出来的属于下一个请求
      // （pipelines/keep-alive），不能混进本次正文。单测「只读 Content-Length 字节」钉住它。
      const left = length - received;
      if (buf.length > left) buf = buf.subarray(0, left);
      chunks.push(buf);
      received += buf.length;
      if (received >= length) finish();
    });
    req.on('end', finish);
    req.on('close', finish);                  // 提前断开：按已读内容解析（见 ⑤）
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/** JSON 正文序列化：优先与 Python 逐字节一致，编码不了才退回 JS 原生（带日志） */
function jsonBody(value) {
  try {
    return pyJsonDumps(value);
  } catch (error) {
    console.error(`touchstone-node: JSON 正文无法按 Python 口径序列化（退回 JSON.stringify）: `
      + `${(error && error.message) || error}`);
    return JSON.stringify(value);
  }
}

/**
 * 发一个完整响应（与 Python `_respond` 逐项等价）。
 * @param {object} res      node:http 的 ServerResponse（测试里用同形状的桩）
 * @param {number} status   状态码
 * @param {Buffer|string} body 正文（字符串按 UTF-8 计长度）
 * @param {string} contentType
 * @param {object} [extraHeaders]
 */
export function respond(res, status, body, contentType, extraHeaders) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const headers = {
    'Content-Type': contentType,
    'Content-Length': String(buf.length),
    'Cache-Control': 'no-store',
  };
  for (const [name, value] of Object.entries(extraHeaders || {})) headers[name] = value;
  res.writeHead(status, headers);
  try {
    res.end(buf);
  } catch {
    // 客户端提前断开（刷新/关页）属常态，与 Python 侧吞 BrokenPipe 同口径
  }
}

/** JSON 响应（Content-Type 固定 application/json; charset=utf-8，与 Python 侧同；正文为 Python 口径） */
export function respondJson(res, status, value, extraHeaders) {
  respond(res, status, jsonBody(value), 'application/json; charset=utf-8', extraHeaders);
}

/**
 * 错误响应 —— **紧凑** JSON：`{"error":"..."}`（冒号后**没有**空格）。
 *
 * 为什么不能直接用 `respondJson`：Python 侧的错误体全部是**硬编码字节串**
 * （`b'{"error":"not found"}'`、`b'{"error":"task not found"}'`…），走的是字面量而不是
 * `json.dumps`；而 `json.dumps` 的缺省分隔符是 `(', ', ': ')` ⇒ `{"error": "..."}` 多一个空格。
 * 两者在同一份源码里并存，所以 Node 侧必须分两个函数：**错误体紧凑、数据体带空格**。
 * 这条系统性差异由 M3 的任务族实现者实测抓出（15 处全中），否则整族错误响应都会差 1 字节。
 */
export function respondError(res, status, message, extraHeaders) {
  // message 仍走 pyJsonDumps（字符串转义与 Python 逐字节一致），外层括号与冒号手工拼
  respond(res, status, `{"error":${jsonBody(String(message))}}`,
    'application/json; charset=utf-8', extraHeaders);
}

/**
 * 错误响应 —— **带空格**的 JSON：`{"error": "..."}`。
 *
 * 为什么错误体要有两个函数：Python 侧的错误正文**并存两种形态，取决于写点**（M3 项目族
 * 实现者逐字节实测确认）：
 *   - 硬编码字节串（`b'{"error":"not found"}'`，112 处）⇒ 紧凑，用 `respondError`；
 *   - `json.dumps({"error": ...})`（49 处，如 `_api_fs_browse`:2350、`_api_project_file`:2392/2402、
 *     `_send_project_file_raw`:2425/2430、项目名/归档/prefs 的 400…）⇒ 缺省分隔符带空格，用本函数。
 * 两类都「正确」，差别只在 Python 源码怎么写的；Node 侧必须按端点选对，否则每个点差 1 字节。
 * **判断方法**：去 `server.py` 看该处 `_respond` 的第二个参数是字节串字面量还是 `json.dumps(...)`。
 */
export function respondErrorSpaced(res, status, message, extraHeaders) {
  respondJson(res, status, { error: String(message) }, extraHeaders);
}

export { jsonBody };

/** 302 重定向（与 Python `_redirect` 一致：只有 Location 与 Content-Length: 0） */
export function sendRedirect(res, location) {
  res.writeHead(302, { Location: location, 'Content-Length': '0' });
  res.end();
}

/**
 * 发一个磁盘文件（Python `_send_file`）：读得到 → 200 + 调用方给的 Content-Type；
 * 读不到（`OSError`）→ **404 `not found` + text/plain**（注意不是 JSON、也不是空体）。
 *
 * 为什么单独抽出来：M3 有三个端点走它（看板卡片附件 `/board/media/<fid>`、
 * 会话图片、项目文件 raw），三处都要同一条「读不到就 404 文本」语义；Python 侧是
 * 同一个 `_send_file`，Node 侧分头写必然有人写成 JSON 404。
 */
export async function sendFile(res, filePath, contentType) {
  try {
    const data = await readFile(filePath);
    respond(res, 200, data, contentType);
  } catch {
    respond(res, 404, 'not found', 'text/plain; charset=utf-8');
  }
}

/**
 * Python `BaseHTTPRequestHandler.send_error(501)` 的**逐字节**复刻（Node 版没有 do_* 的
 * 方法走它：HEAD / PUT / OPTIONS / TRACE …）。
 *
 * 为什么要复刻而不是「回个 501 就完事」：Python 侧的 501 不是 JSON，而是 `send_error`
 * 生成的一张 HTML 错误页，Content-Type 是 `text/html;charset=utf-8`（**分号后没有空格**）。
 * 对拍比的是「状态码 + Content-Type + 正文哈希」，随手写成 `text/plain` + 一句
 * `unsupported method` 就会在方法语义上留下一类永久差异，逼着报告里挂一条白名单。
 * 复刻成本十几行，收益是这类差异彻底消失——**白名单只留真正无法消除的**。
 *
 * 两个细节照抄：HEAD 请求**不写正文**（Python `send_error` 里 `if self.command != 'HEAD'`），
 * 正文里的方法名是请求方法原文（如 `Unsupported method ('OPTIONS')`）。
 * 模板与文案取自真机实测（2026-10-11，Python 3.12.14，见 M3 记录）。
 */
export function respondUnsupportedMethod(res, method) {
  const body = `<!DOCTYPE HTML>
<html lang="en">
    <head>
        <meta charset="utf-8">
        <title>Error response</title>
    </head>
    <body>
        <h1>Error response</h1>
        <p>Error code: 501</p>
        <p>Message: Unsupported method ('${method}').</p>
        <p>Error code explanation: 501 - Server does not support this operation.</p>
    </body>
</html>
`;
  const buf = Buffer.from(String(method).toUpperCase() === 'HEAD' ? '' : body, 'utf8');
  res.writeHead(501, {
    'Content-Type': 'text/html;charset=utf-8',
    'Content-Length': String(buf.length),
    Connection: 'close',
  });
  try {
    res.end(buf);
  } catch {
    // 对端已断开：忽略（与其他响应写口同口径）
  }
}

/**
 * 打开一条 SSE 流并返回写口（Python 侧三条事件流的公共头部 + 写帧形态）。
 *
 * 头部逐条对齐 Python：`Content-Type: text/event-stream; charset=utf-8` +
 * `Cache-Control: no-store`；`X-Accel-Buffering: no` 只有看板那两条流带
 * （`server.py:5052/5124`），`/api/stream` 与任务会话流不带 —— 这里用参数区分，
 * 免得「顺手统一」把头部差异带进对拍。
 *
 * 写口三件事都**逐字节**照 Python：`event:` 行 + `data:` 行 + 空行；注释帧
 * （keepalive）只有一行 `: xxx` + 空行；`id:` 行仅任务会话流的 entries 帧用。
 * 写失败（客户端断开）一律吞掉并让调用方收尾 —— SSE 断连不是业务错误。
 */
export function openSse(res, { accelBuffering = false } = {}) {
  const headers = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (accelBuffering) headers['X-Accel-Buffering'] = 'no';
  res.writeHead(200, headers);
  res.flushHeaders?.();
  const writeRaw = (text) => {
    try {
      res.write(text);
      return true;
    } catch {
      return false;      // 对端已断开：调用方按循环退出处理
    }
  };
  return {
    /** 一条命名事件（`event: <name>\ndata: <json>\n\n`），payload 按 Python 口径序列化 */
    event(name, payload) {
      return writeRaw(`event: ${name}\ndata: ${jsonBody(payload)}\n\n`);
    },
    /** 带 id 的命名事件（任务会话流 entries 帧用：`id: <n>\n`） */
    eventWithId(name, id, payload) {
      return writeRaw(`id: ${id}\nevent: ${name}\ndata: ${jsonBody(payload)}\n\n`);
    },
    /** 裸 data 行（`/api/stream` 的旧形态：只有 data、没有 event 名） */
    data(payload) {
      return writeRaw(`data: ${jsonBody(payload)}\n\n`);
    },
    /** 注释帧（keepalive），如 `: keepalive` / `: hb` */
    comment(text) {
      return writeRaw(`: ${text}\n\n`);
    },
    /** 未编码的原始文本（`_stream_note` 那种整段预编码载荷用） */
    raw(text) {
      return writeRaw(text);
    },
    end() {
      try {
        res.end();
      } catch {
        // 已经断开：忽略
      }
    },
  };
}
