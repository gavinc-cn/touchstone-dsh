/**
 * zstd **多帧**解压（Node 后端 M2 的第一个交付物，方案 R1b）。
 *
 * 为什么需要自己扫帧边界：`node:zlib` 的 zstd 只解**单帧**——`zstdDecompressSync(整个文件)`
 * 只返回第一帧（真机实测：989 帧 / 5,151,586 字节的会话文件只回 203 字节），流式 API 随后报
 * `ZSTD_error_prefix_unknown`。而 dsh 会话存储就是**多帧**追加写的
 * （`~/.dsh/sessions/<bucket>/<sid>/session*.jsonl.zstd`，一次追加一帧），所以 Node 侧要
 * 自己做「帧边界扫描 + 逐帧解压」，否则 sessparse 直接废掉。
 *
 * 扫描只走**帧头 + 块头**（不做熵解码），规则出自 zstd 规范（RFC 8878）：
 *   magic(4) → Frame_Header(2..14，由 Frame_Header_Descriptor 决定各字段宽度)
 *            → 若干 Block（每块 3 字节头 + 内容；RLE 块内容仅 1 字节）
 *            → [Content_Checksum(4)]（FHD 的 checksum 位置 1 时）
 *   另有 Skippable Frame（magic 0x184D2A5?）：8 字节头 + 声明长度，直接跳过。
 *
 * 与 Python 侧的等价口径（`sessparse._dsh_decompressed`，逐帧 `decompressobj()` +
 * `unused_data`）：**坏帧即停，保留此前已解出的帧**（真机踩过：3206 条的会话尾部多 21 字节
 * 垃圾，整段解析曾因此丢成 0 条）；且坏帧若是「写了一半的合法帧」，Python 会把其中**已完整
 * 解出的块内容**一并返回 —— 本模块同样（`decompressFramePartial`，`finishFlush: Z_NO_FLUSH`，
 * 与 Python 实测逐字节同值）。因此主入口 `decompressSessionFile()` **绝不抛异常**。
 */
import { constants, zstdDecompressSync } from 'node:zlib';

/** 标准 zstd 帧 magic（小端读作 uint32） */
export const ZSTD_MAGIC = 0xfd2fb528;

/**
 * Skippable frame 的 magic 区间：`0x184D2A50`..`0x184D2A5F`（低 4 位为序号，规范允许 16 个）。
 * 判定用「与 0xFFFFFFF0 相与后等于基址」。
 */
export const ZSTD_SKIP_MAGIC_BASE = 0x184d2a50;
const ZSTD_SKIP_MAGIC_MASK = 0xfffffff0;

/** 帧头最多 18 字节（4 magic + 1 FHD + 1 WD + 4 DictID + 8 FCS + …），块头 3 字节 */
const MAX_HEADER_BYTES = 18;

/**
 * 扫描**一个** zstd 帧的结束偏移（不含结束位置，即下一帧的起点）。
 *
 * 只解析头与块头，不解熵 ⇒ O(帧数 × 块数) 的纯偏移运算，真机 989 帧文件耗时亚毫秒级。
 * 帧不完整（截断）、magic 不对、块类型保留值 ⇒ 抛错（调用方按「坏帧即停」处理）。
 * @param {Buffer} buf
 * @param {number} offset 帧起始偏移
 * @returns {number} 下一帧的起始偏移
 */
export function frameEnd(buf, offset = 0) {
  let p = offset;
  if (p + 4 > buf.length) throw new Error(`帧头截断（offset=${offset}）`);
  const magic = buf.readUInt32LE(p);
  if ((magic & ZSTD_SKIP_MAGIC_MASK) === ZSTD_SKIP_MAGIC_BASE) {
    // Skippable frame：magic + 4 字节声明长度 + 该长度的用户数据
    if (p + 8 > buf.length) throw new Error(`skippable 帧头截断（offset=${offset}）`);
    const size = buf.readUInt32LE(p + 4);
    const end = p + 8 + size;
    if (end > buf.length) throw new Error(`skippable 帧截断（offset=${offset}）`);
    return end;
  }
  if (magic !== ZSTD_MAGIC) {
    throw new Error(`magic 不对（offset=${offset}: 0x${magic.toString(16)}）`);
  }
  p += 4;
  if (p >= buf.length) throw new Error(`缺 Frame_Header_Descriptor（offset=${offset}）`);
  const fhd = buf[p];
  p += 1;
  const fcsFlag = fhd >> 6;                       // Frame_Content_Size 的宽度档
  const singleSegment = (fhd >> 5) & 1;           // 单段帧（无 Window_Descriptor）
  const dictFlag = fhd & 3;                       // Dictionary_ID 宽度档
  const hasChecksum = (fhd >> 2) & 1;             // 末尾是否有 4 字节 xxhash
  if (!singleSegment) p += 1;                     // Window_Descriptor
  p += dictFlag === 3 ? 4 : dictFlag;             // Dictionary_ID
  // FCS 宽度：flag=0 时「单段帧 1 字节 / 非单段帧 0 字节」，flag=1→2、2→4、3→8
  p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : (fcsFlag === 1 ? 2 : (fcsFlag === 2 ? 4 : 8));
  if (p > buf.length) throw new Error(`帧头截断（offset=${offset}）`);

  for (;;) {
    if (p + 3 > buf.length) throw new Error(`块头截断（offset=${offset}）`);
    const blockHeader = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const last = blockHeader & 1;
    const type = (blockHeader >> 1) & 3;
    const size = blockHeader >> 3;
    if (type === 3) throw new Error(`保留块类型（offset=${offset}）`);
    p += type === 1 ? 1 : size;                   // RLE 块只有 1 字节内容
    if (p > buf.length) throw new Error(`块内容截断（offset=${offset}）`);
    if (last) break;
  }
  if (hasChecksum) p += 4;
  if (p > buf.length) throw new Error(`校验和截断（offset=${offset}）`);
  return p;
}

/**
 * 扫出**连续有效帧**的 `{start, end, bytes}` 列表（遇到第一个坏帧/半截帧即停）。
 *
 * 「即停」不是偷懒，而是与 Python 逐帧解压的行为对齐：dsh 边写边追加，读侧可能撞上「末帧
 * 写了一半」，此时只应丢那一帧，前面的历史必须留着。
 * @param {Buffer} buf
 * @returns {Array<{start:number,end:number,bytes:number,skippable:boolean}>}
 */
export function scanFrames(buf) {
  const out = [];
  let off = 0;
  while (off < buf.length) {
    const start = off;
    let end;
    try {
      end = frameEnd(buf, off);
    } catch {
      break;
    }
    if (end <= start) break;                      // 防死循环（规范上不可能，保留闸门）
    const magic = buf.readUInt32LE(start);
    out.push({ start, end, bytes: end - start,
      skippable: (magic & ZSTD_SKIP_MAGIC_MASK) === ZSTD_SKIP_MAGIC_BASE });
    off = end;
  }
  return out;
}

/**
 * 尽力解出**一个不完整帧**里已完整落盘的块内容（Python `decompressobj()` 的部分输出语义）。
 *
 * 为什么需要它：Python 的 `obj.decompress(半截帧)` **不抛错**，而是返回其中已解出的块内容
 * （实测：400 KB 不可压数据的一帧截到 60% ⇒ Python 返回 239,997 B；Node 的
 * `zstdDecompressSync` 默认在截断处抛 `Z_BUF_ERROR`，加 `finishFlush: Z_NO_FLUSH` 后拿到的
 * 字节数与 Python **完全相同**）。dsh 边写边追加，读侧撞上「末帧写了一半」是常态，半帧里若含
 * 完整事件行（标题/提问），丢掉它就会让会话窗口少一条。
 *
 * 纯垃圾 / 坏校验和仍会抛错 ⇒ 返回空 Buffer（与 Python 抛 `ZstdError` 时「本次结果整段丢弃」同效）。
 * @param {Buffer} bytes 从坏帧起点开始的剩余字节
 * @returns {Buffer} 已解出的部分内容（没有则空 Buffer）
 */
export function decompressFramePartial(bytes) {
  if (!bytes || bytes.length === 0) return Buffer.alloc(0);
  try {
    return zstdDecompressSync(bytes, { finishFlush: constants.Z_NO_FLUSH });
  } catch {
    return Buffer.alloc(0);
  }
}

/**
 * 逐帧解压（与 Python `decompressobj()` 的逐帧语义对齐），返回每一帧的解压结果。
 *
 * 坏帧处**两种口径都要**：
 *   - `partialTail: true`（缺省）＝ **Python 等价**：坏帧里已完整解出的块内容也取回来
 *     （`decompressFramePartial`），然后停止——这正是 `decompressobj()` 的实际行为；
 *   - `partialTail: false` ＝ 严格口径：坏帧整帧丢弃（只用于对比测试与排障）。
 * 两种口径都**不会**继续解析坏帧之后的字节（Python 在坏帧处即停）。
 * @param {Buffer} buf
 * @param {{partialTail?: boolean}} [options]
 * @returns {{chunks: Buffer[], frames: number, stoppedAt: number|null, reason: string, recovered: boolean}}
 */
export function decompressFrames(buf, { partialTail = true } = {}) {
  const chunks = [];
  let off = 0;
  const finish = (reason) => {
    let recovered = false;
    if (partialTail && off < buf.length) {
      const tail = decompressFramePartial(buf.subarray(off));
      if (tail.length > 0) {
        chunks.push(tail);
        recovered = true;
      }
    }
    return { chunks, frames: chunks.length, stoppedAt: off, reason, recovered };
  };
  for (;;) {
    if (off >= buf.length) {
      return { chunks, frames: chunks.length, stoppedAt: null, reason: '', recovered: false };
    }
    let end;
    try {
      end = frameEnd(buf, off);
    } catch (error) {
      return finish(`扫帧失败: ${error.message}`);
    }
    let out;
    try {
      out = zstdDecompressSync(buf.subarray(off, end));
    } catch (error) {
      // 扫描过了但解压失败：magic/框架像 zstd 而内容坏了（Python 同样在此停）
      return finish(`解压失败: ${error.message}`);
    }
    chunks.push(out);
    off = end;
  }
}

/**
 * 解压 dsh 会话文件缓冲（**主入口**，逐字对齐 `sessparse._dsh_decompressed`）。
 *
 * 永不抛异常：完全不是 zstd / 首帧即坏 ⇒ 返回空串；尾部坏帧 ⇒ 返回此前帧拼出的文本。
 * 解码用 `errors="replace"` 同款容错（Node 的 utf8 解码本来就把非法序列换成 U+FFFD）。
 * @param {Buffer} buf
 * @returns {string}
 */
export function decompressSessionFile(buf) {
  return Buffer.concat(decompressFrames(buf).chunks).toString('utf8');
}

/** 帧头字段自检用：给一个偏移，返回该帧头解出来的字段（测试与排障用） */
export function parseFrameHeader(buf, offset = 0) {
  if (offset + 5 > buf.length) throw new Error('帧头截断');
  const magic = buf.readUInt32LE(offset);
  if (magic !== ZSTD_MAGIC) throw new Error(`magic 不对: 0x${magic.toString(16)}`);
  const fhd = buf[offset + 4];
  return {
    magic,
    descriptor: fhd,
    fcsFlag: fhd >> 6,
    singleSegment: ((fhd >> 5) & 1) === 1,
    dictFlag: fhd & 3,
    hasChecksum: ((fhd >> 2) & 1) === 1,
    unusedBit: ((fhd >> 3) & 1) === 1,   // 规范要求为 0（置位即格式异常，只报告不拦）
    maxHeaderBytes: MAX_HEADER_BYTES,
  };
}
