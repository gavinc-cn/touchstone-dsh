/**
 * `server.py` 顶部那组「会话元信息派生」函数的 Node 对应物（M3 读路径）：
 * 能力声明、会话解析族归一、默认模型、有效模型、权限档反查、会话归属三态。
 *
 * 为什么单独一个文件而不是塞进路由：看板族（`routes/board.js`）与会话族
 * （`routes/sessions.js`）**都要**用它们（`_api_get_board` 下发 family/capabilities，
 * `_session_payload` 下发 model/capabilities/owned…），而这两族由不同的人写。
 * 放在 Lead 名下的小文件里，两边都 import 同一份，不会出现「两处各写一份 capability 表」。
 *
 * 白名单常量（权限档/思考等级/反查表）**复用 `dshdriver.js` 的导出**，不另抄一份：
 * Python 侧同样是 `DSH_PERMISSION_PRESETS = dshdriver.PERMISSION_PRESETS` 的别名。
 */
import fs from 'node:fs';
import os from 'node:os';

import * as dbmod from './db.js';
import * as dshevents from './dshevents.js';
import * as dshdriver from './dshdriver.js';

/** 思考等级白名单（`dshdriver.EFFORT_LEVELS`，与 Python 同源） */
export const DSH_EFFORT_LEVELS = dshdriver.EFFORT_LEVELS;
/** 平台三档 → 宿主 preset（`server.py:84`） */
export const DSH_PERMISSION_PRESETS = dshdriver.PERMISSION_PRESETS;
/** 宿主 preset → 平台三档近似反查（`server.py:88`） */
export const DSH_PRESET_MODES = dshdriver.PRESET_MODES;

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

/** `normalize_permission_mode`：''=不指定；manual/yolo/auto 原样；非法返回 null */
export function normalizePermissionMode(value) {
  const v = String(pyOrEmpty(value)).trim();
  if (!v) return '';
  return Object.prototype.hasOwnProperty.call(DSH_PERMISSION_PRESETS, v) ? v : null;
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

/**
 * `_session_permission_mode`：会话级权限档。
 * ① 平台记下的 `mode`（唯一能区分 yolo/auto 的来源）；② 反查宿主 `preset`（老插件/外部改过）。
 * 两者都无 → `''`（调用方**不下发** `permission`，前端保持置灰：不猜）。
 */
export function sessionPermissionMode(state) {
  const perm = (state || {}).permission || {};
  const mode = String(perm.mode || '');
  if (mode) return mode;
  return DSH_PRESET_MODES[String(perm.preset || '')] || '';
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
