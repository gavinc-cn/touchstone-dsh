/**
 * 发包前自检 —— package.json 的 `prepack` 钩子（`npm pack` / `npm publish` 前自动执行）。
 *
 * 两道检查:
 *  ① **必需文件在不在**：本包是自包含的（插件壳 + Python 平台 + 预构建 webui/dist-plugin +
 *     内置提示词/内置资产），少任何一块装到 profile 里都跑不起来；
 *  ② **三处「包名」逐字一致**：包根 package.json 的 `name`、`dsh-plugin/cordis.patch.yml`
 *     里 insert 行的 `name`、`dsh-plugin/lib/client.bundle.js` 里 `__ModuleLoader__.load({id})`
 *     的 id —— dsh 宿主按注册行的包名给浏览器半预留模块槽，三者不一致时页面报
 *     "loaded without registering"（2026-10-07 改名 @gavinc-cn/touchstone-dsh 时踩过）。
 *
 * 任一项不过就非 0 退出，让 `npm pack` / `npm publish` 直接中断：宁可发不出去，不可发出坏包。
 * 用法: node dsh-plugin/scripts/prepack-check.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 包根（本脚本在 <包根>/dsh-plugin/scripts/ 下, 上溯三级） */
const PKG_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** 发到 npm 后用户装完必须存在的相对路径（缺一即坏包） */
const REQUIRED = [
  'package.json',
  'server.py',
  'requirements.txt',
  'builtin_prompts',
  'extensions/dsh-autocommit/asset.json',
  'webui/dist-plugin/index.html',
  'dsh-plugin/cordis.patch.yml',
  'dsh-plugin/lib/index.js',
  'dsh-plugin/lib/agent-driver.js',
  'dsh-plugin/lib/client.bundle.js',
  'dsh-plugin/install.sh',
  'dsh-plugin/scripts/select-bundle.mjs',
];

const failures = [];
for (const rel of REQUIRED) {
  if (!existsSync(join(PKG_ROOT, rel))) failures.push(`缺失: ${rel}`);
}

const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
const patch = readFileSync(join(PKG_ROOT, 'dsh-plugin/cordis.patch.yml'), 'utf8');
const bundle = readFileSync(join(PKG_ROOT, 'dsh-plugin/lib/client.bundle.js'), 'utf8');

// 包名一致性: cordis.patch.yml 的 insert name / 客户端 bundle 的模块 id 必须等于 package.json 的 name
if (!patch.includes(`name: "${pkg.name}"`)) {
  failures.push(`dsh-plugin/cordis.patch.yml 里的 insert name 不是 "${pkg.name}"（改包名后要同步）`);
}
if (!bundle.includes(`id: ${JSON.stringify(pkg.name)}`)) {
  failures.push(`dsh-plugin/lib/client.bundle.js 的模块 id 不是 "${pkg.name}"（跑 node dsh-plugin/scripts/build.mjs 重建）`);
}
if (pkg.private === true) failures.push('package.json 里 private: true, 发不出去（发布前删掉）');

if (failures.length > 0) {
  console.error(`prepack 自检未通过（${failures.length} 项）:`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`prepack 自检通过: ${pkg.name}@${pkg.version}, ${REQUIRED.length} 个必需路径齐全, 包名三处一致`);
