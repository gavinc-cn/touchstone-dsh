/**
 * `backend/lib/*` 用户可见错误文案的**静态登记表**（T10 覆盖门禁的唯一真相源）。
 *
 * 为什么需要它：routes 层的错误文案是 `ctx.error*(…)` 的实参，覆盖门禁可以直接扫；
 * lib 层的错误则是「抛异常」或「返回字符串/`{error}`」，形态散落，无法靠一条正则覆盖。
 * 本表显式登记**哪些模块、哪些类/函数里的中文文案算用户可见**，`i18n-ctx.test.mjs`
 * 据此扫描源码并逐条要求 `i18n/en.json` 的 `api` 词条。新增 lib 用户可见错误时必须
 * 同步两处：词条 + 本表（若用了新的产出形态）。否则门禁变红。
 *
 * 字段含义：
 *   - `classes`：该模块里「类名 + 中文消息实参」即用户可见错误（如 `new DeliveryRefused(…)`）。
 *     门禁会要求每个字面量消息（含占位符 key）都有 api 词条；带 `${}` 的模板直接判失败
 *     （应改用 `localizable()` 附加 i18nKey/i18nVars）。
 *   - `functions`：该模块里「返回值/抛错会给到路由层」的函数。门禁扫描函数体内的
 *     `throw …;`、`return …;` 与 `{ error: … }`，其中的中文字面量必须是词条 key；
 *     带 `${}` 的模板判失败（应改用 `messageVars()`）。
 *   - `keys`：无法从字面量直接推出、但确实经 `localizable()`/`messageVars()` 产出的词条 key
 *     （例如变量的 `.key`）。门禁会反向校验这些 key 在模块源码里出现且有 api 词条。
 *   - `constants`：模块内中文常量（门禁解析后按 key 要求词条）。
 *
 * 未登记的产出形态（例如 `_manifest_error` 的开发者错误、Jira 测试结果的 JSON
 * `{ok:false,error}`）**不在守卫面**——这是已知边界，见 task-10-report.md「残留绕过类」。
 */
export const LIB_USER_MESSAGE_SOURCES = Object.freeze({
  'chat.js': {
    classes: ['DeliveryRefused', 'InjectRefused'],
  },
  'board.js': {
    functions: [
      'answerInteraction',
      'answerApproval',
      'deliverPendingAnswerNow',
      'reorderCard',
      'cleanupCardWorktree',
      'handoffWorktreeMerge',
      'moveCard',
      'doingGesture',
      'enterDoing',
      'enterDoingWorktree',
      'startCard',
      'startWeb',
      'deliverComment',
      'deliverNow',
      'compactSession',
      'forkCompactSession',
      'forkSession',
      'requireCardSession',
    ],
    constants: ['LOST_SESSION_MSG'],
  },
  'dshdriver.js': {
    classes: ['DshDriverError'],
    constants: ['UNCONFIGURED_MESSAGE'],
  },
  'rag.js': {
    functions: ['_cfg_int', 'save_config'],
  },
  'builtin-assets.js': {
    functions: [
      'list_assets',
      '_require_profile',
      '_patch_foreign_error',
      '_installed_files',
      'install',
      'uninstall',
    ],
    // 经 unsupportedInfo() 按变量 `.key` 产出，不是字面量实参
    keys: [
      '该资产只支持{targets}安装',
      'dsh 插件资产只支持用户级（装进 dsh profile，与项目无关）',
      '该资产（{family}）暂不支持此目标的安装',
    ],
  },
  'lib.js': {
    functions: ['fsMkdir'],
  },
  'agents.js': {
    constants: ['RETIRED_MSG'],
  },
});
