/**
 * 运行依赖预检自检（不经 dsh）：用假解释器驱动 lib/index.js 的依赖预检分支（2026-10-07）。
 *
 * 用法: node scripts/dev-check-deps.mjs
 * 退出码: 0=全过, 1=有失败项。
 *
 * 为什么需要它：npm 安装路径下，用户常常只 `dsh plugin add` 而没跑
 * `pip install -r requirements.txt`；此时 server.py 在**导入期**就退出
 * （sessparse.py 模块级 `import zstandard`、feishu.py 模块级 `import requests`），
 * 面板只会看到 503 JSON、日志只有一行 traceback。本 harness 把三条钉死：
 *   ① 缺硬依赖 → **不拉起后端**，日志给出可复制的修复命令；
 *   ② 面板返回提示页（含缺失名 + 修复命令 + 重试指引），不是裸 JSON；
 *   ③ 预检自身跑不成（输出不可解析）→ **照常启动**（铁律：预检绝不挡启动），
 *      且依赖齐全时 backendHint 被清空，不给用户留上一次的残页。
 * 另验预检参数装配：硬依赖名写死、可选依赖名读自 requirements.txt（注释/版本约束剥掉）。
 * 2026-10-11 增两条（用户口径「兜底应该用 python, 不要用 python3」）：
 *   ④ 未配置 pythonPath ⇒ 按 `python` → `python3` 探到解释器, 并在提示页明说「这是缺省探测到的」;
 *   ⑤ 一个都探不到（PATH 只留空目录）⇒ 不拉起后端, 面板给「装 Python / 配 pythonPath」提示页。
 * 假解释器只回答预检那条 `-c` 调用，其余一律 exit 1（模拟 server.py 起不来）——
 * 这样无需真 Python 也能验分支；真解释器的 JSON 契约由本文件末的「真解释器」一节复核。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { apply } from '../lib/index.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : '  → ' + detail}`);
  if (!ok) failures++;
}

/** 桩 ctx：只要 webServer（注册路由）与 logger（捕获日志）；loader 缺席即断言「在挂」。 */
function makeCtx(webServer, logs) {
  return {
    fiber: { stub: true },
    logger: () => ({
      info: (m) => logs.push(`info:${m}`),
      warn: (m) => logs.push(`warn:${m}`),
      error: (m) => logs.push(`error:${m}`),
      debug: () => {},
    }),
    get(name) {
      if (name === 'webServer') return webServer;
      return undefined;
    },
    inject() { return { dispose() {} }; },
  };
}

/** 桩 webServer：只记注册，返回注销函数。 */
function makeWebServer() {
  const prefixes = new Map();
  return {
    port: 0,
    prefixes,
    register(route) {
      prefixes.set(route.path, route);
      return () => { prefixes.delete(route.path); };
    },
  };
}

/** 假仓库：有 server.py（存在性检查过）与 requirements.txt（供预检装配可选依赖名）。 */
function makeFakeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-deps-check-'));
  fs.writeFileSync(path.join(dir, 'server.py'), '# 假后端: 本 harness 不真跑 Python\n');
  fs.writeFileSync(path.join(dir, 'requirements.txt'), [
    '# 注释行应被跳过',
    'zstandard>=0.25.0',
    'requests>=2.31',
    'lark-oapi>=1.3.0',
    'psutil>=5.9.0',
    '',
  ].join('\n'));
  return dir;
}

/**
 * 假解释器：每次调用往 callsFile 记一行，只有 `-c`（预检/探测）作答，
 * 其余调用 exit 1（后端起不来）。
 * 两类 `-c` 要分开（两者都是 `-c`, 否则探测会污染预检的调用记录）：
 *   - 探测（`$2` 带 touchstone-python-probe 标记）⇒ 只 exit 0, **不记录**;
 *   - 依赖预检 ⇒ 记一行 `preflight fatal=$3 advisory=$4` 并按 stdoutText 作答。
 * 默认就叫 `python`（不是 fakepython.sh）: 这样**不配 pythonPath** 时, 缺省探测链
 * （python → python3）也能在受控 PATH 下命中它 —— 缺省探测分支才验得动。
 */
function makeFakePython(dir, callsFile, stdoutText) {
  const file = path.join(dir, 'python');
  const quoted = `'${String(stdoutText).replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(file, [
    '#!/bin/sh',
    'if [ "$1" = "-c" ]; then',
    '  case "$2" in',
    '    *touchstone-python-probe*) exit 0 ;;',
    '  esac',
    // 只记关心的两个参数: 脚本本体是多行的, 直接 echo "$2" 会把日志撑成多行
    `  echo "preflight fatal=$3 advisory=$4" >> "${callsFile}"`,
    `  printf '%s\\n' ${quoted}`,
    '  exit 0',
    'fi',
    `echo "spawn" >> "${callsFile}"`,
    'exit 1',
    '',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
  return file;
}

const readCalls = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 子进程启动是异步的：等到调用数达标为止（超时返回当前实况，让断言给出真实 detail）。 */
async function waitForCalls(file, count, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && readCalls(file).length < count) {
    await sleep(30);
  }
  return readCalls(file);
}

/** 直接调 proxy 处理器，拿回 (status, contentType, body)。 */
function callProxy(webServer) {
  const route = webServer.prefixes.get('/touchstone');
  if (!route) return { status: 0, contentType: '', body: '' };
  let status = 0;
  let contentType = '';
  let body = '';
  route.handler(
    { url: '/touchstone/', method: 'GET', headers: {}, pipe: () => {} },
    {
      writeHead: (code, headers) => { status = code; contentType = (headers || {})['content-type']; },
      end: (chunk) => { body = String(chunk); },
    },
  );
  return { status, contentType, body };
}

const HINT_JSON = '{"fatal":["zstandard"],"advisory":["lark-oapi","psutil"]}';
const OK_JSON = '{"fatal":[],"advisory":[]}';

/**
 * 跑一个场景。`opts` 三选一：
 *   { pythonPath }        —— 配置里显式给解释器（假解释器路径, 旧场景用）
 *   { pathDir }           —— 不给 pythonPath, 只把 PATH 换成一个目录（验缺省探测链）
 *   { pathDir: null }     —— 不给 pythonPath, PATH 置空（验「一个都探不到」）
 * PATH 覆盖**只经 extraEnv 下发**, 不动 process.env：探测是异步的（spawn 在 await 之后才发生）,
 * 改完在 finally 里还原会与探测竞态 —— 会让探测用回真 PATH, 场景结论全错（首版踩到）。
 */
async function scenario(label, stdoutText, opts = {}) {
  const dir = makeFakeRepo();
  const callsFile = path.join(dir, 'calls.log');
  // 假解释器就叫 `python` 且放在 repoDir 下：不配 pythonPath 时, 缺省探测链
  // （python → python3）在下面的受控 PATH 里正好命中它, 缺省分支才验得动。
  const fakePython = makeFakePython(dir, callsFile, stdoutText);
  const logs = [];
  const webServer = makeWebServer();
  const ctx = makeCtx(webServer, logs);
  console.log(`\n-- ${label}`);
  const config = { repoDir: dir };
  if (opts.pythonPath) config.pythonPath = fakePython;
  // PATH 只留本场景的目录（或置空）——不配 pythonPath 时, 探测与 spawn 都只看这里
  config.extraEnv = { PATH: opts.pathDir === null ? '' : (opts.pathDir || dir) };
  const dispose = await apply(ctx, config);
  return { dir, callsFile, logs, webServer, dispose: dispose || (() => {}) };
}

async function main() {
  console.log('== 运行依赖预检自检（缺依赖 / 齐全 / 预检自身失败）==');
  const leftovers = [];
  try {
    // ---- 场景 A：缺硬依赖（zstandard）→ 不拉起后端 + 提示页 ----
    const a = await scenario('缺硬依赖', HINT_JSON);
    leftovers.push(a);
    // 反向断言要给足时间: 若实现真去 spawn, 假解释器会立刻多记一行
    await sleep(400);
    const aCalls = readCalls(a.callsFile);
    // 2026-10-11 起缺省探测会先跑一次探针调用（带 probe 标记, 假解释器不记）, 所以断言
    // 「恰好一条 preflight 记录、且没有 spawn 记录」——比数调用条数更能表达真意图。
    check('缺硬依赖时只调用预检、不拉起后端',
      aCalls.length === 1 && aCalls[0].startsWith('preflight '), JSON.stringify(aCalls));
    check('预检参数装配正确（硬依赖写死 + 可选依赖读 requirements.txt）',
      aCalls[0] === 'preflight fatal=zstandard,requests advisory=lark-oapi,psutil',
      aCalls[0]);
    check('日志给出缺失项与可复制的修复命令',
      a.logs.some((l) => l.includes('运行依赖缺失: zstandard'))
      && a.logs.some((l) => l.includes('pip install -r'))
      && a.logs.some((l) => l.includes('停用再启用')),
      JSON.stringify(a.logs));
    const aProxy = callProxy(a.webServer);
    check('面板返回提示页而非裸 JSON',
      aProxy.status === 503 && aProxy.contentType.includes('text/html')
      && aProxy.body.startsWith('<!doctype html>'),
      JSON.stringify({ status: aProxy.status, ct: aProxy.contentType }));
    check('提示页含缺失名 / 修复命令 / 重试指引',
      aProxy.body.includes('zstandard') && aProxy.body.includes('pip install -r')
      && aProxy.body.includes('停用再启用'));
    await a.dispose();

    // ---- 场景 B：依赖齐全 → 照常拉起后端 + 提示页清空 ----
    const b = await scenario('依赖齐全', OK_JSON);
    leftovers.push(b);
    const bCalls = await waitForCalls(b.callsFile, 2);
    check('依赖齐全时照常拉起后端（预检 + 启动 = 两次调用）',
      bCalls.length === 2 && bCalls[0].startsWith('preflight ') && bCalls[1] === 'spawn',
      JSON.stringify(bCalls));
    check('依赖齐全时无「依赖缺失」告警',
      !b.logs.some((l) => l.includes('运行依赖缺失')), JSON.stringify(b.logs));
    const bProxy = callProxy(b.webServer);
    check('面板回到 503 JSON（上一次的提示页不残留）',
      bProxy.status === 503 && bProxy.contentType.includes('application/json')
      && bProxy.body === '{"error":"touchstone 后端尚未就绪, 稍后重试"}',
      JSON.stringify({ status: bProxy.status, ct: bProxy.contentType, body: bProxy.body }));
    await b.dispose();

    // ---- 场景 C：预检自身输出不可解析 → 照常启动（铁律） ----
    const c = await scenario('预检输出不可解析', '不是 JSON');
    leftovers.push(c);
    const cCalls = await waitForCalls(c.callsFile, 2);
    check('预检输出不可解析时照常拉起后端',
      cCalls.length === 2 && cCalls[1] === 'spawn', JSON.stringify(cCalls));
    check('预检失败有告警但不阻断',
      c.logs.some((l) => l.includes('依赖预检未完成')), JSON.stringify(c.logs));
    await c.dispose();

    // ---- 场景 D：未配置 pythonPath → 缺省探测链（python → python3） ----
    // PATH 只留 repoDir（里面有可执行的 `python`、没有 python3）, 既验「缺省探测」也验顺序。
    const d = await scenario('未配置 pythonPath（PATH 里只有 python）', HINT_JSON);
    leftovers.push(d);
    check('缺省探到 python 并写进日志（不是 python3）',
      d.logs.some((l) => l.includes('缺省探到解释器: python')), JSON.stringify(d.logs));
    check('缺省探测时预检仍照常跑（缺依赖 ⇒ 不拉起后端, 只有一条 preflight）',
      readCalls(d.callsFile).length === 1
      && readCalls(d.callsFile)[0].startsWith('preflight '), JSON.stringify(readCalls(d.callsFile)));
    const dProxy = callProxy(d.webServer);
    check('提示页命令用探到的解释器, 且标明「缺省探测」与配置入口',
      dProxy.body.includes('python -m pip install -r')
      && dProxy.body.includes('缺省探测') && dProxy.body.includes('pythonPath'),
      dProxy.body.slice(0, 200));
    await d.dispose();

    // ---- 场景 E：一个解释器都探不到 → 不拉起后端, 面板给「装 Python / 配 pythonPath」提示页 ----
    const e = await scenario('PATH 为空（探不到解释器）', HINT_JSON, { pathDir: null });
    leftovers.push(e);
    check('探不到解释器时不拉起后端（无任何子进程调用）',
      readCalls(e.callsFile).length === 0, JSON.stringify(readCalls(e.callsFile)));
    check('日志给出「找不到 Python 解释器」与配置指引',
      e.logs.some((l) => l.includes('找不到 Python 解释器'))
      && e.logs.some((l) => l.includes('pythonPath')), JSON.stringify(e.logs));
    // 探不到解释器时 apply 早退：**不注册路由**（面板会拿不到任何响应, 不是提示页）——
    // 这条不变量本身要钉住, 免得以后有人在这里悄悄注册了半死路由。
    check('探不到解释器时不注册 /touchstone 路由（申请早退, 不半死挂载）',
      !e.webServer.prefixes.has('/touchstone'),
      JSON.stringify([...e.webServer.prefixes.keys()]));
    await e.dispose();

    // ---- 真解释器：复核预检脚本的 JSON 契约（缺名必报、有名不报） ----
    // 探针脚本与 lib/index.js 里那份同源；这里只验它对本机真解释器的行为。
    // 解释器不写死 python3：与 lib/index.js 同口径, 用同一入口探（python → python3）,
    // 否则会出现「薄壳在本机探到 python、本 harness 却还在调 python3」的口径分裂。
    const resolved = execFileSync(process.execPath, [path.resolve(import.meta.dirname, '../lib/index.js'), '--resolve-python'],
      { encoding: 'utf8', timeout: 20000 }).trim();
    const probe = [
      'import importlib, importlib.metadata as md, json, sys',
      'fatal, rest = sys.argv[1].split(","), sys.argv[2].split(",")',
      'out = {"fatal": [], "advisory": []}',
      'for mod in fatal:',
      '    try: importlib.import_module(mod)',
      '    except Exception: out["fatal"].append(mod)',
      'for dist in rest:',
      '    if not dist: continue',
      '    try: md.version(dist)',
      '    except Exception: out["advisory"].append(dist)',
      'print(json.dumps(out))',
    ].join('\n');
    let realOk = true;
    let realDetail = '';
    try {
      const out = execFileSync(resolved, ['-c', probe, 'no_such_mod_x', 'no-such-dist-x'],
        { encoding: 'utf8', timeout: 15000 }).trim();
      const parsed = JSON.parse(out);
      realOk = parsed.fatal.length === 1 && parsed.fatal[0] === 'no_such_mod_x'
        && parsed.advisory.length === 1 && parsed.advisory[0] === 'no-such-dist-x';
      realDetail = out;
    } catch (error) {
      realOk = false;
      realDetail = String(error && error.message).slice(0, 120);
    }
    check('真解释器上探针契约正确（不存在的模块/发行名各报一条）', realOk, realDetail);
  } finally {
    for (const item of leftovers) {
      try {
        fs.rmSync(item.dir, { recursive: true, force: true });
      } catch { /* 清理失败不影响结论 */ }
    }
  }

  console.log(failures === 0 ? '\nOVERALL: PASS' : `\nOVERALL: FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('harness error:', error);
  process.exit(1);
});
