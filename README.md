# Touchstone

AI agent 驱动的自动化测试平台：在站点上创建项目（绑定被测代码目录、智能体路径、工作目录），
创建六类任务（探索 / 回归 / 压测 / 修复 / 复测 / 修例），由平台以「多轮会话」方式驱动 agent
在案例库中生成与执行用例、沉淀 bug 报告，并提供登录鉴权、多用户隔离、实时监控与 session 对话窗口。

**智能体族只有 dsh 插件一族**（2026-10-03 单族化定稿）：项目「智能体路径」选扫描到的 dsh 条目
即得 `dsh-plugin:<dsh 路径>`，平台经 `dshdriver.py` 驱动 dsh 宿主进程内
（`dsh-plugin/lib/agent-driver.js`）的常驻会话池——一轮 = 一次 followup + 等 SSE 的 `turn/end`，
零状态轮询。kimi / claude / opencode / hermes 与 dsh CLI 五个旧族**已退场删除**：起跑处按
「该智能体族已下线，请在项目设置里改绑 dsh 插件」拒绝，存量项目绑定由 `migrate_p7b.py` 改写。

本文件给出**平台能力 × 唯一族（dsh 插件）**的支持清单。

## 构建 / 运行 / 测试

```bash
# 构建前端（start/restart 会自动构建；无 webui/dist 时 server.py 直接退出）
./touchstone.sh build

# 启动后端（同时托管前端），默认 127.0.0.1:4601；--port/--host 可改
python3 server.py

# 一键启停（后台运行，PID/日志在 .run/ 下；TS_PYTHON 指定解释器，TS_PORT/TS_HOST 覆盖监听）
./touchstone.sh start | stop | restart | status

# 测试三档
./touchstone.sh test        # 快层：后端 pytest + 前端 vitest（缺前端环境自动跳过）
./touchstone.sh test-full   # 快层 + 隔离实例 e2e（未随附 e2e 脚本时提示并跳过该档）
./touchstone.sh test-ui     # Playwright e2e（需站点在跑；只探活提示，不自动重启站点）
```

Windows 原生运行用跨平台启停器（命令面与 `touchstone.sh` 一致，运行产物同为 `.run/`）：

```bash
pip install -r requirements.txt
python touchstone.py start | stop | restart | status | build | test | test-full | test-ui
```

首次启动自动种子默认账号：未设 `TS_ADMIN_PASSWORD` 时随机生成 16 位一次性初始口令，
只在启动横幅打印一次且首次登录强制改密；设了则用该值、不强制改密。
数据库默认 `~/.touchstone/touchstone.db`（`TOUCHSTONE_DB` 覆盖，须放本地盘，
SQLite 文件锁不能用于 CIFS/网盘同步目录）。

dsh 插件形态（内嵌 dsh web，与独立形态二选一运行；同库互斥）：

```bash
./dsh-plugin/install.sh      # 幂等安装到 ~/.dsh/profiles/web，重启 dsh web 生效
```

案例库派生索引导出与复测粗筛（独立 CLI）：

```bash
python3 export_cases.py export <案例库根> [--out <路径>]
python3 export_cases.py retest-candidates <案例库根> <变更文件...> [--json]
```

## 智能体入口

| 项目「智能体路径」的值 | 实际族名 | 说明 |
|----------------------|---------|------|
| `dsh-plugin:<dsh 路径>` | dsh_plugin | 「智能体路径」下拉里**唯一**的「dsh（插件·进程内）」条目（产品入口） |
| 留空 / 未知路径 | dsh_plugin | 默认族（未配置项目也按 dsh 插件跑） |
| kimi / claude / opencode / hermes 旧可执行名、**裸 `dsh` 可执行**，或 `kimi-web:` / `opencode-web:` 旧前缀 | retired | **已退场**：起跑处返回明确错误，不静默降级（存量绑定在下拉里以只读兜底项显示） |

图例：✔ 支持 · △ 受限/部分支持 · ✘ 不支持 · － 不适用。

## A. 接入与配置

| 功能 | 支持 | 边界 |
|------|:----:|------|
| 项目智能体下拉可选（本机扫描） | ✔ | 只有「dsh（插件·进程内）」一条（裸 dsh CLI 行已退场、不再出现） |
| 六类任务执行（探索/回归/压测/修复/复测/修例） | ✔ | |
| 会话上下文续接（resume） | ✔ | 会话常驻宿主进程，sid 在轮次开始即精确入库 |
| 任务/项目级模型下发 | ✔ | 值 = `provider/模型 id`（下传宿主用），显示用显示名 |
| 模型下拉列表 | ✔ | 宿主 `sessionController.modelCatalog()`，60s 缓存 |
| 免审批运行 / 项目级权限配置 | ✔ | 默认 `danger-full-access`（免审批）；会话级权限档切换见 C 表 |
| 项目能力 skill 扫描与注入 | ✔ | 用户级 `~/.dsh/skills`、`~/.agents/skills`；项目级 `.dsh/skills`、`.agents/skills` |

## B. 会话可观测

| 功能 | 支持 | 边界 |
|------|:----:|------|
| 会话窗口查看（历史消息渲染） | ✔ | 解析 `~/.dsh/sessions/**/session*.jsonl.zstd`（多帧 zstd，逐帧容错） |
| 任务首轮运行中会话探测 | ✔ | 正常路径零探测（sid 在轮次开始即精确入库）；仅「建会话已发出、库未写入」的毫秒级窗口回落到驱动 `GET /live` 一次 |
| 会话列表（绑定已有会话 / 外部会话自动同步） | ✔ | |
| 归档标记（archived → 已完成） | ✔ | dsh 侧归档主会话 ⇒ 看板自动落「已完成」并级联归档（2026-10-05 起双向同步；`TS_ARCHIVE_SYNC=0` 关闭） |
| 模型请求失败错误条目 | ✘ | dsh 无该事件通道（窗口不显示错误横幅） |

## C. 会话交互（会话详情页）

| 功能 | 支持 | 边界 |
|------|:----:|------|
| 对话续发消息 | ✔ | |
| 停止 / 中断 | ✔ | |
| 统一队列消息排队（不与其他单元并发改代码） | ✔ | |
| 服务端排队插话（会话在跑时收下不丢） | ✔ | `followup` 排进 agent inbox |
| 排队消息「立即注入」当前轮 | ✔ | `steer` 注入最近 step 边界 |
| 平台触发 compact（上下文压缩） | ✔ | 走宿主 `/compact` 命令 |
| 压缩并新建会话 | ✔ | **等价近似**：fork 副本 → 压缩副本（无摘要读取口） |
| fork 会话（完整复制） | ✔ | 宿主 `session.fork` |
| 提问回退（rewind） | ✔ | **变相实现**：`session.fork(atSeq)` 从这里另起一支，旧会话仍在、可切回（不是原地撤销） |
| 交互问答（提问卡片作答） | ✔ | |
| 审批请求应答 | ✔ | 平台接管（`holdApprovals`）后代答；`scope=session` 无对应语义、明确报错 |
| 会话级控件（模型 / 上下文圈） | ✔ | 模型走驱动 `/model`；圈圈只显示 used（dsh 无窗口上限，不画弧） |
| 会话级控件（权限档） | ✔ | 三档 `manual 逐条确认` / `yolo 自动通过` / `auto 完全自主`，按 `DSH_PERMISSION_PRESETS` 映射到宿主 preset；当前档随会话 meta 回读（2026-10-04 起），meta 未到时控件 disabled（不猜） |
| 附件图片预览 | ✔ | 驱动 `GET /media` 取宿主 attachment 字节 |

## D. 看板

| 功能 | 支持 | 边界 |
|------|:----:|------|
| 卡片会话启动与评论投递 | ✔ | |
| 交互阻塞调和（提问自动进阻塞列） | ✔ | 事件驱动（`dshevents.wait` 唤醒，静默期零请求，60s 兜底对账） |

## 关键边界

- **退场族不可跑**：kimi / claude / opencode / hermes / dsh CLI 的 CLI 与 web 驱动均已删除；
  旧会话文件仍在磁盘上（`~/.dsh/sessions` 之外的旧存储平台不再读），需要时请到对应工具里自行查看。
- **平台自身不自动提交**，但可按需分发**自动提交守卫**：设置页「内置资产」里可一键安装
  dsh 原生插件 `dsh-autocommit`（`extensions/dsh-autocommit/`，原 kimi hook 资产的替代）；
  装与不装由用户决定，插件默认只「挡 + 提示模型去提交」，自行提交仅在 `commitOnApproval=true`
  （默认 false）时发生。提交本身仍由用户或其在 agent 会话里发起的动作完成。
- **归档双向同步**（2026-10-05）：dsh 侧归档主会话 ⇒ 看板卡自动落「已完成」；看板卡进/出
  「已完成」也同步归档/取消归档（失败回滚列并 400；`TS_ARCHIVE_SYNC=0` 关闭）。
- **rewind / 压缩并新建是语义近似**：见 C 表对应行的边界列。
- **Windows 与 Linux 一致**：平台本体全功能 + 只支持 dsh 插件族；**dsh 在 Windows 上的实机验证仍未做**。

> 与智能体族无关（平台本体）的能力：案例库与 bug 报告目录、任务生命周期与 pipeline 后段、
> 统一队列调度、飞书通知、附件上传、RAG 案例库语义检索、`live.json` 监控数据源。
