/**
 * 启动横幅的默认账号提示（`server.py:5457-5472 _seed_hint` 的对应物，2026-10-16 补）。
 *
 * ── 三档与 `db.js:seedAdmin()` 的口令来源一一对应（逐条对齐 Python） ──────────────
 *   ① 随机一次性口令（`seedPassword` 非空）→ 打印口令本身 + 首登须改密（读后即清）
 *   ② `TS_ADMIN_PASSWORD` 非空          → 只指向变量名，**绝不回显口令值**
 *   ③ 都没有（`TS_ADMIN_PASSWORDLESS=1`，插件形态）→ 空口令，提示可在设置页设密码
 *
 * ── 为什么单列第 ③ 档（2026-10-16 修） ────────────────────────────────────────
 * 第 ③ 档此前**落进第 ② 档的文案**：插件形态（薄壳默认下发 `TS_ADMIN_PASSWORDLESS=1`）
 * 首启横幅写的是「初始口令取自 TS_ADMIN_PASSWORD」，可那个变量根本没设、账号实际是空口令
 * ——首装排障按这句话去找变量会白找。Python 侧同一分支的旧文案是「其一次性口令已在上一次
 * 启动时打印，本次不再显示」，同样对不上：该分支**结构上不可达**于「口令已被取走」——
 * `seeded=false` 时 `_seed_hint` 直接返回空串，而 `seeded=true` 且 `initial_pw` 为空只可能
 * 是空口令种子。两版现在给同一句、且逐字节相同（`tests/test_seed_admin.py` 与
 * `test/seed-hint.test.mjs` 各钉一半）。
 *
 * 纯函数：不读全局、无副作用（`env` 由调用方传入）⇒ 与 Python 一样可函数级单测，
 * 不必真起进程。
 */

/**
 * 组装本次种子后的横幅片段。
 * @param {{seeded?: boolean, seedPassword?: string, env?: NodeJS.ProcessEnv}} [boot]
 *   `seeded`/`seedPassword` 取自 `initDb()` 的返回值；`env` 缺省 `process.env`
 *   ——种子用的就是它，横幅判断与种子判断必须同源
 * @returns {string} 本次实际种子时返回横幅片段（含前导两空格）；日常启动返回空串
 */
export function seedHint({ seeded = false, seedPassword = '', env = process.env } = {}) {
  if (!seeded) return '';
  if (seedPassword) {
    return `  （首次启动已创建默认账号 admin，一次性初始口令：${seedPassword}`
      + '，首次登录须修改；仅本次显示，请立即记录）';
  }
  if (env.TS_ADMIN_PASSWORD) {
    return '  （首次启动已创建默认账号 admin，初始口令取自 TS_ADMIN_PASSWORD，请尽快登录修改）';
  }
  return '  （首次启动已创建默认账号 admin，空口令（插件形态免登）'
    + '；如需口令登录请在设置页设置密码）';
}
