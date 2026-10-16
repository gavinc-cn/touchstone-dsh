/**
 * 请求访问门禁（`server.py` 里挂在 Handler 上的那几道**纯判据**，M4.5）。
 *
 * 为什么单独一个文件：`server.js` 是入口脚本——模块顶层就 `await main()`（进程契约要求
 * 「被 import 即启动」不成立，而 Node 22.19 没有 `import.meta.main`，用它做守卫会在旧版
 * 上静默不启动）。因此门禁判据留在 `server.js` 里就**不可被单测 import**，只能靠实例级
 * 对拍覆盖。抽成纯函数（零 IO、零 import）后，`backend/test/write-base.test.mjs` 能逐条
 * 钉死边界，而 `server.js` 只负责「在正确的时机调它」。
 *
 * 与 Python 的对齐点（`server.py`）：
 *   - `MUST_CHANGE_PW_ALLOW`(487)：白名单三端点；
 *   - `_must_change_pw_blocked`(5203)：`must_change_pw` 为假 ⇒ 放行；信任头 ⇒ 放行；
 *     在白名单里 ⇒ 放行；否则 403 `{"error":"请先修改初始口令"}`；
 *   - **`do_GET`(1023) 与 `do_POST`(1040) 都调它**，且都在各自的 `if path.startswith("/api/")`
 *     之内；`do_PATCH`(1227) / `do_DELETE`(1266) 没有这道闸。
 *     ⚠ 2026-10-14 订正：本文件此前写的是「只有 `do_POST`(1040) 调它」，**与源码不符**——
 *     `server.js` 曾照这句错注释实现，于是持一次性口令的账号在 Node 侧能 GET 全部 `/api/*`
 *     读端点（oracle 一律 403）。M7-R3 车道用隔离实例真跑 `server.py` 量出来的。
 */

/** 强制改密闸白名单（`server.py:MUST_CHANGE_PW_ALLOW`）：持一次性口令的账号只能走这三个端点 */
export const MUST_CHANGE_PW_ALLOW = Object.freeze([
  '/api/auth/me', '/api/auth/change_password', '/api/auth/logout',
]);

/**
 * `server.py:_must_change_pw_blocked` 的纯判据。
 *
 * 返回 `true` = 调用方应回 **403 紧凑体** `{"error":"请先修改初始口令"}`。
 *
 * `user` 为空（未登录）不算「被闸挡住」——那种情况该走 401，且 Python 里
 * `if not user or not user["must_change_pw"]: return False` 也是放行（401 由更早的检查发）。
 *
 * @param {object|null|undefined} user 当前用户行（`must_change_pw` 为 0/1 或布尔）
 * @param {string} path 不含查询串的请求路径
 * @param {{trusted?: boolean}} [options] `trusted` = 反代注入免登信任头（`_trusted_admin_request`）
 * @returns {boolean}
 */
export function mustChangePwBlocked(user, path, { trusted = false } = {}) {
  if (!user || !user.must_change_pw) return false;
  if (trusted) return false;
  if (MUST_CHANGE_PW_ALLOW.includes(path)) return false;
  return true;
}
