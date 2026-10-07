# tests 运行矩阵

三层测试的统一入口与前置条件（2026-09-13 批次建立）。

**e2e 脚本不随公开发布分发**：本仓若缺少 `tests/e2e_*.py`（隔离实例档与 Playwright 档），
`test-full` / `test-ui` 检测到缺失会打印「未随附…，该档已跳过」提示并正常退出（不是失败）；
e2e 脚本在私有开发仓中维护并照常运行。下表后两行的文件与规模以带 e2e 脚本的仓为准。

## 一键入口（推荐）

```bash
./touchstone.sh test        # 快层：后端单测（~2s）+ 前端单测（vitest，webui 配置后自动纳入）
./touchstone.sh test-full   # 快层 + 隔离实例 e2e 脚本（自起临时实例，无需站点，分钟级）
./touchstone.sh test-ui     # Playwright e2e（需站点在跑；只探活提示，不自动重启站点）
```

Windows 原生运行：`python touchstone.py test|test-full|test-ui`（命令面与 touchstone.sh 一致）。
Python 解析：默认 `python3`，需指向项目环境（my_pyenv）或用 `TS_PYTHON` 指定；
解释器缺 pytest 时命令会给出明确报错。

## 三层测试的分工

| 层 | 文件 | 规模 | 运行方式 | 前置条件 |
|----|------|------|----------|----------|
| 单元/回归（pytest） | `test_*.py`（59 个） | 1004 用例 | `pytest tests/` 或 `touchstone.sh test` | 无（零外部依赖，全部打桩） |
| 隔离实例 e2e（独立脚本） | `e2e_board_continue.py` / `e2e_board_stream.py` / `e2e_chat_queue.py` / `e2e_unit_state.py` / `e2e_stress_case.py` / `e2e_board_archive.py` / `e2e_board_worktree.py` | 合计 **219** 个 check（53+5+49+53+17+12+30；前五个 2026-10-04 实测，archive 2026-10-05、worktree 2026-10-06 实测全绿） | `python tests/e2e_<名>.py`（或 `touchstone.sh test-full`） | my_pyenv + `webui/dist`（脚本自起临时 server/库/**假 driver**：`tests/fakedriver.py`，P7a 起替身退到驱动边界；worktree 档另用系统 `git` 在沙箱内真建工作树） |
| 插件侧契约自检（桩 ctx） | `dsh-plugin/scripts/dev-check-driver.mjs` + `dev-check-shell.mjs` + `dev-check-shortcuts.mjs` + `dev-check-bridge.mjs`（均由 `test_dsh_plugin.py` 挂钩进快层） | 驱动 **71 项** / 薄壳生命周期 **12 项** / 客户端快捷键 **36 项** / 面板消息桥 **33 项**（2026-10-07 实测 PASS） | `node dsh-plugin/scripts/dev-check-*.mjs` | node（缺失自动 skip） |
| 真机 e2e（需 dsh 实例） | `e2e_dsh_driver.py`（驱动契约/平台全链路） + `e2e_feishu_card_answer.py`（**飞书卡片点选作答全链路**：真会话 `ask_user_question` → 真调和器产卡 → 从真卡控件反推飞书回调载荷经 `P2CardActionTrigger`/`_card_sdk_to_dict` 喂 `_on_card_action` → runner 真送达 → 会话 transcript 的 tool_result 断言 agent 实收；2026-10-07 实测 **22/22 passed**）+ `e2e_session_walkthrough.py`（会话窗 UI 只读走查，Playwright 经插件反代口免登；`TS_WALK_BASE`/`TS_WALK_PROJECT`/`TS_WALK_CARD` 可覆盖，2026-10-04 实测 21 断言全绿，截图落 `.run/b7_session_window.png`）+ `e2e_plugin_shortcut.py`（面板开关快捷键 `Alt+T`：宿主页/面板 iframe 两侧 + 官方注册表键位通道 + 速查目录 + **面板保活/焦点交还/路由记忆/切到 dsh 主界面另一处再回来/跨宿主页刷新回到上次页面**（2026-10-07），25 断言，截图落 `.run/e2e_plugin_shortcut.png`） | 三层：默认单轮 + `--resume` 续轮；**`--contract`** 能力面逐条（fork/压缩新建/回退/cancel/媒体/状态流…）；**`--platform <url>`** 平台全链路（建项目→看板卡起跑→落 review→任务 done + 产品 fork/压缩新建/回退端点） | `python tests/e2e_dsh_driver.py <cwd> [--resume] [--contract] [--platform http://127.0.0.1:3099/touchstone]`；`python tests/e2e_feishu_card_answer.py [--keep]`（约 1-2 分钟、花真实 token，跑完 dispose 会话）；`python tests/e2e_plugin_shortcut.py [--base <带token的dsh URL>]`（默认读 `~/.dsh/profiles/dsh-test/ts-test.log`） | 装着 touchstone 插件的 dsh 实例 + `TS_AGENT_DRIVER_URL/TOKEN`（文件头给了取法；**飞书档**从实盘后端 `/proc/<pid>/environ` 自动取、令牌只进内存）；快捷键档另需 `bash ~/.dsh/profiles/dsh-test/start-test.sh` |
| Playwright e2e（需站点） | `e2e_board_enhance.py` / `e2e_board_quickadd_skill.py` / `e2e_board_unread.py` / `e2e_personalize.py` / `e2e_project_dialog.py` / `e2e_session_dialog.py` / `e2e_session_scroll.py` / `e2e_settings.py` / `e2e_tabbar.py` | 54 用例（`e2e_board_unread.py` 另 3 例，自举门控） | `pytest tests/e2e_<名>.py -v`（或 `touchstone.sh test-ui`） | 站点在跑 + chromium（`playwright install chromium`）+ admin/TS_E2E_ADMIN_PW（未设时默认 123456） |

- e2e 失败退出码即非零（独立脚本靠 `check()` 汇总；Playwright 靠 pytest 退出码）。
- 站点地址可用 `TS_BASE` 覆盖（默认 `http://127.0.0.1:4601`；`touchstone.sh`/`touchstone.py` 会自动带上实际端口）。
- 跑 test-ui 前若改过代码：先 `restart` 让站点加载最新代码，否则测的是旧版。
- Playwright 档会操作真实数据；**写操作类用例只挑「测试专用卡」**（标题含 `[e2e]`，`TS_E2E_MARK` 可改；整机专用环境可 `TS_E2E_WRITE=1` 放开），没有该卡时这些用例 skip——避免把测试消息写进真实卡片会话（见 `e2e_session_dialog.py` 文件头「写操作用例落点约束」）。
- 手势矩阵自举开关：`e2e_board_enhance.py` 的 doing 列三手势矩阵（v2c T3）默认 SKIP（真机红线 #401，手势会真起/真停会话）——置 `TS_E2E_GESTURE_SELFHOST=1` 时模块夹具自拉隔离实例（假 driver + 长睡会话）才跑，不对 4601/开发站点跑。
- Ctrl+Enter 建卡即入队用例（`e2e_board_quickadd_skill.py::test_8`，2026-09-29）：同属真机红线 #401 同类（会真起会话），默认 SKIP——置 `TS_E2E_QUICKADD_SELFHOST=1` 时模块夹具自拉隔离实例（假 driver + 长睡会话）才跑。
- 看板「有更新」标记档（`e2e_board_unread.py`，2026-10-07）：同样会真起会话（假 driver 跑完一轮让调和器搬 review），默认 SKIP——置 `TS_E2E_UNREAD_SELFHOST=1` 时自拉隔离实例（`sleep=1`，约 35s 跑完 3 例：会话跑完置位并渲染标记 / 打开卡片清标记且 `updated_at` 不变 / 用户自己移列不置位）。

## 直接调用（不经 touchstone 入口）

```bash
# 单测全量（快）
pytest tests/ -q

# 单文件
pytest tests/test_rag.py -v

# 显式点名 Playwright e2e（需站点）
pytest tests/e2e_tabbar.py -v
```

pytest 配置在仓库根 `pytest.ini`（`testpaths = tests`）。`e2e_*.py` 不在默认收集中，
只能显式点名运行——这是有意设计（无站点的机器跑默认套件不应被 skip 淹没）。

## 约定

- **新增 Playwright e2e 文件**：需同步加入 `touchstone.sh` 的 `cmd_test_ui` 与 `touchstone.py` 的
  `cmd_test_ui` 文件列表（两处），否则一键入口不会跑到它。
- **新增隔离实例脚本**：同步加入两处 `cmd_test_full`；脚本请沿用现有模式
  （随机端口 + `TOUCHSTONE_DB`/`TOUCHSTONE_RUN_DIR` 沙箱 + 假 driver（`tests/fakedriver.py`）记录调用）。
- 单测原则：零外部依赖（网络/agent CLI/真实会话存储全部打桩）、真实临时库
  （`conftest.py` 把 `TOUCHSTONE_DB` 指到临时文件，勿绕开）。
- 提交门禁（可选安装）：`git config core.hooksPath githooks` 启用 `githooks/pre-commit`
  （跑快层；`SKIP_TS_TESTS=1` 可单次跳过；环境缺 pytest 时警告放行不阻塞）。

## 常见问题

- **`No module named pytest`**：用了系统 python3。先激活装着 pytest 的项目环境，
  或用 `TS_PYTHON=<项目环境解释器> ./touchstone.sh test` 显式指定。
- **test-ui 提示站点未运行**：先 `./touchstone.sh start`；改了代码用 `restart`。
- **端口顺延后 e2e 连不上**：server 绑定失败会自动 port+1，`touchstone.sh test-ui`
  已按 `.run/server.port` 的实际端口自动设置 `TS_BASE`；手工直连时注意。
- **前端单测不跑**：需 `cd webui && npm install`（就绪判定看 `webui/node_modules/vitest/vitest.mjs`
  在不在，`webui/package.json` 还得有 `test` script）。
- **前端单测报 `ERR_MODULE_NOT_FOUND .../node_modules/.bin/dist/cli.js`**：本仓库
  `webui/node_modules` 是从 Windows 侧拷贝来的，npm 的 bin 符号链接被展平成同名文件拷贝，
  从 `.bin/` 解析其相对导入必失败。快层已直连包入口（`node node_modules/vitest/vitest.mjs run`），
  手工跑请用同一条命令；要恢复 `npm test` / `npx vitest`，重建那 5 个 bin 链接即可
  （`npm rebuild` 或重装依赖后符号链接自然恢复）。
