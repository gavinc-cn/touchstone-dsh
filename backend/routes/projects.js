/**
 * 路由族：项目 / 用户偏好 / 目录浏览 / 项目文件 / 监控状态 / 案例库与 bug 报告（M3 读路径）
 *
 * 归属条目（顺序 = 匹配顺序，见 `./index.js` 文件头；必须与 `server.py:_route_get` 同序）：
 *   - `GET /api/projects`                    → `_api_list_projects`
 *   - `GET /api/projects/dup_check`          → `_api_dup_check`
 *   - `GET /api/fs/browse`                   → `_api_fs_browse`
 *   - `GET /api/prefs`                       → `_api_prefs_get`
 *   - `GET /api/state`                       → `_api_state`
 *   - `GET /api/stream`                      → `_stream`（SSE，StateCache 指纹驱动）
 *   - `GET /api/projects/<id>`               → `_api_get_project`
 *   - `GET /api/projects/<id>/file`          → `_api_project_file`（`raw=1` 走 `_send_project_file_raw`）
 *   - `GET /api/projects/<id>/bugs`          → `_api_list_bugs`
 *   - `GET /api/projects/<id>/bugs/<dir>`    → `_api_get_bug`
 *   - `POST /api/fs/mkdir`                   → `_api_fs_mkdir`(2357)（M6.9 写路径）
 *   - `POST /api/projects`                   → `_api_create_project`(2212)
 *   - `POST /api/prefs`                      → `_api_prefs_set`(2497)
 *   - `POST /api/projects/<id>/(archive|unarchive)` → `_api_archive_project`(2462)
 *   - `POST /api/projects/<id>/bugs/<dir>/reject`   → `_api_reject_bug`(3997)（M6-6）
 *   - `PATCH /api/projects/<id>`             → `_api_update_project`(2268)
 *   - `DELETE /api/projects/<id>`            → `_api_delete_project`(2321)
 *
 * 写路径的顺序=Python 的 `do_POST`(1050→1102) / `do_PATCH`(1231) / `do_DELETE`(1273) 链。
 * RAG/内置资产/agent 扫描写端点属其他族（`admin.js`/`assets.js`/`agents.js`）。
 *
 * ── 三处「看着能简化、其实一改就分叉」的地方（逐条对着 server.py 核过） ─────────────
 * 1. **`_owned_project` 与 `ctx.ownedProject` 不是同一件东西**：Python 的 `_owned_project`
 *    **只返回行、不写响应**，404 由各调用点自己发。`ctx.ownedProject` 则「越权即回 404 并返回
 *    null」（这是 M3 给其他族的统一契约，省得每处重写）。于是：
 *      - `_api_get_project`/`_api_project_file`/`_api_list_bugs`/`_api_get_bug` 的 Python 形态是
 *        「拿到 None → 自己 404」，与 `ctx.ownedProject` **正好等价**（用它，然后直接 return）；
 *      - `_resolve_project`（`/api/state`、`/api/stream` 用）**不同**：它拿不到越权项目会
 *        **继续回落**到「当前用户第一个项目」并最终 200。若在这里误用 `ctx.ownedProject`，
 *        会先发一个 404 再发一个 200（Python 侧只有一个 200）⇒ 故本文件自带
 *        `ownedProjectQuiet()`（只查行、不写响应），语义与 Python 的 `_owned_project` 逐字对应。
 * 2. **`_api_dup_check` 的 `norm()` 是 `os.path.normpath`**：POSIX 下 `//a/b` 保留双斜杠，
 *    `path.normalize` 会压成 `/a/b` ⇒ 走 `lib.pyNormpath`（单测钉住这几个形态）。
 * 3. **`_api_get_bug` 的 `os.path.join(row["bug_dir"], bug_dir)`**：`bug_dir` 来自 URL 且先
 *    `unquote`，**可能是绝对路径**（`bugs/%2Ftmp`）——Python 的 `join` 遇到绝对段会**丢弃**前面的
 *    目录，Node 的 `path.join` 只会拼接 ⇒ 必须 `lib.pyJoin`。这是「照抄既有行为」而不是加固：
 *    两侧保持同一行为才有对拍价值（该行为本身已在报告中登记，未擅自改安全语义）。
 *
 * ── 错误正文的两种字节形态（本族两条都用到了） ───────────────────────────────────
 * Python 的 `_respond(code, body)` 第二参有两种写法，字节形态不同，Node 侧必须逐点跟住：
 *   - **硬编码字节串**（本项目/bug/prefs 的 404）：`b'{"error":"project not found"}'` ⇒ 紧凑
 *     ⇒ 用 `ctx.error(...)`；
 *   - **`json.dumps({"error": ...})`**（fs/browse 的 400、project_file 的四档、raw 的 404/413）
 *     ⇒ 冒号后带空格 ⇒ 用 `ctx.errorSpaced(...)`。
 * 判法：去 `server.py` 看该处 `_respond` 的第二参是字节串字面量还是 `json.dumps(...)`。
 *
 * ── 写路径（M6.9）的三条契约 ─────────────────────────────────────────────────────
 * 1. **读体的时机**是契约，不是「想读就读」。Python 在 `do_POST:1048` 给**每个** POST
 *    统一读体（`logout`/`change_password` 排在那行之前，故那两条不许读）；`do_PATCH:1238`
 *    在**调用 handler 之前**读（`self._api_update_project(..., self._read_json() or {})`）；
 *    `do_DELETE` 全程不读，只有 `_api_delete_project` 内部在**归档闸之后**才读。
 *    `ctx.readBody()` 是记忆化的，但**没被读掉的请求体会留在 socket 上**污染同一条 keep-alive
 *    连接的下一个请求（`server.js` 只在未命中路由时补读）⇒ 必须逐端点照 Python 的位置读：
 *      - `POST /api/projects`、`/api/prefs`、`/api/fs/mkdir`、`/archive|/unarchive`：**一进
 *        handler 就读**（对应 `do_POST:1048` 在读体之后才分派）；
 *      - `PATCH /api/projects/<id>`：**在 `ctx.ownedProject` 之前读**（404 档也要读掉）；
 *      - `DELETE /api/projects/<id>`：**在归档闸之后读**（未归档的 400 档**不读体**）。
 * 2. **错误体的两种形态**见上一节；本节的 400 全部是 `json.dumps` 口径 ⇒ `ctx.errorSpaced`，
 *    而 prefs 的两条 400 与 404 是硬编码字节串 ⇒ `ctx.error`。成功体里
 *    `{"ok":true}` 是字面量 ⇒ `ctx.text`；`{"id": N}` 与 fs/mkdir 的 data 是 `json.dumps`
 *    ⇒ `ctx.json`。混用一处就差一个空格。
 * 3. **`OSError` 的文案要逐字节相同**（`工作目录不可用: [Errno 17] File exists: '<path>'`）：
 *    Python 的 `str(e)` 形态是 `[Errno {errno}] {os.strerror(errno)}: '{filename}'`，而 Node
 *    的 `util.getSystemErrorMessage()` 给的是 libuv 的措辞（`file already exists` 小写）⇒
 *    本文件自带 `PY_STRERROR` 实测表 + `pyOsErrorText()`（见该函数注释）。
 *
 * ── 与 Python 的一处**有意**差异 ─────────────────────────────────────────────────
 * `/api/stream` 在「当前用户一个项目都没有」时，Python 的 `_stream_note` 写完
 * `data: {"error":"no project"}\n\n` **不断开连接**（响应既无 Content-Length 也非 chunked，
 * 客户端只能靠自己主动断开）。Node 侧写完即 `end()`：客户端可观察的帧序列完全一致，
 * 差别只在「服务端是否保持这条半开连接」。保持半开会让 Node 侧每请求漏一个 socket。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';

import * as dbmod from '../lib/db.js';
import { listTasks, nowStr } from '../lib/db.js';
import {
  FILE_RAW_MAX, PY_WS, bugCases, findCaseDirs, fsBrowse, fsMkdir, isDir, normalizeProjectName,
  parseFields, parseStatusMd, pathLastSegment, pyBasename, pyIntOr, pyIsDigits, pyJoin, pyMtimeInt,
  pyNormpath, pyRelpath, pyStrip, readText, readTextPreview, resolveProjectFile, setMdField,
} from '../lib/lib.js';
import { bugLastTask, listProjectBugs, pyJsonDumpsSorted } from '../lib/casescan.js';
import { pyJsonDumps } from '../lib/pyjson.js';
import { quote, unquote } from '../lib/query.js';
import * as runner from '../lib/runner.js';
import { normalizeEffort, normalizePermissionMode } from '../lib/servercaps.js';

/** bug 报告目录名：`20260829_0635_FS_cli_config_load`（标题取 `_FS_` 之后那段） */
const BUG_DIR_RE = /^\d{8}_\d{4}_([^\n]+)$/;

/** `(?m)^## 拒绝记录\s*$`（server.py:4036）：`\s` 取 Python 空白集（PY_WS 与全仓同源） */
const REJECT_SECTION_RE = new RegExp(`^## 拒绝记录${PY_WS}*$`, 'm');

/**
 * `_append_reject_record`(4030)：把拒绝理由追加到 bug_report.md 的「拒绝记录」小节。
 *
 * 三个必须照抄的点：① `read_text` 的通用换行归一（`\r\n`→`\n`）发生在正则之前；
 * ② 正则里的 `\s*` 是**贪婪**的，会吃掉小节标题后的空行 ⇒ `m.end()` 落在空行之后，
 * 拼回去时 `rest` 要再 `lstrip("\n")`；③ 没有该小节时 `rstrip("\n")` 后新建。
 * 写失败（OSError）**整体吞掉**——拒绝理由写不进去也不该让整条端点半途失败。
 */
function appendRejectRecord(reportPath, reason) {
  const content = readText(reportPath);
  if (!content) return;
  const line = `- ${nowStr()} ${reason}`;
  const m = REJECT_SECTION_RE.exec(content);
  let text;
  if (m) {
    const rest = content.slice(m.index + m[0].length).replace(/^\n+/, '');
    text = content.slice(0, m.index + m[0].length) + '\n\n' + line + (rest ? `\n${rest}` : '\n');
  } else {
    text = `${content.replace(/\n+$/, '')}\n\n## 拒绝记录\n\n${line}\n`;
  }
  try {
    fs.writeFileSync(reportPath, text, 'utf8');
  } catch {
    // 照 Python：OSError 静默（拒绝记录写不进去不影响主流程）
  }
}

/**
 * `_api_reject_bug`(3997)：拒绝 bug 报告 = 标记「已拒绝」+ 追加拒绝记录 + 创建修例任务。
 *
 * 归属 → bug 目录存在性 → 理由非空 → 落盘标记 → 去重（同 bug 已有排队/运行中的 reject 任务
 * 时复用其 id）→ 落库建任务 → `runner.INSTANCE.submit`。响应 `{ok, task_id}` 走 `json.dumps`。
 */
async function apiRejectBug(ctx, projectId, bugDirRaw) {
  const body = await ctx.readBody();           // Python 在 do_POST:1048 统一读体
  const row = ctx.ownedProject(projectId);
  if (row === null) return;
  const bugDir = pyStripSlashes(pyStrip(unquote(bugDirRaw)));
  const dirPath = pyJoin(row.bug_dir, bugDir);
  if (!isDir(dirPath)) {
    ctx.error(404, 'bug not found');           // 紧凑（Python 是字节串字面量）
    return;
  }
  const reason = pyStrip(pyStrOrEmpty(body.reason));
  if (!reason) {
    ctx.text(400, '{"error":"请填写拒绝理由"}', 'application/json; charset=utf-8');
    return;
  }
  const reportPath = pyJoin(dirPath, 'bug_report.md');
  // 状态 → 已拒绝；理由追加到「拒绝记录」小节（重复拒绝累加，最新在最上）
  setMdField(reportPath, '状态', '已拒绝');
  appendRejectRecord(reportPath, reason);
  let tid = null;
  for (const t of listTasks(row.id, { db: ctx.db })) {
    if (t.task_type !== 'reject' || !['queued', 'running'].includes(t.status)) continue;
    let parsed;
    try {
      parsed = JSON.parse(t.payload || '{}');
    } catch {
      continue;                                // = Python 的 ValueError 分支：跳过这条任务
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // 照 Python：`json.loads(...).get` 对非 dict 抛 AttributeError ⇒ 只断这一条连接
      throw new TypeError(`'${Array.isArray(parsed) ? 'list' : typeof parsed}'`
        + " object has no attribute 'get'");
    }
    if (parsed.bug_dir === bugDir) {
      tid = t.id;
      break;
    }
  }
  if (tid === null) {
    const bm = BUG_DIR_RE.exec(bugDir);
    const name = `修例 ${bm ? bm[1] : bugDir}`;
    let casesBase = 0;
    try {
      const state = ctx.stateCache.get(row.id, row.cases_root, row.bug_dir, row.work_dir);
      casesBase = (state.library.stats || {}).total || 0;
    } catch {
      casesBase = 0;                           // 照 Python：任何异常 ⇒ 基线 0
    }
    tid = dbmod.insertTask(row.id, {
      name,
      autoFix: 0,
      retest: '不复测',
      stopType: 'rounds',
      stopValue: '1',
      taskType: 'reject',
      payload: pyJsonDumps({ bug_dir: bugDir, reason }),
      casesBase,
    }, { db: ctx.db });
    runner.INSTANCE.submit(tid);
  }
  ctx.json(200, { ok: true, task_id: tid });
}

/** Python `str(x or "")`（标量面；容器按 JSON 文本兜底——与既有私有助手同口径） */
function pyStrOrEmpty(value) {
  if (value === null || value === undefined || value === false || value === 0) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length ? JSON.stringify(value) : '';
  if (typeof value === 'object') return Object.keys(value).length ? JSON.stringify(value) : '';
  return String(value);
}

/** Python `s.strip("/")`：只剥两端的 `/`（本处 bug_dir 来自 `([^/]+)`，理论不触发） */
function pyStripSlashes(text) {
  return String(text).replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * 聚合状态缓存 —— **全进程唯一实例在 `routes/index.js` 的 `STATE_CACHE`**（M4.5 收口）：
 * M3 时本文件与 `routes/tasks.js` 各建一个实例（行为等价但同盘扫两遍），现统一由
 * `ctx.stateCache` 下发（= `server.py:Handler.state_cache`，`/api/state`、`/api/stream`
 * 与 `_task_json.new_cases` 三处共用一份）。
 */

/** `time.sleep(0.5)` 的 Promise 版（`_stream` 的轮询间隔） */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * `_project_json`：项目行的对外形状（键序与 Python 逐条相同；`archived` 折成布尔）。
 * @param {object} row
 * @returns {object}
 */
function projectJson(row) {
  return {
    id: row.id,
    name: row.name,
    project_dir: row.project_dir,
    agent_path: row.agent_path,
    work_dir: row.work_dir,
    bug_dir: row.bug_dir,
    guide_text: row.guide_text,
    commit_spec: row.commit_spec,
    deploy_spec: row.deploy_spec,
    env_label: row.env_label,
    model: row.model,
    skill_understand: row.skill_understand,
    skill_deploy: row.skill_deploy,
    skill_commit: row.skill_commit,
    skill_test: row.skill_test,
    skill_cases: row.skill_cases,
    // 项目级会话默认值（2026-10-04）：思考等级 / 权限档（空=不指定）
    reasoning_effort: row.reasoning_effort,
    permission_mode: row.permission_mode,
    archived: Boolean(row.archived),
    created_at: row.created_at,
  };
}

/** 看板三列数量的缺省值（`db.board_counts_many` 无该 id 时的回落，同 Python 的字面量） */
function emptyBoardCounts() {
  return { doing: 0, blocked: 0, review: 0 };
}

/**
 * `_owned_project` 的**静默**版：只查行、不写响应。
 *
 * 为什么需要它：`_resolve_project` 依赖「拿不到就继续回落」这一副作用（见文件头 §1），
 * 用会发 404 的 `ctx.ownedProject` 会多出一个响应。
 * @param {object} ctx
 * @param {number} projectId
 * @returns {object|null}
 */
function ownedProjectQuiet(ctx, projectId) {
  const row = dbmod.getProject(projectId, { db: ctx.db });
  if (row === null || row === undefined || row.user_id !== ctx.user.id) return null;
  return row;
}

/**
 * `_resolve_project`：按 `?project=<id>` 取当前用户的项目；缺省（或该 id 不可见）取当前用户
 * 第一个项目（列表按 id 升序 ⇒ 「第一个」= 最小 id）。
 * @param {object} ctx
 * @returns {object|null}
 */
function resolveProject(ctx) {
  const pid = ctx.q('project', '');
  if (pyIsDigits(pid)) {
    const row = ownedProjectQuiet(ctx, pyIntOr(pid, 0));
    if (row) return row;
  }
  const rows = dbmod.listProjects(ctx.user.id, { db: ctx.db });
  return rows.length ? rows[0] : null;
}

/**
 * `file?inline=1` 的内联白名单（2026-10-16，`server.py:PROJECT_INLINE_IMAGE_TYPES` 同表）：
 * **只放行浏览器可直接渲染的位图**。与 `raw=1`「一律 text/plain 或附件下载」的红线配套——
 * 按扩展名把 agent 在工作区写的内容内联下发，等于让同源页面按该类型解释它；`html`/`svg`/`js`
 * 这类可执行/可带脚本的类型一律不给，只给位图（`<img>` 里不会执行任何东西）。
 * 扩展名口径同 `fileExt()`（`os.path.splitext(...)[1].lstrip('.').lower()`，大小写不敏感）。
 */
const PROJECT_FILE_INLINE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

/**
 * `_send_project_file_raw`：原文（新标签打开/二进制下载）：文本按 text/plain，二进制按附件下载。
 *
 * 为什么不用 `ctx.file()`：`sendFile` 缺三样 Python 侧有的东西 —— `X-Content-Type-Options:
 * nosniff`、二进制的 `Content-Disposition`、以及「超 32MiB 回 413」；且它把整个文件读进内存，
 * 而 Python 是 64KB 分块流式写。故这里直接写 `ctx.res`（逐条对齐 Python 的头与分块）。
 * @param {object} ctx
 * @param {string} filePath
 */
function sendProjectFileRaw(ctx, filePath) {
  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    ctx.errorSpaced(404, '文件不存在或不可读');
    return;
  }
  if (size > FILE_RAW_MAX) {
    ctx.errorSpaced(413, '文件过大，无法按原文打开');
    return;
  }
  const name = pyBasename(filePath);
  let binary;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.allocUnsafe(65536);
      const n = fs.readSync(fd, buf, 0, Math.min(size, 65536), 0);
      binary = buf.subarray(0, n).includes(0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    binary = true;                                 // 探测失败按二进制处理（只影响下载方式）
  }
  const headers = {
    'Content-Type': binary ? 'application/octet-stream' : 'text/plain; charset=utf-8',
    'Content-Length': String(size),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (binary) {
    const asciiName = name.replace(/[^A-Za-z0-9._-]/g, '_') || 'download';
    headers['Content-Disposition'] =
      `attachment; filename="${asciiName}"; filename*=UTF-8''${quote(name)}`;
  }
  ctx.res.writeHead(200, headers);
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (!n) break;
        ctx.res.write(buf.subarray(0, n));
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // 客户端提前断开属常态（对齐 Python 的 `except (BrokenPipeError, ConnectionResetError, OSError)`）
  }
  try {
    ctx.res.end();
  } catch {
    // 已断开：忽略
  }
}

/**
 * `_send_project_file_inline`：`inline=1` 的项目内位图原图内联下发。
 *
 * 与 `sendProjectFileRaw` 只差两处：Content-Type 按扩展名给真图片类型、不带
 * `Content-Disposition: attachment`（浏览器才肯在 `<img>` 里渲染）。仍带 nosniff 与
 * no-store。扩展名不在白名单 ⇒ 400（不是「不支持就按 raw 下发」——那正是 raw 红线要防的）；
 * 超 `FILE_RAW_MAX` ⇒ 413。三条错误体的 JSON 口径与 Python `json.dumps(..., ensure_ascii=False)`
 * 逐字节相同，故一律走 `ctx.errorSpaced`（`{"error": "…"}` 带空格）。
 * @param {object} ctx
 * @param {string} filePath
 */
function sendProjectFileInline(ctx, filePath) {
  const ctype = PROJECT_FILE_INLINE_TYPES[fileExt(filePath)];
  if (ctype === undefined) {
    ctx.errorSpaced(400, '该类型不支持内联显示');
    return;
  }
  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    ctx.errorSpaced(404, '文件不存在或不可读');
    return;
  }
  if (size > FILE_RAW_MAX) {
    ctx.errorSpaced(413, '文件过大，无法内联显示');
    return;
  }
  ctx.res.writeHead(200, {
    'Content-Type': ctype,
    'Content-Length': String(size),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (!n) break;
        ctx.res.write(buf.subarray(0, n));
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // 客户端提前断开属常态（对齐 Python 的 `except (BrokenPipeError, ConnectionResetError, OSError)`）
  }
  try {
    ctx.res.end();
  } catch {
    // 已断开：忽略
  }
}

/**
 * `_api_project_file` 的 err → (状态码, 消息) 映射（照抄 Python 的字面量，含中文标点）。
 * @param {string} err
 * @returns {[number, string]|null}
 */
function projectFileError(err) {
  const messages = {
    empty: [400, 'path 不能为空'],
    outside: [403, '路径不在项目目录/工作目录范围内'],
    dir: [400, '该路径是目录，暂不支持预览'],
    missing: [404, '文件不存在或不可读'],
  };
  return messages[err] || null;
}

/**
 * `os.path.splitext(path)[1].lstrip(".").lower()`：扩展名（可有多个点，末尾空扩展名得空串）。
 * @param {string} filePath
 * @returns {string}
 */
function fileExt(filePath) {
  return path.extname(filePath).replace(/^\.+/, '').toLowerCase();
}

// ==========================================================================
// 写路径（M6.9）：`POST /api/projects`、`PATCH|DELETE /api/projects/<id>`、
// `/archive|/unarchive`、`POST /api/prefs`、`POST /api/fs/mkdir`
//
// 期望值全部来自 `server.py`（行号写在每个函数头），不是从 Node 实现反推。
// ==========================================================================

// ---------- Python 语义助手（本文件私有；口径与 `routes/tasks.js` 的同名助手一致） ----------

/** Python 真值：`""`/`0`/`None`/`False`/空容器为假（JS 的 `[]`/`{}` 是 truthy，必须显式收口） */
function pyTruthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/**
 * Python `str()`（只覆盖 JSON 里会出现的类型）：str→原样；bool→`True`/`False`；null→`None`；
 * 数字→十进制文本；容器→JSON 文本兜底（Python 是 `repr` 形态，容器只可能来自手写调用，
 * 与 `routes/tasks.js:pyStr` 同一条已知差异）。
 *
 * **为什么不用同文件既有的 `pyStrOrEmpty`**：那个是早期写点留下的版本，`true` 会变成
 * `'true'`（Python 是 `'True'`），`str(row["commit_spec"])` 的 `None → 'None'` 也不成立；
 * 它现在只被 `_api_reject_bug` 的 reason 用，不在本次改动范围内（已知差异，未顺手改）。
 */
function pyStr(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

/** Python `dict.get(key, dflt)`：键存在但值为 null 时**不**回落 dflt（与 Python 同） */
function pyGet(obj, key, dflt = '') {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : dflt;
}

/** Python `str(x or "").strip()`（`str()` 永不抛） */
function pyStripStr(value) {
  return pyStrip(pyStr(pyTruthy(value) ? value : ''));
}

/**
 * Python `(x or "").strip()` —— **没有** `str()` 包裹的那种写法。
 *
 * 真值但非字符串时 Python 抛 `AttributeError`（`5 .strip()`），一路冒到 socketserver
 * ⇒ **该连接不回响应、直接断**。这里同形抛错，由 `routes/index.js:dispatchSafely` 收口成
 * `res.destroy()`（与 Python 只断一条连接同形）。受影响的写点：建项目的
 * `project_dir`/`name`/`agent_path`/`work_dir`（`server.py:2213-2218`）、改项目的
 * `project_dir`/`work_dir`/`name`/`agent_path`、删项目的 `confirm_name`。
 */
function pyStripBare(value) {
  if (!pyTruthy(value)) return '';
  if (typeof value !== 'string') {
    throw new TypeError(`AttributeError: '${Array.isArray(value) ? 'list' : typeof value}'`
      + " object has no attribute 'strip'");
  }
  return pyStrip(value);
}

/**
 * `sqlite3.IntegrityError` 的 Node 判据：`SQLITE_CONSTRAINT`（主码 19）**一族**，不只唯一索引。
 *
 * 口径与 `lib/waitq.js:214` 的 `isIntegrityError` 相同（Python 的
 * `except sqlite3.IntegrityError` 也吃 NOT NULL 等约束错）；**不 import**：那是 waitq 的私有
 * 函数（未导出），本文件自带等价物，避免改动那条车道的文件。
 */
function isIntegrityError(error) {
  return Boolean(error) && error.code === 'ERR_SQLITE_ERROR'
    && (Number(error.errcode) & 0xff) === 19;
}

/** Node 的 fs 错误（带 code/syscall），与「解码/解析」类错误区分开（同 `lib/loadgen.js` 口径） */
function isOsError(error) {
  return Boolean(error) && typeof error.code === 'string' && typeof error.syscall === 'string';
}

/**
 * errno → glibc `strerror(3)` 文案表（**实测值**：`python3 -c "import os;print(os.strerror(n))"`）。
 *
 * 为什么不直接用 `util.getSystemErrorMessage()`：那是 **libuv** 的表，措辞与 glibc 不同
 * （实测 17 ⇒ `file already exists`，glibc 是 `File exists`），而这段文案要逐字节进 400 正文。
 */
const PY_STRERROR = new Map([
  [1, 'Operation not permitted'],
  [2, 'No such file or directory'],
  [13, 'Permission denied'],
  [17, 'File exists'],
  [20, 'Not a directory'],
  [28, 'No space left on device'],
  [30, 'Read-only file system'],
  [36, 'File name too long'],
  [40, 'Too many levels of symbolic links'],
]);

/**
 * Python `str(OSError)` 的逐字节还原：`[Errno {errno}] {strerror}: '{filename}'`。
 *
 * 三个要点：
 *  ① Node 的 `err.errno` 是**负数**（libuv 口径）⇒ 取 `Math.abs`；`getSystemErrorMessage`
 *     反而要求负数（传正数抛 `ERR_OUT_OF_RANGE`）；
 *  ② `filename` 由调用方传**当时传给 `mkdirSync` 的那个路径**（Python 的 `e.filename` 就是
 *     它，实测两档都是传入路径本身；Node 的 `err.path` 在递归建父目录的某些档位可能指向
 *     中间层 ⇒ 以 Python 的路径为准）；
 *  ③ 表里没有的 errno **不编文案**：退回 `util.getSystemErrorMessage()`（libuv 自带的表），
 *     该档措辞与 glibc 可能不同 —— **已登记为未验项**，本机实测只覆盖了 errno 17/20 两档。
 *
 * @param {any} error `mkdirSync` 抛出的 fs 错误
 * @param {string} [filename] Python 侧 `e.filename` 对应的路径
 * @returns {string}
 */
function pyOsErrorText(error, filename) {
  const raw = Number(error && error.errno);
  const where = filename !== undefined && filename !== null ? filename : (error && error.path);
  const suffix = where === undefined || where === null ? '' : `: '${where}'`;
  if (!Number.isFinite(raw) || raw === 0) {
    // 理论上到不了（mkdir 一定带 errno）：宁可原样透出 Node 的 message，也不硬编假文案
    return `${(error && error.message) || String(error)}${suffix}`;
  }
  const errno = Math.abs(raw);
  const known = PY_STRERROR.get(errno);
  const text = known === undefined ? util.getSystemErrorMessage(-errno) : known;
  return `[Errno ${errno}] ${text}${suffix}`;
}

/**
 * `for d in (work_dir, db.cases_root_of(work_dir), db.bug_root_of(work_dir)): os.makedirs(d, exist_ok=True)`
 * （`server.py:2249` 建项目 / `2298` 改项目共用）。
 *
 * `mkdirSync(recursive: true)` 对应 `makedirs` 的递归建父目录，`exist_ok` 语义由 Node 的
 * recursive 覆盖（同名目录不报错、同名普通文件报 EEXIST）。失败时把**当时那条路径**一并回传
 * ——不是「谁抛的谁猜」，而是 Python 的 `e.filename` 口径。
 *
 * **已知差异（未验）**：路径中间有**悬空符号链接**时 Python 抛 `NotADirectoryError`(20)，
 * Node 的 recursive mkdir 给 `ENOENT`(-2)（本机实测）⇒ 该档文案会不同；正常前端不产生。
 *
 * @param {string} workDir
 * @returns {{error: any, path: string}|null}
 */
function makedirsProjectDirs(workDir) {
  for (const dir of [workDir, dbmod.casesRootOf(workDir), dbmod.bugRootOf(workDir)]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      return { error, path: dir };
    }
  }
  return null;
}

/** `except OSError as e: 400 {"error": f"工作目录不可用: {e}"}`（建/改项目共用，带空格口径） */
function respondWorkDirUnavailable(ctx, failure) {
  ctx.errorSpaced(400, `工作目录不可用: ${pyOsErrorText(failure.error, failure.path)}`);
}

// ---------- 处理器 ----------

/**
 * `_api_create_project`(2212)：新建项目（`body` 在 `do_POST:1048` 已统一读掉）。
 *
 * 四个照抄点：
 *  ① `project_dir` 缺省 `os.path.expanduser("~")` ⇒ `os.homedir()`（**不是** `process.env.HOME`
 *     手拼：HOME 未设时 Python 会回落到 pwd 库，`os.homedir()` 是同一回落，手拼会得空串）；
 *  ② `work_dir` 缺省 `<project_dir>/.touchstone`，用 `pyJoin`（Python 的 join **保留**
 *     `project_dir` 结尾的重复斜杠，`path.join` 会压掉 ⇒ 落库的 work_dir 会差字节）；
 *  ③ `commit_spec`/`deploy_spec` 恒传空串（已废弃），而 `skill_test`/`skill_cases`
 *     **必须往下传**——历史缺陷：这两个字段读了却没传给 `insert_project`，新建项目时
 *     「测试项目/用例规范」静默丢失，只有再编辑一次才存得下；
 *  ④ 建目录在 `insert_project` **之前**：目录建不出来就一条行都不许落。
 */
async function apiCreateProject(ctx) {
  const body = await ctx.readBody();           // Python do_POST:1048 统一读体
  const projectDir = pyStripBare(pyGet(body, 'project_dir', undefined)) || os.homedir();
  // 项目名称留空时自动取项目路径最后一段（前端已先行填充，此处兜底）
  const name = normalizeProjectName(
    pyStripBare(pyGet(body, 'name', undefined)) || pathLastSegment(projectDir));
  const agentPath = pyStripBare(pyGet(body, 'agent_path', undefined));
  // 只填一个工作目录（未填默认 <项目目录>/.touchstone）；案例库/free_style 与
  // bug_report 由平台按固定子目录派生、自动创建
  const workDir = pyStripBare(pyGet(body, 'work_dir', undefined))
    || pyJoin(projectDir, '.touchstone');
  const guideRaw = pyGet(body, 'guide_text', '');
  const guideText = pyStr(pyTruthy(guideRaw) ? guideRaw : '');
  const envRaw = pyGet(body, 'env_label', '');
  const envLabel = pyStr(pyTruthy(envRaw) ? envRaw : '');
  const model = pyStripStr(pyGet(body, 'model', ''));
  const skillUnderstand = pyStripStr(pyGet(body, 'skill_understand', ''));
  const skillDeploy = pyStripStr(pyGet(body, 'skill_deploy', ''));
  const skillCommit = pyStripStr(pyGet(body, 'skill_commit', ''));
  const skillTest = pyStripStr(pyGet(body, 'skill_test', ''));
  const skillCases = pyStripStr(pyGet(body, 'skill_cases', ''));
  // 项目级会话默认值（2026-10-04）：思考等级 / 权限档（空=不指定，非法=400 不静默丢弃）
  const reasoningEffort = normalizeEffort(pyGet(body, 'reasoning_effort', undefined));
  const permissionMode = normalizePermissionMode(pyGet(body, 'permission_mode', undefined));
  if (reasoningEffort === null || permissionMode === null) {
    ctx.errorSpaced(400, '思考等级或权限档非法');
    return;
  }
  // Python 的 try 同时罩着 makedirs 与 insert_project；能抛 OSError 的只有 makedirs
  // （sqlite3 的错是 DatabaseError/OperationalError，不是 OSError）⇒ 拆开是等价的
  const failure = makedirsProjectDirs(workDir);
  if (failure !== null) {
    respondWorkDirUnavailable(ctx, failure);
    return;
  }
  let projectId;
  try {
    projectId = dbmod.insertProject(ctx.user.id, name, projectDir, agentPath, workDir,
      guideText, '', '', envLabel, model,
      skillUnderstand, skillDeploy, skillCommit, skillTest, skillCases,
      reasoningEffort, permissionMode, { db: ctx.db });
  } catch (error) {
    if (isIntegrityError(error)) {
      ctx.errorSpaced(400, '项目名已存在');
      return;
    }
    throw error;
  }
  ctx.json(200, { id: projectId });
}

/**
 * `_api_update_project`(2268)：改项目。
 *
 * 读体位置：Python `do_PATCH:1238` 是 `self._api_update_project(id, self._read_json() or {})`
 * ⇒ **读体发生在 `_owned_project` 之前**（404 档也要把体读掉），本函数的顺序照抄。
 *
 * 未带键＝保持存量（`dict.get(key, row[key])` 语义，**不是** JS 的缺省参数）；两列
 * `commit_spec`/`deploy_spec` 保留存量但**不接受更新**（`str(row[...])` 直传）。
 */
async function apiUpdateProject(ctx, projectId) {
  const body = await ctx.readBody();
  const row = ctx.ownedProject(projectId);
  if (row === null) return;                    // 已回 404 project not found（紧凑字节串）
  const reasoningEffort = normalizeEffort(pyGet(body, 'reasoning_effort', row.reasoning_effort));
  const permissionMode = normalizePermissionMode(
    pyGet(body, 'permission_mode', row.permission_mode));
  if (reasoningEffort === null || permissionMode === null) {
    ctx.errorSpaced(400, '思考等级或权限档非法');
    return;
  }
  try {
    const bodyDir = pyGet(body, 'project_dir', undefined);
    const newDir = pyStripBare(pyTruthy(bodyDir) ? bodyDir : row.project_dir);
    const bodyWork = pyGet(body, 'work_dir', undefined);
    const newWork = pyStripBare(pyTruthy(bodyWork) ? bodyWork : row.work_dir);
    if (newWork !== row.work_dir) {
      // 工作目录变更：新目录与派生子目录一并创建（幂等），旧目录文件不动
      const failure = makedirsProjectDirs(newWork);
      if (failure !== null) {
        respondWorkDirUnavailable(ctx, failure);
        return;
      }
    }
    const bodyAgent = pyGet(body, 'agent_path', undefined);
    const bodyGuide = pyGet(body, 'guide_text', row.guide_text);
    const bodyEnv = pyGet(body, 'env_label', row.env_label);
    dbmod.updateProject(projectId,
      // 名称留空时自动取项目路径最后一段（与新建逻辑一致）
      normalizeProjectName(
        pyStripBare(pyGet(body, 'name', undefined)) || pathLastSegment(newDir)),
      newDir,
      pyStripBare(pyTruthy(bodyAgent) ? bodyAgent : row.agent_path),
      newWork,
      pyStr(pyTruthy(bodyGuide) ? bodyGuide : ''),
      pyStr(row.commit_spec),                  // 已废弃：保留存量、不再接受更新
      pyStr(row.deploy_spec),
      pyStr(pyTruthy(bodyEnv) ? bodyEnv : ''),
      pyStripStr(pyGet(body, 'model', row.model)),
      pyStripStr(pyGet(body, 'skill_understand', row.skill_understand)),
      pyStripStr(pyGet(body, 'skill_deploy', row.skill_deploy)),
      pyStripStr(pyGet(body, 'skill_commit', row.skill_commit)),
      pyStripStr(pyGet(body, 'skill_test', row.skill_test)),
      pyStripStr(pyGet(body, 'skill_cases', row.skill_cases)),
      reasoningEffort, permissionMode, { db: ctx.db });
  } catch (error) {
    if (isIntegrityError(error)) {
      ctx.errorSpaced(400, '项目名已存在');
      return;
    }
    throw error;
  }
  ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8');
}

/**
 * `_api_delete_project`(2321)：删除已归档项目（仅删库行 + 级联任务/轮次，磁盘文件一律保留）。
 *
 * **读体时机是本端点的契约**：Python 先判归属、再判归档闸，然后才 `self._read_json()`
 * ⇒ 未归档/不存在这两档**不消费请求体**。`ctx.readBody()` 是记忆化的，这里若提前读，
 * 未归档的 400 档就会把一个「Python 侧没读掉的体」读掉 —— 对拍里表现为 keep-alive
 * 连接上下一个请求的行为分叉（`server.js` 只在未命中路由时补读）。
 */
async function apiDeleteProject(ctx, projectId) {
  const row = ctx.ownedProject(projectId);
  if (row === null) return;                    // 已回 404 project not found
  if (!row.archived) {                         // Python `if not row["archived"]`（列存整数 0/1）
    ctx.errorSpaced(400, '仅已归档的项目可删除，请先归档');
    return;                                    // ⚠️ 此处不读体（见函数头）
  }
  const body = await ctx.readBody();
  if (pyStripBare(pyGet(body, 'confirm_name', undefined)) !== row.name) {
    ctx.errorSpaced(400, '确认名称与项目名不一致');
    return;
  }
  dbmod.deleteProject(projectId, { db: ctx.db });
  ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8');
}

/** `_api_archive_project`(2462)：归档/恢复（幂等，只切 `archived` 标记）。 */
async function apiArchiveProject(ctx, projectId, archived) {
  await ctx.readBody();                        // Python do_POST:1048 在读体之后才分派
  const row = ctx.ownedProject(projectId);
  if (row === null) return;
  dbmod.setProjectArchived(projectId, archived, { db: ctx.db });
  ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8');
}

/**
 * `_api_prefs_set`(2497)：UPSERT 一条 UI 偏好。
 *
 * 三条口径：
 *  ① `key` 先 `str(...).strip()` 再 `re.fullmatch(r"[a-z_]{1,64}")`（`" k "` ⇒ 合法）；
 *  ② `value` 必须是 dict 且 `json.dumps(ensure_ascii=False)` 的**字符数** ≤16384
 *     （中文不转义 ⇒ 必须走 `pyJsonDumps`；`len()` 按码点，JS 的 `.length` 是 UTF-16 码元
 *     ⇒ 展开计数，emoji 才不会提前 400）；
 *  ③ `int(body.get("project_id") or 0)` 失败折 0（**不是** 400）。Node 用 `pyIntOr`，
 *     已知差异：`int(2.7)==2`、`int(True)==1` 在 `pyIntOr` 里走 fallback 0，`int("1_0")==10`
 *     与 Unicode 数字（`int("١٢")==12`）同样回落 0 —— 这些档正常前端不产生，**未为它改 lib.js**。
 */
async function apiPrefsSet(ctx) {
  const body = await ctx.readBody();
  const key = pyStripStr(pyGet(body, 'key', undefined));
  if (!/^[a-z_]{1,64}$/.test(key)) {
    ctx.error(400, 'key 非法');                // 紧凑（Python 是硬编码字节串）
    return;
  }
  const value = pyGet(body, 'value', undefined);
  let text = null;
  if (value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)) {
    text = pyJsonDumps(value);                 // 与 Python `json.dumps(..., ensure_ascii=False)` 同口径
  }
  if (text === null || [...text].length > 16384) {
    ctx.error(400, 'value 非法');              // 紧凑
    return;
  }
  const pid = pyIntOr(pyGet(body, 'project_id', undefined) || 0, 0);
  if (pid && ctx.ownedProject(pid) === null) return;   // 已回 404 project not found（紧凑）
  dbmod.setUserPref(ctx.user.id, pid, key, value, { db: ctx.db });
  ctx.text(200, '{"ok":true}', 'application/json; charset=utf-8');
}

/**
 * `_api_fs_mkdir`(2357)：在 `body.path` 下新建子目录 `body.name`。
 *
 * 七档中文拒绝文案全在 `lib/lib.js:fsMkdir` 里（含 `os.path.lexists`、`str.rstrip(". ")`
 * 等逐条对齐），这里只做接线与判错口径（`data is None ⇒ 400 json.dumps({"error": err})`
 * ⇒ **带空格**）。
 *
 * **已知差异（在 lib.js，不在本文件）**：Python 的 `(raw_path or "").strip()` 遇到真值非字符串
 * （如 `{"path": 5}`）抛 `AttributeError` ⇒ 断连；`fsMkdir` 内部走 `pyOrEmpty`/`pyStrip`
 * 会把它转成文本 `"5"` 再判目录 ⇒ 这一档回 400 文案而不是断连。未改 lib.js。
 */
async function apiFsMkdir(ctx) {
  const body = await ctx.readBody();
  const [data, err] = fsMkdir(pyGet(body, 'path', undefined) || '', pyGet(body, 'name', undefined));
  if (data === null) {
    ctx.errorSpaced(400, err);
    return;
  }
  ctx.json(200, data);
}

export const routes = [
  {
    method: 'GET',
    path: '/api/projects',
    /** 项目列表 + 看板三列计数批量预计算（侧栏展示用）。 */
    handler: (ctx) => {
      const rows = dbmod.listProjects(ctx.user.id, { db: ctx.db });
      const counts = dbmod.boardCountsMany(rows.map((r) => r.id), { db: ctx.db });
      const out = rows.map((r) => {
        const pj = projectJson(r);
        pj.board_counts = counts[r.id] || emptyBoardCounts();
        return pj;
      });
      ctx.json(200, out);
    },
  },
  {
    method: 'GET',
    path: '/api/projects/dup_check',
    /**
     * 目录重复检测（跨用户）：`project_dir`/`work_dir` 与已存在项目相同时返回重复项。
     * 仅提醒不阻止写入；`exclude=<id>` 用于编辑项目时排除自身。
     * 注意 `?exclude=` 非数字时 Python `isdigit()` 为假 ⇒ 不排除任何项目（不报错）。
     */
    handler: (ctx) => {
      const pdir = pyStrip(ctx.q('project_dir', '') || '');
      const wdir = pyStrip(ctx.q('work_dir', '') || '');
      const exclude = ctx.q('exclude', '');
      const excludeId = pyIsDigits(exclude) ? pyIntOr(exclude, null) : null;
      const dups = [];
      for (const p of dbmod.listProjectsAll({ db: ctx.db })) {
        if (excludeId !== null && p.id === excludeId) continue;
        const owner = dbmod.getUserById(ctx.db, p.user_id);
        const uname = owner ? owner.username : '未知';
        if (pdir && pyNormpath(pdir) === pyNormpath(p.project_dir)) {
          dups.push({
            field: 'project_dir', value: pdir, project_id: p.id,
            project_name: p.name, username: uname,
          });
        }
        if (wdir && pyNormpath(wdir) === pyNormpath(p.work_dir)) {
          dups.push({
            field: 'work_dir', value: wdir, project_id: p.id,
            project_name: p.name, username: uname,
          });
        }
      }
      ctx.json(200, dups);
    },
  },
  {
    method: 'GET',
    path: '/api/fs/browse',
    /** 目录浏览：返回当前目录的子目录列表 + 服务端平台 + 根列表（供目录选择对话框）。 */
    handler: (ctx) => {
      const data = fsBrowse(ctx.q('path', ''));
      if (data === null) {
        ctx.errorSpaced(400, '目录不存在或不可读');
        return;
      }
      ctx.json(200, data);
    },
  },
  {
    method: 'GET',
    path: '/api/prefs',
    /**
     * 当前用户在某项目下的全部 UI 偏好：`{prefs: {key: value}}`。
     * `project_id` 缺省按 0（跨项目全局，预留）；给定时须为本人项目（多用户隔离）。
     * 非数字 `project_id` 按 Python `int()` 的 ValueError 分支回落到 0（不 404）。
     */
    handler: (ctx) => {
      const pid = pyIntOr(ctx.q('project_id', '0') || '0', 0);
      if (pid && ctx.ownedProject(pid) === null) return;      // 已回 404 project not found
      ctx.json(200, { prefs: dbmod.getUserPrefs(ctx.user.id, pid, { db: ctx.db }) });
    },
  },
  {
    method: 'GET',
    path: '/api/state',
    /** 聚合状态（案例树/统计/bug/轮次 + live 运行状态 + project 段）。无项目时 200 `{"error":"no project"}`。 */
    handler: (ctx) => {
      const project = resolveProject(ctx);
      if (project === null) {
        ctx.json(200, { error: 'no project' });
        return;
      }
      const state = ctx.stateCache.get(project.id, project.cases_root, project.bug_dir, project.work_dir);
      state.project = projectJson(project);
      ctx.json(200, state);
    },
  },
  {
    method: 'GET',
    path: '/api/stream',
    /**
     * SSE 长连接：每 0.5s 检查聚合状态，有变化才推 `data:` 帧，空闲每 ~15s 发 `: hb` 心跳。
     *
     * 帧里带 `generated_at`（构建时刻）⇒ **本帧不参与 content-hash 类判据**，对拍用例用
     * `ignore: ['generated_at']` 显式声明（理由写在用例文件里）。指纹的主体（缓存指纹）
     * 已在构建时剔除 `generated_at`，故「没有真实变化就不推帧」这条语义仍然成立。
     */
    handler: async (ctx) => {
      const project = resolveProject(ctx);
      if (project === null) {
        ctx.res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        ctx.res.end('data: {"error":"no project"}\n\n');
        return;
      }
      const sse = ctx.sse();
      let closed = false;
      ctx.res.on('close', () => { closed = true; });
      // Python 靠「往断开的 socket 写」抛 BrokenPipeError 收尾；Node 的 write 未必同步抛错，
      // 故额外挂一个 error 监听（无它时断连会变成未捕获异常，把进程带走）
      ctx.res.on('error', () => { closed = true; });
      let lastFingerprint = null;
      let idleTicks = 0;
      try {
        while (!closed) {
          const state = ctx.stateCache.get(project.id, project.cases_root, project.bug_dir, project.work_dir);
          state.project = projectJson(project);
          // 指纹 = 缓存指纹（剔除 generated_at）+ project 段的 sort_keys dumps（与 Python 同式）
          const fingerprint = `${ctx.stateCache.fingerprint(project.id) || ''}|${pyJsonDumpsSorted(state.project)}`;
          if (fingerprint !== lastFingerprint) {
            lastFingerprint = fingerprint;
            if (!sse.data(state)) break;
            idleTicks = 0;
          } else {
            idleTicks += 1;
            if (idleTicks >= 30) {                        // ~15s 一次心跳，防中间层断连
              idleTicks = 0;
              if (!sse.comment('hb')) break;
            }
          }
          await sleep(500);
        }
      } finally {
        sse.end();
      }
    },
  },
  {
    method: 'GET',
    re: /^\/api\/projects\/(\d+)$/,
    /** 项目详情（多用户隔离）；`board_counts` 与列表端点同口径（前端 refreshProject 替换列表项）。 */
    handler: (ctx, m) => {
      const row = ctx.ownedProject(Number(m[1]));
      if (row === null) return;                              // 已回 404 project not found
      const pj = projectJson(row);
      pj.board_counts = dbmod.boardCountsMany([row.id], { db: ctx.db })[row.id];
      ctx.json(200, pj);
    },
  },
  {
    method: 'GET',
    re: /^\/api\/projects\/(\d+)\/file$/,
    /**
     * 读取项目范围内的文件内容供会话页预览（只读，多用户隔离）。
     *
     * query: `path=`相对/绝对路径（相对按 项目目录 → 工作目录 解析）；`raw=1` 直接返回原文；
     * `inline=1` 把项目范围内的**位图**按原图内联下发（会话页渲染 agent 写的截图用，
     * 见 `sendProjectFileInline`；两参数都给时 inline 优先）。
     * 安全：路径须落在本项目「项目目录/工作目录」之内（realpath 包含判定，防目录穿越与越权
     * 读他人文件）；raw 一律 text/plain + nosniff —— 这些文件是 agent 在工作区写的内容，
     * 按扩展名猜类型内联下发会让同源页面执行其中脚本；`inline=1` 是这条红线上的**收窄例外**：
     * 只放行 `PROJECT_FILE_INLINE_TYPES` 里的位图扩展名。
     */
    handler: (ctx, m) => {
      const row = ctx.ownedProject(Number(m[1]));
      if (row === null) return;
      const resolved = resolveProjectFile(row, ctx.q('path', ''));
      const mapped = projectFileError(resolved.err);
      if (mapped) {
        ctx.errorSpaced(mapped[0], mapped[1]);
        return;
      }
      if (['1', 'true', 'yes'].includes(ctx.q('inline', '0'))) {
        sendProjectFileInline(ctx, resolved.path);
        return;
      }
      if (['1', 'true', 'yes'].includes(ctx.q('raw', '0'))) {
        sendProjectFileRaw(ctx, resolved.path);
        return;
      }
      let preview;
      let mtime;
      try {
        preview = readTextPreview(resolved.path);
        mtime = pyMtimeInt(fs.statSync(resolved.path, { bigint: true }).mtimeNs);
      } catch {
        ctx.errorSpaced(404, '文件不存在或不可读');
        return;
      }
      const rootDir = (resolved.rootKey === 'project' ? row.project_dir : row.work_dir) || '';
      const rel = rootDir
        ? pyRelpath(resolved.path, rootDir).split(path.sep).join('/')
        : resolved.path;
      ctx.json(200, {
        path: resolved.path,
        rel,
        root: resolved.rootKey || 'project',
        name: pyBasename(resolved.path),
        ext: fileExt(resolved.path),
        size: preview.size,
        mtime,
        text: preview.text,
        truncated: preview.truncated,
        binary: preview.binary,
      });
    },
  },
  {
    method: 'GET',
    re: /^\/api\/projects\/(\d+)\/bugs$/,
    /** bug 报告列表（扫描结果 + 每个 bug 最近的修复/复测/修例任务）。 */
    handler: (ctx, m) => {
      const row = ctx.ownedProject(Number(m[1]));
      if (row === null) return;
      ctx.json(200, listProjectBugs(row, { db: ctx.db }));
    },
  },
  {
    method: 'GET',
    re: /^\/api\/projects\/(\d+)\/bugs\/(.+)$/,
    /** 单枚 bug 报告详情：全文 + 关联 case 的当前状态 + 最近任务。 */
    handler: (ctx, m) => {
      const row = ctx.ownedProject(Number(m[1]));
      if (row === null) return;
      const bugDir = unquote(m[2]);
      const dirPath = pyJoin(row.bug_dir, bugDir);
      if (!isDir(dirPath)) {
        ctx.error(404, 'bug not found');
        return;
      }
      const { content, ids } = bugCases(dirPath);
      const fields = parseFields(content);
      const bm = BUG_DIR_RE.exec(bugDir);
      const cases = [];
      for (const [cid, dir] of findCaseDirs(row.cases_root, ids)) {
        const st = parseStatusMd(pyJoin(dir, 'status.md'));
        cases.push({
          id: cid,
          name: pyBasename(dir).slice(cid.length + 1),
          status: st.status,
          last_run: st.last_run,
          fail_reason: st.fail_reason,
        });
      }
      ctx.json(200, {
        dir: bugDir,
        title: bm ? bm[1] : bugDir,
        status: fields['状态'] || '',
        cases,
        content,
        last_task: bugLastTask(listTasks(row.id, { db: ctx.db }), bugDir),
      });
    },
  },
  // ---------- 写路径（M6.9）：顺序照 Python 的 do_POST / do_PATCH / do_DELETE 链 ----------
  //   do_POST:   /api/fs/mkdir(1050) → /api/projects(1075) → /api/prefs(1085)
  //              → /api/projects/<id>/(archive|unarchive)(1089)
  //              → /api/projects/<id>/bugs/<dir>/reject(1102)
  //   do_PATCH:  /api/projects/<id>(1231)
  //   do_DELETE: /api/projects/<id>(1273)
  {
    method: 'POST',
    path: '/api/fs/mkdir',
    /** 建目录（目录选择对话框「新建文件夹」）：`body {path, name}`；错误体带空格。 */
    handler: (ctx) => apiFsMkdir(ctx),
  },
  {
    method: 'POST',
    path: '/api/projects',
    /** 新建项目：名称/工作目录派生 + 真建目录（work_dir + free_style + bug_report）。 */
    handler: (ctx) => apiCreateProject(ctx),
  },
  {
    method: 'POST',
    path: '/api/prefs',
    /** UPSERT 一条 UI 偏好（key 白名单 + value 形状/大小门 + project_id 折 0）。 */
    handler: (ctx) => apiPrefsSet(ctx),
  },
  {
    method: 'POST',
    re: /^\/api\/projects\/(\d+)\/(archive|unarchive)$/,
    /** 归档/恢复：一条正则两个分支（`m[2] === 'archive'`），不动任务与文件。 */
    handler: (ctx, m) => apiArchiveProject(ctx, Number(m[1]), m[2] === 'archive'),
  },
  {
    method: 'POST',
    re: /^\/api\/projects\/(\d+)\/bugs\/([^/]+)\/reject$/,
    handler: (ctx, m) => apiRejectBug(ctx, Number(m[1]), m[2]),
  },
  {
    method: 'PATCH',
    re: /^\/api\/projects\/(\d+)$/,
    /** 改项目：未带键保持存量；换工作目录时新派生目录一并创建。 */
    handler: (ctx, m) => apiUpdateProject(ctx, Number(m[1])),
  },
  {
    method: 'DELETE',
    re: /^\/api\/projects\/(\d+)$/,
    /** 删项目：仅已归档可删 + `confirm_name` 双保险；只删库行，磁盘文件保留。 */
    handler: (ctx, m) => apiDeleteProject(ctx, Number(m[1])),
  },
];
