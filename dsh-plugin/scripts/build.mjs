/**
 * 客户端 bundle 打包: 把 src/client.js(纯函数体)包装为 dsh 懒加载 CJS 模块 factory
 * （形态逐字对齐 kanban-board/lib/client.bundle.js; 无打包器依赖——客户端只依赖宿主播种的 react）。
 * 用法: node scripts/build.mjs  → lib/client.bundle.js
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(root, 'src', 'client.js'), 'utf8');
const out = `window.__ModuleLoader__.load({
\tid: "touchstone",
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
console.log('client.bundle.js written');
