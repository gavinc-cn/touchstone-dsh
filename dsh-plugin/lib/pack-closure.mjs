/**
 * 发包闭包计算 —— 「npm 包里必须有哪些文件」的**唯一一份**算法（零依赖，只用 `node:`）。
 *
 * 为什么要有它：`package.json` 的 `files` 是**白名单**，漏一条就是「发出去的包起不来」，
 * 而漏的形态是静默的 —— 2026-10-15 实测 `@gavinc-cn/touchstone-dsh@0.1.1` 的 105 个文件里
 * **没有 `backend/routes/` 的 11 个文件**（白名单只写了 `backend/server.js` / `backend/lib` /
 * `backend/schema`），解包后 `node backend/server.js` 当场
 * `ERR_MODULE_NOT_FOUND: .../backend/routes/index.js`（`backend/server.js:61` 就 import 它）
 * 并 exit 1。手写清单（`dsh-plugin/scripts/prepack-check.mjs` 的 `REQUIRED`）挡不住这种漏，
 * 因为它只查「我记得的那些」；这里改成**从入口正推**：包内必需 = 两个入口的**静态 import
 * 闭包** + 运行时时按路径读的数据根。新增一个 `backend/routes/xxx.js` 而忘了改白名单 ⇒
 * 闭包自动长大 ⇒ 判据变红。
 *
 * 两个入口（`package.json` 的 `main` + Node 后端入口，见 `dsh-plugin/lib/index.js:117-118`）:
 *   - `dsh-plugin/lib/index.js` —— dsh 插件壳，宿主 `require`/`import` 的就是它；
 *   - `backend/server.js`      —— 薄壳 spawn 的 Node 后端进程。
 * 只解析**相对说明符**（`./` / `../`）：`node:*` 内建与裸包名不是包内文件，一律记为
 * `unresolved` 供人看（不参与判据 —— 把裸包名当必需会把判据搞成假红）。
 *
 * 数据根（`RUNTIME_RESOURCES`）是**手写的**，条目都带「谁在哪一行读它」的证据；递归 import
 * 扫描器看不到这些「按路径拼出来的读」，所以只能人工登记 —— 但每条都写清理由，不写「大概
 * 需要」。注意 `backend/schema/fixtures/*` **不在**闭包里：它只被 `backend/test/db.test.mjs`、
 * `tools/parity/db-run.mjs`、`tools/export_schema.py` 读（测试/量具），运行时没人读
 * （实测 `grep -rn fixtures backend/lib backend/routes` 无命中）—— 别凭印象往里塞。
 *
 * 白名单展开（`expandFilesEntries`）按 npm 的 `files` 语义实现最小规则，行为经实测校准
 * （`npm pack --dry-run --json`，见下），不是照文档猜的：
 *   - 条目相对包根；`*` 不跨 `/`（实测 `files:["*.py","*.md"]` 只收根级的 a.py/top.md，
 *     子目录 `sub/b.py` 不收 ⇒ **没有** matchBase 语义），`**` 跨目录；
 *   - 条目指到目录 ⇒ 递归含其内容（`backend/lib`、`webui/dist-plugin` 都是这个形态）；
 *   - `package.json` / `README*` / `LICENSE*`（含 `LICENCE*`）恒含。
 * 有意**不**建模 `.gitignore`：本仓 `.gitignore` 里有 `webui/dist-plugin/`，但它照进包
 * （实测 3 个文件都在）—— 说明显式 `files` 条目压过忽略规则。副作用写在文件末尾「已知缺口」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 包根（本文件在 `<包根>/dsh-plugin/lib/` 下, 上溯三级） */
export const PKG_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

/** 闭包的两个入口（相对包根，posix 分隔） */
export const ENTRIES = Object.freeze([
  'dsh-plugin/lib/index.js',
  'backend/server.js',
]);

/**
 * 运行时时**按路径读**的数据根（静态扫描看不到；每条都要有证据行号）。
 * `files` 列出「精确文件」（测试夹具不算，别往里塞）；`dirs` 列出「整个目录都要」——
 * 目录内容在判据里**当场递归枚举**，所以往里新增数据文件也自动进入闭包。
 */
export const RUNTIME_RESOURCES = Object.freeze({
  files: Object.freeze([
    { rel: 'backend/schema/schema.sql', why: 'backend/lib/db.js:59 initDb 启动即读（目标 DDL）' },
    { rel: 'backend/schema/schema.json', why: 'backend/lib/db.js:60 收敛器按它补列/建索引' },
    { rel: 'backend/schema/migrations.json', why: 'backend/lib/db.js:61 声明式迁移清单，启动即执行' },
  ]),
  dirs: Object.freeze([
    { rel: 'builtin_prompts/free_style', why: 'backend/lib/prompts.js:237 _ASSET_DIR，运行时读流程文档与文件模板' },
    { rel: 'extensions', why: 'backend/lib/builtin-assets.js:262 DEFAULT_EXT_DIR，资产清单扫描根（routes/assets.js 的端点）' },
    { rel: 'webui/dist-plugin', why: 'server 静态服务目录（薄壳启动参数 --web-dir 传的就是它，dsh-plugin/lib/index.js）' },
  ]),
});

/** 目录递归枚举时跳过的东西（不进包，也不需要进闭包） */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.run', '__pycache__']);

/** 相对说明符扫描（见文件头：锚在行首，避开注释里的散文；多行 import 靠 `[^'"]` 跨行） */
const IMPORT_FROM_RE = /^[ \t]*import\s+[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm;
const IMPORT_SIDE_EFFECT_RE = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;
const EXPORT_FROM_RE = /^[ \t]*export\s+(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** posix 化（判据字符串一律用 `/`，Windows 上跑出来的也必须一样） */
export function toPosix(rel) {
  return rel.split(path.sep).join('/');
}

/** 目录清单缓存：同一进程内按 root 复用（判据是只读的静态检查，进程内不假设文件树会变） */
const LIST_CACHE = new Map();

/** 递归列出 root 下所有**文件**（相对包根，posix 分隔，排序）；结果按 root 缓存 */
export function listFiles(root = PKG_ROOT) {
  const cached = LIST_CACHE.get(root);
  if (cached) return cached;
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;                       // 读不动就当不存在（判据自己会报缺）
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        out.push(toPosix(path.relative(root, abs)));
      }
    }
  };
  walk(root);
  out.sort();
  LIST_CACHE.set(root, out);
  return out;
}

/** 抽一个源文件里的相对说明符（去重、保持出现顺序） */
export function scanRelativeSpecifiers(source) {
  const found = [];
  const add = (spec) => {
    if (!spec) return;
    if (!spec.startsWith('./') && !spec.startsWith('../')) return;
    if (!found.includes(spec)) found.push(spec);
  };
  for (const re of [IMPORT_FROM_RE, IMPORT_SIDE_EFFECT_RE, EXPORT_FROM_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    for (const m of source.matchAll(re)) add(m[1]);
  }
  return found;
}

/**
 * 解析相对说明符 → 包内文件（posix 相对路径）；解析不到返回 null。
 * 支持无扩展名（补 `.js`、`/index.js`），与 Node 的 ESM 解析口径近似（本仓无扩展名导入）。
 */
export function resolveSpecifier(fromRel, spec, root = PKG_ROOT) {
  const baseDir = path.posix.dirname(fromRel);
  const joined = path.posix.normalize(path.posix.join(baseDir, spec));
  const candidates = [joined, `${joined}.js`, `${joined}.mjs`, path.posix.join(joined, 'index.js')];
  for (const rel of candidates) {
    if (rel.startsWith('..')) continue;              // 跑出包根：不是包内文件
    const abs = path.join(root, rel);
    try {
      if (fs.statSync(abs).isFile()) return rel;
    } catch { /* 不存在的候选，继续试下一个 */ }
  }
  return null;
}

/**
 * 计算运行时闭包：两个入口的静态 import 闭包 + `RUNTIME_RESOURCES`。
 * @returns {{files: string[], unresolved: Array<{from: string, spec: string}>,
 *            entries: string[], resources: string[]}}
 *   `files` 排序去重；`unresolved` 是相对说明符解析不到（或裸包名/`node:`）的清单，
 *   只报不用（避免把裸包名当必需导致假红）。
 */
export function computeClosure(root = PKG_ROOT) {
  const files = new Set();
  const unresolved = [];
  const queue = [...ENTRIES];
  const seen = new Set();
  while (queue.length > 0) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = path.join(root, rel);
    let source;
    try {
      source = fs.readFileSync(abs, 'utf8');
    } catch {
      unresolved.push({ from: rel, spec: '(入口本身读不到)' });
      continue;
    }
    files.add(rel);
    for (const spec of scanRelativeSpecifiers(source)) {
      const resolved = resolveSpecifier(rel, spec, root);
      if (resolved === null) unresolved.push({ from: rel, spec });
      else queue.push(resolved);
    }
  }
  const resources = [];
  for (const item of RUNTIME_RESOURCES.files) {
    files.add(item.rel);
    resources.push(item.rel);
  }
  for (const item of RUNTIME_RESOURCES.dirs) {
    const abs = path.join(root, item.rel);
    if (!fs.existsSync(abs)) { unresolved.push({ from: '(资源根)', spec: item.rel }); continue; }
    for (const rel of listFiles(abs)) {
      const full = `${item.rel}/${rel}`;
      files.add(full);
      resources.push(full);
    }
  }
  return {
    files: [...files].sort(),
    unresolved,
    entries: [...ENTRIES],
    resources: resources.sort(),
  };
}

/** glob → 正则（npm `files` 最小语义：`**` 跨 `/`，`*`/`?` 不跨 `/`） */
function globToRegExp(pattern) {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') { i++; re += '(?:.*/)?'; }   // `**/` 也匹配零层
        else re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`${re}$`);
}

/**
 * npm 恒含的文件（`files` 白名单管不着）—— **只在包根**，实测校准过：
 * `files:["a.txt"]` 时 `sub/README.md` / `sub/deep/LICENSE` 都不进包，
 * 而根级 `package.json` 恒在。别把这条写成「任意层级的 README/LICENSE」（会假绿：
 * 例如 `tests/README.md` 会被误判成包内 —— 实测它不在 105 个文件里）。
 */
function isAlwaysIncluded(rel) {
  if (rel === 'package.json') return true;
  if (rel.includes('/')) return false;
  return /^(README|LICENSE|LICENCE)(\..*)?$/i.test(rel);
}

/**
 * 展开 `files` 白名单 → 包内文件集合（最小 npm 语义，见文件头）。
 * @param {string[]} entries package.json 的 files 数组
 * @param {{root?: string, allFiles?: string[]}} [opts] 便于测试注入（负对照就在内存里换 entries）
 * @returns {Set<string>} posix 相对路径集合
 */
export function expandFilesEntries(entries, opts = {}) {
  const root = opts.root || PKG_ROOT;
  const all = opts.allFiles || listFiles(root);
  const packed = new Set();
  for (const rel of all) if (isAlwaysIncluded(rel)) packed.add(rel);
  for (const raw of entries) {
    const entry = path.posix.normalize(String(raw).replace(/^\.\//, '').replace(/\/+$/, ''));
    if (!entry || entry.startsWith('..')) continue;
    const abs = path.join(root, entry);
    let stat = null;
    try { stat = fs.statSync(abs); } catch { /* 不存在：当 glob 处理 */ }
    if (stat && stat.isDirectory()) {
      for (const rel of listFiles(abs)) packed.add(`${entry}/${rel}`);
      continue;
    }
    if (stat && stat.isFile()) { packed.add(entry); continue; }
    const re = globToRegExp(entry);
    for (const rel of all) if (re.test(rel)) packed.add(rel);
  }
  return packed;
}

/**
 * 判据本体：闭包里但包内没有的文件（空数组 = 过）。
 * @param {string[]} closureFiles `computeClosure().files`
 * @param {Iterable<string>} packedFiles `expandFilesEntries(...)`
 */
export function findUnpacked(closureFiles, packedFiles) {
  const packed = packedFiles instanceof Set ? packedFiles : new Set(packedFiles);
  return closureFiles.filter((rel) => !packed.has(rel));
}

/**
 * 读仓库 `package.json` 的 `files` 并跑完整判据（`prepack-check.mjs` 与单测共用）。
 * @returns {{ok: boolean, missing: string[], closure: object, packedCount: number, files: string[]}}
 */
export function checkPackClosure(root = PKG_ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const entries = Array.isArray(pkg.files) ? pkg.files : [];
  const closure = computeClosure(root);
  const packed = expandFilesEntries(entries, { root });
  const missing = findUnpacked(closure.files, packed);
  return { ok: missing.length === 0, missing, closure, packedCount: packed.size, files: entries };
}

/**
 * 已知缺口（写在这里，不装作没有）:
 *   ① `.gitignore` / `.npmignore` 未建模 —— 若将来某个运行时文件恰好落在被忽略的目录里、
 *      而白名单**没有**显式列出它，本判据会假绿（今天不会：闭包里的路径全部由显式条目覆盖）。
 *   ② npm 的 `files` 对**符号链接**、`.npmrc`、`bundledDependencies` 有额外规则，本判据不管。
 *   ③ 运行时**动态拼**出来的路径（例如按用户输入拼文件名）静态看不到，只能靠人工登记进
 *      `RUNTIME_RESOURCES`；登记漏了就是假绿。
 */
