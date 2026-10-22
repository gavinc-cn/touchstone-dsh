/**
 * 路由族：智能体探测四条（M6-6；2026-10-21 增加权限目录）
 *
 *   GET /api/agents/scan   → `server.py:1330`（`agents.scan_agents()`）
 *   GET /api/agents/models → `server.py:1333`（`agent_models(agent_path)`）
 *   GET /api/agents/presets→ `_permission_catalog_payload()`（宿主权限目录，60s 缓存）
 *   GET /api/agents/skills → `server.py:1338`（`{"skills": scan_skills(agent_path, project_dir)}`）
 *
 * 四条都是**登录即可读**（`do_GET` 顶部只查 `_current_user()`，不吃 `_require_admin`），
 * 成功体一律 `json.dumps(..., ensure_ascii=False)` ⇒ `ctx.json`；本族**没有**任何写口，
 * 也没有错误体（参数缺省各自回落空串；权限目录不可用也是 200 `available:false`）。
 *
 * `agent_models` / `_dsh_plugin_models`（server.py:147/208）本该住 `lib/`，但 M6-6 的
 * 冻结契约不许改 `backend/lib/**`；它们只被这一条端点消费，故落在本文件（**唯一**消费者），
 * 语义逐行照 oracle：
 *  - 值/显示分离（`name` = `provider/<id>` 供宿主 `selectModel` 严格匹配，
 *    `display_name` = `provider/<显示名>` 供下拉展示）；
 *  - 空 `agent_path`（db 默认 ''）与未知路径都归默认族 ⇒ **不列模型**、只回读部署默认模型；
 *  - 结果进 60s 的 `_MODELS_CACHE`（键 = agent_path），驱动不可用时回空表且**不缓存**。
 *
 * `/api/agents/presets` 的目录归一/缓存/「已知档位集合」全部收在 `servercaps.js`
 * （`permissionCatalogPayload()`，契约 §5.2），本文件只做 `ctx.json(200, await …)`。
 */
import * as agents from '../lib/agents.js';
import * as dshdriver from '../lib/dshdriver.js';
import { dshDefaultModel, permissionCatalogPayload } from '../lib/servercaps.js';

/** `_MODELS_CACHE_TTL`（server.py:139）：60s */
const MODELS_CACHE_TTL = 60.0;

/** `_MODELS_CACHE`（server.py:138）：agent_path → `[时刻秒, 结果]` */
const MODELS_CACHE = new Map();

/** Python `dict.get(k) or ""` 后 `str(...)`：非字符串（数组/数字/null）→ 空串（`_req_str`） */
function reqStr(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Python `(x or {}).get(key)`：**假值先折成空 dict**（`None`/`[]`/`''`/`0` 都退回 `undefined`），
 * 其余非 dict（非空 list / 字符串 / 数字）在 Python 抛 AttributeError（端点打成 500、
 * 只断这一条连接）——这里抛 TypeError 交给 `dispatchSafely`，**不静默兜底**，
 * 否则驱动返回异常形状时两侧行为分叉（一边 500/断连、一边 200）。
 */
function dictGet(value, key) {
  if (value === null || value === undefined || value === false || value === 0
      || value === '' || (Array.isArray(value) && value.length === 0)) {
    return undefined;                        // `x or {}`
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`'${Array.isArray(value) ? 'list' : typeof value}'`
      + " object has no attribute 'get'");
  }
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

/**
 * `_dsh_plugin_models`(147)：dsh 插件族模型列表（值/显示分离 + 思考等级透传）。
 * 驱动不可用（`DshDriverError`）⇒ `{"models": [], "default": ""}`，**不入缓存**。
 */
async function dshPluginModels(cacheKey) {
  const hit = MODELS_CACHE.get(cacheKey);
  if (hit && Date.now() / 1000 - hit[0] < MODELS_CACHE_TTL) return hit[1];
  const models = [];
  let def = '';
  let catalog;
  try {
    catalog = await dshdriver.models();
  } catch (e) {
    if (e instanceof dshdriver.DshDriverError) return { models: [], default: '' };
    throw e;
  }
  for (const group of dictGet(catalog, 'groups') || []) {
    const provider = strOf(dictGet(group, 'id'));
    for (const m of dictGet(group, 'models') || []) {
      const mid = strOf(dictGet(m, 'id')).trim();
      const label = strOf(dictGet(m, 'name')).trim() || mid;   // 显示名缺省回落 id
      if (!mid && !label) continue;
      const modelId = mid || label;
      // 思考等级选项：只认 id 落在平台白名单内的项，名字缺省回落 id
      const efforts = [];
      for (const e of dictGet(m, 'efforts') || []) {
        const eid = strOf(dictGet(e, 'id')).trim();
        if (!dshdriver.EFFORT_LEVELS.includes(eid)) continue;
        efforts.push({ id: eid, name: strOf(dictGet(e, 'name')).trim() || eid });
      }
      models.push({
        name: provider ? `${provider}/${modelId}` : modelId,
        display_name: provider ? `${provider}/${label}` : label,
        efforts,
        default_effort: strOf(dictGet(m, 'default_effort')),
      });
    }
  }
  const sel = dictGet(catalog, 'default') || {};
  if (dictGet(sel, 'provider') && dictGet(sel, 'model')) {
    def = `${dictGet(sel, 'provider')}/${dictGet(sel, 'model')}`;
  }
  const result = { models, default: def };
  MODELS_CACHE.set(cacheKey, [Date.now() / 1000, result]);
  return result;
}

/** Python `str(x or "")`（标量面；容器按 JSON 文本兜底 —— 与全仓私有助手同口径） */
function strOf(value) {
  if (value === null || value === undefined || value === false || value === 0) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length ? JSON.stringify(value) : '';
  if (typeof value === 'object') return Object.keys(value).length ? JSON.stringify(value) : '';
  return String(value);
}

/**
 * `agent_models`(208)：指定 agent 的可用模型（空/未知路径 ⇒ 空列表 + 部署默认模型）。
 * 单族世界（P7b）：只剩 `dsh_plugin`（前缀 `dsh-plugin:`）。
 */
async function agentModels(agentPath) {
  const ap = reqStr(agentPath).trim();
  if (ap.startsWith(agents.DSH_PLUGIN_PREFIX)) return dshPluginModels(ap);
  const hit = MODELS_CACHE.get(ap);
  if (hit && Date.now() / 1000 - hit[0] < MODELS_CACHE_TTL) return hit[1];
  const result = { models: [], default: dshDefaultModel() };
  MODELS_CACHE.set(ap, [Date.now() / 1000, result]);
  return result;
}

export const routes = [
  {
    method: 'GET',
    path: '/api/agents/scan',
    /** `scan_agents()`：AGENT_DEFS + EXTRA_DIRS 探测（`which` + `--version`） */
    handler: (ctx) => {
      ctx.json(200, agents.scanAgents());
    },
  },
  {
    method: 'GET',
    path: '/api/agents/models',
    /** `agent_models(parsed["agent_path"][0])`：模型下拉数据源（宿主 `/models`） */
    handler: async (ctx) => {
      ctx.json(200, await agentModels(ctx.q('agent_path', '')));
    },
  },
  {
    method: 'GET',
    path: '/api/agents/presets',
    /** `_permission_catalog_payload()`：权限下拉数据源（宿主 `GET /presets`，60s 缓存） */
    handler: async (ctx) => {
      ctx.json(200, await permissionCatalogPayload());
    },
  },
  {
    method: 'GET',
    path: '/api/agents/skills',
    /** `scan_skills(agent_path, project_dir)`：用户级 + 项目级 SKILL.md 扫描（dsh 恒为空） */
    handler: (ctx) => {
      ctx.json(200, { skills: agents.scanSkills(ctx.q('agent_path', ''), ctx.q('project_dir', '')) });
    },
  },
];
