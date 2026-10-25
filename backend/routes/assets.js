/**
 * 路由族：平台内置资产（skill / dsh 插件）两条（M6-6）
 *
 *   GET  /api/builtin-assets                          → `server.py:1326` → `_api_builtin_assets_list`(1946)
 *   POST /api/builtin-assets/<id>/(install|uninstall)  → `server.py:1085` → `_api_builtin_asset_action`(1971)
 *
 * 权限与隔离（照 oracle 的 `_assets_target`(1930)，**逐条不同**）：
 *   - `target=user`（缺省）：读状态**登录即可**；写（install/uninstall）仅管理员 ⇒ 403
 *     `json.dumps` 形态（**带空格**）。用户级写入的是服务进程 HOME 下的 agent 配置
 *     （影响本机所有项目），故写口必须管理员。
 *   - `target=project`：读/写都要过项目归属；越权/不存在 ⇒ **紧凑** 404 `project not found`
 *     （与既有按 project_id 的端点同口径）。`project_id` 必须是 JSON **int**（bool 不算），
 *     否则 400（`json.dumps` 形态）。
 *   - 其它 target ⇒ 400 `target 必须是 user 或 project`（`json.dumps` 形态）。
 *
 * 落点（`builtin-assets.js` 的 `ext_dir()` / `dsh_profiles_dir()`）：资产**清单**根默认是仓库
 * `extensions/`（`TS_EXT_DIR` 覆盖），安装产物落 `~/.dsh/skills`（`TS_DSH_PROFILES` 覆盖）
 * —— 单测必须把这两个 env 指到夹具，**绝不允许**在真 `~/.dsh` 上做安装/卸载。
 */
import * as assets from '../lib/builtin-assets.js';

/** `_is_admin`：管理员判据只有用户名等于 `admin`（与 `routes/admin.js` 同款） */
function isAdmin(ctx) {
  return Boolean(ctx.user) && ctx.user.username === 'admin';
}

/** Python `str(x or "")`（标量面；target/asset_id 这类字段都是字符串） */
function pyStrOrEmpty(value) {
  if (value === null || value === undefined || value === false || value === 0) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length ? JSON.stringify(value) : '';
  if (typeof value === 'object') return Object.keys(value).length ? JSON.stringify(value) : '';
  return String(value);
}

/** `_req_str`(580)：非字符串（数组/数字/null）一律按空串处理 */
function reqStr(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * `_assets_target`(1930)：解析资产操作目标 → `{ok, project_dir, pid}`；错误路径已回响应。
 * `write=true` 时用户级要管理员；项目级无论读写都要归属（越权 404 紧凑）。
 */
function assetsTarget(ctx, target, projectId, write = false) {
  if (target === 'user') {
    if (write && !isAdmin(ctx)) {
      ctx.errorSpaced(403, '用户级安装影响本机所有项目，仅管理员可操作');
      return { ok: false, projectDir: '', pid: null };
    }
    return { ok: true, projectDir: '', pid: null };
  }
  if (target !== 'project') {
    ctx.errorSpaced(400, 'target 必须是 user 或 project');
    return { ok: false, projectDir: '', pid: null };
  }
  if (!Number.isInteger(projectId) || typeof projectId === 'boolean') {
    ctx.errorSpaced(400, '项目级操作需要 project_id');
    return { ok: false, projectDir: '', pid: null };
  }
  const row = ctx.ownedProject(projectId);          // 已回 404 project not found（紧凑）
  if (row === null) return { ok: false, projectDir: '', pid: null };
  return { ok: true, projectDir: row.project_dir, pid: row.id };
}

/**
 * `_api_builtin_assets_list`(1946)：清单 + 指定目标下的安装状态。
 * `can_install` 为当前用户在该目标的写权限；逐资产 `supported` 为「该资产是否支持此目标」。
 */
function apiBuiltinAssetsList(ctx) {
  const target = (reqStr(ctx.q('target', 'user')) || 'user').trim();
  const rawPid = reqStr(ctx.q('project_id', '')).trim();
  // Python `int(raw_pid) if raw_pid.isdigit() else None`：Unicode 数字面按全仓 ASCII 口径
  const pidIn = /^[0-9]+$/.test(rawPid) ? Number(rawPid) : null;
  const resolved = assetsTarget(ctx, target, pidIn);
  if (!resolved.ok) return;
  let list;
  try {
    list = assets.listAssets(target, resolved.projectDir);
  } catch (e) {
    if (e instanceof assets.AssetError) {
      ctx.errorSpaced(e.code, e);          // AssetError 可能带 i18nKey（插值文案）
      return;
    }
    throw e;
  }
  const canInstall = target === 'user' ? isAdmin(ctx) : true;
  ctx.json(200, {
    target,
    project_id: resolved.pid,
    can_install: canInstall,
    assets: list,
  });
}

/**
 * `_api_builtin_asset_action`(1971)：安装（收敛到期望状态）/ 卸载（删清单内文件）。
 * 失败按 `AssetError.code` 回 400/500；磁盘异常（OSError）统一 500 带原因。
 */
async function apiBuiltinAssetAction(ctx, assetId, action) {
  const body = await ctx.readBody();           // Python 在 do_POST:1048 统一读体
  const target = (reqStr(body.target) || 'user').trim();
  const rawPid = body.project_id;
  const pid = (typeof rawPid === 'number' && Number.isInteger(rawPid) && typeof rawPid !== 'boolean')
    ? rawPid : null;
  const resolved = assetsTarget(ctx, target, pid, true);
  if (!resolved.ok) return;
  const asset = assets.getAsset(assetId);
  if (asset === null || asset === undefined) {
    // 动态文案用「中文 {占位符} 词条 + vars」：中文侧插值回原文，英文侧查同一词条
    ctx.errorSpaced(404, '未知资产：{id}', { id: assetId });   // json.dumps 形态（带空格）
    return;
  }
  let result;
  try {
    result = action === 'install'
      ? assets.install(asset, target, resolved.projectDir)
      : assets.uninstall(asset, target, resolved.projectDir);
  } catch (e) {
    if (e instanceof assets.AssetError) {
      ctx.errorSpaced(e.code, e);          // 同上：key+vars 由 lib 的 localizable 附加
      return;
    }
    // 磁盘异常（权限/空间）统一 500，带原因供前端 toast（Python 只吞 OSError）
    if (e && typeof e.code === 'string') {
      ctx.errorSpaced(500, '操作失败：{detail}', { detail: pyStrOrEmpty(e.message) });
      return;
    }
    throw e;
  }
  ctx.json(200, result);
}

export const routes = [
  {
    method: 'GET',
    path: '/api/builtin-assets',
    handler: (ctx) => apiBuiltinAssetsList(ctx),
  },
  {
    method: 'POST',
    re: /^\/api\/builtin-assets\/([a-z0-9][a-z0-9._-]*)\/(install|uninstall)$/,
    handler: (ctx, m) => apiBuiltinAssetAction(ctx, m[1], m[2]),
  },
];
