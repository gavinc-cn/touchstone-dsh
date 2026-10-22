/**
 * `server.py` 顶部那组「会话元信息派生」函数的 Node 对应物（M3 读路径）：
 * 能力声明、会话解析族归一、默认模型、有效模型、权限目录/权限档归一、会话归属三态。
 *
 * 为什么单独一个文件而不是塞进路由：看板族（`routes/board.js`）与会话族
 * （`routes/sessions.js`）**都要**用它们（`_api_get_board` 下发 family/capabilities，
 * `_session_payload` 下发 model/capabilities/owned…），而这两族由不同的人写。
 * 放在 Lead 名下的小文件里，两边都 import 同一份，不会出现「两处各写一份 capability 表」。
 *
 * 权限档（2026-10-21 权限档对齐 DSH 宿主目录，契约 §5.2/§5.3/§5.5）：
 * 宿主目录是唯一真源（驱动 `GET /presets` 不带 session_id），本模块负责 60s 缓存、
 * 「已知档位值集合」、项目级 `normalizePermissionMode` 与会话 meta 的 `permission` 回读。
 * 领域常量（`LEGACY_PERMISSION_ALIASES` / 内置中文名 / `permissionOption`）复用
 * `dshdriver.js` 的导出，不另抄一份（Python 侧同样从 `dshdriver` 取）。
 */
import fs from 'node:fs';
import os from 'node:os';

import * as dbmod from './db.js';
import * as dshevents from './dshevents.js';
import * as dshdriver from './dshdriver.js';

/** 思考等级白名单（`dshdriver.EFFORT_LEVELS`，与 Python 同源） */
export const DSH_EFFORT_LEVELS = dshdriver.EFFORT_LEVELS;

/** `~/.dsh/settings.yaml` 的 agent-default-model 段：provider 行后的 model 行 */
const DSH_DEFAULT_MODEL_RE =
  /^agent-default-model:[ \t]*$\n^[ \t]+provider:[ \t]*\S+[ \t]*$\n^[ \t]+model:[ \t]*([^\n#]+)/m;

/**
 * Python `value or ""`：**按 Python 真值**判空（`0` / `False` / `''` / 空容器 → `""`）。
 *
 * 别写成 `String(value ?? '')`：那会把 `0` 归一成 `"0"`、把 `{}` 归一成 `"[object Object]"`
 * ——`normalize_*` 的下一步是白名单检查，`"0"` 不在白名单 ⇒ 白白把一个「不指定」判成 400。
 * （M5-4 实装 `POST /board/sessions/<sid>/profile` 时核出：Python 侧两个 normalize 都是
 * `str(value or "")`，Node 侧原写法在 `0/False/{}` 三种入参上有分歧。）
 */
function pyOrEmpty(value) {
  if (value === null || value === undefined || value === false || value === 0) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.length ? value : '';
  if (typeof value === 'object') return Object.keys(value).length ? value : '';
  return value;                          // 数字（含 NaN，Python 里为真）/ true
}

/**
 * `normalize_effort`：''=不指定；白名单内原样；**非法返回 null**（调用方报 400，不静默丢弃）。
 * 返回 `null` 与返回 `''` 语义不同，别用 `|| ''` 抹平。
 */
export function normalizeEffort(value) {
  const v = String(pyOrEmpty(value)).trim();
  if (!v) return '';
  return DSH_EFFORT_LEVELS.includes(v) ? v : null;
}

// ---------- 权限目录（DSH 宿主 preset catalog） ----------

/** 权限目录缓存 TTL（秒，照 `_MODELS_CACHE_TTL`）：仅成功入缓存 */
const PERMISSION_CATALOG_TTL = 60;

/** 目录缓存键（固定键：取目录不带 session_id，全局只有一份） */
const PERMISSION_CATALOG_KEY = 'presets';

/** `PERMISSION_CATALOG_CACHE`：固定键 → `[时刻秒, payload]`（失败不入缓存） */
const PERMISSION_CATALOG_CACHE = new Map();

/** 从未成功取到目录时的兜底已知档位集合：三个 DSH 内置产品档 */
const BUILTIN_PERMISSION_VALUES = Object.freeze([
  'read-only', 'workspace-write', 'danger-full-access',
]);

/**
 * 进程内「已知档位值集合」= 最近一次**成功**取到目录的 value 全集。
 * `null` = 从未成功过（回退 `BUILTIN_PERMISSION_VALUES`）。不随 TTL 过期清空
 * （目录服务临时抖动不应把存量/刚下发的档位判非法）。
 * @type {Set<string>|null}
 */
let permissionCatalogValuesKnown = null;

/** 目录不可用时的统一回执（成功/失败**都是 200**，无错误体） */
function permissionCatalogUnavailable() {
  return { available: false, options: [], default: '', default_label: '' };
}

/**
 * 取宿主权限目录（`dshdriver.presets('')`）并归一成前端契约形状，60s 缓存、成功才缓存。
 *
 * 回执：`{available, options:[{value,label,description}], default, default_label}`
 * - 驱动未配置 / 抛 `DshDriverError` ⇒ `{available:false, options:[], default:'', default_label:''}`
 *   （不缓存失败；其他异常照抛，不静默兜底）；
 * - `options` 先过滤空 value，再逐个 `permissionOption` 归一（内置档中文名 / 自定义档宿主名）；
 * - `default_label` 由 `options` 里同 value 的 label 反查，找不到 ⇒ `''`；
 * - 每次成功后同步刷新「已知档位值集合」（`permissionCatalogValues()` 的同步数据源）。
 *
 * @returns {Promise<{available: boolean, options: object[], default: string, default_label: string}>}
 */
export async function permissionCatalogPayload() {
  // 60s 缓存优先（与 Python `_permission_catalog_payload` 同序、与 `_MODELS_CACHE` 同款：
  // 缓存只在成功时写入；驱动随后不可用也不清成功缓存，最多 60s 后自然失效）
  const hit = PERMISSION_CATALOG_CACHE.get(PERMISSION_CATALOG_KEY);
  if (hit && Date.now() / 1000 - hit[0] < PERMISSION_CATALOG_TTL) return hit[1];
  if (!dshdriver.configured()) return permissionCatalogUnavailable();
  let raw;
  try {
    raw = await dshdriver.presets('');
  } catch (error) {
    if (error instanceof dshdriver.DshDriverError) return permissionCatalogUnavailable();
    throw error;
  }
  const rawOptions = (raw !== null && typeof raw === 'object' && Array.isArray(raw.options))
    ? raw.options : [];
  const options = [];
  for (const item of rawOptions) {
    // 只认普通对象项（坏形状跳过而不是把端点打成 500；正常目录恒为对象）
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const option = dshdriver.permissionOption(item.value, item.name, item.description);
    if (!option.value) continue;                     // 空 value 过滤
    options.push(option);
  }
  const dflt = (raw !== null && typeof raw === 'object' && raw.default) ? String(raw.default) : '';
  const matched = options.find((option) => option.value === dflt);
  const payload = {
    available: true,
    options,
    default: dflt,
    default_label: matched ? matched.label : '',
  };
  // 成功才刷新「已知档位集合」+ 入缓存（失败分支在上面直接 return，绝不清空/不缓存）
  permissionCatalogValuesKnown = new Set(options.map((option) => option.value));
  PERMISSION_CATALOG_CACHE.set(PERMISSION_CATALOG_KEY, [Date.now() / 1000, payload]);
  return payload;
}

/**
 * 进程内「已知档位值集合」（同步）：最近一次成功目录的 value 全集；
 * 从未成功过 ⇒ 三个 DSH 内置产品档。返回**副本**（调用方改不到内部状态）。
 *
 * 用途：`normalizePermissionMode` 与卡片会话 profile 端点的档位校验。
 * @returns {Set<string>}
 */
export function permissionCatalogValues() {
  return new Set(permissionCatalogValuesKnown === null
    ? BUILTIN_PERMISSION_VALUES : permissionCatalogValuesKnown);
}

/**
 * 测试缝：清空权限目录缓存与「已知档位集合」（**生产路径不调用**，名字里的 `ForTest`
 * 就是这条约定）。用途＝用例间隔离模块级 60s 缓存。
 */
export function _resetPermissionCatalogCacheForTest() {
  PERMISSION_CATALOG_CACHE.clear();
  permissionCatalogValuesKnown = null;
}

/**
 * `normalize_permission_mode`：项目级权限档归一（契约 §5.3）。
 *
 * 顺序：空 ⇒ `''`（不指定）；旧档别名 `manual/yolo` ⇒ 宿主 preset（兼容旧请求，先于
 * 目录校验，目录暂不可用也照样接受）；与存量同值 ⇒ 原样直通（PATCH 未变值/目录不可用时
 * 不把存量判非法）；在已知档位集合里 ⇒ 原样；否则 `null`（调用方 400，**不静默丢弃**）。
 *
 * 注意 `auto` **不走旧别名**：只有宿主目录里确实有 auto 档才被接受。
 *
 * @param {unknown} value 请求里的 permission_mode
 * @param {unknown} [existing] 存量值（创建路径传 `''`；PATCH 传当前行值）
 * @returns {string|null} 归一值 / `''`（不指定）/ `null`（非法）
 */
export function normalizePermissionMode(value, existing = '') {
  const v = String(pyOrEmpty(value)).trim();
  if (!v) return '';
  if (Object.prototype.hasOwnProperty.call(dshdriver.LEGACY_PERMISSION_ALIASES, v)) {
    return dshdriver.LEGACY_PERMISSION_ALIASES[v];
  }
  if (v === String(pyOrEmpty(existing)).trim()) return v;
  return permissionCatalogValues().has(v) ? v : null;
}

/** `_dsh_default_model`：读 `~/.dsh/settings.yaml` 的默认模型，任何失败返回 ''（不抛） */
export function dshDefaultModel() {
  try {
    const conf = `${os.homedir()}/.dsh/settings.yaml`;
    if (fs.existsSync(conf)) {
      const m = DSH_DEFAULT_MODEL_RE.exec(fs.readFileSync(conf, 'utf8'));
      if (m && m[1].trim()) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    // 读不到/解析不了都按「无法判定」——与 Python 的 try/except pass 同口径
  }
  return '';
}

/**
 * `effective_model`：任务实际使用的模型名。
 * ① 任务显式指定；② 首轮日志 `### CMD ` 行里的 `-m/--model`（存量 CLI 轮次日志）；
 * ③ dsh 部署默认模型。返回 '' = 完全无法判定（前端显示「默认」回退文案）。
 *
 * 注意 Python 的两处 `break`：**只看第一条有 log_path 且文件存在的轮次**，且该文件里
 * 只看第一个 `### CMD ` 行（避免多次读文件）——这里逐点照抄，包括「文件不存在就跳到下一条」。
 */
export function effectiveModel(taskId, model, { db } = {}) {
  const explicit = String(model ?? '').trim();
  if (explicit) return explicit;
  try {
    for (const round of dbmod.listRounds(taskId, { db })) {
      const logPath = round.log_path;
      if (!logPath || !fs.existsSync(logPath) || !fs.statSync(logPath).isFile()) continue;
      const text = fs.readFileSync(logPath, 'utf8');
      for (const line of text.split('\n')) {
        if (line.startsWith('### CMD ')) {
          const m = /(?:-m|--model)\s+(\S+)/.exec(line);
          if (m) return m[1];
          break;                                  // 首个 CMD 行没带模型：不再往下找
        }
      }
      break;                                      // 只看第一条可读轮次（与 Python 同）
    }
  } catch {
    // 日志读失败不阻断展示（Python 同为 except Exception: pass）
  }
  return dshDefaultModel();
}

/** `_sess_family`：dsh_plugin 的会话就是 dsh 宿主的会话，按 `dsh` 解析族读取 */
export function sessFamily(family) {
  return family === 'dsh_plugin' ? 'dsh' : family;
}

/** `family_capabilities`：会话窗口能力声明（dsh_plugin 全开；退场族全 False） */
export function familyCapabilities(family) {
  if (family === 'dsh_plugin') {
    return {
      stream: true, chat: true, queue: true, steer: true, abort: true,
      compact: true, fork: true, rewind: true, profile: true, permission: true,
      events: true,
    };
  }
  return {
    stream: false, chat: false, queue: false, steer: false, abort: false,
    compact: false, fork: false, rewind: false, profile: false, permission: false,
    events: false,
  };
}

/** 旧插件旧帧的 mode → 展示兜底映射（只用于读回显，**不是**写入路径） */
const LEGACY_MODE_DISPLAY = Object.freeze({
  manual: 'workspace-write',
  yolo: 'danger-full-access',
  auto: 'danger-full-access',
});

/**
 * `_session_permission_mode`：会话级权限档回读（契约 §5.5）。
 *
 * 优先级：① `state.permission.preset` 非空 ⇒ **原样返回**（新首选，可能是 path-rules 等
 * 宿主自定义档，平台不认识的也照实给前端）；② 否则旧插件旧帧的 `mode` ∈ {manual,yolo,auto}
 * ⇒ 展示兜底映射成 preset（只针对旧帧，新代码基本走不到）；③ 都没有 ⇒ `''`（调用方
 * **不下发** `permission`，前端保持置灰：不猜）。
 *
 * @param {object|null|undefined} state dshevents 注册表里的会话实时态
 * @returns {string} 宿主 preset key 或 `''`
 */
export function sessionPermissionMode(state) {
  const perm = (state || {}).permission || {};
  const preset = String(perm.preset || '');
  if (preset) return preset;
  const mode = String(perm.mode || '');
  return Object.prototype.hasOwnProperty.call(LEGACY_MODE_DISPLAY, mode)
    ? LEGACY_MODE_DISPLAY[mode] : '';
}

/**
 * `_session_owned`：会话归属**三态**。
 * - `true`  = 平台自持（驱动池内）；
 * - `false` = 外部会话（用户在 dsh GUI 直跑/接管，平台停不了 ⇒ 前端置灰「停止」）；
 * - `null`  = 注册表未知（未连接/热对齐中/没见过该 sid）⇒ 前端按「池内」渲染。
 *
 * 为什么不是 `Boolean(...)`：外部会话上报的也是 `false`，与「未知」的兜底值撞车，
 * 会把断连窗口里的池内会话误判成外部（误出提示条 + 误停用停止按钮）。**未知 ≠ 外部**。
 */
export function sessionOwned(sid) {
  const st = dshevents.get(sid);
  if (st === null || st === undefined || !dshevents.aligned()) return null;
  return Boolean(st.owned);
}

/**
 * `_dsh_live_sid`：dsh 插件族「运行中会话」精确探测（零 mtime 启发式）。
 * 判据＝驱动池自持（owned）+ cwd 匹配 + 最近创建；驱动不可用返回 ''（交调用方兜底）。
 *
 * **形态差异（有意）**：Node 的 `dshdriver.live()` 是 async（M2 的调用约定：
 * 毫秒 + opts 对象 + async），故本函数也是 async；Python 侧是同步函数。
 * 调用方（`_session_payload` 的 Node 对应物）本来就是 async，多一个 await 无碍。
 */
export async function dshLiveSid(cwd) {
  let rows;
  try {
    rows = await dshdriver.live();
  } catch {
    return '';
  }
  const want = String(cwd || '').replace(/\/+$/, '');
  let best = '';
  let bestTs = -1;
  for (const row of rows || []) {
    if (!row.owned) continue;
    if (want && String(row.cwd || '').replace(/\/+$/, '') !== want) continue;
    const ts = Number.parseInt(row.started_at, 10) || 0;
    if (ts > bestTs) { best = row.session_id || ''; bestTs = ts; }
  }
  return best;
}
