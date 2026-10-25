#!/usr/bin/env python3
"""`backend_py/*` 用户可见错误文案的**静态登记表**（Python 覆盖门禁的真相源）。

镜像 `backend/lib/user-messages.js`（T10 的 Node 登记表），模块名改为 Python 的
`backend_py/<模块>.py`、函数名改为 snake_case。为什么需要它：`server.py` 的错误文案是
`self._error*(…)` 的实参，覆盖门禁可以直接扫；lib 层的错误则是「抛异常」或「返回
字符串 / `{"error": …}`」，形态散落，无法靠一条正则覆盖。本表显式登记**哪些模块、哪些
类/函数里的中文文案算用户可见**，`tests/test_i18n_api.py` 据此扫描源码并逐条要求
`i18n/en.json` 的 `api` 词条。新增 lib 用户可见错误时必须同步两处：词条 + 本表
（若用了新的产出形态）。否则门禁变红。

字段含义（与 Node 登记表逐条对应）：
  - `classes`：该模块里「类名 + 中文消息实参」即用户可见错误（如
    `DeliveryRefused(…)`）。门禁会要求每个字面量消息（含 `{占位符}` key）都有 api
    词条；带 f-string 插值的模板直接判失败（应改用 `i18n.localizable()`）。
  - `functions`：该模块里「返回值/抛错会给到路由层」的函数。门禁扫描函数体内的
    `raise …`、`return …` 与 `{"error": …}`，其中的中文字面量必须是词条 key；
    带 f-string 插值的模板判失败（应改用 `i18n.message_vars()` /
    `i18n.localizable()`）。
  - `keys`：无法从字面量直接推出、但确实经 `localizable()`/`message_vars()` 产出的
    词条 key（例如变量的 `.key`）。门禁会反向校验这些 key 在模块源码里出现且有 api 词条。
  - `constants`：模块内中文常量（门禁解析后按 key 要求词条）。

与 Node 的差异（Python 架构使然，已在 task-11-report.md 登记）：
  - `fsMkdir` 在 Python 里是 `server.py` 的模块级函数 `fs_mkdir`（Node 在 `lib.js`），
    故登记在 `server.py` 项下；
  - `python 的 board.py` 用 `start_into_doing`（Node 名 `enterDoing`）等，函数名逐条
    对齐 Python 源码；
  - `lib.py` 没有 HTTP 用户可见错误（`git 不可用` 只进任务日志，由 runner 消费），
    故不登记。

未登记的产出形态（例如 `_manifest_error` 的开发者错误、Jira 测试结果的 JSON
`{ok:false,error}`）**不在守卫面**——这是已知边界，见 task-11-report.md「残留绕过类」。
"""

# 模块名 → 登记面（键是 backend_py/ 下的文件名）
LIB_USER_MESSAGE_SOURCES = {
    "server.py": {
        # fs_mkdir 的 6 条固定文案 + 「新建失败：{detail}」插值文案
        # （Node 登记在 lib.js:fsMkdir；Python 该函数在 server.py）
        "functions": ["fs_mkdir"],
    },
    "chat.py": {
        "classes": ["DeliveryRefused", "InjectRefused"],
    },
    "board.py": {
        "functions": [
            "answer_interaction",
            "answer_approval",
            "deliver_pending_answer_now",
            "reorder_card",
            "cleanup_card_worktree",
            "handoff_worktree_merge",
            "move_card",
            "_doing_gesture",
            "_enter_doing",
            "_enter_doing_worktree",
            "start_card",
            "_start_web",
            "deliver_comment",
            "_deliver_now",
            "compact_session",
            "fork_compact_session",
            "fork_session",
        ],
        "constants": ["LOST_SESSION_MSG"],
    },
    "dshdriver.py": {
        "classes": ["DshDriverError"],
        "constants": ["UNCONFIGURED_MESSAGE"],
    },
    "rag.py": {
        "functions": ["_cfg_int", "save_config"],
    },
    "builtin_assets.py": {
        "functions": [
            "list_assets",
            "_require_profile",
            "_patch_foreign_error",
            "_unsupported_error",
            "_installed_files",
            "install",
            "uninstall",
        ],
    },
    "agents.py": {
        "constants": ["RETIRED_MSG"],
    },
}
