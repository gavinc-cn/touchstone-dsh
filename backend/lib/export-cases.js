/**
 * `export_cases.py`（160 行）的 Node 对应物（Node 后端 M6-2）。
 *
 * 两个子命令：`export`（扫案例库 → `<根>/.live/cases.jsonl` 派生索引）与
 * `retest-candidates`（按变更文件粗筛候选复测用例）。**案例库的 md 是唯一权威**，
 * 本模块只读；索引写进 `.live/`（可随时重建）。
 *
 * 与 Python 的形态差异（逐条给理由）：
 *   ① CLI 入口是模块底部 `if (import.meta.url === pathToFileURL(process.argv[1]).href)`，
 *      子命令解析手写（Python 用 argparse）——**退出码与 stdout/stderr 分流照 oracle**：
 *      成功 0；未知/缺失子命令 2；`export` 的警告走 stderr、结果行走 stdout。
 *      argparse 的用法文案（`usage: …`）**不逐字节复刻**（那是帮助文本，不是行为契约），
 *      但两条错误路径的**退出码**必须一致（对拍用例钉这个）。
 *   ② `cmd_retest_candidates` 在 Python 里是同步函数（`--semantic` 用惰性 `import rag`）；
 *      Node 的 ESM 只能 `await import()`，故本函数是 **async**，`--semantic` 分支的语义
 *      （配置不可用即保持原序、异常整体吞掉）照抄。**不传 `--semantic` 时行为与同步版等价。**
 *   ③ `--semantic` 的「RAG 可用」方向不纳入本批对拍（见 M6 计划 §六.12）；「RAG 不可用 ⇒
 *      退化为原序」方向两版必须一致。
 *
 * 逐字节口径：`cases.jsonl` 每行是 `json.dumps(rec, ensure_ascii=False)`（→ `lib/pyjson.js`
 * 的 `pyJsonDumps`），`--json` 输出是 `json.dumps(..., ensure_ascii=False, indent=2)`
 * （→ `pyJsonDumpsIndent`）。字段**插入序**就是 JSON 键序，故 record 的构造顺序必须照抄。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CASE_DIR_RE, VERIFY_SCRIPT_NAME, isFile, parseFields, parseStatusMd, pyStrCompare, readText,
} from './lib.js';
import { pyJsonDumps, pyJsonDumpsIndent } from './pyjson.js';

// `VERIFY_SCRIPT_NAME` 归位 `lib.js`（M6-6 前的 lib 补齐），本模块 import 后原样 re-export
// ——保持既有导入面不变。
export { VERIFY_SCRIPT_NAME };

/**
 * 「依据代码」里的代码文件引用（照 `export_cases.py:21-24`）。
 * 字符集**不含中文**（原文注释：避免吞掉前文）；可带 `:行号` 或 `:起-止`。
 */
export const CODE_REF_RE = new RegExp(
  '[A-Za-z0-9_./-]+\\.(?:cpp|cc|cxx|hpp|h|java|py|jsx?|tsx?|sql|xml|proto|go|rs)'
  + '(?::\\d+(?:-\\d+)?)?',
  'g',
);

/**
 * `export_cases.extract_code_files`：抽出文件路径（去行号、去重、**保留原文写法与出现序**）。
 *
 * Python 用 `if path not in files` 的去重（保序 list，不是 set）——照抄。
 */
export function extractCodeFiles(raw) {
  const files = [];
  const text = raw == null ? '' : String(raw);
  CODE_REF_RE.lastIndex = 0;
  let m = CODE_REF_RE.exec(text);
  while (m !== null) {
    const p = m[0].split(':')[0];
    if (!files.includes(p)) files.push(p);
    m = CODE_REF_RE.exec(text);
  }
  return files;
}

/**
 * `export_cases.scan_cases`：遍历案例库，返回用例记录列表（按 id 升序）。
 *
 * `os.walk` 的三条语义逐条对齐：① 跳过隐藏目录（**不深入**）；② 目录名匹配
 * `^(FS\d{4})_(.+)$` 才算用例，**不匹配也继续下钻**（子目录里可能有真用例）；
 * ③ `dir` 字段是相对根的路径（`os.path.relpath`）。
 */
export function scanCases(root) {
  const base = String(root == null ? '' : root);
  const records = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const m = CASE_DIR_RE.exec(path.basename(dir));
    if (m) {
      const caseMd = parseFields(readText(path.join(dir, 'case.md')));
      const status = parseStatusMd(path.join(dir, 'status.md'));
      const codeRefs = caseMd['依据代码'] || '';
      // 字段顺序照 Python 的 dict 字面量（它同时决定 jsonl 的键序）
      records.push({
        id: m[1],
        name: m[2],
        dir: path.relative(base, dir) || '.',
        interface: caseMd['接口'] || '',
        message_id: caseMd['message_id'] || '',
        module: caseMd['所属模块/功能'] || '',
        status: status.status,
        bug_report: status.bug_report,
        code_files: extractCodeFiles(codeRefs),
        code_refs: codeRefs,
        // 照 Python `os.path.isfile`：**同名目录不算**（`existsSync` 会把目录判成 true）
        has_script: isFile(path.join(dir, VERIFY_SCRIPT_NAME)),
      });
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;               // 跳过 .live/.web 等机器目录
      if (ent.isDirectory()) walk(path.join(dir, ent.name));
    }
  };
  walk(base);
  records.sort((a, b) => pyStrCompare(a.id, b.id));
  return records;
}

/** `export_cases._norm`：`path.replace('\\','/').lstrip('./')`（**按字符集剥离前导**） */
export function norm(filePath) {
  return String(filePath == null ? '' : filePath).replace(/\\/g, '/').replace(/^[./]+/, '');
}

/**
 * `export_cases._match_level`：`path`＝路径（互为 `/` 后缀）/ `name`＝仅同名（需人工确认）/
 * 无匹配返回 null。
 */
export function matchLevel(caseFile, changed) {
  const cf = norm(caseFile);
  const ch = norm(changed);
  if (cf === ch || ch.endsWith(`/${cf}`) || cf.endsWith(`/${ch}`)) return 'path';
  if (path.basename(cf) === path.basename(ch)) return 'name';
  return null;
}

/**
 * `export_cases.cmd_export`：导出 cases.jsonl（每行一个用例），返回退出码 0。
 *
 * 落盘走「临时文件 + rename」（照 `os.replace`）；stdout 一行结果、stderr 可选警告。
 */
export function cmdExport(args) {
  const root = args.root;
  const out = args.out || path.join(root, '.live', 'cases.jsonl');
  const records = scanCases(root);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.tmp`;
  let body = '';
  for (const rec of records) body += `${pyJsonDumps(rec)}\n`;
  fs.writeFileSync(tmp, body, { encoding: 'utf8' });
  fs.renameSync(tmp, out);
  const noCode = records.filter((r) => r.code_files.length === 0).map((r) => r.id);
  process.stdout.write(`导出 ${records.length} 条用例 -> ${out}\n`);
  if (noCode.length) {
    process.stderr.write(`警告：${noCode.length} 条未提取到依据代码文件：${noCode.join(' ')}\n`);
  }
  return 0;
}

/**
 * `export_cases.cmd_retest_candidates`：按变更文件列表粗筛候选复测用例（**async**，见文件头②）。
 *
 * 匹配等级只在「尚未命中 path」时降级（`matched.get(changed) != "path"`）——即同一变更文件
 * 只要有一条 `path` 命中就不被后来的 `name` 覆盖。`--json` 走 `indent=2`；否则逐行打印、
 * 汇总行走 stderr。
 */
export async function cmdRetestCandidates(args) {
  const records = scanCases(args.root);
  const hits = [];
  for (const rec of records) {
    const matched = new Map();                 // changed_file -> level（插入序）
    for (const caseFile of rec.code_files) {
      for (const changed of args.files) {
        const level = matchLevel(caseFile, changed);
        if (level && matched.get(changed) !== 'path') matched.set(changed, level);
      }
    }
    if (matched.size) hits.push([rec, matched]);
  }
  if (args.semantic) {
    // RAG 语义重排（可选）：配置存在时按混合检索序输出；不可用保持原序（离线默认）。
    // 照 Python：**任何异常整体吞掉**（`except Exception: pass`）。
    try {
      const rag = await import('./rag.js');
      if (rag.loadConfig()) {
        const ranked = new Map();
        const rows = await rag.retrieve(args.root, args.files.join('\n'), 30);
        rows.forEach((r, i) => ranked.set(r.id, i));
        hits.sort((a, b) => (ranked.get(a[0].id) ?? 10 ** 9) - (ranked.get(b[0].id) ?? 10 ** 9));
      }
    } catch {
      /* 离线/未移植：保持原序（与 Python 同） */
    }
  }
  if (args.json) {
    // 照 Python：`matched` 是普通 dict，键序 = **首次赋值序**（遍历 code_files × files 的顺序），
    // 不是排序序——只有下面那条「逐行打印」分支才 `sorted(matched.items())`。
    const payload = hits.map(([rec, matched]) => {
      const out = { ...rec, matched: {} };
      for (const [key, level] of matched.entries()) out.matched[key] = level;
      return out;
    });
    process.stdout.write(`${pyJsonDumpsIndent(payload, 2)}\n`);
  } else {
    for (const [rec, matched] of hits) {
      const keys = [...matched.keys()].sort((a, b) => pyStrCompare(a, b));
      const files = keys.map((f) => `${f}(${matched.get(f)})`).join(', ');
      process.stdout.write(`${rec.id} [${rec.status}] ${rec.dir}  <- ${files}\n`);
    }
    process.stderr.write(`共 ${hits.length} 条候选（path=路径匹配，name=仅同名需确认）\n`);
  }
  return 0;
}

/** 手写子命令解析（见文件头①）。返回 `{cmd, opts}`；非法用法返回 `{error}`。 */
export function parseArgv(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'export') {
    const opts = { root: '', out: '' };
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '--out') opts.out = rest[++i] ?? '';
      else if (opts.root === '') opts.root = rest[i];
      else return { error: `unrecognized arguments: ${rest[i]}` };
    }
    if (!opts.root) return { error: 'the following arguments are required: root' };
    return { cmd, opts };
  }
  if (cmd === 'retest-candidates') {
    const opts = { root: '', files: [], json: false, semantic: false };
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '--json') opts.json = true;
      else if (rest[i] === '--semantic') opts.semantic = true;
      else if (opts.root === '') opts.root = rest[i];
      else opts.files.push(rest[i]);
    }
    if (!opts.root) return { error: 'the following arguments are required: root' };
    if (!opts.files.length) return { error: 'the following arguments are required: files' };
    return { cmd, opts };
  }
  return { error: 'the following arguments are required: cmd' };
}

/** CLI 主入口（退出码语义照 oracle：成功 0、用法错 2） */
export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgv(argv);
  if (parsed.error) {
    process.stderr.write(`usage: export_cases.py {export,retest-candidates} ...\n`);
    process.stderr.write(`export_cases.py: error: ${parsed.error}\n`);
    return 2;
  }
  if (parsed.cmd === 'export') return cmdExport(parsed.opts);
  return cmdRetestCandidates(parsed.opts);
}

// 直接执行时才跑（被 import 时不动）——`node backend/lib/export-cases.js export <root>`
//
// **入口不许用顶层 await**（2026-10-13 M6-3 实测）：`main()` 的 `--semantic` 分支会
// `await import('./rag.js')`，而 `rag.js` 静态 import 回本模块（`scanCases`）——若本模块的
// 求值被顶层 await 挂起，这条异步环就会死锁：进程报 `Detected unsettled top-level await`、
// 退出码 **13**（而 Python 侧是「RAG 不可用即优雅降级」）。改成 `.then()` 后求值立即完成，
// 环变成普通的一前一后。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(`export-cases: ${err && err.stack ? err.stack : err}\n`);
      process.exitCode = 2;
    });
}
