/**
 * `dsh-plugin/install.sh` 自检（不经 dsh，2026-10-15 M8）。
 *
 * 用法: node dsh-plugin/scripts/dev-check-install.mjs
 * 退出码: 0=全过, 1=有失败项。
 *
 * 为什么需要它：插件缺省后端翻成 node 的**全部收益**就是「装插件不再要求用户机器上有
 * Python 与 pip」，而这句话只有在**安装路径**上也成立才算数。此前 `install.sh` 在探不到
 * 解释器时直接 `exit 1`（"错误: 未找到可用的 Python 解释器"）—— 缺省已经是 node，用户却
 * 连装都装不上（探到解释器只是为了让 pip 装 Python 版依赖，而那条链现在默认根本不走）。
 *
 * 做法：造一个**假仓库 + 假 HOME + 受控 PATH**，跑**真 install.sh** 并断言：
 *   A 本机无 Python ⇒ exit 0、给一行提示、**不**往配置里塞 `pythonPath`、且真的走到
 *     `dsh plugin add`（桩 dsh 留痕）——这是本档的主判据；
 *   B 本机有 Python ⇒ exit 0、无提示、配置行给 `pythonPath`（显式 `backend: python`
 *     回滚要用），并带上回滚说明；
 *   C 负对照：同一个「无 Python」环境里，任何「没有解释器就得失败」的探法都必须失败
 *     （证明 A 的绿不是环境自带的）。
 *
 * 桩（受控 PATH 里只有这些，真 python/python3 一律进不来）：`bash`/`node`/`dirname`
 * 指向真二进制；`dsh`/`pnpm` 是只打印一行的桩（**绝不真装包**——真 dsh 会往真实 profile
 * 里写 package.json）。`TS_DSH_PROFILE=web` 配假 HOME ⇒ 落点全在临时目录里。
 *
 * 测试替身（如实登记）：`install.sh` 的解释器候选含**绝对路径**
 * `/opt/{mini,ana}conda3/envs/…/bin/python3`（写成 `…` 是为了不把本注释提前闭合），
 * 而本机 `/opt/miniconda3` 真实存在 ⇒
 * 「无 Python」这一档只能把这两个绝对候选 sed 到一个不存在的根（`/nonexistent-conda`）。
 * 替身只动**环境**（候选指向哪），不动被测逻辑（`pick_python` 的探测链、探不到之后的分支
 * 与输出）；C 场景用同一替身做负对照 ⇒ 替身本身也被判据覆盖。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO_DIR = path.resolve(import.meta.dirname, '..', '..');
const INSTALL_SRC = path.join(REPO_DIR, 'dsh-plugin', 'install.sh');
const SELECT_BUNDLE = path.join(REPO_DIR, 'dsh-plugin', 'scripts', 'select-bundle.mjs');
/** 绝对 conda 候选的真前缀与替身前缀（见文件头「测试替身」） */
const CONDA_REAL = '/opt/{mini,ana}conda3/envs/*/bin/python3';
const CONDA_STUB = '/nonexistent-conda/envs/*/bin/python3';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : '  → ' + detail}`);
  if (!ok) failures++;
}

/** 造一套隔离环境：假仓库（install.sh 所在处）+ 假 HOME + 受控 PATH。 */
function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-install-check-'));
  const bin = path.join(root, 'bin');
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(repo, 'dsh-plugin', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'webui', 'dist-plugin'), { recursive: true });
  fs.mkdirSync(path.join(home, '.dsh', 'profiles', 'web'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });

  // 假仓库：install.sh 只需要这三样（包名、预构建产物、选 bundle 的脚本）
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"@gavinc-cn/touchstone-dsh"}\n');
  fs.writeFileSync(path.join(repo, 'webui', 'dist-plugin', 'index.html'), '<!-- stub -->\n');
  fs.copyFileSync(SELECT_BUNDLE, path.join(repo, 'dsh-plugin', 'scripts', 'select-bundle.mjs'));
  // 假 profile：select-bundle.mjs 要改它的 package.json
  fs.writeFileSync(path.join(home, '.dsh', 'profiles', 'web', 'package.json'), '{}\n');

  // 受控 PATH：真 bash/node/dirname + 桩 dsh/pnpm（桩只打印，绝不真装）
  for (const exe of ['bash', 'node', 'dirname']) {
    fs.symlinkSync(execFileSync('bash', ['-c', `command -v ${exe}`], { encoding: 'utf8' }).trim(),
      path.join(bin, exe));
  }
  for (const exe of ['dsh', 'pnpm']) {
    fs.writeFileSync(path.join(bin, exe), `#!/bin/sh\necho "STUB ${exe} $*"\n`);
    fs.chmodSync(path.join(bin, exe), 0o755);
  }
  return { root, bin, repo, home };
}

/**
 * 跑一次真 install.sh：`stubConda` ⇒ 把绝对 conda 候选指到不存在的根（模拟「本机无 Python」）。
 * 返回 { status, out }（stdout+stderr 合并，判据只看文本片段）。
 */
function runInstall(env, stubConda) {
  const target = path.join(env.repo, 'dsh-plugin', 'install.sh');
  let src = fs.readFileSync(INSTALL_SRC, 'utf8');
  if (stubConda) {
    if (!src.includes(CONDA_REAL)) {
      throw new Error(`install.sh 里找不到绝对 conda 候选（${CONDA_REAL}）：测试替身失效，先核对脚本`);
    }
    src = src.replace(CONDA_REAL, CONDA_STUB);
  }
  fs.writeFileSync(target, src);
  try {
    const out = execFileSync(path.join(env.bin, 'bash'), [target], {
      cwd: env.repo,
      env: { HOME: env.home, PATH: env.bin, TS_DSH_PROFILE: 'web' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, out };
  } catch (error) {
    return { status: error.status === undefined || error.status === null ? -1 : error.status,
      out: String(error.stdout || '') + String(error.stderr || '') };
  }
}

/** 负对照探法：同一个无 Python 环境里，任何要求解释器的做法都必须失败。 */
function probeNoPython(env) {
  try {
    execFileSync(path.join(env.bin, 'bash'),
      ['-c', 'command -v python >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1 || exit 1'],
      { env: { HOME: env.home, PATH: env.bin }, encoding: 'utf8' });
    return { status: 0, out: '' };
  } catch (error) {
    return { status: error.status === undefined || error.status === null ? -1 : error.status,
      out: String(error.stdout || '') + String(error.stderr || '') };
  }
}

console.log('== install.sh 自检（无 Python 也能装 / 有 Python 给 pythonPath / 负对照）==');
const env = makeEnv();
try {
  // ---- A 本机无 Python（缺省后端已是 node ⇒ 不该拦） ----
  const a = runInstall(env, true);
  check('A 无 Python ⇒ install.sh exit 0（不再被解释器卡住）', a.status === 0, `exit=${a.status} ${a.out}`);
  check('A 无 Python ⇒ 给一行提示且说明不影响安装',
    a.out.includes('未找到 Python 解释器') && a.out.includes('不影响安装'), a.out);
  check('A 无 Python ⇒ 真走到 dsh plugin add（不是提前 return）',
    a.out.includes('STUB dsh plugin'), a.out);
  check('A 无 Python ⇒ 配置行**不**塞 pythonPath（塞了就会让薄壳去找不存在的解释器）',
    !/^\s*config:.*pythonPath/m.test(a.out), a.out);
  check('A 无 Python ⇒ 收尾明说缺省 Node 后端可用',
    a.out.includes('缺省 Node 后端直接可用'), a.out);
  check('A 无 Python ⇒ dsh.profile.bundles 已被写进假 profile（端到端真落盘）',
    fs.readFileSync(path.join(env.home, '.dsh', 'profiles', 'web', 'package.json'), 'utf8')
      .includes('@gavinc-cn/touchstone-dsh'),
    fs.readFileSync(path.join(env.home, '.dsh', 'profiles', 'web', 'package.json'), 'utf8'));

  // ---- C 负对照：这个环境里确实没有 Python 可探（A 的绿不是环境自带的） ----
  const c = probeNoPython(env);
  check('C 负对照 ⇒ 同一环境里「必须有解释器」的探法必须失败（证明 A 的环境真没 Python）',
    c.status !== 0, `exit=${c.status}`);

  // ---- B 本机有 Python（候选未打桩 ⇒ 命中真解释器）：给 pythonPath 与回滚说明 ----
  const b = runInstall(env, false);
  check('B 有 Python ⇒ install.sh exit 0', b.status === 0, `exit=${b.status} ${b.out}`);
  check('B 有 Python ⇒ 无「未找到解释器」提示', !b.out.includes('未找到 Python 解释器'), b.out);
  check('B 有 Python ⇒ 配置行给 pythonPath（回滚到 Python 后端要用）',
    /^\s*config:.*pythonPath: \S+/m.test(b.out), b.out);
  check('B 有 Python ⇒ 收尾给出回滚说明（显式 backend: python；删键等于 node）',
    b.out.includes('backend: python') && b.out.includes('删掉 backend 键等于 node'), b.out);
} finally {
  fs.rmSync(env.root, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nOVERALL: PASS' : `\nOVERALL: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
