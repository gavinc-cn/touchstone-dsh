/**
 * 查询串与百分号编解码 —— `urllib.parse` 对应物（`server.py:do_GET` 的第一件事就是
 * `parse_qs(self.path.split("?", 1)[1])`，几乎每个读端点都吃它的结果）。
 *
 * **为什么必须自己写**：Node 的 `URLSearchParams` 与 Python `parse_qs` 有四处可观察差异，
 * 每一处都能让读端点行为漂移：
 *   ① `URLSearchParams` 保留空值（`?raw=` → `raw=""`），Python 缺省 **丢弃空值**
 *      （`keep_blank_values=False`）⇒ `parsed.get("raw", [""])[0]` 得到 `""` 而不是
 *      「没这个键」。端点里大量 `or "main"` 兜底就是靠这个区别生效的；
 *   ② Python 3.10 起 `;` **不再是分隔符**（`a=1;a=2` 是一个键 `a` 值 `1;a=2`）；
 *      `URLSearchParams` 同样不切 `;`，但 `parse_qsl(separator=...)` 的历史差异常被记错；
 *   ③ 解码口径：键与值都走 `unquote_plus`（`+`→空格 后再百分号解码），
 *      而**路径里的** `unquote(media_id)` 不处理 `+`；
 *   ④ 非法百分号转义（`%ZZ`）原样保留，非法 UTF-8 字节按 U+FFFD 替换（`errors='replace'`）。
 *
 * 期望值全部由本机 Python 3.12 实测产出（`backend/test/query.test.mjs` 里逐条钉住），
 * 不是按文档猜的。
 */

/**
 * 收集百分号转义字节的游标解码器：连续 `%XX` 攒成一个字节串一起做 UTF-8 解码
 * （多字节字符必须一起解），遇到非转义字符就先冲掉已攒字节。
 *
 * 与 Python `unquote` 的实现同构：Python 用 `_asciire` 把串切成「ASCII 段/非 ASCII 段」，
 * 对含 `%` 的段做 `unquote_to_bytes(...).decode(encoding, 'replace')`，其余原样拼接。
 * 区别仅在于 Python 是「整段一次解码」而这里按转义连续段解码——对 UTF-8 而言等价
 * （同一段里的字节本来就该一起解；跨段的多字节字符在 Python 里也会被拆成两次
 * `decode` 从而各自出替换符，这里同样）。
 */
function makeByteDecoder() {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let bytes = [];
  return {
    /** 攒一个转义字节 */
    push(byte) { bytes.push(byte); },
    /** 冲掉已攒字节，返回解码文本（无字节时返回空串） */
    flush() {
      if (bytes.length === 0) return '';
      const out = decoder.decode(Uint8Array.from(bytes));
      bytes = [];
      return out;
    },
  };
}

const HEX = /^[0-9A-Fa-f]{2}$/;

/**
 * `urllib.parse.unquote(s)`：`+` **不**转空格；非法转义原样；非法 UTF-8 → U+FFFD。
 */
export function unquote(value) {
  const s = String(value ?? '');
  if (!s.includes('%')) return s;      // 与 Python 的快路径一致（也避开无谓的构造）
  const dec = makeByteDecoder();
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '%' && i + 2 < s.length && HEX.test(s.slice(i + 1, i + 3))) {
      dec.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    out += dec.flush() + ch;           // 非转义字符：先冲字节段，再原样输出
  }
  return out + dec.flush();
}

/** `urllib.parse.unquote_plus(s)`：先 `+`→空格，再按 `unquote` 解（查询串键值口径） */
export function unquotePlus(value) {
  return unquote(String(value ?? '').replace(/\+/g, ' '));
}

/**
 * `urllib.parse.quote(s, safe='/')`：安全字符 = 字母数字 + `_.-~` + `safe`；
 * 其余按 UTF-8 逐字节 `%XX`（大写十六进制）。
 */
export function quote(value, safe = '/') {
  let out = '';
  for (const byte of Buffer.from(String(value ?? ''), 'utf8')) {
    const ch = String.fromCharCode(byte);
    const keep = (byte < 128
      && (/[A-Za-z0-9]/.test(ch) || ch === '_' || ch === '.' || ch === '-' || ch === '~'
        || safe.includes(ch)));
    out += keep ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/**
 * `urllib.parse.parse_qs(qs)`：`&` 分隔（**不切 `;`**）、空值丢弃、同名键聚成数组、
 * 键值都过 `unquote_plus`。
 *
 * 返回**无原型对象**（等价于 Python dict）：查询串里出现 `__proto__=x` 时不能污染
 * 原型链——Python 里它只是个普通键。
 */
export function parseQs(qs) {
  const out = Object.create(null);
  const s = String(qs ?? '');
  if (!s) return out;
  for (const pair of s.split('&')) {
    if (!pair) continue;                       // 'a=1&&b=2' 的空段
    const eq = pair.indexOf('=');
    const rawName = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? '' : pair.slice(eq + 1);
    // keep_blank_values=False：**空值整对丢弃**（'raw' 与 'raw=' 都不出现在结果里）；
    // 空名但值非空（'=1'）Python 仍保留成 {'': ['1']}，此处照抄
    if (rawValue === '') continue;
    const name = unquotePlus(rawName);
    const value = unquotePlus(rawValue);
    if (out[name]) out[name].push(value);
    else out[name] = [value];
  }
  return out;
}

/**
 * `parsed.get(name, [def])[0]` 的对应物（端点里最常见的取值形态）。
 *
 * 注意传 `def` 的语义：Python 只在**键不存在**时用默认值；键存在则取首个值。
 * 由于 `parseQs` 已丢弃空值，键存在即值非空——与 Python 逐点同。
 */
export function qsGet(parsed, name, def = '') {
  const values = parsed ? parsed[name] : undefined;
  return values && values.length ? values[0] : def;
}
