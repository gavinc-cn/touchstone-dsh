/**
 * `agents.py` 的 Node 对应物（M3 交付归族读口；M6-2 补齐扫描口）。
 *
 * M3（读路径）里几乎所有端点都要按项目的 `agent_path` 归族（`_api_get_board` 下发
 * family/capabilities、`_api_board_session_messages` 归一 sessparse 解析族、
 * `board.web_busy_map` 判「是不是 dsh 族」…），而归族判据是纯字符串规则、零 IO，故先落。
 * M6-2 把模块的另一大半（`scan_agents` / `scan_skills` / `_probe_version` /
 * `_search_extra` / `_parse_skill_md` / `_scan_skill_dir` 与四张常量表）按 `agents.py` 补齐。
 *
 * 归族返回值与 Python 逐字一致（`"dsh_plugin"` / `"retired"`），判据见 `agents.py:134-162`：
 *   ① `dsh-plugin:` 前缀（必须先于 basename 判——它不是有效可执行路径）；
 *   ② `kimi-web:` / `opencode-web:` 两个旧虚拟前缀；
 *   ③ basename 含 kimi/opencode/claude/hermes/deepseek 的旧 CLI 族；
 *   ④ basename == `dsh`（裸 dsh CLI，`--profile headless` 形态已退场）；
 *   ⑤ **其余一律 `dsh_plugin`**（空 `agent_path` 与未知可执行名的默认族）。
 *
 * 第 ⑤ 条是最容易写反的一条：默认族不是「未知就报错」，而是「收敛到唯一产品入口」。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** dsh 插件驱动前缀（`agents.py:DSH_PLUGIN_PREFIX`）：后跟任意提示串，平台不使用 */
export const DSH_PLUGIN_PREFIX = 'dsh-plugin:';

/** 退场族标记（`agents.py:RETIRED_FAMILY`）：起跑处据此返回 `RETIRED_MSG` */
export const RETIRED_FAMILY = 'retired';

/** 退场族提示文案（`agents.py:RETIRED_MSG`，逐字照抄——它直接展示给用户） */
export const RETIRED_MSG = '该智能体族已下线，请在项目设置里改绑 dsh 插件';

/** 「插件·进程内」条目展示名（`agents.py:PLUGIN_ENTRY_NAME`，M6 的 scan 会用） */
export const PLUGIN_ENTRY_NAME = 'dsh（插件·进程内）';

/** 退场族的旧虚拟条目前缀（`agents.py:LEGACY_WEB_PREFIXES`） */
export const LEGACY_WEB_PREFIXES = ['kimi-web:', 'opencode-web:'];

/** 旧 CLI 族可执行名关键词（`agents.py:152` 的判定同源） */
const RETIRED_NAME_HINTS = ['kimi', 'opencode', 'claude', 'hermes', 'deepseek'];

/**
 * 归族：只可能返回 `"dsh_plugin"`（可跑）或 `RETIRED_FAMILY`（退场族）。
 *
 * Python 用 `ap.strip()` 后判前缀、再用 `os.path.basename(ap).lower()` 判名字；
 * Node 侧 `path.basename` 在 POSIX 上等价（Windows 反斜杠路径在 Linux 版上本来就
 * 不是有效路径，与 Python 同——两版都跑在同一个平台上，不比跨平台行为）。
 */
export function agentFamily(agentPath) {
  const ap = String(agentPath ?? '').trim();
  if (ap.startsWith(DSH_PLUGIN_PREFIX)) return 'dsh_plugin';
  if (LEGACY_WEB_PREFIXES.some((prefix) => ap.startsWith(prefix))) return RETIRED_FAMILY;
  const name = path.basename(ap).toLowerCase();
  if (RETIRED_NAME_HINTS.some((hint) => name.includes(hint))) return RETIRED_FAMILY;
  if (name === 'dsh') return RETIRED_FAMILY;     // 裸 dsh CLI（headless 形态）已退场
  return 'dsh_plugin';                           // 空串/未知名的默认族（见文件头 ⑤）
}

// ══════════════════════════════════════════════════════════════════════════
// M6-2：扫描口（`agents.py:45-247`）
//
// 与 Python 的形态差异（两条，都是「Node 没有 stdlib 对应物」）：
//   ① `shutil.which` → 本地 `whichSync`：POSIX 语义（名字含 `/` 直接判，否则遍历 `PATH`
//      各段取第一个「文件且可执行」者）。Windows 的 PATHEXT 分支不在本轮范围（本机 POSIX）。
//   ② `glob.glob` → 本地 `globDirs`：只支持本文件用到的那一种模式（`<base>/*/<suffix>`，
//      单个 `*` 整段通配），按 `sorted()` 返回——与 `sorted(glob.glob(pat))` 同序。
// 另注：`_probe_version` 的 `text[0][:120]` 在 Python 按**码点**切，这里用 `[...str]` 同口径
// （`String.prototype.slice` 会切在 UTF-16 码元上）。
// ══════════════════════════════════════════════════════════════════════════

/** 支持的 agent 清单（`agents.py:AGENT_DEFS`；展示名仅作文档，实际用于定位 dsh 可执行） */
export const AGENT_DEFS = [['dsh（DeepSeek Harness）', ['dsh']]];

/** PATH 之外常见的安装目录（`agents.py:EXTRA_DIRS`，顺序即查找顺序） */
export const EXTRA_DIRS = [
  '/usr/local/bin',
  path.join(os.homedir(), '.local/bin'),
  '/bin/versions/node',
  path.join(os.homedir(), '.npm-global/bin'),
];
if (process.platform === 'win32' && process.env.APPDATA) {
  EXTRA_DIRS.push(path.join(process.env.APPDATA, 'npm'));
}

/** 递归进 versions 下各 node 版本的 bin/（`agents.py:VERSIONS_BIN_GLOB`） */
export const VERSIONS_BIN_GLOB = '/bin/versions/node';

/** conda/mamba 各虚拟环境的 bin 目录（`agents.py:CONDA_ENV_BIN_GLOBS`，glob 模式） */
export const CONDA_ENV_BIN_GLOBS = [
  '/opt/miniconda3/envs/*/bin',
  '/opt/anaconda3/envs/*/bin',
  path.join(os.homedir(), 'miniconda3/envs/*/bin'),
  path.join(os.homedir(), 'anaconda3/envs/*/bin'),
];

/** skill 目录约定（`agents.py:SKILL_DIRS_BY_FAMILY`）：族 → [用户级元组, 项目级元组] */
export const SKILL_DIRS_BY_FAMILY = {
  dsh_plugin: [['~/.dsh/skills', '~/.agents/skills'], ['.dsh/skills', '.agents/skills']],
};

/** SKILL.md 相对扫描根的最大目录深度（`agents.py:SKILL_WALK_MAX_DEPTH`） */
export const SKILL_WALK_MAX_DEPTH = 2;

/** `_SKILL_FRONT_RE`：`\A---\s*\n(.*?)\n---`（DOTALL） */
const SKILL_FRONT_RE = /^---\s*\n([\s\S]*?)\n---/;
/** `_SKILL_NAME_RE` / `_SKILL_DESC_RE`：多行模式下 `^name:` / `^description:`（行首锚定） */
const SKILL_NAME_RE = /^name:[ \t]*(.+)$/m;
const SKILL_DESC_RE = /^description:[ \t]*(.+)$/m;

/** description 截断长度（`agents.py:_SKILL_DESC_LIMIT`） */
export const SKILL_DESC_LIMIT = 200;

/** 文本拆行（照 Python `str.splitlines()` 的边界集合） */
function splitLines(text) {
  return String(text ?? '').split(/\r\n|\r|\n|\u2028|\u2029/);
}

/** 文件是否「存在且可执行」（Python `os.path.isfile(p) and os.access(p, os.X_OK)`） */
function isExecutableFile(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `os.path.isdir`（不存在/权限不足一律 false） */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `os.path.expanduser('~/x')`：只处理开头的 `~`（POSIX 下用 HOME） */
function expandUser(p) {
  const s = String(p ?? '');
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return s;
}

/** `shutil.which` 的 POSIX 子集（见文件头差异①） */
export function whichSync(name) {
  const n = String(name ?? '');
  if (!n) return null;
  if (n.includes('/')) return isExecutableFile(n) ? n : null;
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, n);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** `glob.glob` 的单 `*` 整段通配子集（见文件头差异②），返回 `sorted()` 序 */
function globDirs(pattern) {
  const star = pattern.indexOf('*');
  if (star < 0) return [pattern];
  const base = pattern.slice(0, pattern.lastIndexOf('/', star));
  const rest = pattern.slice(pattern.indexOf('/', star));
  let names;
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }
  return names.slice().sort().map((n) => `${base}/${n}${rest}`);
}

/**
 * `agents._search_extra`：在扩展目录中查找 name 可执行文件，返回路径或 null。
 *
 * 命中判据是「文件 + 可执行位」（`agents.py:82/88`）；`VERSIONS_BIN_GLOB` 那一项要**再下钻
 * 一层**到 `<d>/<版本>/bin/<name>`；conda 那组是 glob 展开后逐个匹配。
 */
export function searchExtra(name) {
  const candidates = [];
  for (const d of EXTRA_DIRS) {
    if (!isDir(d)) continue;
    if (d === VERSIONS_BIN_GLOB) {
      let versions;
      try {
        versions = fs.readdirSync(d);
      } catch {
        versions = [];
      }
      for (const ver of versions) candidates.push(path.join(d, ver, 'bin', name));
    } else {
      candidates.push(path.join(d, name));
    }
  }
  for (const p of candidates) {
    if (isExecutableFile(p)) return p;
  }
  for (const pat of CONDA_ENV_BIN_GLOBS) {
    for (const bindir of globDirs(pat)) {
      const p = path.join(bindir, name);
      if (isExecutableFile(p)) return p;
    }
  }
  return null;
}

/**
 * `agents._probe_version`：跑 `--version`（2s 超时），失败返回空串。
 *
 * Python 的 `except (OSError, TimeoutExpired)` 对应 Node 的 `error`（ENOENT/EACCES）与
 * 「被信号杀死」（spawnSync 超时 ⇒ `status === null`）；**非 0 退出不算失败**
 * （Python `subprocess.run` 同样不抛），照旧读它写出来的 stdout/stderr，
 * 取首行（`splitlines()` 口径）并按码点截 120。
 */
export function probeVersion(exePath) {
  const p = spawnSync(exePath, ['--version'], {
    encoding: 'utf8',
    timeout: 2000,
    cwd: os.tmpdir(),
    maxBuffer: 4 * 1024 * 1024,
  });
  if (p.error || p.status === null) return '';
  const text = splitLines(String(p.stdout || p.stderr || '').trim());
  return text.length ? [...text[0]].slice(0, 120).join('') : '';
}

/**
 * `agents.scan_agents`：扫描本机 dsh 可执行，返回**产品入口单条目**（恒 1 条）。
 *
 * 未找到时同样返回一条 `found=false`（前端显示「未找到」），保持「下拉里有且只有这一条」
 * 的读侧不变量。**裸 dsh CLI 行不返回**（它属退场族，列出来是误选陷阱）。
 */
export function scanAgents() {
  let found = '';
  for (const [, bins] of AGENT_DEFS) {
    for (const b of bins) {
      found = whichSync(b) || searchExtra(b) || '';
      if (found) break;
    }
    if (found) break;
  }
  return [{
    name: PLUGIN_ENTRY_NAME,
    path: found ? DSH_PLUGIN_PREFIX + found : '',
    version: found ? probeVersion(found) : '',
    found: Boolean(found),
  }];
}

/**
 * `agents._parse_skill_md`：解析 SKILL.md 的 frontmatter，返回 `[name, description]`。
 *
 * 只读前 **4096 字节**（照 `f.read(4096)`，按 UTF-8 解码后的字符数）；读失败返回 null。
 * name 缺省用所在目录名；description 缺省空串并截断到 200（Python `[:200]` 按码点）。
 */
export function parseSkillMd(filePath, fallbackName) {
  let head;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const read = fs.readSync(fd, buf, 0, 4096, 0);
      head = new TextDecoder('utf-8').decode(buf.subarray(0, read));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const m = SKILL_FRONT_RE.exec(head);
  const body = m ? m[1] : head;               // 无 frontmatter 时退化为头部全文（容错）
  const nm = SKILL_NAME_RE.exec(body);
  const dm = SKILL_DESC_RE.exec(body);
  const name = nm ? nm[1].trim() : fallbackName;
  const desc = dm ? [...dm[1].trim()].slice(0, SKILL_DESC_LIMIT).join('') : '';
  return [name, desc];
}

/**
 * `agents._scan_skill_dir`：扫一个 skill 根（深度受限），返回 `[{name,description,source}]`。
 *
 * 深度按「相对根的目录层数」算：只在 `rel < SKILL_WALK_MAX_DEPTH` 时继续下钻，
 * 故 `SKILL.md` 最深允许出现在第 2 层（`<类>/<名>/SKILL.md`）。命中目录先收自身再下钻，
 * 与 `os.walk` 的自顶向下序一致。
 */
export function scanSkillDir(root, source) {
  const skills = [];
  const base = String(root ?? '').replace(/[/\\]+$/, '');
  if (!base || !isDir(base)) return skills;
  const baseDepth = base.split(path.sep).length - 1;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === 'SKILL.md')) {
      const parsed = parseSkillMd(path.join(dir, 'SKILL.md'),
        path.basename(dir.replace(/[/\\]+$/, '')));
      if (parsed) skills.push({ name: parsed[0], description: parsed[1], source });
    }
    const rel = dir.split(path.sep).length - 1 - baseDepth;
    if (rel >= SKILL_WALK_MAX_DEPTH) return;
    for (const ent of entries) {
      if (ent.isDirectory()) walk(path.join(dir, ent.name));
    }
  };
  walk(base);
  return skills;
}

/**
 * `agents.scan_skills`：列出 agent 可用的 skill（用户级 + 项目级），按 name 排序。
 *
 * 同名时项目级**覆盖**用户级；用户级内部先命中者保留（`setdefault` 语义）；`agent_path`
 * 为空返回空列表；无目录约定的族返回空。
 */
export function scanSkills(agentPath, projectDir = '') {
  const ap = String(agentPath ?? '').trim();
  if (!ap) return [];
  const family = agentFamily(ap);
  const [userDirs, projDirs] = SKILL_DIRS_BY_FAMILY[family] || [[], []];
  const found = new Map();
  for (const d of userDirs) {
    for (const s of scanSkillDir(expandUser(d), 'user')) {
      if (!found.has(s.name)) found.set(s.name, s);
    }
  }
  const pd = String(projectDir ?? '').trim();
  if (pd) {
    for (const d of projDirs) {
      for (const s of scanSkillDir(path.join(pd, d), 'project')) {
        found.set(s.name, s);           // 项目级覆盖用户级
      }
    }
  }
  return [...found.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
