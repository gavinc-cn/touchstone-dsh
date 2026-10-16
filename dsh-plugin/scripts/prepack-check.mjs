/**
 * 发包前自检 —— package.json 的 `prepack` 钩子（`npm pack` / `npm publish` 前自动执行）。
 *
 * 三道检查:
 *  ① **必需文件在不在**：本包是自包含的（插件壳 + Python 平台 + 预构建 webui/dist-plugin +
 *     内置提示词/内置资产），少任何一块装到 profile 里都跑不起来；
 *  ② **三处「包名」逐字一致**：包根 package.json 的 `name`、`dsh-plugin/cordis.patch.yml`
 *     里 insert 行的 `name`、`dsh-plugin/lib/client.bundle.js` 里 `__ModuleLoader__.load({id})`
 *     的 id —— dsh 宿主按注册行的包名给浏览器半预留模块槽，三者不一致时页面报
 *     "loaded without registering"（2026-10-07 改名 @gavinc-cn/touchstone-dsh 时踩过）。
 *  ③ **闭包 ⊆ 白名单**（2026-10-15 新增）：从两个入口（`backend/server.js`、
 *     `dsh-plugin/lib/index.js`）正推运行时闭包（静态 import 图 + 运行时按路径读的数据根），
 *     与 `files` 展开结果比对。①的手写清单挡不住「新加了一个文件、忘了改白名单」——
 *     实测 0.1.1 发出去的包里 `backend/routes/` 11 个文件全缺，解包后
 *     `node backend/server.js` 直接 ERR_MODULE_NOT_FOUND（`backend/server.js:61` import 它）。
 *     算法在 `dsh-plugin/lib/pack-closure.mjs`（与 `tools/parity/test/pack-closure.test.mjs`
 *     **同一份**，不是一个抄一个）；这里只读文件、**绝不递归调用 `npm pack`**（会被自己再触发）。
 *
 * 任一项不过就非 0 退出，让 `npm pack` / `npm publish` 直接中断：宁可发不出去，不可发出坏包。
 * 用法: node dsh-plugin/scripts/prepack-check.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkPackClosure } from '../lib/pack-closure.mjs';

/** 包根（本脚本在 <包根>/dsh-plugin/scripts/ 下, 上溯三级） */
const PKG_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** 发到 npm 后用户装完必须存在的相对路径（缺一即坏包） */
const REQUIRED = [
  'package.json',
  'server.py',
  'requirements.txt',
  // Node 后端骨架（2026-10-11 M0）：profile 里配 `backend: node` 时薄壳拉起的就是它，
  // 缺了等于「开关一打开就起不来」——必须在发包自检里挡住。
  'backend/server.js',
  'backend/lib',
  // 数据层共享契约（2026-10-11 M1）：`backend/lib/db.js` 启动即读 schema.sql /
  // schema.json / migrations.json，缺了就是「Node 后端起不来」——同样必须在发包自检里挡住。
  'backend/schema/schema.sql',
  'backend/schema/schema.json',
  'backend/schema/migrations.json',
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

// 闭包 ⊆ 白名单: 从入口正推运行时必需文件, 逐条要求在 files 展开结果里
// （算法见 dsh-plugin/lib/pack-closure.mjs；只读文件, 不跑 npm pack ⇒ 可以安全地待在 prepack 里）
const closure = checkPackClosure(PKG_ROOT);
if (!closure.ok) {
  failures.push(`files 白名单漏了 ${closure.missing.length} 个运行时必需文件`
    + `（新增运行时文件/目录后忘了改 package.json 的 files 就会这样）:`);
  for (const rel of closure.missing) failures.push(`files 缺: ${rel}`);
}

if (failures.length > 0) {
  console.error(`prepack 自检未通过（${failures.length} 项）:`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`prepack 自检通过: ${pkg.name}@${pkg.version}, ${REQUIRED.length} 个必需路径齐全, 包名三处一致, `
  + `运行时闭包 ${closure.closure.files.length} 个文件全在白名单内`);
