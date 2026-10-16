/**
 * backend/lib/zstd-frames.js 的测试（node --test，零依赖）。
 *
 * 为什么这一层必须测得这么细（方案 R1b）：`node:zlib` 只解单帧，dsh 会话文件是多帧追加写的
 * （真机 989 帧 / 5MB），sessparse 的**一切**都建立在「帧边界扫得准 + 坏帧只丢那一帧」之上。
 * 少算一个字节 → 后续帧全部错位；多算一个字节 → 把下一帧的 magic 吃掉。故本文件同时钉住：
 *   ① 帧头/块头解析的每一个宽度档（FCS 4 档、DictID 4 档、单段/非单段、checksum、RLE 块）；
 *   ② skippable frame（规范允许，真文件里可能出现）；
 *   ③ 尾部半截帧/垃圾字节 ⇒ 只丢坏帧、保留前序（真机踩过：3206 条的会话尾部多 21 字节垃圾，
 *      整段解析曾因此丢成 0 条）；
 *   ④ **真会话文件与 Python `zstandard.decompressobj()` 逐帧对拍**（本模块存在的唯一理由，
 *      探针见 tools/parity/probe/zstd_frames.py；没有会话文件时跳过）。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';

import { decompressFramePartial, decompressFrames, decompressSessionFile, frameEnd,
  parseFrameHeader, scanFrames } from '../lib/zstd-frames.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PROBE = path.join(ROOT, 'tools', 'parity', 'probe', 'zstd_frames.py');
const VARIANT_GEN = path.join(ROOT, 'tools', 'parity', 'probe', 'make_zstd_variants.py');

/** 用 node:zlib 造 n 帧（每帧内容独立压缩，等价 dsh 的「一次追加一帧」） */
function makeFrames(texts) {
  return Buffer.concat(texts.map((t) => zstdCompressSync(Buffer.from(t, 'utf8'))));
}

test('帧边界扫描：多帧逐帧对齐（含空帧）', () => {
  const texts = ['第一帧：中文\n', '{"a":1}\n', '', '第四帧\n'];
  const frames = texts.map((t) => zstdCompressSync(Buffer.from(t, 'utf8')));
  const buf = Buffer.concat(frames);
  const scan = scanFrames(buf);
  assert.equal(scan.length, 4);
  let off = 0;
  for (let i = 0; i < frames.length; i += 1) {
    assert.equal(scan[i].start, off, `第 ${i + 1} 帧起点`);
    assert.equal(scan[i].end, off + frames[i].length, `第 ${i + 1} 帧终点`);
    off += frames[i].length;
  }
  assert.equal(off, buf.length, '扫完应正好到缓冲区末尾');
  assert.deepEqual(decompressFrames(buf).chunks.map((c) => c.toString('utf8')), texts);
  assert.equal(decompressSessionFile(buf), texts.join(''));
});

test('帧头字段：单段帧的 FCS 宽度档与 checksum 位', () => {
  const buf = zstdCompressSync(Buffer.from('x'.repeat(100), 'utf8'));
  const h = parseFrameHeader(buf, 0);
  assert.equal(h.magic, 0xfd2fb528);
  assert.equal(h.dictFlag, 0, '不带字典');
  assert.equal(h.hasChecksum, false, 'zlib 默认不写 xxhash');
  // singleSegment + fcsFlag=0 ⇒ 帧头里有 1 字节 Frame_Content_Size（100 → 0x64）
  assert.equal(h.singleSegment, true);
  assert.equal(frameEnd(buf, 0), buf.length, '单帧的终点应等于总长');
  assert.equal(buf[5], 100, 'FCS 实测 100');
});

test('RLE 块与多块帧：块头 last/type/size 解析正确', () => {
  // 高度可压缩内容 ⇒ zstd 会用 RLE / 原始块；只要 frameEnd 到最后一块的 last 位即正确
  const buf = zstdCompressSync(Buffer.alloc(300000, 0x41));
  assert.equal(frameEnd(buf, 0), buf.length);
  assert.equal(decompressSessionFile(buf).length, 300000);
});

test('skippable frame：跳过（不当作坏帧），其后标准帧照常解出', () => {
  const payload = Buffer.from('skip me', 'utf8');
  const head = Buffer.alloc(8);
  head.writeUInt32LE(0x184d2a50, 0);              // skippable magic（低 4 位为序号）
  head.writeUInt32LE(payload.length, 4);
  const skip = Buffer.concat([head, payload]);
  const real = zstdCompressSync(Buffer.from('真实帧内容\n', 'utf8'));
  const buf = Buffer.concat([skip, real]);
  const scan = scanFrames(buf);
  assert.equal(scan.length, 2);
  assert.equal(scan[0].skippable, true);
  assert.equal(scan[1].skippable, false);
  assert.equal(decompressSessionFile(buf), '真实帧内容\n');
});

test('尾部坏字节：完整帧保留；半帧里已解出的内容也取回（Python 口径），严格模式整帧丢', () => {
  // 与 Python `decompressobj()` 实测对齐（2026-10-11 收口）：
  //   - 「真·垃圾尾巴 / 坏字节」⇒ Python 抛 ZstdError、丢弃该次结果 ⇒ 只剩完整帧；
  //   - 「写了一半的合法帧」⇒ Python **不抛错**、返回其中已解出的部分 ⇒ 也要取回。
  // 两个要点：① 完整帧永不因尾巴坏而消失；② 部分输出必是**完整内容的前缀**。
  const texts = ['{"type":"a"}\n', '{"type":"b"}\n', '{"type":"c"}\n'];
  const good = makeFrames(texts);
  const full = texts.join('');
  for (const dirty of [Buffer.concat([good, Buffer.from('半截垃圾')]),
    Buffer.concat([good, Buffer.alloc(21, 0x7f)])]) {
    assert.equal(decompressSessionFile(dirty), full,
      '垃圾尾巴不得让前序历史消失，也不该多出内容');
    const r = decompressFrames(dirty);
    assert.equal(r.chunks.length, 3);
    assert.equal(r.stoppedAt, good.length);
    assert.equal(r.recovered, false, '垃圾尾巴取不到部分内容');
    assert.match(r.reason, /扫帧失败|解压失败/);
  }
  // 半截帧：取回已解出的前缀（Python 同值），严格模式只保留完整帧
  const half = Buffer.concat([good, good.subarray(0, 12)]);
  const recoveredText = decompressSessionFile(half);
  assert.ok(recoveredText.startsWith(full), '完整帧必须完整保留');
  assert.ok(recoveredText.length > full.length, '半帧里已解出的内容应被取回（Python 口径）');
  assert.ok(full.concat('{"t').startsWith(recoveredText),
    `部分输出必须是完整内容的前缀，实际多出 ${JSON.stringify(recoveredText.slice(full.length))}`);
  const r = decompressFrames(half);
  assert.equal(r.recovered, true);
  assert.equal(r.stoppedAt, good.length);
  assert.equal(Buffer.concat(r.chunks).toString('utf8'), recoveredText);
  const strict = decompressFrames(half, { partialTail: false });
  assert.equal(strict.recovered, false);
  assert.equal(Buffer.concat(strict.chunks).toString('utf8'), full, '严格模式整帧丢弃');
});

test('半帧收尾：多块大帧截到 60% 时取回长度与 Python 实测同值', (t) => {
  // 不可压数据（随机字节）⇒ 一帧多块；截到 60% 时前面的块完整 ⇒ 与 Python `decompressobj()`
  // 应当取出**同样长度**的部分内容。这里不写死数字（长度随压缩结构而变），而是拿
  // `tools/parity/probe/zstd_frames.py` 在同一份字节上实测的 `lens[0]` 来断言——跨语言同值
  // 才是判据本身（真会话上的大规模同值见 zstd-run 报告）。
  const big = randomBytes(400000);
  const frame = zstdCompressSync(big);
  const cut = frame.subarray(0, Math.floor(frame.length * 0.6));
  const partial = decompressFramePartial(cut);
  assert.ok(partial.length > 0, '多块帧截断后应能取回部分内容');
  assert.ok(partial.length < big.length, '截断的帧不可能解出全部内容');
  assert.ok(big.subarray(0, partial.length).equals(partial), '部分输出必须是原文前缀');
  assert.equal(decompressFramePartial(Buffer.from('不是 zstd')).length, 0, '垃圾输入返回空');
  // 与 Python 同值（探针不可用时跳过跨语言那一半，其余断言仍然有效）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-zstd-partial-'));
  try {
    const p = path.join(dir, 'cut.zstd');
    fs.writeFileSync(p, cut);
    let probe;
    try {
      probe = JSON.parse(execFileSync('python3', [PROBE, p], { encoding: 'utf8' }).trim());
    } catch (error) {
      t.diagnostic(`跳过跨语言比对（需要 python3 + zstandard）: ${error.message}`);
      return;
    }
    assert.equal(probe.lens.length, 1, 'Python 应把半帧解成一段部分输出');
    assert.equal(partial.length, probe.lens[0],
      `部分输出长度需与 Python 同值（Node ${partial.length} vs Py ${probe.lens[0]}）`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('完全非 zstd / 首帧即坏 ⇒ 空串（不抛异常）', () => {
  assert.equal(decompressSessionFile(Buffer.from('这不是 zstd')), '');
  assert.equal(decompressSessionFile(Buffer.alloc(0)), '');
  assert.equal(decompressFrames(Buffer.from('nope')).chunks.length, 0);
  assert.throws(() => frameEnd(Buffer.from('nope'), 0), /magic/);
});

test('解出的文本按 UTF-8 替换非法序列（与 Python errors="replace" 同口径）', () => {
  const bad = Buffer.from([0x41, 0xff, 0xfe, 0x42]);     // A + 非法字节 + B
  const buf = zstdCompressSync(bad);
  const text = decompressSessionFile(buf);
  assert.equal(text.length, 4, '非法序列各占一个替换字符（Python 同款计数）');
  assert.equal(text[0], 'A');
  assert.equal(text[3], 'B');
  assert.equal([...text].filter((c) => c === '\uFFFD').length, 2);
});

/** 真会话文件（体积最大者），没有则跳过（CI 机器可能没有 ~/.dsh） */
function realSessionFiles(limit = 3) {
  const root = path.join(os.homedir(), '.dsh', 'sessions');
  const found = [];
  if (!fs.existsSync(root)) return found;
  for (const bucket of fs.readdirSync(root)) {
    const bp = path.join(root, bucket);
    if (!fs.statSync(bp).isDirectory()) continue;
    for (const sid of fs.readdirSync(bp)) {
      const sp = path.join(bp, sid);
      if (!fs.statSync(sp).isDirectory()) continue;
      for (const name of fs.readdirSync(sp)) {
        if (/^session.*\.jsonl\.zstd$/.test(name)) {
          const p = path.join(sp, name);
          found.push({ path: p, size: fs.statSync(p).size });
        }
      }
    }
  }
  found.sort((a, b) => b.size - a.size);
  return found.slice(0, limit);
}

test('真会话文件：与 Python zstandard.decompressobj() 逐帧一致（本模块的立身之本）', (t) => {
  const files = realSessionFiles(3);
  if (!files.length) return t.skip('本机没有 ~/.dsh/sessions 会话文件');
  // **先冻结字节再对拍**：会话文件边写边追加，两侧各自读原文件会得到假差异（实测：全量
  // 462 个文件里唯一不一致的正是「正在被写的本会话文件」，帧数 3286 vs 3284）。故先拷成同一份
  // 临时文件，两侧都读它。
  const frozenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-zstd-test-'));
  const frozen = files.map((f, i) => {
    const dest = path.join(frozenDir, `probe-${i}.zstd`);
    fs.writeFileSync(dest, fs.readFileSync(f.path));
    return { ...f, frozenPath: dest };
  });
  const out = execFileSync('python3', [PROBE, ...frozen.map((f) => f.frozenPath)],
    { encoding: 'utf8', maxBuffer: 1 << 28 });
  const probes = out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  try {
  for (let i = 0; i < files.length; i += 1) {
    const buf = fs.readFileSync(frozen[i].frozenPath);
    const mine = decompressFrames(buf);
    const py = probes[i];
    assert.equal(mine.chunks.length, py.frames, `${files[i].path}: 帧数`);
    assert.equal(mine.chunks.map((c) => c.length).join(','), py.lens.join(','),
      `${files[i].path}: 逐帧解压字节数`);
    const blob = Buffer.concat(mine.chunks);
    assert.equal(createHash('sha256').update(blob).digest('hex'), py.sha256,
      `${files[i].path}: 拼接 sha256`);
    const text = blob.toString('utf8');
    const encoded = Buffer.from(text, 'utf8');
    assert.equal(encoded.length, py.text_bytes, `${files[i].path}: 文本 UTF-8 字节数`);
    assert.equal(createHash('sha256').update(encoded).digest('hex'), py.text_sha256,
      `${files[i].path}: 文本 sha256`);
  }
  assert.ok(files.every((f) => f.size > 0));
  } finally {
    fs.rmSync(frozenDir, { recursive: true, force: true });
  }
});

test('头变体语料：checksum / FCS 档 / 字典 / skippable / 截断尾 的扫描与解压都对', (t) => {
  // 真会话文件只覆盖 dsh 实际写法（单段帧、无 checksum、无字典），而扫描器要按规范解析
  // Frame_Header 的每个宽度档。这里用 Python 生成变体语料（生成器见 probe/），既断扫描边界，
  // 也与 Python 逐帧比长度——「真文件没覆盖到的分支」也有证据。
  // 注：dictFlag=3（4 字节 Dictionary_ID）本机 python-zstandard 无 API 可造（它只写 2 字节），
  // 扫描器里是 `dictFlag === 3 ? 4 : dictFlag` 同一条表达式，此处如实标注未覆盖。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-zstd-variants-'));
  try {
    let listed;
    try {
      listed = execFileSync('python3', [VARIANT_GEN, dir], { encoding: 'utf8' });
    } catch (error) {
      return t.skip(`无法生成变体语料（需要 python3 + zstandard）: ${error.message}`);
    }
    assert.match(listed, /checksum\.zstd/);
    const probe = JSON.parse(execFileSync('python3', [PROBE, path.join(dir, 'default.zstd')],
      { encoding: 'utf8' }).trim());
    assert.equal(probe.frames, 5, '默认变体应为 5 帧（探针自证）');
    const cases = {
      'default.zstd': 5, 'checksum.zstd': 5, 'no_content_size.zstd': 5, 'level22.zstd': 5,
      'skippable_middle.zstd': 3, 'truncated_tail.zstd': 2, 'empty.zstd': 0, 'garbage.zstd': 0,
    };
    for (const [name, wantFrames] of Object.entries(cases)) {
      const buf = fs.readFileSync(path.join(dir, name));
      const scan = scanFrames(buf);
      const mine = decompressFrames(buf);
      assert.equal(mine.chunks.length, wantFrames, `${name}: 解出帧数`);
      // 扫描边界：连续、无重叠、到文件末尾（有截断尾时停在坏帧处）
      let off = 0;
      for (const f of scan) {
        assert.equal(f.start, off, `${name}: 帧起点连续`);
        off = f.end;
      }
      assert.ok(off <= buf.length, `${name}: 边界不得越界`);
      const py = JSON.parse(execFileSync('python3', [PROBE, path.join(dir, name)],
        { encoding: 'utf8' }).trim());
      assert.equal(mine.chunks.map((c) => c.length).join(','), py.lens.join(','),
        `${name}: 逐帧解压字节数须与 Python 一致`);
    }
    // 字典帧：两侧都**解不出来**（Node/`zlib` 没有字典）⇒ 0 帧，但**扫描器必须能正确跳过帧头**
    const dictBuf = fs.readFileSync(path.join(dir, 'dict.zstd'));
    const dictScan = scanFrames(dictBuf);
    assert.equal(dictScan.length, 5, 'dictFlag=2 的帧头必须扫得对（5 帧）');
    assert.equal(decompressFrames(dictBuf).chunks.length, 0, '没有字典 ⇒ 首帧解压失败即停');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('手造帧头：8 字节 FCS 与 4 字节 Dictionary_ID 档的宽度算术（真文件覆盖不到的两档）', () => {
  // 为什么手造：真会话帧很小 ⇒ FCS 走 1/2 字节档；本机 python-zstandard 也只写 2 字节 dictID。
  // 这两档**不可能**用真文件或生成器覆盖，而扫描器少算/多算字节会让后续帧全部错位。
  // 这里只断**边界算术**（帧内容是假的，不参与解压），把两条分支钉住。
  // 一个「last + raw + size=0」的块头（3 字节，小端）：bit0=last=1, bit1-2=type=0, 其余=size
  const block = Buffer.from([0x01, 0x00, 0x00]);

  // ① fcsFlag=3（8 字节 FCS）+ singleSegment=1 + dictFlag=3（4 字节 dictID）
  const fhd1 = (0b11 << 6) | (1 << 5) | 0b11;
  const hdr1 = Buffer.alloc(4 + 1 + 4 + 8);
  hdr1.writeUInt32LE(0xfd2fb528, 0);
  hdr1[4] = fhd1;
  // 4 字节 dictID 从偏移 5 起，8 字节 FCS 从偏移 9 起
  const fake1 = Buffer.concat([hdr1, block]);
  assert.equal(frameEnd(fake1, 0), fake1.length, '8B FCS + 4B dictID 的帧尾应正好在块之后');
  assert.equal(scanFrames(fake1).length, 1);

  // ② fcsFlag=0 + 非单段帧（0 字节 FCS，但有 1 字节 Window_Descriptor）
  const fhd2 = (0b00 << 6) | (0 << 5) | 0b00;
  const hdr2 = Buffer.alloc(4 + 1 + 1);
  hdr2.writeUInt32LE(0xfd2fb528, 0);
  hdr2[4] = fhd2;
  const fake2 = Buffer.concat([hdr2, block]);
  assert.equal(frameEnd(fake2, 0), fake2.length, '非单段帧 + 0 字节 FCS 的宽度');

  // ③ checksum 位 ⇒ 帧尾多 4 字节
  const fhd3 = (0b00 << 6) | (1 << 5) | 0b00 | (1 << 2);
  const hdr3 = Buffer.alloc(4 + 1 + 1);
  hdr3.writeUInt32LE(0xfd2fb528, 0);
  hdr3[4] = fhd3;
  const fake3 = Buffer.concat([hdr3, block, Buffer.alloc(4)]);
  assert.equal(frameEnd(fake3, 0), fake3.length, 'checksum 帧尾多 4 字节');
  // 少了那 4 字节 ⇒ 视为截断（不能假装扫成功）
  assert.throws(() => frameEnd(Buffer.concat([hdr3, block]), 0), /校验和截断/);

  // ④ 保留块类型（type=3）必须报错，而不是当成某个长度跳过
  const reservedBlock = Buffer.from([0x07, 0x00, 0x00]);  // last=1, type=3(保留), size=0
  const fhd4 = (0b00 << 6) | (1 << 5) | 0b00;
  const hdr4 = Buffer.alloc(4 + 1 + 1);
  hdr4.writeUInt32LE(0xfd2fb528, 0);
  hdr4[4] = fhd4;
  assert.throws(() => frameEnd(Buffer.concat([hdr4, reservedBlock]), 0), /保留块类型/);

  // ⑤ magic 不对 ⇒ 报 magic（不是静默跳过）
  const hdr5 = Buffer.alloc(6);
  hdr5.writeUInt32LE(0x12345678, 0);        // 不是 zstd magic（也不是 skippable 区间）
  hdr5[4] = fhd4;
  assert.throws(() => frameEnd(Buffer.concat([hdr5, block]), 0), /magic/);
});
