/**
 * `backend/lib/sessparse.js` 单测（node --test，零依赖）。
 *
 * 三块断言：
 *   ① **语义**：entry 模型、标题/首问扫描、列表/归档/子代理判定、缓存 stamp 语义、
 *      截断与 token 口径、坏帧容错——每条都对应 `sessparse.py` 的一个行为点；
 *   ② **Python 实测向量**：`_trunc`/`_dsh_prompt_tokens`/`_obj`/`_nonneg_int` 的期望值
 *      全部由 CPython 3.12 + sessparse 真跑生成（注释里给出生成方式），不是「照 Node 抄的」；
 *   ③ **跨语言对拍（有 Python + 真会话时）**：同一份**合成会话**与同一批**真会话**上，
 *      调 `tools/parity/probe/sessparse.py` 与 Node 侧逐字段比——对应验收的第 2/3 条，
 *      让 `node --test` 单跑也能自证（完整量具是 `tools/parity/sess-run.mjs`）。
 *
 * 全部文件操作只落 `os.tmpdir()`；`~/.dsh/sessions` 一律只读。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';

import * as sp from '../lib/sessparse.js';
import { scanFrames } from '../lib/zstd-frames.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PROBE = path.join(ROOT, 'tools', 'parity', 'probe', 'sessparse.py');
const PYTHON = process.env.TS_PYTHON || 'python3';
const REAL_ROOT = path.join(os.homedir(), '.dsh', 'sessions');

/** 临时存储根（每个用例一个，避免缓存/路径串味） */
function mkRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessparse-test-'));
  return path.join(dir, 'sessions');
}

/** 造一个多帧 zstd 会话文件（每帧一批 JSONL 行，等价 dsh 的追加写） */
function writeSession(sessionsRoot, bucket, sid, frames, fileName = 'session.v4.jsonl.zstd') {
  const dir = path.join(sessionsRoot, bucket, sid);
  fs.mkdirSync(dir, { recursive: true });
  const buf = Buffer.concat(frames.map((rows) => {
    const text = rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
    return zstdCompressSync(Buffer.from(text, 'utf8'));
  }));
  const p = path.join(dir, fileName);
  fs.writeFileSync(p, buf);
  return p;
}

/** 会话文件的一帧：头行 + 若干事件（真实 dsh 布局） */
function headerFrame(sid, extra = {}) {
  return [{ type: 'session', version: 4, id: sid, cwd: '/tmp/x', ...extra }];
}

/** Python 侧跑一份 op 请求（探针的 stdin 协议），返回结果数组 */
function pyOps(ops, root) {
  const req = JSON.stringify({ root: root || null, ops });
  const out = execFileSync(PYTHON, [PROBE], { input: req, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** python3 + zstandard + 探针是否可用（不可用则跳过跨语言用例） */
function pythonReady() {
  try {
    execFileSync(PYTHON, ['-c', 'import zstandard'], { stdio: 'ignore' });
    return fs.existsSync(PROBE);
  } catch {
    return false;
  }
}

const HAS_PY = pythonReady();
const HAS_REAL = fs.existsSync(REAL_ROOT);

// ---------------------------------------------------------------- ① 纯函数（Python 实测向量）

test('_trunc：按**码点**截断（emoji 不被切成半个代理对）', () => {
  const emoji = '😀';
  const long = `${emoji}${emoji}${emoji}中文abc`;
  // 期望值由 CPython 实测：python3 -c "import sessparse as s;print([s._trunc(L,n) for n in ...])"
  assert.equal(sp._trunc(long, 0), '');
  assert.equal(sp._trunc(long, 1), '😀');
  assert.equal(sp._trunc(long, 3), '😀😀😀');
  assert.equal(sp._trunc(long, 4), '😀😀😀中');
  assert.equal(sp._trunc(long, 8), long);            // 码点数恰为 8
  assert.equal(sp._trunc(long, 100), long);
  assert.equal(sp._trunc('abcdef', 3), 'abc');
  assert.equal(sp._trunc('中'.repeat(5), 4), '中'.repeat(4));
  // JS 朴素 slice 会切出孤立代理对（长度 3 是「1 个 emoji + 半个」）——这里必须与 Python 同口径
  assert.equal(sp._trunc(long, 1).length, 2);
});

test('_obj：坏 JSON / 非对象一律 null，合法对象原样返回', () => {
  // 期望值由 CPython sessparse._obj 实测
  assert.deepEqual(sp._obj('{"a":1}'), { a: 1 });
  assert.equal(sp._obj('[1]'), null);
  assert.equal(sp._obj('"x"'), null);
  assert.equal(sp._obj('42'), null);
  assert.equal(sp._obj('null'), null);
  assert.equal(sp._obj('{bad'), null);
  assert.equal(sp._obj(''), null);
  assert.deepEqual(sp._obj('  {"a": 1}  '), { a: 1 });
});

test('_nonneg_int / _dsh_prompt_tokens：token 口径与 dsh token-meter 一致', () => {
  // 期望值由 CPython sessparse 实测（含 bool 是 int 子类、负数、字符串等边界）
  assert.equal(sp._nonneg_int(0), 0);
  assert.equal(sp._nonneg_int(12), 12);
  assert.equal(sp._nonneg_int(-1), null);
  assert.equal(sp._nonneg_int(1.5), null);
  assert.equal(sp._nonneg_int(true), null);          // Python：bool 不算 int
  assert.equal(sp._nonneg_int('3'), null);
  assert.equal(sp._nonneg_int(null), null);

  assert.equal(sp._dsh_prompt_tokens({ inputTokens: 10 }), 10);
  assert.equal(sp._dsh_prompt_tokens({ inputTokens: 10, cacheReadTokens: 3, cacheWriteTokens: 2 }), 15);
  assert.equal(sp._dsh_prompt_tokens({ totalTokens: 100, outputTokens: 40 }), 60);
  assert.equal(sp._dsh_prompt_tokens({ totalTokens: 100, outputTokens: 140 }), null);
  assert.equal(sp._dsh_prompt_tokens({ inputTokens: -5, totalTokens: 9, outputTokens: 4 }), 5);
  assert.equal(sp._dsh_prompt_tokens({ inputTokens: 5, cacheReadTokens: -1, cacheWriteTokens: true }), 5);
  assert.equal(sp._dsh_prompt_tokens({}), null);
  assert.equal(sp._dsh_prompt_tokens(null), null);
  assert.equal(sp._dsh_prompt_tokens([1]), null);
  assert.equal(sp._dsh_prompt_tokens({ inputTokens: '7' }), null);
});

test('_line_at / dsh_bucket：取行与 bucket 命名（Python 同名口径）', () => {
  assert.equal(sp._line_at('l1\nl2\nl3', 0), 'l1');
  assert.equal(sp._line_at('l1\nl2\nl3', 4), 'l2');
  assert.equal(sp._line_at('l1\nl2\nl3', 99), 'l3');
  assert.equal(sp._line_at('no newline', 3), 'no newline');
  assert.equal(sp._line_at('a\n\nb', 2), '');        // 命中空行（CPython 实测）
  const root = sp.dshSessionsRoot();
  assert.equal(sp.dsh_bucket('/tmp/proj'), path.join(root, '--tmp-proj--'));
  assert.equal(sp.dsh_bucket('/a/b/c///'), path.join(root, '--a-b-c--'));
  assert.equal(sp.dsh_bucket(''), path.join(root, '---'));
});

/**
 * `pyStrip` 的 Python 空白集（P8/评审补测）：`\x1c-\x1f`、`\x85` 只有 Python 剥，
 * `\ufeff` 只有 JS `trim()` 剥。评审实测：把 `pyStrip` 换成 JS `trim()` 或窄化成纯 ASCII，
 * 原有 26 例**全绿** ⇒ 之前零覆盖。这里用 Python 实测向量 + 两条行为断言钉住。
 * 期望值生成：`python3 -c "import sessparse as s;print(repr(s.__dict__ and '\x1ca\x1f'.strip()))"`（见注释中的向量）。
 */
test('pyStrip：Python 空白集与 JS trim 的差集（U+001C-U+001F / U+0085 / U+FEFF）', () => {
  // Python `str.strip()` 实测： /  剥，﻿ **不**剥，​ 也不算空白
  assert.equal(sp.pyStrip('\x1c a \x1f'), 'a');            // JS trim() 会原样留下 → 差集
  assert.equal(sp.pyStrip('\x85a\x85'), 'a');              // 同上
  assert.equal(sp.pyStrip('\ufeffa\ufeff'), '\ufeffa\ufeff');  // JS trim() 会剥成 'a' → 反向差集
  assert.equal(sp.pyStrip('\x0ba\x0c'), 'a');
  assert.equal(sp.pyStrip('\u00a0a\u3000'), 'a');
  assert.equal(sp.pyStrip('\u200ba\u2028'), '\u200ba');    // 前导零宽空格两侧都不剥，尾随 U+2028 剥
  assert.equal(sp.pyStrip('  a  '), 'a');
  assert.equal(sp.pyStrip(''), '');
  // 与 JS trim 的直接对照（差集自证，避免「实现被换成 trim 也不知道」）
  assert.notEqual(sp.pyStrip('\x1c a \x1f'), '\x1c a \x1f'.trim());
  assert.notEqual(sp.pyStrip('\ufeffa\ufeff'), '\ufeffa\ufeff'.trim());
});

test('pyStrip 行为守卫：JSONL 行的 U+001C/U+0085 padding 要能解析、BOM 开头不能（Python 同口径）', () => {
  const root = mkRoot();
  sp.setSessionsRoot(root);
  const sid = 'session-00000000-0000-4000-8000-0000000000a7';
  const line = (text, time) => JSON.stringify({
    type: 'assistant/message', seq: time, time, data: { message: { content: [{ type: 'text', text }] } },
  });
  writeSession(root, '--p--', sid, [
    headerFrame(sid),
    // ① Python 剥 U+001C…U+001F/U+0085 ⇒ 该行必须解析出 C1（换成 JS trim 则 JSON.parse 失败 → 少一条）
    [`\x1c${line('C1', 1)}\x1f\x85`],
    // ② Python **不**剥 U+FEFF ⇒ 该行必须解析失败（换成 JS trim 则会多出一条 C2）
    [`\ufeff${line('C2', 2)}`],
  ]);
  const entries = sp._parse_dsh(sp._dsh_session_file(sid)).entries;
  assert.deepEqual(entries.map((e) => e.text), ['C1']);
  // ③ 首问的 strip 同理：BOM 保留、尾随空格剥掉（Python 实测 '\ufeff hello'）
  const sid2 = 'session-00000000-0000-4000-8000-0000000000a8';
  writeSession(root, '--p--', sid2, [
    headerFrame(sid2),
    [JSON.stringify({
      type: 'user/message', seq: 1, time: 1,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '\ufeff hello ' }] },
    })],
  ]);
  assert.equal(sp.dsh_first_prompt(sid2), '\ufeff hello');
});

// ---------------------------------------------------------------- ② 存储定位

test('_dsh_format_version / _dsh_pick_file：版本号大者优先（无版本记 0）', () => {
  const root = mkRoot();
  sp.setSessionsRoot(root);
  const sid = 'session-11111111-2222-4333-8444-555555555555';
  const dir = path.join(root, '--b--', sid);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['session.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.v4.jsonl.zstd', 'notes.txt']) {
    fs.writeFileSync(path.join(dir, name), 'x');
  }
  assert.equal(sp._dsh_format_version(path.join(dir, 'session.jsonl.zstd')), 0);
  assert.equal(sp._dsh_format_version(path.join(dir, 'session.v3.jsonl.zstd')), 3);
  assert.equal(sp._dsh_format_version(path.join(dir, 'session.v4.jsonl.zstd')), 4);
  assert.equal(sp._dsh_format_version(path.join(dir, 'notes.txt')), 0);
  assert.equal(sp._dsh_pick_file(dir), path.join(dir, 'session.v4.jsonl.zstd'));
  // 无版本兜底：只留无版本文件时仍然选得到（只认 v4 名会让存量会话全读不到）
  fs.rmSync(path.join(dir, 'session.v4.jsonl.zstd'));
  assert.equal(sp._dsh_pick_file(dir), path.join(dir, 'session.v3.jsonl.zstd'));
  fs.rmSync(path.join(dir, 'session.v3.jsonl.zstd'));
  assert.equal(sp._dsh_pick_file(dir), path.join(dir, 'session.jsonl.zstd'));
  assert.equal(sp._dsh_pick_file(path.join(dir, 'nonexistent')), null);
});

test('_dsh_pick_file / _dsh_session_file：**同版本并列**时的取舍（Python max((版本,路径)) 口径）', () => {
  // 期望值由 CPython 实测：
  //   同目录 session.v4 与 session.v04 ⇒ 版本都是 4 ⇒ 取**路径字符串更大者** = session.v4（'4' > '0'）
  //   跨 bucket 同 sid 同版本 ⇒ 取**完整路径更大者** = --bbb-- 那个
  const root = mkRoot();
  sp.setSessionsRoot(root);
  const sid = 'session-00000000-0000-4000-8000-000000000ab1';
  for (const bucket of ['--aaa--', '--bbb--']) {
    const dir = path.join(root, bucket, sid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), 'x');
  }
  fs.writeFileSync(path.join(root, '--bbb--', sid, 'session.v04.jsonl.zstd'), 'x');
  assert.equal(sp._dsh_pick_file(path.join(root, '--bbb--', sid)), path.join(root, '--bbb--', sid, 'session.v4.jsonl.zstd'));
  assert.equal(sp._dsh_session_file(sid), path.join(root, '--bbb--', sid, 'session.v4.jsonl.zstd'));
  assert.equal(sp._dsh_format_version(path.join(root, '--bbb--', sid, 'session.v04.jsonl.zstd')), 4);
  // 并列只在「同版本」时发生：v5 直接压过 v4（不看路径）
  fs.writeFileSync(path.join(root, '--aaa--', sid, 'session.v5.jsonl.zstd'), 'x');
  assert.equal(sp._dsh_pick_file(path.join(root, '--aaa--', sid)), path.join(root, '--aaa--', sid, 'session.v5.jsonl.zstd'));
  assert.equal(sp._dsh_session_file(sid), path.join(root, '--aaa--', sid, 'session.v5.jsonl.zstd'));
});

test('_dsh_session_file / session_exists：跨 bucket、裸 uuid、坏 id 拒绝', () => {
  const root = mkRoot();
  sp.setSessionsRoot(root);
  const main = 'session-aaaa1111-2222-4333-8444-555555555555';
  const sub = 'bbbb1111-2222-4333-8444-555555555555';        // 裸 uuid（子代理/老主会话两代并存）
  writeSession(root, '--opt-x--', main, [headerFrame(main)]);
  writeSession(root, '--tmp-y--', sub, [headerFrame(sub)]);
  assert.equal(sp._dsh_session_file(main), path.join(root, '--opt-x--', main, 'session.v4.jsonl.zstd'));
  assert.equal(sp._dsh_session_file(sub), path.join(root, '--tmp-y--', sub, 'session.v4.jsonl.zstd'));
  assert.equal(sp._dsh_session_file('zzzz'), null);                       // 形态不符
  assert.equal(sp._dsh_session_file('../../etc/passwd'), null);           // 路径穿越
  assert.equal(sp._dsh_session_file(''), null);
  assert.equal(sp._dsh_session_file('aaaaaaaa-0000-4000-8000-000000000000'), null);
  assert.equal(sp.session_exists('dsh', main), true);
  assert.equal(sp.session_exists('dsh', 'zzzz'), false);
  assert.equal(sp.session_exists('kimi', main), false);                   // 退场族一律拒
});

test('dsh_latest_session / live_session_id：mtime 最新者 + since 过滤 + 族白名单', () => {
  const root = mkRoot();
  sp.setSessionsRoot(root);
  const oldSid = 'session-00000000-0000-4000-8000-00000000000a';
  const newSid = 'session-00000000-0000-4000-8000-00000000000b';
  const oldPath = writeSession(root, '--p--', oldSid, [headerFrame(oldSid)], 'session.jsonl.zstd');
  const newPath = writeSession(root, '--p--', newSid, [headerFrame(newSid)]);
  fs.utimesSync(oldPath, 1000, 1000);
  fs.utimesSync(newPath, 2000, 2000);
  assert.equal(sp.dsh_latest_session('/p'), newSid);
  assert.equal(sp.live_session_id('dsh', '/p', 1500), newSid);
  assert.equal(sp.live_session_id('dsh', '/p', 2500), '');
  assert.equal(sp.live_session_id('dsh', '/p', 0), '');        // since<=0 视为无效
  assert.equal(sp.live_session_id('dsh', '', 1500), '');
  assert.equal(sp.live_session_id('kimi', '/p', 1500), '');
});

// ---------------------------------------------------------------- ③ 头行 / 子代理

test('_dsh_header / is_subagent：origin 与 delegationDepth 双判据，未知按主会话', () => {
  const root = mkRoot();
  sp.setSessionsRoot(root);
  const mainSid = 'session-00000000-0000-4000-8000-0000000000m1'.replace('m', 'a');
  const subSid = '00000000-0000-4000-8000-0000000000s1'.replace('s', 'b');
  const depthSid = 'session-00000000-0000-4000-8000-0000000000d1'.replace('d', 'c');
  const bareMain = '00000000-0000-4000-8000-0000000000e1'.replace('e', 'd');
  const unknown = 'session-00000000-0000-4000-8000-0000000000f1'.replace('f', 'e');
  writeSession(root, '--p--', mainSid, [headerFrame(mainSid)]);
  writeSession(root, '--p--', subSid, [headerFrame(subSid, { origin: 'subagent', delegationDepth: 1, parentSession: mainSid })]);
  writeSession(root, '--p--', depthSid, [headerFrame(depthSid, { delegationDepth: 2 })]);
  writeSession(root, '--p--', bareMain, [headerFrame(bareMain)]);           // 裸 uuid 但是主会话
  writeSession(root, '--p--', unknown, [[{ type: 'not-session' }]]);        // 无头行
  assert.equal(sp.is_subagent('dsh', mainSid), false);
  assert.equal(sp.is_subagent('dsh', subSid), true);
  assert.equal(sp.is_subagent('dsh', depthSid), true);                      // 兜底判据
  assert.equal(sp.is_subagent('dsh', bareMain), false);                     // 目录名不是判据
  assert.equal(sp.is_subagent('dsh', unknown), false);                      // 未知按主会话
  assert.equal(sp.is_subagent('kimi', subSid), false);
  assert.deepEqual(sp._dsh_header(path.join(root, '--p--', mainSid, 'session.v4.jsonl.zstd')),
    { type: 'session', version: 4, id: mainSid, cwd: '/tmp/x' });
  assert.deepEqual(sp._dsh_header(path.join(root, '--p--', 'nope')), {});
});

test('_dsh_header：坏帧只影响头行读取（读不到按主会话），不抛异常', () => {
  const root = mkRoot();
  sp.setSessionsRoot(root);
  const sid = 'session-00000000-0000-4000-8000-0000000000a1';
  const good = zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', id: sid, origin: 'subagent' })}\n`));
  const p = path.join(root, '--p--', sid, 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.concat([good, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])]));
  assert.deepEqual(sp._dsh_header(p), { type: 'session', id: sid, origin: 'subagent' });
  fs.writeFileSync(p, Buffer.from('not zstd at all'));
  assert.deepEqual(sp._dsh_header(p), {});
});

// ---------------------------------------------------------------- ④ entry 模型

/** 一份覆盖全部事件的合成会话（含系统注入、非文本块、坏行、嵌入同名字符串的干扰行） */
function fillFrames(sid) {
  return [
    headerFrame(sid),
    [
      { type: 'session/title', seq: 1, time: 100, data: { title: '兜底标题' } },
      { type: 'user/message', seq: 2, time: 200, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一问\n第二行' }] } },
    ],
    [
      { type: 'user/message', seq: 3, time: 300, data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: '系统注入' }] } },
      { type: 'assistant/message', seq: 4, time: 400, data: {
        message: { content: [{ type: 'reasoning', text: '想一想' }, { type: 'text', text: '回答' }] },
        usage: { inputTokens: 100, cacheReadTokens: 5, cacheWriteTokens: 2, totalTokens: 200, outputTokens: 93 },
      } },
    ],
    [
      { type: 'request/context', seq: 5, time: 500, data: { contextWindow: 1000000 } },
      { type: 'tool/call', seq: 6, time: 600, data: { callId: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' } },
      { type: 'tool/result', seq: 7, time: 700, data: { message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'out1' }, { type: 'text', text: 'out2' }], isError: false } } },
    ],
    [
      { type: 'user/message', seq: 8, time: 800, data: { source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'sha256:' + 'a'.repeat(64) } }] } },
      { type: 'session/title', seq: 9, time: 900, data: { title: 'LLM 标题' } },
      '{"type":"tool/result","data":{"message":{"content":[{"type":"text","text":"干扰行"}]}}}',   // 合法 JSON：会被解析
      'not json at all',                                                                          // 坏行：跳过
      { type: 'unknown/event', seq: 10, time: 1000, data: {} },
      { type: 'request/context', seq: 11, time: 1100, data: { contextWindow: 0 } },                // 0 忽略
      { type: 'assistant/message', seq: 12, time: 1200, data: { usage: { inputTokens: 7 } } },     // 无 content：仍结算 token
    ],
  ];
}

test('_parse_dsh：entry 序列逐字段（user/think/assistant/tool_call/tool_result）', () => {
  const root = mkRoot();
  sp.setSessionsRoot(root);
  const sid = 'session-00000000-0000-4000-8000-0000000000c1';
  const p = writeSession(root, '--p--', sid, fillFrames(sid));
  const col = sp._parse_dsh(p);
  assert.deepEqual(col.entries, [
    { seq: 0, kind: 'user', time: 200, text: '第一问\n第二行', images: [], mid: 'e2', eseq: 2 },
    { seq: 1, kind: 'think', time: 400, text: '想一想' },
    { seq: 2, kind: 'assistant', time: 400, text: '回答' },
    { seq: 3, kind: 'tool_call', time: 600, name: 'bash', args: '{"cmd":"ls"}', call_id: 'c1' },
    { seq: 4, kind: 'tool_result', time: 700, call_id: 'c1', name: 'bash', text: 'out1\nout2', is_error: false, truncated: false },
    { seq: 5, kind: 'user', time: 800, text: '', images: [{ media: `sha256:${'a'.repeat(64)}` }], mid: 'e8', eseq: 8 },
    // 合法 JSON 的「干扰行」其实是一条真 tool/result 事件（Python 同样会产出条目）：
    // 坏行/非对象行/未知事件类型才被跳过
    { seq: 6, kind: 'tool_result', time: 0, call_id: '', name: '', text: '干扰行', is_error: false, truncated: false },
  ]);
  // 系统注入被过滤、坏行/非对象行跳过、无 content 的 assistant 不产条目（只结算 token）
  assert.deepEqual(col.totals, { input: 0, output: 0, cache_read: 0, duration_ms: 0 });
  assert.deepEqual(col.ctx, { used: 7, max: 1000000 });        // last-wins：usage 7 覆盖 107
  assert.deepEqual(col.dshAnchors, [
    ['e2', 2, '第一问\n第二行'],
    ['e8', 8, '[图片]'],                                        // 只有图片 → 占位文本
  ]);
});

test('_parse_dsh：工具输出截断（OUT_MAX）与 args 截断（ARGS_MAX）、is_error 真值口径', () => {
  const root = mkRoot();
  sp.setSessionsRoot(root);
  const sid = 'session-00000000-0000-4000-8000-0000000000c2';
  const big = 'x'.repeat(5000);
  const emojiOut = '😀'.repeat(5000);                          // 码点数 5000 > 4000（JS 码元数 10000）
  const p = writeSession(root, '--p--', sid, [
    headerFrame(sid),
    [{ type: 'tool/call', seq: 1, time: 1, data: { callId: 'k', name: 'n', arguments: 'y'.repeat(3000) } }],
    [{ type: 'tool/result', seq: 2, time: 2, data: { message: { source: { callId: 'k' }, content: [{ type: 'text', text: big }], isError: [] } } }],
    [{ type: 'tool/call', seq: 3, time: 3, data: { callId: 'm', name: 'n2', arguments: 'z' } }],
    [{ type: 'tool/result', seq: 4, time: 4, data: { message: { source: { callId: 'm' }, content: [{ type: 'text', text: emojiOut }], isError: 'yes' } } }],
  ]);
  const entries = sp._parse_dsh(p).entries;
  assert.equal(entries[0].args.length, 2000);
  assert.equal(entries[1].text.length, 4000);
  assert.equal(entries[1].truncated, true);
  assert.equal(entries[1].is_error, false);                    // [] 在 Python 里是假值
  assert.equal(entries[3].text.length, 8000);                  // 4000 个 emoji = 8000 码元
  assert.equal([...entries[3].text].length, 4000);             // 码点数仍是 4000
  assert.equal(entries[3].truncated, true);
  assert.equal(entries[3].is_error, true);                     // 非空字符串是真值
});

test('_parse_dsh：tool/result 的 cid 回填（source.callId / toolCallId / 嵌层 tool-result）', () => {
  const root = mkRoot();
  sp.setSessionsRoot(root);
  const sid = 'session-00000000-0000-4000-8000-0000000000c3';
  const p = writeSession(root, '--p--', sid, [
    headerFrame(sid),
    [{ type: 'tool/call', seq: 1, time: 1, data: { callId: 'c9', name: 'read' } }],
    [{ type: 'tool/result', seq: 2, time: 2, data: { message: { content: [{ type: 'tool-result', toolCallId: 'c9', content: [{ type: 'text', text: '嵌套形态' }] }] } } }],
    [{ type: 'tool/result', seq: 3, time: 3, data: { message: { toolCallId: 'unknown-cid', content: [{ type: 'text', text: 'x' }] } } }],
  ]);
  const entries = sp._parse_dsh(p).entries;
  assert.deepEqual(entries[0], { seq: 0, kind: 'tool_call', time: 1, name: 'read', args: '', call_id: 'c9' });
  assert.deepEqual(entries[1], { seq: 1, kind: 'tool_result', time: 2, call_id: 'c9', name: 'read', text: '嵌套形态', is_error: false, truncated: false });
  assert.equal(entries[2].call_id, 'unknown-cid');
  assert.equal(entries[2].name, '');                           // 未登记的工具名回落 ''
});

// ---------------------------------------------------------------- ⑤ 加载 / 缓存 / ctx

test('load：found/unsupported/missing + after 增量 + ctx 只在分母已知时下发', () => {
  const root = mkRoot();
  sp.setSessionsRoot(root);
  const sid = 'session-00000000-0000-4000-8000-0000000000d1';
  writeSession(root, '--p--', sid, fillFrames(sid));
  const full = sp.load('dsh', sid, 'main');
  assert.equal(full.found, true);
  assert.equal(full.agent, 'main');
  assert.deepEqual(full.agents, [{ id: 'main', type: 'main', parent: '' }]);
  assert.equal(full.total, 7);
  assert.equal(full.entries.length, 7);
  assert.deepEqual(full.totals, { input: 0, output: 0, cache_read: 0, duration_ms: 0 });
  assert.deepEqual(full.ctx, { used: 7, max: 1000000 });
  assert.equal(full.entries[0].seq, 0);
  const inc = sp.load('dsh', sid, 'main', 3);
  assert.equal(inc.entries.length, 4);
  assert.equal(inc.entries[0].seq, 3);
  assert.equal(inc.total, 7);
  assert.equal(sp.load('dsh', sid, 'main', 999).entries.length, 0);
  assert.equal(sp.load('dsh', sid, 'main', -5).entries.length, 7);   // max(0, after)
  assert.equal(sp.load('dsh', 'aaaaaaaa-0000-4000-8000-000000000000', 'main').reason, 'missing');
  assert.equal(sp.load('kimi', sid, 'main').reason, 'unsupported');
  assert.equal(sp.load('dsh', sid, '').agent, 'main');               // agent falsy → main
  // 分母未知（无 request/context）时**不带** ctx 键
  const sid2 = 'session-00000000-0000-4000-8000-0000000000d2';
  writeSession(root, '--p--', sid2, [headerFrame(sid2), [{ type: 'assistant/message', seq: 1, time: 1, data: { message: { content: [{ type: 'text', text: 'hi' }] } } }]]);
  assert.equal('ctx' in sp.load('dsh', sid2, 'main'), false);
});

test('load：缓存按 (mtime_ns, size) 复用/失效（同 stamp 换内容仍返回旧解析）', () => {
  const root = mkRoot();
  sp.setSessionsRoot(root);
  sp.cache_clear();
  const sid = 'session-00000000-0000-4000-8000-0000000000d3';
  const dir = path.join(root, '--p--', sid);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'session.v4.jsonl.zstd');
  /** 造一份「头行 + assistant 文本」的单帧会话，尾部补零对齐到 size（坏帧即停，补零不影响解析） */
  const make = (text, size) => {
    const buf = zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', id: sid })}\n${JSON.stringify({ type: 'assistant/message', seq: 1, time: 1, data: { message: { content: [{ type: 'text', text }] } } })}\n`));
    return buf.length >= size ? buf : Buffer.concat([buf, Buffer.alloc(size - buf.length)]);
  };
  const rawA = make('AAA', 0);
  const rawB = make('BBB', rawA.length);
  assert.ok(rawA.length === rawB.length);
  fs.writeFileSync(p, rawA);
  fs.utimesSync(p, 1000.5, 1000.5);               // 整秒 + 0.5s：ns 可被 double 精确表达
  assert.equal(sp.load('dsh', sid, 'main').entries[0].text, 'AAA');
  // 同 (mtime_ns, size) 下换成 B 的内容 ⇒ stamp 不变 ⇒ 命中缓存，仍返回旧解析（Python 同语义）
  fs.writeFileSync(p, rawB);
  fs.utimesSync(p, 1000.5, 1000.5);
  assert.equal(sp.load('dsh', sid, 'main').entries[0].text, 'AAA');
  // cache_clear() 后重新解析 → 新内容
  sp.cache_clear();
  assert.equal(sp.load('dsh', sid, 'main').entries[0].text, 'BBB');
  // 追加一帧（size 变）⇒ stamp 变 ⇒ 自动重解析
  fs.appendFileSync(p, zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: 'CCC' }] } } })}\n`)));
  const after = sp.load('dsh', sid, 'main');
  assert.equal(after.total, 2);
  assert.equal(after.entries[1].text, 'CCC');
  // 只把 mtime 拨走（size 不变）⇒ stamp 变 ⇒ 也重解析
  fs.utimesSync(p, 2000.25, 2000.25);
  const post = sp.load('dsh', sid, 'main');
  assert.equal(post.total, 2);
  assert.equal(post.entries[0].text, 'BBB');
});

test('load：不同 agent 各自一份解析（与 Python 的 (sid, agent) 缓存键一致）', () => {
  const root = mkRoot();
  sp.setSessionsRoot(root);
  sp.cache_clear();
  const sid = 'session-00000000-0000-4000-8000-0000000000d4';
  writeSession(root, '--p--', sid, [headerFrame(sid), [{ type: 'assistant/message', seq: 1, time: 1, data: { message: { content: [{ type: 'text', text: 'x' }] } } }]]);
  const a = sp.load('dsh', sid, 'agentA');
  const b = sp.load('dsh', sid, 'agentB');
  assert.equal(a.agent, 'agentA');
  assert.equal(b.agent, 'agentB');
  assert.notEqual(a.entries, b.entries);                        // 两份独立 entries（Python 同样不共享）
  assert.deepEqual(a.entries, b.entries);
});

// ---------------------------------------------------------------- ⑥ 标题 / 首问 / 列表 / 归档

test('dsh_title / dsh_first_prompt / list_sessions：last-wins 标题、首问全文、titles 全量', () => {
  const root = mkRoot();
  sp.setSessionsRoot(root);
  const sid = 'session-00000000-0000-4000-8000-0000000000e1';
  writeSession(root, '--p--', sid, [
    headerFrame(sid),
    [{ type: 'session/title', seq: 1, time: 1, data: { title: '兜底' } },
     { type: 'user/message', seq: 2, time: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一问\n带换行' }] } }],
    [{ type: 'session/title', seq: 3, time: 3, data: { title: 'LLM 标题' } },
     { type: 'session/title', seq: 4, time: 4, data: { title: '' } }],      // 空标题事件：不表态
    [{ type: 'session/title', seq: 5, time: 5, data: { title: '用户改名' } }],
  ]);
  assert.equal(sp.dsh_title(sid), '用户改名');
  assert.equal(sp.session_title('dsh', sid), '用户改名');
  assert.equal(sp.session_title('kimi', sid), '');
  assert.equal(sp.dsh_first_prompt(sid), '第一问\n带换行');
  const items = sp.list_sessions('dsh', '/p');
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].titles, ['兜底', 'LLM 标题', '用户改名']);
  assert.equal(items[0].title, '用户改名');
  assert.equal(items[0].first_prompt, '第一问\n带换行');
  assert.equal(items[0].sid, sid);
  assert.equal(typeof items[0].mtime, 'number');
  assert.equal(items[0].archived, false);
  assert.equal(sp.list_sessions('kimi', '/p').length, 0);
  assert.equal(sp.list_sessions('dsh', '').length, 0);
  assert.equal(sp.list_sessions('dsh', '/nonexistent').length, 0);
});

test('_dsh_scan_prompt：系统注入跳过、只有图片给 [图片]、无有效提问给空串', () => {
  const root = mkRoot();
  sp.setSessionsRoot(root);
  const sid = 'session-00000000-0000-4000-8000-0000000000e2';
  writeSession(root, '--p--', sid, [
    headerFrame(sid),
    [{ type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: '注入' }] } }],
    [{ type: 'user/message', seq: 2, time: 2, data: { source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'sha256:' + 'b'.repeat(64) } }] } }],
  ]);
  assert.equal(sp.dsh_first_prompt(sid), '[图片]');
  const sid2 = 'session-00000000-0000-4000-8000-0000000000e3';
  writeSession(root, '--p--', sid2, [headerFrame(sid2), [{ type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'user' }, content: [] } }]]);
  assert.equal(sp.dsh_first_prompt(sid2), '');
});

test('_dsh_scan_titles / _dsh_scan_prompt：非事件行里的同名字符串不误命中', () => {
  const text = [
    '{"type":"tool/result","data":{"message":{"content":[{"type":"text","text":"{\\"session/title\\": 1} 和 {\\"user/message\\": 2}"}]}}}',
    '{"type":"session/title","seq":1,"time":1,"data":{"title":"真标题"}}',
    '{"type":"user/message","seq":2,"time":2,"data":{"source":{"kind":"user"},"content":[{"type":"text","text":"真提问"}]}}',
  ].join('\n');
  assert.deepEqual(sp._dsh_scan_titles(text), ['真标题']);
  assert.equal(sp._dsh_scan_prompt(text), '真提问');
});

test('list_sessions：mtime 降序 + 子代理过滤 + 版本择大 + LIMIT', () => {
  const root = mkRoot();
  sp.setSessionsRoot(root);
  const mk = (sid, mt, extra = {}) => {
    const p = writeSession(root, '--p--', sid, [headerFrame(sid, extra)]);
    fs.utimesSync(p, mt, mt);
    return p;
  };
  mk('session-00000000-0000-4000-8000-0000000000f1', 1000);
  mk('session-00000000-0000-4000-8000-0000000000f2', 3000);
  mk('00000000-0000-4000-8000-0000000000f3', 2000);                              // 裸 uuid 主会话
  mk('00000000-0000-4000-8000-0000000000f4', 4000, { origin: 'subagent' });      // 子代理：不进列表
  const items = sp.list_sessions('dsh', '/p');
  assert.deepEqual(items.map((x) => x.sid), [
    'session-00000000-0000-4000-8000-0000000000f2',
    '00000000-0000-4000-8000-0000000000f3',
    'session-00000000-0000-4000-8000-0000000000f1',
  ]);
  assert.deepEqual(items.map((x) => x.mtime), [3000, 2000, 1000]);
  // 上限 50
  const many = mkRoot();
  sp.setSessionsRoot(many);
  for (let i = 0; i < 55; i += 1) {
    const sid = `session-00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const p = writeSession(many, '--p--', sid, [headerFrame(sid)]);
    fs.utimesSync(p, 1000 + i, 1000 + i);
  }
  const limited = sp.list_sessions('dsh', '/p');
  assert.equal(limited.length, sp.LIST_SESSIONS_LIMIT);
  assert.equal(limited[0].sid, 'session-00000000-0000-4000-8000-000000000054');
});

test('_dsh_archived_ids：global/顶层两种写法、坏 JSON 降级、按 stamp 失效', () => {
  const root = mkRoot();
  sp.setSessionsRoot(root);
  const wsDir = path.join(path.dirname(root), 'storages');
  fs.mkdirSync(wsDir, { recursive: true });
  const ws = path.join(wsDir, 'workspace.json');
  fs.writeFileSync(ws, JSON.stringify({ global: { archivedSessionIds: ['s1', 's2'] } }));
  assert.deepEqual([...sp._dsh_archived_ids()].sort(), ['s1', 's2']);
  fs.writeFileSync(ws, JSON.stringify({ archivedSessionIds: ['s3'] }));         // 顶层直挂
  assert.deepEqual([...sp._dsh_archived_ids()], ['s3']);
  fs.writeFileSync(ws, '{bad json');
  assert.deepEqual([...sp._dsh_archived_ids()], []);                            // 坏文件 → 空集
  fs.rmSync(ws);
  assert.deepEqual([...sp._dsh_archived_ids()], []);                            // 文件缺失 → 空集
  // archives 参与 list_sessions 的 archived 标记
  fs.writeFileSync(ws, JSON.stringify({ global: { archivedSessionIds: ['session-00000000-0000-4000-8000-0000000000a9'] } }));
  const sid = 'session-00000000-0000-4000-8000-0000000000a9';
  writeSession(root, '--p--', sid, [headerFrame(sid)]);
  assert.equal(sp.list_sessions('dsh', '/p')[0].archived, true);
});

// ---------------------------------------------------------------- ⑦ 回退 / 媒体

test('dsh_user_anchors / dsh_fork_boundary：atSeq 取前一个（inclusive）', () => {
  const root = mkRoot();
  sp.setSessionsRoot(root);
  const sid = 'session-00000000-0000-4000-8000-0000000000g1'.replace('g', 'a');
  writeSession(root, '--p--', sid, fillFrames(sid));
  assert.deepEqual(sp.dsh_user_anchors(sid), [
    { mid: 'e2', eseq: 2, text: '第一问\n第二行' },
    { mid: 'e8', eseq: 8, text: '[图片]' },
  ]);
  assert.equal(sp.dsh_fork_boundary(sid, 'e2'), 1);
  assert.equal(sp.dsh_fork_boundary(sid, 'e8'), 7);
  assert.equal(sp.dsh_fork_boundary(sid, 'e0'), null);          // 会话里没有的锚点
  assert.equal(sp.dsh_fork_boundary(sid, ''), null);
  assert.equal(sp.dsh_fork_boundary('aaaaaaaa-0000-4000-8000-000000000000', 'e1'), null);
  assert.deepEqual(sp.dsh_user_anchors('aaaaaaaa-0000-4000-8000-000000000000'), []);
});

test('resolve_media（async）：族/形态校验 + 未注入返回 null + 同步/异步 fetcher 都能接', async () => {
  const mid = `sha256:${'c'.repeat(64)}`;
  assert.equal(await sp.resolve_media('kimi', 's', 'main', mid), null);
  assert.equal(await sp.resolve_media('dsh', 's', 'main', 'not-a-media-id'), null);
  assert.equal(await sp.resolve_media('dsh', 's', 'main', ''), null);
  assert.equal(await sp.resolve_media('dsh', 's', 'main', mid), null);   // 驱动未注入（≡ dshdriver 未配置）
  // 同步 fetcher 照旧可用
  sp.setMediaFetcher(() => ({ data: Buffer.from('hello').toString('base64'), content_type: 'image/png' }));
  const got = await sp.resolve_media('dsh', 's', 'main', mid);
  assert.equal(Buffer.isBuffer(got[0]), true);
  assert.equal(got[0].toString(), 'hello');
  assert.equal(got[1], 'image/png');
  // 空字节 / 空类型 / 坏 base64 → null（路由层据此落 404）
  sp.setMediaFetcher(() => ({ data: '', content_type: 'image/png' }));
  assert.equal(await sp.resolve_media('dsh', 's', 'main', mid), null);
  sp.setMediaFetcher(() => ({ data: Buffer.from('x').toString('base64'), content_type: '' }));
  assert.equal(await sp.resolve_media('dsh', 's', 'main', mid), null);
  sp.setMediaFetcher(() => ({ data: '!!!!', content_type: 'image/png' }));
  assert.equal(await sp.resolve_media('dsh', 's', 'main', mid), null);
  sp.setMediaFetcher(null);
});

/**
 * P1 评审守卫：**异步 fetcher（`dshdriver.media` 的真实形态）必须被 await**。
 *
 * 变异自证：把 `resolve_media` 里的 `await mediaFetcher(...)` 去掉 ⇒ 这里拿到 Promise，
 * `dget` 抛 PyTypeError ⇒ 返回 null ⇒ 第 1 条断言红；并伴随下面第 2 条
 * （未处理拒绝）在去掉 `await`/try-catch 时被抓出。
 */
test('resolve_media：async fetcher 必须被 await（去掉 await 即红）', async () => {
  const mid = `sha256:${'d'.repeat(64)}`;
  // ① 异步 fetcher 正常返回 ⇒ 必须拿到字节（不 await 会变成 null）
  sp.setMediaFetcher(async (id) => {
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(id, mid);
    return { data: Buffer.from('async-bytes').toString('base64'), content_type: 'image/jpeg' };
  });
  const got = await sp.resolve_media('dsh', 's', 'main', mid);
  assert.ok(got, 'async fetcher 的结果必须被 await（拿到 null 说明 await 丢了）');
  assert.equal(got[0].toString(), 'async-bytes');
  assert.equal(got[1], 'image/jpeg');

  // ② 异步 fetcher 拒绝 ⇒ 返回 null，且**不得**产生 unhandled rejection
  //    （去掉 await/try-catch 会让 Node 默认以未处理拒绝崩进程——评审实测 exit 1）
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    sp.setMediaFetcher(async () => { throw new Error('驱动 404'); });
    assert.equal(await sp.resolve_media('dsh', 's', 'main', mid), null);
    await new Promise((r) => setTimeout(r, 30));      // 给 unhandledRejection 上报留时间
    assert.deepEqual(unhandled, [], `不应有未处理拒绝：${unhandled.map((e) => e.message)}`);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  // ③ 非预期异常要留痕（P8）：附件不存在这类「预期」静默，接线类错误不静默
  const logs = [];
  const orig = console.error;
  console.error = (...args) => { logs.push(args.join(' ')); };
  try {
    sp.setMediaFetcher(() => ({ data: Buffer.from('x').toString('base64'), content_type: '' }));   // 无异常，只是空类型
    assert.equal(await sp.resolve_media('dsh', 's', 'main', mid), null);
    assert.equal(logs.length, 0, `预期内降级不应打日志：${logs.join(' | ')}`);
    sp.setMediaFetcher(() => { throw new TypeError('接线错了：fetcher 不是函数也不是 Promise'); });
    assert.equal(await sp.resolve_media('dsh', 's', 'main', mid), null);
    assert.equal(logs.length, 1, '非预期异常必须 console.error 留痕');
    assert.match(logs[0], /\[sessparse\] resolve_media/);
  } finally {
    console.error = orig;
    sp.setMediaFetcher(null);
  }
});

// ---------------------------------------------------------------- ⑧ 坏帧容错（验收第 3 条）

test('坏帧容错：尾部垃圾 / 半截帧 / 帧内截断都只丢坏帧，且与 Python 逐字节一致', {
  skip: !HAS_REAL ? '本机没有 ~/.dsh/sessions，跳过' : false,
}, () => {
  const root = mkRoot();
  sp.setSessionsRoot(root);
  // 挑一个真会话（中等大小，避免用例太慢）
  const cands = [];
  for (const bucket of fs.readdirSync(REAL_ROOT)) {
    const bpath = path.join(REAL_ROOT, bucket);
    if (!fs.statSync(bpath).isDirectory()) continue;
    for (const sid of fs.readdirSync(bpath)) {
      const dir = path.join(bpath, sid);
      if (!fs.statSync(dir).isDirectory()) continue;
      const f = sp._dsh_pick_file(dir);
      if (!f) continue;
      const size = fs.statSync(f).size;
      if (size > 200000) continue;
      cands.push({ bucket, sid, f, size });
    }
  }
  cands.sort((a, b) => a.size - b.size);
  assert.ok(cands.length > 0, '真会话里应有小文件');
  // 从中间开始找第一个「真能解析出条目」的（小会话里有不少是只有标题/元信息的）
  let pick = null;
  for (let k = Math.floor(cands.length / 2); k < cands.length; k += 1) {
    if (sp._parse_dsh(cands[k].f).entries.length > 0) { pick = cands[k]; break; }
  }
  assert.ok(pick, '真会话里应有可解析出条目的会话');
  const raw = fs.readFileSync(pick.f);
  const baseText = sp._dsh_decompressed(pick.f);
  const baseEntries = sp._parse_dsh(pick.f).entries.length;   // pick.f 就是事件流文件路径
  assert.ok(baseEntries > 0, '真会话应能解析出条目');

  const target = path.join(root, pick.bucket, pick.sid, 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // ① 尾部 21 字节垃圾（真机踩过的场景）
  fs.writeFileSync(target, Buffer.concat([raw, Buffer.alloc(21)]));
  const trash = sp.load('dsh', pick.sid, 'main');
  assert.equal(trash.found, true);
  assert.ok(trash.total >= baseEntries, `尾部垃圾不得丢历史：base=${baseEntries} got=${trash.total}`);
  // ② 尾部半截帧：取首帧的 60% 字节拼上去
  const frames = scanFrames(raw);
  const firstFrameBytes = Math.max(1, Math.floor((frames[0] ? frames[0].bytes : raw.length) * 0.6));
  fs.writeFileSync(target, Buffer.concat([raw, raw.subarray(0, firstFrameBytes)]));
  const half = sp.load('dsh', pick.sid, 'main');
  assert.equal(half.found, true);
  assert.ok(half.total >= baseEntries, `半截帧不得丢历史：base=${baseEntries} got=${half.total}`);
  // ③ 整文件在**末帧内**截断：前序帧的条目必须仍在（丢的是末帧及其后）。
  //    半帧里「已完整解出的块内容」由 `_dsh_decompressed` 的第二跳补齐
  //    （`decompressFrames().stoppedAt` + `zstdDecompressSync(…, {finishFlush: Z_NO_FLUSH})`），
  //    口径与 Python `decompressobj()` 的最后一次 `decompress()` 相同 ⇒ 逐字节一致。
  if (frames.length >= 2) {
    const last = frames[frames.length - 1];
    const cut = raw.subarray(0, last.start + Math.max(1, Math.floor(last.bytes * 0.6)));
    fs.writeFileSync(target, cut);
    const cutBody = sp.load('dsh', pick.sid, 'main');
    assert.equal(cutBody.found, true);
    assert.ok(cutBody.total > 0, '末帧内截断不得整段读空');
    assert.ok(cutBody.total <= baseEntries);
    assert.ok(sp._dsh_decompressed(target).length > 0);
    if (HAS_PY) {
      sp.cache_clear();
      const pyCut = pyOps([
        { op: 'decompressed_sha', path: target },
        { op: 'load', family: 'dsh', sid: pick.sid, agent: 'main', after: 0 },
        { op: 'meta', sid: pick.sid },
      ], root);
      const mine = sp._dsh_decompressed(target);
      assert.equal(pyCut[0].value.len_cp, [...mine].length, '帧内截断的解压文本码点数必须相等');
      assert.equal(pyCut[0].value.sha256,
        createHash('sha256').update(Buffer.from(mine, 'utf8')).digest('hex'), '帧内截断的解压文本必须逐字节相等');
      assert.deepEqual(sp.load('dsh', pick.sid, 'main'), pyCut[1].value);
      assert.deepEqual(sp._dsh_meta(target).titles, pyCut[2].value.titles);
    }
  }
  assert.ok(baseText.length > 0);
});

// ---------------------------------------------------------------- ⑨ 跨语言：真会话 + 合成会话

test('Python 对拍：真会话上 load/meta/title/first_prompt/list 逐字段一致', {
  skip: !(HAS_PY && HAS_REAL) ? '缺 python3+zstandard 或真会话存储，跳过' : false,
}, () => {
  // 挑 3 个真会话（1 主 + 1 子代理 + 1 无版本优先）
  sp.setSessionsRoot(REAL_ROOT);          // 前序用例改过全局根，这里复位到真存储
  const rows = [];
  for (const bucket of fs.readdirSync(REAL_ROOT)) {
    const bpath = path.join(REAL_ROOT, bucket);
    if (!fs.statSync(bpath).isDirectory()) continue;
    for (const sid of fs.readdirSync(bpath)) {
      const dir = path.join(bpath, sid);
      if (!fs.statSync(dir).isDirectory()) continue;
      const f = sp._dsh_pick_file(dir);
      if (!f) continue;
      rows.push({ bucket, sid, f, size: fs.statSync(f).size, ver: sp._dsh_format_version(f), sub: sp.is_subagent('dsh', sid) });
    }
  }
  const chosen = [
    rows.filter((r) => !r.sub && r.size < 300000).sort((a, b) => a.size - b.size)[0],
    rows.filter((r) => r.sub).sort((a, b) => a.size - b.size)[0],
    rows.filter((r) => r.ver === 0).sort((a, b) => a.size - b.size)[0],
  ].filter(Boolean);
  assert.ok(chosen.length >= 2, '真会话样本不足');
  const ops = [];
  for (const c of chosen) {
    ops.push({ op: 'load', family: 'dsh', sid: c.sid, agent: 'main', after: 0 });
    ops.push({ op: 'load', family: 'dsh', sid: c.sid, agent: 'main', after: 2 });
    ops.push({ op: 'meta', sid: c.sid });
    ops.push({ op: 'title', family: 'dsh', sid: c.sid });
    ops.push({ op: 'first_prompt', sid: c.sid });
    ops.push({ op: 'subagent', family: 'dsh', sid: c.sid });
    ops.push({ op: 'exists', family: 'dsh', sid: c.sid });
    ops.push({ op: 'anchors', sid: c.sid });
    ops.push({ op: 'fork_first', sid: c.sid });
    ops.push({ op: 'list', family: 'dsh', cwd: `/${c.bucket.slice(1, -2).replaceAll('-', '/')}` });
    ops.push({ op: 'bucket', cwd: `/${c.bucket.slice(1, -2).replaceAll('-', '/')}` });
  }
  sp.cache_clear();
  const py = pyOps(ops, null);              // 探针用默认根（真存储）；Node 侧同样是默认根
  const nodeOpsMap = {
    load: (o) => sp.load(o.family, o.sid, o.agent, o.after),
    meta: (o) => {
      const p = sp._dsh_session_file(o.sid);
      if (!p) return { path: null, title: '', prompt: '', titles: [] };
      const m = sp._dsh_meta(p);
      return { path: p, title: m.title, prompt: m.prompt, titles: m.titles };
    },
    title: (o) => sp.session_title(o.family, o.sid),
    first_prompt: (o) => sp.dsh_first_prompt(o.sid),
    subagent: (o) => sp.is_subagent(o.family, o.sid),
    exists: (o) => sp.session_exists(o.family, o.sid),
    anchors: (o) => sp.dsh_user_anchors(o.sid),
    fork_first: (o) => {
      const a = sp.dsh_user_anchors(o.sid);
      return a.length ? sp.dsh_fork_boundary(o.sid, a[0].mid) : null;
    },
    list: (o) => sp.list_sessions(o.family, o.cwd),
    bucket: (o) => sp.dsh_bucket(o.cwd),
  };
  ops.forEach((op, i) => {
    assert.equal(py[i].ok, true, `探针第 ${i} 条失败：${py[i].error}`);
    assert.deepEqual(nodeOpsMap[op.op](op), py[i].value, `op#${i} ${op.op} 两侧不一致`);
  });
});

test('Python 对拍：合成会话上 entry 序列逐字段一致（含截断/图片/坏行）', {
  skip: !HAS_PY ? '缺 python3+zstandard，跳过' : false,
}, () => {
  const root = mkRoot();
  sp.setSessionsRoot(root);
  const sid = 'session-00000000-0000-4000-8000-0000000000h1'.replace('h', 'a');
  writeSession(root, '--p--', sid, fillFrames(sid));
  sp.cache_clear();
  const ops = [
    { op: 'load', family: 'dsh', sid, agent: 'main', after: 0 },
    { op: 'meta', sid },
    { op: 'header', sid },
    { op: 'anchors', sid },
    { op: 'fork_first', sid },
    { op: 'list', family: 'dsh', cwd: '/p' },
    { op: 'trunc', text: '😀😀😀中文abc', limit: 4 },
    { op: 'prompt_tokens', usage: { totalTokens: 10, outputTokens: 3 } },
  ];
  const py = pyOps(ops, root);
  for (let i = 0; i < ops.length; i += 1) assert.equal(py[i].ok, true, py[i].error);
  assert.deepEqual(sp.load('dsh', sid, 'main'), py[0].value);
  const p = sp._dsh_session_file(sid);
  const m = sp._dsh_meta(p);
  assert.deepEqual({ path: p, title: m.title, prompt: m.prompt, titles: m.titles }, py[1].value);
  assert.deepEqual(sp._dsh_header(p), py[2].value);
  assert.deepEqual(sp.dsh_user_anchors(sid), py[3].value);
  assert.equal(sp.dsh_fork_boundary(sid, sp.dsh_user_anchors(sid)[0].mid), py[4].value);
  assert.deepEqual(sp.list_sessions('dsh', '/p'), py[5].value);
  assert.equal(sp._trunc('😀😀😀中文abc', 4), py[6].value);
  assert.equal(sp._dsh_prompt_tokens({ totalTokens: 10, outputTokens: 3 }), py[7].value);
});

/**
 * mtime 口径与边界行为（**双 Node 版本都必须绿**）。
 *
 * 2026-10-11 实测的两条事实（Node 22.19 上曾因此挂过一条用例，根因不是「浮点末位」）：
 *   ① **Node 22.19 的 `fs.utimesSync` 只到微秒**：`utimesSync(p, 1.000000001)` 落盘成
 *      `1000000000n`（Node 24 保留 `1000000001n`）。故**造纳秒样本必须用自然写入**
 *      （内核给 ns），不能用 utimesSync；
 *   ② 400 个静止真会话文件上，`statMtime()` 的「ns 拆分」公式与 Python `st_mtime` **400/400 逐位相等**，
 *      而 `mtimeMs/1000` **0/400**（integer-ms 截断丢亚毫秒）——`mtime` 是 `list_sessions`
 *      下发给看板的**参与对拍的字段**，故实现保留 ns 拆分公式，不换成 `mtimeMs/1000`。
 *
 * 用例本身按**行为**断言：跨语言只要求「同一个 sid + 同一相对次序」，边界判定留 ≥0.5s 余量，
 * 不对跨语言浮点做位级要求（位级相等是上面 400 个样本的实测结论，不是这里的前提）。
 */
test('mtime 口径（自然 mtime 与 Python 逐位相等）与 live/latest 边界行为（留余量）', {
  skip: !HAS_PY ? '缺 python3+zstandard，跳过' : false,
}, () => {
  const pyStat = (file) => JSON.parse(execFileSync(PYTHON, ['-c',
    'import json,os,sys;st=os.stat(sys.argv[1]);print(json.dumps([st.st_mtime, st.st_mtime_ns]))', file],
  { encoding: 'utf8' }));

  // ① 口径对拍：**自然写入**的文件（内核给 ns）上，Node 的 mtime 与 Python `st_mtime` 位级相等。
  //    （造纳秒样本必须靠自然写入：Node 22.19 的 utimesSync 只到微秒，实测 1.000000001 → 1.0）
  const rootA = mkRoot();
  sp.setSessionsRoot(rootA);
  const natural = writeSession(rootA, '--q--', 'session-00000000-0000-4000-8000-0000000000a3',
    [headerFrame('session-00000000-0000-4000-8000-0000000000a3')]);
  const pyNat = pyStat(natural);
  const natList = sp.list_sessions('dsh', '/q');
  assert.equal(natList.length, 1);
  assert.equal(natList[0].mtime, pyNat[0]);                    // 实测：静止真会话文件 400/400 位级相等
  assert.ok(pyNat[1] % 1000000 !== 0, '自然 mtime 应带亚毫秒部分（否则这条断言证明力不足）');

  // ② 边界行为：整秒级的 mtime 安排（避开 Node 22.19 的微秒截断），跨语言同结论、留 ≥0.5s 余量
  const rootB = mkRoot();
  sp.setSessionsRoot(rootB);
  const older = 'session-00000000-0000-4000-8000-0000000000a1';
  const newer = 'session-00000000-0000-4000-8000-0000000000a2';
  const pOld = writeSession(rootB, '--p--', older, [headerFrame(older)]);
  const pNew = writeSession(rootB, '--p--', newer, [headerFrame(newer)]);
  fs.utimesSync(pOld, 1000, 1000);
  fs.utimesSync(pNew, 1002, 1002);
  const pyOld = pyStat(pOld);
  assert.deepEqual(sp.list_sessions('dsh', '/p').map((x) => x.sid), [newer, older]);   // mtime 降序
  assert.equal(sp.list_sessions('dsh', '/p').find((x) => x.sid === older).mtime, pyOld[0]);
  const m = pyOld[0];
  // 语义：返回「mtime > since 的最新那个会话」，不是「since 之后最接近的那个」
  assert.equal(sp.live_session_id('dsh', '/p', m - 0.5), newer);   // 两个都在 since 之后 ⇒ 取更新的
  assert.equal(sp.live_session_id('dsh', '/p', m), newer);         // 严格「>」：older 不算命中，newer 仍算
  assert.equal(sp.live_session_id('dsh', '/p', 1001.5), newer);    // 只剩 newer 在 since 之后
  assert.equal(sp.live_session_id('dsh', '/p', 1002), '');         // 两者 mtime 都不 > since
  assert.equal(sp.live_session_id('dsh', '/p', 1002.5), '');
  assert.equal(sp.dsh_latest_session('/p'), newer);
  // 参数护栏：since<=0 / 空 cwd / 退场族
  assert.equal(sp.live_session_id('dsh', '/p', 0), '');
  assert.equal(sp.live_session_id('dsh', '/p', -1), '');
  assert.equal(sp.live_session_id('dsh', '', m - 0.5), '');
  assert.equal(sp.live_session_id('kimi', '/p', m - 0.5), '');

  // ③ 缓存 stamp 与 mtime 同源：把文件 touch 到别的秒 ⇒ stamp 变 ⇒ 重新解析（内容不变仍可读）
  sp.cache_clear();
  assert.equal(sp.load('dsh', older, 'main').found, true);
  fs.utimesSync(pOld, 1500, 1500);
  assert.equal(sp.load('dsh', older, 'main').found, true);
  assert.deepEqual(sp.list_sessions('dsh', '/p').map((x) => x.sid), [older, newer]);   // 次序随 mtime 翻转
});
