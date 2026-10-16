/**
 * `base64.b64decode` 的 Node 对应物（M5-4 附件上传端点用）。
 *
 * ## 为什么不能直接用 `Buffer.from(s, 'base64')`
 * Node 的解码器**永不报错**：非法字符丢弃、长度随便、`=` 随便放，坏输入静默产出垃圾字节。
 * Python 的 `base64.b64decode`（`binascii.a2b_base64`，`strict_mode=False`）在坏输入上
 * **抛 `binascii.Error`（ValueError 子类）**，`_api_board_upload_media` 据此回
 * 400 `{"error":"bad base64"}`。若 Node 照 Node 的口径走，坏 base64 会被写成一个垃圾附件
 * 文件并回 200 —— 用户看到「上传成功」但内容损坏（**比报错更难查**）。
 *
 * ## 口径（逐条实测自 CPython 3.12 的 `binascii.a2b_base64`）
 * 1. **非 ASCII 的 str**：Python 先 `encode('ascii')` ⇒ `ValueError`。
 * 2. 过滤：删掉所有不在 `A-Za-z0-9+/=` 的字符（空白、`!`、中文…），保留 `=`。
 * 3. 主体解码：每 4 个数据字符出 3 字节；遇 `=` 的分支是**反直觉的那个**：
 *    · `=` 前已攒 **3** 个数据字符 ⇒ 出 2 字节并**立即结束**（**其后的输入整段被忽略**：
 *      `'aGVsbG8=extra'` → `b'hello'`）；
 *    · `=` 前已攒 **2** 个数据字符、且**紧跟着还有一个 `=`** ⇒ 出 1 字节并立即结束
 *      （`'0x= ==0A'` → 1 字节）；只有**一个** `=` 时该 `=` 被**跳过**、继续攒
 *      （`'AA=AA'` → 3 字节 = `'AAAA'`）；
 *    · 其余（0 或 1 个数据字符）：跳过。
 * 4. 收尾校验（未触发上面两个「立即结束」时）：余数 r = 数据字符数 % 4
 *    · r = 0 ⇒ 成功；r = 1 ⇒ **错误**（Python 文案是「…cannot be 1 more than a multiple of 4」）；
 *    · r = 2 ⇒ 要求结尾**至少两个** `=`；r = 3 ⇒ 要求结尾**至少一个** `=`，否则
 *      「Incorrect padding」。判据只看**结尾**的 `=`，中间位置的 `=` 不作数。
 *
 * ## 保真度证据
 * 与 `base64.b64decode` 做了 **760,000 条随机串**的差分（三种偏置字母表：混合/`=` 密集/
 * 纯 `=/`；长度 0..20，含非 ASCII 与空白），**零不一致**；外加 27 条人工语料（含本文件
 * 注释里的每一个例子）。见 `backend/test/pybase64.test.mjs`（表来自 Python 实跑）。
 *
 * ## 与 Python 的形态差异（已登记）
 * · 异常类名 `PyB64Error` 对应 `binascii.Error`；**异常文案不逐字复刻**（调用方只判类型，
 *   正文由端点写死 `bad base64`）。
 * · Python 的 `str()` 对**容器**给 repr（`{'a': 1}`）；Node 侧走全仓已登记的容器口径
 *   （见 `doc_ai/spec/dsh_plugin/dsh插件形态.md` §23.7）——上传端点的 `data` 只会是字符串，
 *   该差异只在「有人把 `data` 传成对象」时可见，两侧同为拒绝/同为乱码的概率不保证。
 */

/** `binascii.Error` 的对应物（ValueError 子类）；调用方据此回 400 `bad base64`。 */
export class PyB64Error extends Error {
  constructor(message) {
    super(message);
    this.name = 'PyB64Error';
  }
}

/** 标准 base64 字母表（`A-Za-z0-9+/`，`=` 单独处理） */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 字符 → 6 bit 值（查表；非字母表字符不在表内） */
const VAL = new Map();
for (let i = 0; i < ALPHABET.length; i += 1) VAL.set(ALPHABET[i], i);

/** 一位字符是否是字母表成员（含 `=` 由调用方另判） */
function inAlphabet(ch) {
  return VAL.has(ch);
}

/**
 * 解 base64（Python `base64.b64decode(text)` 的非严格口径）。
 *
 * @param {string} text 输入串（**必须已是 str**；调用方按 Python `str(x or "")` 归一）
 * @returns {Buffer} 解出的字节
 * @throws {PyB64Error} 命中 Python 会抛 `ValueError`/`binascii.Error` 的任一情形
 */
export function b64decode(text) {
  const s = String(text);
  // ① 非 ASCII：Python `_bytes_from_decode_data` 走 s.encode('ascii') ⇒ ValueError
  //    （按码位判，不接受任何 > 0x7f 的字符）
  for (const ch of s) {
    if (ch.codePointAt(0) > 0x7f) {
      throw new PyB64Error('string argument should contain only ASCII characters');
    }
  }
  // ② 过滤非字母表字符（保留 '='）
  const kept = [];
  for (const ch of s) {
    if (ch === '=' || inAlphabet(ch)) kept.push(ch);
  }
  const out = [];
  let quad = [];
  const flush = (n) => {
    // n = 本 quad 的有效数据字符数（4→3 字节 / 3→2 字节 / 2→1 字节）
    const v = [VAL.get(quad[0]), VAL.get(quad[1]), quad.length > 2 ? VAL.get(quad[2]) : 0,
      quad.length > 3 ? VAL.get(quad[3]) : 0];
    out.push((v[0] << 2) | (v[1] >> 4));
    if (n >= 3) out.push(((v[1] & 0x0f) << 4) | (v[2] >> 2));
    if (n >= 4) out.push(((v[2] & 0x03) << 6) | v[3]);
  };
  for (let i = 0; i < kept.length; i += 1) {
    const ch = kept[i];
    if (ch === '=') {
      if (quad.length === 3) { flush(3); return Buffer.from(out); }      // 出 2 字节，其后忽略
      if (quad.length === 2 && kept[i + 1] === '=') {                     // 双 '=' ⇒ 出 1 字节
        flush(2);
        return Buffer.from(out);
      }
      continue;                                                           // 其余位置的 '=' 跳过
    }
    quad.push(ch);
    if (quad.length === 4) { flush(4); quad = []; }
  }
  const r = quad.length;
  if (r === 0) return Buffer.from(out);
  if (r === 1) {
    throw new PyB64Error('Invalid base64-encoded string: number of data characters cannot be 1'
      + ' more than a multiple of 4');
  }
  let trail = 0;
  for (let i = kept.length - 1; i >= 0 && kept[i] === '='; i -= 1) trail += 1;
  if (trail < 4 - r) throw new PyB64Error('Incorrect padding');
  flush(r);
  return Buffer.from(out);
}
