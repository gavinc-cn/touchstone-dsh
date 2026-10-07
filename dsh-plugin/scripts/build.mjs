/**
 * 客户端 bundle 打包: 把 src/client.js(纯函数体)包装为 dsh 懒加载 CJS 模块 factory
 * （形态逐字对齐 kanban-board/lib/client.bundle.js; 无打包器依赖——客户端只依赖宿主播种的 react）。
 * 用法: node scripts/build.mjs  → lib/client.bundle.js
 *
 * 模块 id 取自**包名**（仓库根 package.json 的 name），不写死:
 *   dsh 宿主按「注册行的包名」给浏览器半预留模块槽, bundle 里的 id 必须逐字相等,
 *   否则页面报 "loaded without registering"。2026-10-07 包名改为 @gavinc-cn/touchstone-dsh
 *   （原名 touchstone 已被 npm 上的他人占用）时, 就是靠这里改一次、重跑本脚本同步的。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, '..', 'package.json'), 'utf8'));
if (!pkg.name || typeof pkg.name !== 'string') {
  throw new Error(`包根 package.json 缺少 name: ${join(root, '..', 'package.json')}`);
}
const src = readFileSync(join(root, 'src', 'client.js'), 'utf8');
const out = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
\t\tconst React = require("react");
${src}
\t\texports.inject = ["slots"];
\t\texports.apply = apply;
\t\treturn module.exports;
\t}
});
`;
mkdirSync(join(root, 'lib'), { recursive: true });
writeFileSync(join(root, 'lib', 'client.bundle.js'), out);
console.log(`client.bundle.js written (id=${pkg.name})`);
