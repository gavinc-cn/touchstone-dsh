/**
 * 卡片独立 git worktree 支撑（`worktree.py` 393 行的 Node 对应物）。
 *
 * 设计出处：`doc_ai/plan/202610/20261006_0115_看板卡片独立worktree执行（开始按钮下拉+免排队）.md`。
 *
 * ── 分批历史（两批，界限是「端点要不要写盘」） ────────────────────────────────────
 * **M3（读口）**：唯一调用面是 `board.worktree_preview`（`board.py:1357`），它只用五个函数
 *   `branch_for`(51) / `preview`(117) / `repo_root`(100) / `worktree_path`(67) / `merge_status`(290)，
 *   加上只读依赖 `head_branch`(274)、`_porcelain`(359)、`_int`(351)、`_git`(84)。
 * **M6-1（写口）**：`create`(206) / `status`(249) / `remove`(371) 及只服务它们的
 *   `_readable_worktree`(135) / `_relpath`(146) / `_write_text`(151) / `_normalize_pointers`(159)。
 *   此前它们**临时**住在 `board.js`（M5-2 的 `wtCreate`/`wtStatus`/`wtRemove`），
 *   现已整体迁入本文件，`board.js` 只留 `import { create as wtCreate, … }` 的薄别名。
 *
 * ── M6-1 顺手修掉的一个真缺陷（先红后绿的现场在 `backend/test/worktree-write.test.mjs`） ──
 * 那次「临时安置」漏了 `worktree_path` 的 import：`board.js:1916` 直接引用裸标识符
 * ⇒ worktree 直起（`enterDoingWorktree` → `wtCreate`）**必然** `ReferenceError`。
 * M5 三层判据全绿也没抓到它，因为函数级/实例级用例都没走到该分支（M5 记录里的「未验项：
 * 真 worktree create/remove」就是它）。教训：**未验项不是「待补的覆盖」，是「没被读过的代码」**。
 *
 * ── git 调用约定（照 plan §3.3，一个字节都不改） ──────────────────────────────────
 * 一律 `git -C <目录> ...`；**不设 `GIT_DIR`/`GIT_WORK_TREE`**（本项目自身就是 9p 映射
 * worktree 的特例，平台擅自改写会与用户仓库既有配置打架）；git 非 0 退出一律把 stderr
 * 截断成可读错误串上抛（返回值形态，不抛异常）。
 *
 * ── 与 Python 的形态差异（唯一必要的差异，语义等价） ─────────────────────────────
 *   ① **同步**：Python `subprocess.run` 是阻塞调用；Node 用 `spawnSync`（同样同步），
 *      故本文件全部函数保持**同步**——`board.js` 的读路径因此也全是同步的，与 Python 同。
 *      **不**用 `execFileSync`：它把非 0 退出抛成异常，而本模块的契约是「rc !== 0 时把
 *      stderr 归一成错误串返回」。
 *   ② `proc.stdout`/`stderr` 缺省为 `''`（Python `capture_output=True` 同）；`ENOENT`
 *      等启动异常归一 `rc = -1` + `git 不可用: <原因>`（照 Python `except OSError`）。
 *   ③ 超时口径：Python `subprocess.run(timeout=60)` 超时抛 `TimeoutExpired`（被
 *      `except subprocess.SubprocessError` 捕获 ⇒ rc=-1）；Node `spawnSync` 超时给
 *      `status=null` + `signal='SIGTERM'`，这里映射成同一个 rc=-1 分支。
 *   ④ 时间单位不变（60s / 300s），常量照抄。
 *
 * 零 npm 依赖：只用 `node:child_process` / `node:fs` / `node:path`。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { t } from './i18n.js';

/** git 命令超时（毫秒）：查询类很快（`GIT_TIMEOUT` 60s） */
export const GIT_TIMEOUT_MS = 60_000;
/** 写类 git 命令超时（`GIT_WRITE_TIMEOUT` 300s）——本文件只读，保留常量供 M4 复用 */
export const GIT_WRITE_TIMEOUT_MS = 300_000;

/** 工作树落点目录名（平台自有目录下）与仓库内回退目录名 */
export const WT_DIRNAME = 'worktrees';
export const FALLBACK_DIRNAME = '.touchstone-worktrees';

/** 分支名前缀（plan D5） */
export const BRANCH_PREFIX = 'ts/card-';

/** 错误串截断长度（回给前端/日志用，避免把整段 git 输出贴出来） */
const ERR_MAX = 300;

/** Windows 盘符绝对路径（`D:/x`、`D:\x`）：POSIX 的 `path.isAbsolute` 不认，需自行识别 */
const DRIVE_RE = /^[A-Za-z]:[\\/]/;

// --------------------------------------------------------------------------
// 路径推导（纯字符串，不落盘）
// --------------------------------------------------------------------------

/**
 * 卡片对应的 worktree 分支名（确定性命名，plan D5）。
 * @param {number|string} cardId
 * @returns {string}
 */
export function branchFor(cardId) {
  return `${BRANCH_PREFIX}${Number.parseInt(cardId, 10)}`;
}

/**
 * 路径归一化用于「是否在仓库内」比较（`worktree._norm`）。
 *
 * POSIX 下 `normcase` 是恒等，Windows 折大小写——Node 的 `path.normalize` 与
 * `path.resolve` 在对应平台上的行为与 `os.path` 同类（两版都跑在同一平台上，
 * 不比跨平台行为）。
 * @param {string} p
 * @returns {string}
 */
function norm(p) {
  return path.normalize(path.resolve(p));
}

/**
 * child 是否位于 parent 目录内部（**含相等不算「内部」**，便于判 work_dir === project_dir）。
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
function inside(child, parent) {
  const c = norm(child);
  const p = norm(parent);
  return c !== p && c.startsWith(p.replace(/[\\/]+$/, '') + path.sep);
}

/**
 * 推导卡片 worktree 落点（plan D4；纯字符串推导，不落盘）。
 *
 * `repoRoot` 非空时按「不得落在仓库内部」判定（git 顶层可能与 project_dir 不同，例如
 * project_dir 只是仓库的一个子目录）；空则退化为按 project_dir 判定。
 *
 * `name` 的取法照 Python：`os.path.basename(os.path.normpath(project_dir).rstrip("/\\")) or "project"`
 * ——尾部斜杠先剥、`normpath` 收敛 `.`/`..`、basename 为 `''`（或 `.`/`/`）时回落 `project`。
 *
 * @param {object} project 项目行（读 project_dir / work_dir）
 * @param {number|string} cardId
 * @param {string} [repoRoot]
 * @returns {string}
 */
export function worktreePath(project, cardId, repoRoot = '') {
  const projectDir = String(project.project_dir ?? '').trim();
  const workDir = String(project.work_dir ?? '').trim() || projectDir;
  const cleaned = path.normalize(projectDir).replace(/[\\/]+$/, '');
  let name = path.basename(cleaned);
  if (!name || name === '.' || name === path.sep) name = 'project';
  const cid = Number.parseInt(cardId, 10);
  let cand = path.join(workDir, WT_DIRNAME, `card_${cid}`);
  const contain = repoRoot || projectDir;
  if (contain && inside(cand, contain)) {
    const parent = path.dirname(path.normalize(path.resolve(projectDir)));
    cand = path.join(parent, FALLBACK_DIRNAME, `${name}_card_${cid}`);
  }
  return path.normalize(cand);
}

// --------------------------------------------------------------------------
// git 只读探测
// --------------------------------------------------------------------------

/**
 * 跑一条 git 命令，返回 `{rc, out, err}`（err 已截断）。
 *
 * git 不可用（未安装/不可执行）/超时一律按 `rc = -1` 归一，错误串统一文案——调用方只需
 * 判 `rc !== 0`。**不抛异常**（照 Python `_git`）。
 *
 * `lang`（KB-03，尾参，与 `worktree.py:_git` 的位置逐个对齐）：只翻本函数自己写的
 * 骨架；`proc.error.message` / 命令行参数是动态内容，原样保留。
 *
 * @param {string[]} args
 * @param {string} cwd
 * @param {number} [timeoutMs]
 * @param {'zh'|'en'|string=} [lang]
 * @returns {{rc: number, out: string, err: string}}
 */
export function git(args, cwd, timeoutMs = GIT_TIMEOUT_MS, lang = 'zh') {
  const proc = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (proc.error) {
    return {
      rc: -1,
      out: '',
      err: t('api', 'git 不可用: {detail}', lang, { detail: proc.error.message }),
    };
  }
  if (proc.status === null) {
    // 被信号杀死/超时（Python 的 TimeoutExpired 同归一）
    return {
      rc: -1,
      out: '',
      err: t('api', 'git 不可用: 命令被中断或超时（{args}）', lang,
        { args: args.join(' ') }),
    };
  }
  const err = String(proc.stderr ?? '').trim();
  return { rc: proc.status, out: String(proc.stdout ?? ''), err: err.slice(0, ERR_MAX) };
}

/**
 * 项目目录所属 git 仓库顶层；非仓库 / git 不可用返回 `{root:null, error}`。
 *
 * 项目目录只是仓库子目录时返回真正的顶层——`git worktree add` 必须在顶层执行，否则工作树
 * 会挂到子目录语义上（git 会拒绝）。
 *
 * @param {string} projectDir
 * @param {'zh'|'en'|string=} [lang]
 * @returns {{root: string|null, error: string}}
 */
export function repoRoot(projectDir, lang = 'zh') {
  const d = String(projectDir ?? '').trim();
  if (!d) return { root: null, error: t('api', '项目目录为空', lang) };
  if (!isDir(d)) {
    return { root: null, error: t('api', '项目目录不存在: {path}', lang, { path: d }) };
  }
  const { rc, out, err } = git(['rev-parse', '--show-toplevel'], d, undefined, lang);
  if (rc !== 0 || !out.trim()) {
    return { root: null, error: err || t('api', '项目目录不是 git 仓库', lang) };
  }
  return { root: out.trim().split('\n')[0].trim(), error: '' };
}

/**
 * 主仓库当前检出的分支名；游离 HEAD / 读取失败返回 `{name:'', error:按 lang 渲染的原因}`。
 *
 * 平台的「主分支」口径就是它——worktree 由该分支检出，改动也回流到它。**不猜**
 * `master`/`main`：仓库默认分支名由仓库自己决定，猜错会把改动合到错误的分支上。
 *
 * @param {string} root
 * @param {'zh'|'en'|string=} [lang]
 * @returns {{name: string, error: string}}
 */
export function headBranch(root, lang = 'zh') {
  const { rc, out, err } = git(['rev-parse', '--abbrev-ref', 'HEAD'], root, undefined, lang);
  const name = String(out ?? '').trim();
  if (rc !== 0) return { name: '', error: err || t('api', '无法读取主仓库分支', lang) };
  if (!name || name === 'HEAD') {
    return { name: '', error: t('api', '主仓库处于游离 HEAD 状态，无法判定主分支', lang) };
  }
  return { name, error: '' };
}

/** `fs.statSync` 的目录判据（不存在/权限不足一律 false，照 Python `os.path.isdir`） */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 预览（**不落盘**）：`{ok, error, path, branch, exists, root}`。
 *
 * `ok=false` 表示该项目不能建 worktree（非 git 仓库等），`error` 为按 `lang` 渲染的原因；
 * `exists=true` 表示目标路径已存在（前端可据此提示「将复用」）。
 *
 * @param {object} project
 * @param {number|string} cardId
 * @param {'zh'|'en'|string=} [lang]
 * @returns {{ok: boolean, error: string, path: string, branch: string,
 *            exists: boolean, root: string}}
 */
export function preview(project, cardId, lang = 'zh') {
  const projectDir = String(project.project_dir ?? '').trim();
  const { root, error } = repoRoot(projectDir, lang);
  if (error) {
    return {
      ok: false,
      error: t('api', '项目目录不是 git 仓库（{detail}）', lang, { detail: error }),
      path: '',
      branch: branchFor(cardId),
      exists: false,
      root: '',
    };
  }
  const p = worktreePath(project, cardId, root);
  return {
    ok: true,
    error: '',
    path: p,
    branch: branchFor(cardId),
    exists: isDir(p),
    root,
  };
}

/**
 * 卡片 worktree 的合并就绪度（只读判定；「通过」时据此决定是否交给 agent 合并）。
 *
 * 返回对象（**不抛异常**，键名与 Python 逐字同）：
 *   `{ok, error, path, branch, target, exists, branch_exists, dirty, dirty_count, ahead, behind}`
 *   - `target`：主仓库当前分支（见 `headBranch`），空串 = 判定失败；
 *   - `ahead`：`target..branch` 的提交数——**> 0 即有改动还没回流主分支**；
 *   - `behind`：`branch..target` 的提交数——主分支领先多少（agent 需先同步）；
 *   - `dirty`/`dirty_count`：工作树未提交改动（含未跟踪；口径与 `status` 同）；
 *   - `ok=false` 只在「工作树/主仓库读不到」时出现，调用方按「不拦用户」处置。
 *
 * 全程只跑 `rev-parse` / `rev-list --count` / `status --porcelain`——**不执行任何 git
 * 合并命令**（用户 2026-10-07 约定：合并交 agent，平台只判定）。
 *
 * @param {object} project
 * @param {object} card 卡片行（读 id / worktree）
 * @param {'zh'|'en'|string=} [lang]
 * @returns {object}
 */
export function mergeStatus(project, card, lang = 'zh') {
  const out = {
    ok: false,
    error: '',
    path: '',
    branch: branchFor(card.id),
    target: '',
    exists: false,
    branch_exists: false,
    dirty: false,
    dirty_count: 0,
    ahead: 0,
    behind: 0,
  };
  const p = String(card.worktree ?? '').trim();
  out.path = p;
  if (!p) {
    out.error = t('api', '该卡片没有独立 worktree', lang);
    return out;
  }
  if (!isDir(p)) {
    out.error = t('api', 'worktree 目录不存在', lang);
    return out;
  }
  out.exists = true;
  const { root, error } = repoRoot(project.project_dir, lang);
  if (error) {
    out.error = t('api', '项目目录不是 git 仓库（{detail}）', lang, { detail: error });
    return out;
  }
  const head = headBranch(root, lang);
  if (head.error) {
    out.error = head.error;
    return out;
  }
  out.target = head.name;
  const branch = out.branch;
  const verify = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root,
    undefined, lang);
  out.branch_exists = verify.rc === 0;
  if (!out.branch_exists) {
    // 分支不存在（被删/从未创建）：没有可合并的东西，按「无待合并」处置
    out.ok = true;
    return out;
  }
  const ahead = git(['rev-list', '--count', `${out.target}..${branch}`], root,
    undefined, lang);
  if (ahead.rc !== 0) {
    out.error = t('api', '无法读取待合并提交数：{detail}', lang, { detail: ahead.err });
    return out;
  }
  out.ahead = gitInt(ahead.out);
  const behind = git(['rev-list', '--count', `${branch}..${out.target}`], root,
    undefined, lang);
  if (behind.rc !== 0) {
    out.error = t('api', '无法读取落后提交数：{detail}', lang, { detail: behind.err });
    return out;
  }
  out.behind = gitInt(behind.out);
  const dirty = porcelain(p, lang);
  if (!dirty.ok) {
    out.error = t('api', '无法读取工作树状态：{detail}', lang, { detail: dirty.err });
    return out;
  }
  out.dirty = dirty.lines.length > 0;
  out.dirty_count = dirty.lines.length;
  out.ok = true;
  return out;
}

/**
 * git 输出取整（异常输出归一 0，不抛）。
 *
 * 照 Python `_int`：取**第一行**转 int；空输出/非数字/无行都归 0。
 * @param {string} text
 * @returns {number}
 */
export function gitInt(text) {
  const line = String(text ?? '').trim().split('\n')[0];
  const n = Number.parseInt(line, 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * 工作树 `git status --porcelain` 的非空行（含未跟踪）；读不到返回
 * `{ok:false, lines:[], err:原因}`。
 *
 * dirty 判据与 `status` 同口径（有输出即脏）——两处读的是同一条命令，合并判定一次取到
 * 「脏不脏」与「脏几处」。**Python 用 `str.splitlines()`**，它比 `str.split('\n')` 多认
 * `\r`/`\u2028` 等行界，故这里用 `/\r\n|\r|\n|\u2028|\u2029/` 拆，再剔除空行。
 *
 * @param {string} p
 * @param {'zh'|'en'|string=} [lang]
 * @returns {{ok: boolean, lines: string[], err: string}}
 */
export function porcelain(p, lang = 'zh') {
  const { rc, out, err } = git(['status', '--porcelain'], p, undefined, lang);
  if (rc !== 0) return { ok: false, lines: [], err };
  return {
    ok: true,
    lines: String(out ?? '').split(/\r\n|\r|\n|\u2028|\u2029/).filter((ln) => ln.trim() !== ''),
    err: '',
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 写口（`worktree.py:135-247 / 249-273 / 371-401`）
//
// M6-1 从 `board.js` 迁入（原 `wtCreate`/`wtStatus`/`wtRemove`，M5-2 临时安置）。
// 迁移中一并修掉「`worktreePath` 未导入」的 ReferenceError（见文件头）。
//
// 与 Python 的形态差异（本段新增一条，其余同文件头）：
//   ⑤ 读指针文件用 `readFileSync(..., 'utf8')`：Python 的 `open(..., encoding='utf-8')` 遇
//      非法字节抛 `UnicodeDecodeError`（**不是** `OSError`，会穿过 `except OSError` 上抛）；
//      Node 的解码器把坏字节替换成 U+FFFD、不抛。指针文件是 git 写的 ASCII 文本，两者实际同；
//      真要区分只有「有人手工把指针文件写成二进制」这一种场景。
//      （`os.replace` ↔ `fs.renameSync`：libuv 在 Windows 上用 `MOVEFILE_REPLACE_EXISTING`，
//      同样是覆盖式替换，不构成差异。）
// ══════════════════════════════════════════════════════════════════════════

/** worktree `.git` 文件首行形态（`worktree.py:_GITFILE_RE`） */
const GITFILE_RE = /^\s*gitdir:\s*(.+?)\s*$/;

/**
 * Python `(value or "").strip()` 的口径：`None`/`0`/`False`/`""`/缺键一律归空串。
 *
 * 不写 `String(value ?? '')`：那会把 `0` 变成 `"0"`（M5 在 `normalizeEffort` 上踩过同一个坑）。
 * 库里这几列都是 TEXT，两种写法对真实行同值，但**口径要照 oracle**。
 * @param {unknown} value
 * @returns {string}
 */
function orStrip(value) {
  return value ? String(value).trim() : '';
}

/** 异常 → 文本（`str(e)` 口径：`Error` 取 message，不带类名前缀） */
function errText(err) {
  if (err === null || err === undefined) return '';
  if (err instanceof Error) return String(err.message ?? err);
  return String(err);
}

/** `worktree._readable_worktree`：path 是否已是「可用的、检出指定分支」的工作树（复用判据） */
function readableWorktree(p, branch, lang = 'zh') {
  if (!isDir(p)) return false;
  const inside = git(['rev-parse', '--is-inside-work-tree'], p, undefined, lang);
  if (inside.rc !== 0 || inside.out.trim() !== 'true') return false;
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD'], p, undefined, lang);
  return head.rc === 0 && head.out.trim() === branch;
}

/** `worktree._relpath`：相对路径，统一 `/` 分隔（git 指针文件两端平台都认正斜杠） */
function relpath(target, start) {
  return path.relative(start, target).split(path.sep).join('/');
}

/** `worktree._write_text`：原子写文本（同目录临时文件 + rename，避免中断留半个文件） */
function writeTextAtomic(file, text) {
  const tmp = `${file}.tmp_tswt`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8' });
  fs.renameSync(tmp, file);
}

/**
 * `worktree._normalize_pointers`：把工作树两处指针改写为**相对路径**（跨平台可用）。
 *
 * 改写对象：① `<worktree>/.git`（内容 `gitdir: <repo>/.git/worktrees/<name>`）；
 * ② `<repo>/.git/worktrees/<name>/gitdir`（内容 `<worktree 绝对路径>`）。
 * 步骤：读原文 → 算相对形式 → 写入 → **用 git 复验**（`rev-parse --show-toplevel` 能解析）
 * → 失败把两处原文写回。任何读取失败 / 已被改成相对路径都直接返回（不动）——best-effort，
 * 绝不因「指针美化」把可用的工作树改坏。
 *
 * 注意 `adminAbs = path.normalize(admin)` 照 Python `os.path.normpath(admin)`：**不以工作树
 * 目录为基准解析**（能走到这里的 `admin` 必是绝对路径或盘符形态，见上面的早退）。
 * @param {string} p 工作树目录
 */
function normalizePointers(p) {
  const gitfile = path.join(p, '.git');
  let gitfileText;
  try {
    gitfileText = fs.readFileSync(gitfile, 'utf8');
  } catch {
    return;
  }
  const lines = String(gitfileText ?? '').split(/\r\n|\r|\n|\u2028|\u2029/);
  const m = GITFILE_RE.exec(gitfileText ? lines[0] : '');
  if (!m) return;
  const admin = m[1];
  // 已是相对路径（含 Windows 盘符形态的精确识别）则不动
  if (!(path.isAbsolute(admin) || DRIVE_RE.test(admin))) return;
  const adminAbs = path.normalize(admin);
  const gdFile = path.join(adminAbs, 'gitdir');
  let gdText;
  try {
    gdText = fs.readFileSync(gdFile, 'utf8');
  } catch {
    return;
  }
  const newGitfile = `gitdir: ${relpath(adminAbs, p)}\n`;
  const newGd = `${relpath(path.normalize(p), adminAbs)}\n`;
  try {
    writeTextAtomic(gitfile, newGitfile);
    writeTextAtomic(gdFile, newGd);
  } catch {
    return;
  }
  if (git(['rev-parse', '--show-toplevel'], p).rc === 0) return;
  // 复验失败：回滚（宁可留绝对指针也不能把可用工作树改坏）
  try {
    writeTextAtomic(gitfile, gitfileText);
    writeTextAtomic(gdFile, gdText);
  } catch {
    /* 回滚也失败：留痕由调用方日志承担（Python 同：`except OSError: pass`） */
  }
}

/**
 * `worktree.create`：创建（或复用）卡片独立 worktree；返回 `[path, branch, err]`。
 *
 * 幂等语义（plan §3.5）：① 路径已是可用工作树且检出目标分支 ⇒ 直接复用（打回续改/失败重按
 * 开始走这条）；② 路径不存在（用户手删）⇒ 重新创建：分支已存在则检出该分支（保留既往提交），
 * 否则 `-b` 新建；③ 报错一律返回按 `lang` 渲染的错误串（调用方按 400 回给前端）。
 *
 * git add 失败先用 `worktree prune` 清注册残留再重试**一次**（用户删过目录的常见形态）。
 * **不抛异常**（错误走第三元）。
 *
 * @param {object} project 项目行（读 project_dir / work_dir）
 * @param {number|string} cardId
 * @param {'zh'|'en'|string=} [lang]
 * @returns {[string, string, string]}
 */
export function create(project, cardId, lang = 'zh') {
  const projectDir = orStrip(project.project_dir);
  const { root, error } = repoRoot(projectDir, lang);
  if (error) {
    return ['', '', t('api', '无法创建 worktree：项目目录不是 git 仓库（{detail}）', lang,
      { detail: error })];
  }
  const p = worktreePath(project, cardId, root);
  const branch = branchFor(cardId);
  if (readableWorktree(p, branch, lang)) return [p, branch, ''];
  if (fs.existsSync(p)) {
    // 路径被占（文件/非本卡的工作树）：不擅自删用户目录，明确报错交用户处理
    return ['', '', t('api', 'worktree 路径已存在且不可复用：{path}', lang, { path: p })];
  }
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
  } catch (e) {
    return ['', '', t('api', '无法创建 worktree 目录：{detail}', lang,
      { detail: errText(e) })];
  }
  const verify = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root,
    undefined, lang);
  const args = verify.rc === 0
    // 分支已存在（用户删过工作树目录、分支留着）：检出既有分支，保留既往提交
    ? ['worktree', 'add', p, branch]
    : ['worktree', 'add', p, '-b', branch];
  let res = git(args, root, GIT_WRITE_TIMEOUT_MS, lang);
  if (res.rc !== 0) {
    // 目标目录不存在但 git 侧仍有注册残留（用户删过目录）：prune 后重试一次
    if (git(['worktree', 'prune'], root, undefined, lang).rc === 0) {
      res = git(args, root, GIT_WRITE_TIMEOUT_MS, lang);
    }
  }
  if (res.rc !== 0) {
    const why = String(res.err || res.out || t('api', '未知原因', lang)).trim()
      .slice(0, ERR_MAX);
    return ['', '', t('api', 'git worktree add 失败：{detail}', lang, { detail: why })];
  }
  normalizePointers(p);
  return [p, branch, ''];
}

/**
 * `worktree.status`：卡片工作树的改动状态 `{ok, error, path, branch, dirty, exists}`。
 *
 * dirty 判据 = `git status --porcelain` **输出非空白**（含未跟踪文件）——与 plan D8 的
 * 「只在干净时清理」同口径。注意这是「整段输出判空」，与 `merge_status` 的「行数」不同口径，
 * 两者**不要统一**（照 oracle）。
 *
 * @param {object} project 项目行（本函数暂未用到，形参照 Python 保留）
 * @param {object} card 卡片行（读 id / worktree）
 * @param {'zh'|'en'|string=} [lang]
 * @returns {object}
 */
export function status(project, card, lang = 'zh') {
  const p = orStrip(card.worktree);
  const branch = branchFor(card.id);
  if (!p) {
    return {
      ok: false, error: t('api', '该卡片没有独立 worktree', lang),
      path: '', branch, dirty: false, exists: false,
    };
  }
  if (!isDir(p)) {
    return {
      ok: false, error: t('api', 'worktree 目录不存在', lang),
      path: p, branch, dirty: false, exists: false,
    };
  }
  const res = git(['status', '--porcelain'], p, undefined, lang);
  if (res.rc !== 0) {
    return {
      ok: false, error: t('api', '无法读取工作树状态：{detail}', lang, { detail: res.err }),
      path: p, branch, dirty: false, exists: true,
    };
  }
  return {
    ok: true, error: '', path: p, branch, dirty: Boolean(res.out.trim()), exists: true,
  };
}

/**
 * `worktree.remove`：清理卡片 worktree（plan D8：**只在干净时**、绝不用 `--force`）；
 * 返回 `[ok, err]`。
 *
 * 只 `git worktree remove`；**不删分支**（分支里的提交可能还没回流，删了要 reflog 才找得回；
 * 清理分支交用户在 git 侧自行决定）。
 *
 * @param {object} project 项目行（只用于 `repo_root`）
 * @param {object} card 卡片行（读 id / worktree）
 * @param {'zh'|'en'|string=} [lang]
 * @returns {[boolean, string]}
 */
export function remove(project, card, lang = 'zh') {
  const p = orStrip(card.worktree);
  if (!p) return [false, t('api', '该卡片没有独立 worktree', lang)];
  if (!isDir(p)) return [false, t('api', 'worktree 目录不存在', lang)];
  const st = status(project, card, lang);
  if (!st.ok) return [false, st.error];
  if (st.dirty) {
    return [false, t('api', '工作树有未提交改动，请先提交或清理后再移除', lang)];
  }
  const { root, error } = repoRoot(project.project_dir, lang);
  if (error) {
    return [false, t('api', '项目目录不是 git 仓库（{detail}）', lang, { detail: error })];
  }
  const res = git(['worktree', 'remove', p], root, GIT_WRITE_TIMEOUT_MS, lang);
  if (res.rc !== 0) {
    const why = String(res.err || res.out || t('api', '未知原因', lang)).trim()
      .slice(0, ERR_MAX);
    return [false, t('api', 'git worktree remove 失败：{detail}', lang, { detail: why })];
  }
  return [true, ''];
}
