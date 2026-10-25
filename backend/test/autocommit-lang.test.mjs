/**
 * `extensions/dsh-autocommit` agent 侧提示语言（T15 D）——`TS_AGENT_LANG` 兜底开关。
 *
 * 为什么这样测：插件运行在 DSH 宿主进程里、依赖 `@deepseek-ai/dsh-llm`（本仓不安装
 * node_modules），且 `buildReason` 不导出。这里把插件源码**拷到临时目录**，配一个
 * `node_modules/@deepseek-ai/dsh-llm` 桩，再用假 ctx/agent + 真临时 git 仓库驱动
 * `tools/pre-execute` 的 deny reason（= 交给模型的提示文本），不依赖宿主、不触网。
 *
 * 判据：
 *   - `TS_AGENT_LANG` unset / `zh` / 其它值 ⇒ 现有中文提示**逐字节**不变；
 *   - `TS_AGENT_LANG=en`（大小写/空白变体）⇒ 英文提示，结构/文件清单/提交要求一一对应；
 *   - stop / pretool 两个事件分支都覆盖；不改文件清单与防循环（一次阻断后按 maxBlocks 放行）。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SOURCE = path.join(ROOT, 'extensions', 'dsh-autocommit', 'pkg', 'lib', 'index.mjs');

/** 临时 HOME（标记文件不会命中真实用户目录）+ 插件副本 + dsh-llm 桩。 */
function makeHarness() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-autocommit-home-'));
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-autocommit-app-'));
  const stub = path.join(app, 'node_modules', '@deepseek-ai', 'dsh-llm', 'index.js');
  fs.mkdirSync(path.dirname(stub), { recursive: true });
  fs.writeFileSync(stub, 'export function createUserMessage(message) { return message }\n');
  const modPath = path.join(app, 'autocommit.mjs');
  fs.copyFileSync(SOURCE, modPath);
  return { home, app, modPath };
}

/** 临时 git 仓库 + 一个未提交文件（`checkpoint` 只依赖 `git status`/`rev-parse`）。 */
function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-autocommit-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
  return repo;
}

/** 临时 git 仓库 + count 个未提交文件（钉住文件数超过 MAX_MESSAGE_FILES 的缩略分支）。 */
function makeRepoWithFiles(count) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-autocommit-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const names = [];
  for (let i = 1; i <= count; i += 1) {
    const name = `f${String(i).padStart(2, '0')}.txt`;
    fs.writeFileSync(path.join(repo, name), 'changed\n');
    names.push(name);
  }
  return { repo, names };
}

const SESSION_ID = 'session-0123456789abcdef';
const TITLE = 'T15 test title';
const PREFIX = '--012345-- ';

/** 假 ctx：只记录 on() 注册的监听器；会话标题投影返回固定标题。 */
function fakeCtx() {
  const handlers = new Map();
  const ctx = {
    handlers,
    on(name, fn) {
      handlers.set(name, fn);
    },
    sessionProjections: { stateOf: () => TITLE },
  };
  return ctx;
}

/** 跑一次 checkpoint：返回 deny 的 reason（或 undefined=放行）。 */
async function runCheckpoint(mod, { repo, event }) {
  const ctx = fakeCtx();
  mod.apply(ctx, { logPath: path.join(path.dirname(repo), 'autocommit-test.log') });
  const session = { id: SESSION_ID, header: { cwd: repo } };
  ctx.handlers.get('session/event')(session, {
    type: 'tool/call',
    data: { name: 'write_file', arguments: JSON.stringify({ file_path: 'a.txt' }) },
  });
  const agent = { session, steer: () => {} };
  if (event === 'stop') {
    await ctx.handlers.get('agent/turn-stopping')({ agent });
    return undefined;                     // stop 分支走 steer，不返回 reason（下面单独断言）
  }
  const result = await ctx.handlers.get('tools/pre-execute')(
    { name: 'ask_user_question', agent }, () => ({ kind: 'next' }));
  return result;
}

/** 跑一次 pretool checkpoint；先把 names 全部登记为本次会话写过的文件。 */
async function runCheckpointForFiles(mod, { repo, names }) {
  const ctx = fakeCtx();
  mod.apply(ctx, { logPath: path.join(path.dirname(repo), 'autocommit-test.log') });
  const session = { id: SESSION_ID, header: { cwd: repo } };
  for (const name of names) {
    ctx.handlers.get('session/event')(session, {
      type: 'tool/call',
      data: { name: 'write_file', arguments: JSON.stringify({ file_path: name }) },
    });
  }
  const agent = { session, steer: () => {} };
  return ctx.handlers.get('tools/pre-execute')(
    { name: 'ask_user_question', agent }, () => ({ kind: 'next' }));
}

const ZH_HOW = '逐文件 `git add -- <路径>`（禁止 `git add -A`/`.`/`-u`），'
  + `提交消息首行用 "${PREFIX}<一句话摘要>"，正文一行 "session: (${TITLE})"；`
  + '只提交本次会话改动的文件，不要动工作区中其他未提交改动。';

const ZH_PRETOOL = `[自动检查点] 本次会话还有 1 个文件未提交：\n  - a.txt\n`
  + `请先提交这些文件，然后重新调用 ask_user_question 提出同一个问题：${ZH_HOW}`;
const ZH_STOP = `[自动检查点] 本次会话还有 1 个文件未提交：\n  - a.txt\n`
  + `请先提交这些文件再结束回合：${ZH_HOW}提交完成后即可正常结束。`;

const EN_HOW = 'Stage each file explicitly with `git add -- <path>` (never `git add -A` / `.` / `-u`); '
  + `use "${PREFIX}<one-line summary>" as the first line of the commit message and `
  + `"session: (${TITLE})" as one body line; `
  + 'commit only the files changed in this session and do not touch other uncommitted changes in the working tree.';
const EN_PRETOOL = `[Auto checkpoint] This session still has 1 uncommitted file(s):\n  - a.txt\n`
  + `Please commit these files first, then call ask_user_question again to ask the same question: ${EN_HOW}`;
const EN_STOP = `[Auto checkpoint] This session still has 1 uncommitted file(s):\n  - a.txt\n`
  + `Please commit these files before ending the turn: ${EN_HOW}You may end the turn normally once they are committed.`;

// 21 个文件（> MAX_MESSAGE_FILES=20）时只列前 20 条 + 后缀：en 后缀必须是英文（无 CJK），
// zh 后缀保持原有「（共 N 个）」逐字节不变。
const MANY_NAMES = Array.from({ length: 21 }, (_, i) => `f${String(i + 1).padStart(2, '0')}.txt`);
const ZH_MANY_LIST = MANY_NAMES.slice(0, 20).map((f) => `  - ${f}`).join('\n') + '\n  ...（共 21 个）';
const EN_MANY_LIST = MANY_NAMES.slice(0, 20).map((f) => `  - ${f}`).join('\n') + '\n  ... (21 files total)';
const ZH_PRETOOL_MANY = `[自动检查点] 本次会话还有 21 个文件未提交：\n${ZH_MANY_LIST}\n`
  + `请先提交这些文件，然后重新调用 ask_user_question 提出同一个问题：${ZH_HOW}`;
const EN_PRETOOL_MANY = `[Auto checkpoint] This session still has 21 uncommitted file(s):\n${EN_MANY_LIST}\n`
  + `Please commit these files first, then call ask_user_question again to ask the same question: ${EN_HOW}`;
// 英文提示不得残留 CJK 字符/标点（扫描口径与 webui 的 i18n 扫描器一致）
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff01-\uff60]/;

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_LANG = process.env.TS_AGENT_LANG;
const harness = makeHarness();
process.env.HOME = harness.home;
const mod = await import(pathToFileURL(harness.modPath).href);
process.env.HOME = ORIGINAL_HOME;

async function withAgentLang(value, fn) {
  if (value === undefined) delete process.env.TS_AGENT_LANG;
  else process.env.TS_AGENT_LANG = value;
  try {
    return await fn();                    // 必须等 checkpoint 跑完再还原 env（读 env 在 await 之后）
  } finally {
    if (ORIGINAL_LANG === undefined) delete process.env.TS_AGENT_LANG;
    else process.env.TS_AGENT_LANG = ORIGINAL_LANG;
  }
}

test('TS_AGENT_LANG unset/zh/其它值 ⇒ 中文提示逐字节不变（pretool 分支）', async () => {
  for (const value of [undefined, 'zh', '', 'fr', 'en-US', 'EN-US']) {
    await withAgentLang(value, async () => {
      const result = await runCheckpoint(mod, { repo: makeRepo(), event: 'pretool' });
      assert.equal(result.kind, 'deny');
      assert.equal(result.reason, ZH_PRETOOL, String(value));
    });
  }
});

test('TS_AGENT_LANG=en 大小写/空白变体 ⇒ 英文提示（pretool 分支）', async () => {
  for (const value of ['en', 'EN', ' en ']) {
    await withAgentLang(value, async () => {
      const result = await runCheckpoint(mod, { repo: makeRepo(), event: 'pretool' });
      assert.equal(result.kind, 'deny');
      assert.equal(result.reason, EN_PRETOOL, value);
    });
  }
});

test('stop 分支同样按语言选择：中文逐字节不变 / en 英文', async () => {
  const zhRepo = makeRepo();
  const zh = await withAgentLang(undefined, () => {
    const ctx = fakeCtx();
    mod.apply(ctx, { logPath: path.join(path.dirname(zhRepo), 'autocommit-test.log') });
    const session = { id: SESSION_ID, header: { cwd: zhRepo } };
    ctx.handlers.get('session/event')(session, {
      type: 'tool/call',
      data: { name: 'write_file', arguments: JSON.stringify({ file_path: 'a.txt' }) },
    });
    const steered = [];
    return ctx.handlers.get('agent/turn-stopping')({
      agent: { session, steer: (msg) => steered.push(msg) },
    }).then(() => steered);
  });
  assert.equal(zh.length, 1);
  assert.equal(zh[0].content[0].text, ZH_STOP);

  const enRepo = makeRepo();
  const en = await withAgentLang('en', () => {
    const ctx = fakeCtx();
    mod.apply(ctx, { logPath: path.join(path.dirname(enRepo), 'autocommit-test.log') });
    const session = { id: SESSION_ID, header: { cwd: enRepo } };
    ctx.handlers.get('session/event')(session, {
      type: 'tool/call',
      data: { name: 'write_file', arguments: JSON.stringify({ file_path: 'a.txt' }) },
    });
    const steered = [];
    return ctx.handlers.get('agent/turn-stopping')({
      agent: { session, steer: (msg) => steered.push(msg) },
    }).then(() => steered);
  });
  assert.equal(en.length, 1);
  assert.equal(en[0].content[0].text, EN_STOP);
});

test('防循环不变：同一（事件, 文件集合）超过 maxBlocks 后放行', async () => {
  const repo = makeRepo();
  const ctx = fakeCtx();
  mod.apply(ctx, { maxBlocks: 2, logPath: path.join(path.dirname(repo), 'autocommit-test.log') });
  const session = { id: `${SESSION_ID}-loop`, header: { cwd: repo } };
  ctx.handlers.get('session/event')(session, {
    type: 'tool/call',
    data: { name: 'write_file', arguments: JSON.stringify({ file_path: 'a.txt' }) },
  });
  const agent = { session, steer: () => {} };
  const seen = [];
  for (let i = 0; i < 3; i += 1) {
    seen.push(await ctx.handlers.get('tools/pre-execute')(
      { name: 'ask_user_question', agent }, () => ({ kind: 'next' })));
  }
  assert.deepEqual(seen.map((r) => r.kind), ['deny', 'deny', 'next']);
});

test('>20 个文件：en 后缀为英文且无 CJK，zh 保持「（共 N 个）」逐字节不变', async () => {
  const zh = await withAgentLang(undefined, () => {
    const { repo, names } = makeRepoWithFiles(21);
    return runCheckpointForFiles(mod, { repo, names });
  });
  assert.equal(zh.kind, 'deny');
  assert.equal(zh.reason, ZH_PRETOOL_MANY);
  assert.ok(zh.reason.includes('（共 21 个）'));

  for (const value of ['en', 'EN', ' en ']) {
    const en = await withAgentLang(value, () => {
      const { repo, names } = makeRepoWithFiles(21);
      return runCheckpointForFiles(mod, { repo, names });
    });
    assert.equal(en.kind, 'deny', value);
    assert.equal(en.reason, EN_PRETOOL_MANY, value);
    assert.ok(en.reason.includes(' (21 files total)'), value);
    assert.ok(!CJK_RE.test(en.reason), `${value}: 英文提示残留 CJK`);
  }
});
