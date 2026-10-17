/**
 * 任务执行引擎（`runner.py` 2482 行的 Node 对应物）：**M3 只读口 + M4 调度内核**。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 覆盖面（本文件已搬什么 / 没搬什么）
 * ══════════════════════════════════════════════════════════════════════════════
 *   - **M3（读路径，先落地）**：`unitBusy` / `unitState` 两个纯 waitq 表读口 + 窗口几何
 *     纯函数（`prefixMembers` / `prefixWindowBlocked` / `windowN`）+ `LOG_DIR_NAME` /
 *     `appendLog`。它们是会话详情页「队列」徽标、提交时 `queued` 字段与 `project_busy`
 *     的数据源，本批次**不改语义**。
 *   - **M4（统一队列写路径首次落地）**：`runner.py` 的**调度内核**——模块级 helper
 *     （`notify_task_failed` / `_answer_row_sid` / `_session_msg_keys` / `_claim_unit` /
 *     `holders_text` / `SELFCHECK_*` / `set_liveness_probe` / `reconcile_units` /
 *     `start_unit_selfcheck`，runner.py:84-186、2379-2482）与整个 `Runner` 类
 *     （runner.py:188-1160）。行为逐点照 Python：补位器 `_pick_locked` 的五个闸
 *     （not_before / 队首阻塞 / 占位与状态校验 / pipeline 前段 / 前缀窗口 + ext 闸）、
 *     claim 的 rowcount 仲裁、claim 后行口径窗口复判、四类单元的收口映射、recover 的
 *     四类重建矩阵、stop 的 waiting/starting 分流、周期自检与启动对账。
 *   - **不在本批次**（M5/M6 起分批接线；**仍未搬的命中即走下方「缝」或响亮失败**）：
 *     答案送达体（`board._deliver_answer_unit`）、卡片收尾点（`board.finish`）、周期自检的
 *     两个 board 钩子（`board.unit_managed` / `board.refresh_ext_rows`）、飞书通知
 *     （`feishu.task_failed`）。**M6.5 三批（R1/R2/R3）已把 `runner.py` 的执行体搬完**：
 *     入口本体 + bug/复测联动（R1）、脚本复测族 + 压测发压族（R2）、轮次族 + 日志/读侧族（R3）。
 *   - **M6.5 分批接线（分节注释在各族开头）**：R1 = 入口本体（`_process_card` /
 *     `_process_task`）与 bug/复测联动族；R2 = 脚本复测族（`_script_*` / `_run_one_script`）
 *     与压测发压族（`_run_load_phase` / `_next_load_round_no` / `_load_cmd` / `_spawn_load` /
 *     `_wait_killed` / `_finish_load` / `_write_load_report` / `_fail_load` /
 *     `_spawn_retest_task`）；R3 = 轮次族（`_run_round` / `_run_round_dshplugin` /
 *     `_wait_turn_end_dsh` / `_should_stop`）与日志/读侧族（`build_prompt` / `_content_text` /
 *     `dsh_event_to_log_line` / `_dsh_stream_worker` / `parse_session_hint` /
 *     `summary_entry_text` / `_tail_text` / `read_log_tail` / `read_live_summary`）。
 *     差异㉕ 里「未实现时调用点抛 TypeError」的过渡态随之退场（三处调用点全部有实现）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 缝（可注入；默认要么响亮失败、要么照 Python 静默——逐条见下）
 * ══════════════════════════════════════════════════════════════════════════════
 *   ① `setUnitHandlers({processTask, processCard, deliverAnswerUnit})`：`_worker` 的四路
 *      分派体。**未接线抛具名错误** `UnitHandlerMissing`（文案见 `UNIT_HANDLER_MISSING`，
 *      点明到期里程碑）——异常的落点照 Python 的 except/finally 逐条走（见 `runPickedUnit`），
 *      于是「t: 行落 failed / c: 行落 failed / a: 行放回 waiting」都可断言，**绝不静默成功**。
 *   ② `setBoardFinishHook(fn)`：`board.finish(key, reason)` 的等价口。未接线只打一行
 *      `[runner] board.finish 未接线（M5）…`（Python 该子步是「尽力而为的回滚收尾」，
 *      抛了也只打日志，故这里不抛）。
 *   ③ `setBoardSelfcheckHooks({unitManaged, refreshExtRows})`：周期自检的两个 board 读钩子。
 *      未接线时 `unitManaged=null`（照 Python「无豁免判据」）、`refreshExtRows` 跳过一拍
 *      （Python 的 `board.refresh_ext_rows` 异常只打一行，跳过等价于那一支）。
 *   ④ `setFailureNotifier(fn)`：飞书任务失败旁路（**M7 接线**）。未接线**静默**——照
 *      Python `notify_task_failed` 的 `except: pass`「通知永不影响调度主流程」。
 *   ⑤ `setLivenessProbe(fn)`：行判活探针（模块级，照 Python `set_liveness_probe`；board 注册）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 与 Python 的形态差异（逐条 + 理由；**均为形态差异，行为判据一律照 Python**）
 * ══════════════════════════════════════════════════════════════════════════════
 *   ① **无线程**：Python `Runner.__init__` 起 `WORKERS=6` 条 daemon 线程跑 `_worker`；
 *      Node 起 6 个 **async 循环**（`this._workers` 存 promise，Python `_threads` 存
 *      Thread）。循环体内的 `await` 是让位点——Python 靠 GIL + 线程切换，Node 靠事件循环。
 *   ② **`threading.Condition` → `Waiter`**：Python 的 `self._cond` 同时是互斥锁与唤醒面；
 *      Node 单事件循环下**无并发交错**，锁没有可保护的对象，故 `Waiter` 只保留唤醒语义
 *      （`notifyAll()` 唤醒全部等待者、`wait(timeoutMs)` 返回 promise 且超时也 resolve）。
 *      `_worker` 的 **5s 节拍兜底（补位时机④）逐字保留**：`pickLocked()` 返回 null ⇒
 *      `await waiter.wait(5000)` 后重跑补位器。
 *   ③ **锁语义 = 「临界区不许 await」**：Python `with self._cond:` 段在 Node 侧退化为
 *      「同一 tick 内的同步段」——`pickLocked()` 与 `claimAndStartLocked()` 之间**没有
 *      await**，等价于 Python 持锁完成「挑选 + claim + 窗口复判」（双拾取在结构上不可达）。
 *      纪律：所有 `_xxxLocked` 命名的方法体内**不许出现 await**（命名与 Python 对齐，
 *      提醒读者这里是原子段）。
 *   ④ **定时器 ref 口径（两处不同，别一刀切）**：
 *      - `Waiter.wait(timeoutMs)` 的等待定时器**保持 ref**：它是「worker 在等活」的唯一表征，
 *        unref 掉会让事件循环在**没有任何其它活动**时直接判定退出，等待中的 promise 永远
 *        悬着——Node 22 的 `node --test` 会把它报成 `cancelledByParent: Promise resolution
 *        is still pending but the event loop has already resolved`（实测）。生产由 HTTP
 *        服务持循环、退出走 `process.exit()`，故 ref 不影响停机。
 *      - `startUnitSelfcheck` 的周期定时器**一律 `unref()`**：它是「周期任务」而非「在等活」，
 *        不许让进程因为有它而退不出去（= Python daemon 线程语义）。
 *   ⑤ **轮次执行体在 M5/M6**：`_process_task` / `_process_card` / `board._deliver_answer_unit`
 *      一律走注入缝（见上），未接线响亮失败。
 *   ⑥ **`stop()` 是 async**：Python 里它同步调 `dshdriver.cancel`（线程内阻塞）；Node 侧
 *      `dshdriver.cancel` 是远端 IO ⇒ `stop` 返回 promise，调用方必须 await。
 *      `platcompat.kill_tree(pid, SIGTERM)` → `proc.js:killTree(pid, {sig:'SIGTERM'})`
 *      （**按本批次指定的口径映射**）。两者语义并非逐字同，明示在此：Python 的 POSIX 分支
 *      只有一次 `killpg(pgid, SIGTERM)`（非阻塞、失败抛 OSError 由调用方吞）；Node 的
 *      `killTree` 是「逐 pid 投 SIGTERM → 最多等 `KILL_GRACE_MS`(1500ms) 轮询 → 对未退者升级
 *      SIGKILL」，且**同步阻塞事件循环**（Python 只阻塞那一条 HTTP 线程）。后果：停一个真在
 *      跑的进程树时，Node 侧最长 1.5s 内全体请求/SSE 停摆且会升级强杀。M4 期间 `_procs` 恒空
 *      （M6 才填），故当下不可达；**M6.5-R2 已接线**（`spawnLoad` 的停止/超时两支真会调它，
 *      `_procs` 也真会被填）：对拍实测两支的返回值与 Python **逐字节同**（协作支 `[0,'']`、
 *      宽限到期支 `[-15,'用户停止']`），即「单投 SIGTERM + 升级 SIGKILL」在本用例形状
 *      （`/bin/sh -c …` 子进程）下与 `killpg` 可观测等价；**残余差异**（最长 1.5s 同步阻塞、
 *      会升级 SIGKILL、Windows 无 psutil 分支）仍按上文本登记，要逐字同就换 `process.kill` 单投。
 *   ⑦ **`_procs` 键保持 int task_id**：`Map<int, {pid}>`（Python `dict[int, Popen]`）。
 *      取值面只有 `stop()`（`killTree(proc.pid)`）与 worker finally 的 `pop`；Node 侧存
 *      「有 `.pid` 的对象」（M6 的轮次执行体决定具体形态）。
 *   ⑧ **`INSTANCE` 由 `setInstance` 写**：ESM 的命名空间对象不可写（`runner.INSTANCE = x`
 *      会 TypeError，Python 侧是 `runner.INSTANCE = inst`）⇒ 模块级 `export let INSTANCE`
 *      + `setInstance(inst)` 显式写口（`chat.js` 的 `setRunnerInstance` 同因）。
 *      `reconcileUnits` / `startUnitSelfcheck` / `setLivenessProbe` 读它，None 则直接 return
 *      （照 Python 措辞）。
 *   ⑨ **`recover()` 是 async**：它要发飞书失败通知（M7 缝可能是异步 IO）。同步临界段
 *      （行映射 + 任务映射 + 落库）**一段不 await**；通知在临界段之后逐任务 await
 *      （Python 是「循环内同步通知」）——差异只在通知/日志的时点，行态与写序不变。
 *   ⑩ **`_worker` 的单单元执行段抽成 `runPickedUnit(key)`**：分派 + `except` + `finally`
 *      三分支逐条照 Python（runner.py:1073-1159），抽出来的唯一目的是让单测能**手动
 *      pump 一步**（不起后台循环）。返回值 `{err, cardOk}` 是 Node 追加的观测面
 *      （Python 该段无返回值）——行为零影响。
 *   ⑪ **`_worker` 的两段都加了保底 catch**（`runPickedUnit` 之外）：Node 的未捕获异常会
 *      **打死整个进程**（Python 只死一条 daemon 线程）⇒ ①「拾取 + claim」段、②「等单元
 *      执行体」段各自 `console.log` 一行后跳过本轮（「响亮 + 继续」），绝不让一行坏数据或
 *      一次收口写失败（`finally` 里的 DB 故障）带走服务。**单元分派/except/finally 本体照
 *      Python 逐条保留，不吞任何异常**——保底只在它们之外兜底。
 *   ⑫ **`runPickedUnit` 的 a: except 分支两处 Node 侧加固**（本分支在 Python 侧实际不可达：
 *      `runner.py:1087` 直接 `import board` 调执行体，不存在「口没接线」这个态；Node 侧是
 *      缝，未注册即抛 ⇒ 本分支的可达场景就是**接线缺口**，或有异常从执行体逃逸）：
 *      ① **多一行日志**（Python 静默放回重投）——放回→立即重拾→再抛是热旋，日志是唯一可见性；
 *      ② **放回带退避**（`not_before = now + ANSWER_EXC_BACKOFF_S`；Python `runner.py:1110`
 *      传 `waitq.return_to_waiting` 的缺省 `0.0`）——2026-10-16 真机事故：接线缺口 + 零延迟
 *      重投 ⇒ **微任务级热旋**（await 全落已决 promise）把事件循环的宏任务队列饿死：后端
 *      50% CPU、日志 5.5KB/s 涨到 17MB、连 SIGTERM 都收不到（只能 SIGKILL），TS 会话详情
 *      的读端点随事件循环一起卡死；毒行在 `wait_items` 里 ⇒ 重启后端立刻续旋
 *      （用户观感「重启 DSH 也没用」）。**行态语义一字不改**：仍落 `waiting`、`retries`
 *      不涨（`retries` 只记业务重试，判据见 `backend/test/runner-core.test.mjs` ⑮），只把
 *      「立即重拾」改成「30s 后重拾」；退避档与 `board.ANSWER_BACKOFF_S` 同值
 *      （不在本文件 import board：会成环，见差异㉘）。
 *   ⑬ **两处 board/db 口缺失，就地等价实现**（本文件私有、不导出成公开 API）：
 *      `board._card_unit_active`（`_answer_exempt_keys_locked` 用；board.js 的 M3 只读子集
 *      没有这个口，判据本身只是一次 waitq 行读）与 `db.update_board_card(last_error=…)`
 *      （worker 的 c: 异常分支用；db.js 尚无卡片写口，就地 UPDATE 两列 + `updated_at`，
 *      SQL 与 `db.py:update_board_card` 同款）。
 *   ⑭ **`read_log_tail` 的落地路径**：`_kill_residual` 要读日志尾找 `### PID`；M6 的读侧工具
 *      当时未移植，故本文件先落一份**私有** `readLogTail(path, limit)`（同名同语义、不导出）。
 *      **M6.5-R3 已把它转为正式导出**（`read_log_tail` 的 Node 名），并修掉私有版对
 *      `limit<=0` 的切片偏差（见差异㊹）。
 *   ⑮ **两处「Python 会抛、Node 不抛」的防御**（同源理由：别让一行坏数据打死循环）：
 *      ① `json.loads(payload).get(...)`：Python 只吃 `ValueError`（坏 JSON），非对象的
 *      `AttributeError` 会打死 worker 线程 ⇒ Node 一律「坏 JSON / 非对象 ⇒ 按无前段处理」；
 *      ② `_claim_and_start_locked` 的 **t: 分支** Python 无 `None` 检查（`task["project_id"]`
 *      在任务行于 pick→claim 窗口被删时 AttributeError 打死线程）⇒ Node 按「放弃本次拾取」
 *      返回 `null`（与同函数 c:/m:/a: 分支的既有防御姿态一致；行保持 waiting，终态归取消方）。
 *   ⑯ **`int()` / 时间戳解析用共享工具**：`lib.pyIntOr` / `lib.pyIsDigits`（Python `int()`
 *      的容错版，ASCII 数字面，见 lib.js 文件头）；`created_at → epoch 秒` 的
 *      `time.mktime(time.strptime(...))` 等价物是私有 `localSeconds`（waitq.js 有同口径
 *      私有实现但未导出）。
 *   ⑰ **`_finalize_load_rounds`**：Python 是 `@staticmethod`，Node 侧写成实例方法
 *      （要收末位 options 袋；调用面只有 `recover`）。
 *   ⑱ **`processCard` / `processTask` 是 async，缝签名不变**：`rag.refresh`（RAG 索引刷新）
 *      与 `board.dequeueStart`（卡片起跑）在 Node 是 async（Python 侧同步）⇒ 本批两条
 *      执行体一律返回 promise。`setUnitHandlers` 注册的口本就允许返回 promise
 *      （`runPickedUnit` 一律 `await callUnitHandler(...)`），故**接线面零改动**：R4 注册
 *      `(id) => inst.processTask(id)` 即可，缝的形参/键名一字不改。
 *   ⑲ **Python 同步 `board.dequeue_start` vs Node async**：Python 的 `dequeue_start` 在
 *      调用线程里同步阻塞到「起跑有结论」；Node 的 `dequeueStart` 是异步（起会话是 IO，
 *      中途让位）。差异只在**让位点**：返回值语义（`True`/`False`）、行态、失败回滚
 *      照 Python 逐条不变。⚠ 由此 `runPickedUnit` 对 `c:` 口的等待**必须** `await` 到
 *      promise 落地（否则 `cardOk` 拿到的是 pending promise ⇒ finally 的
 *      「起会话失败 / 卡片状态不符」两支全部错判）——**本批只记文档、不改
 *      `runPickedUnit`**（接线在 R4；现口径已是 `await callUnitHandler(...)`，天然满足）。
 *   ⑳ **`STAGES` 在本文件独立定义**（`runner.py:64` 同源注释：与 `server.STAGES` / 前端
 *      STAGES 一致，**防循环依赖不 import server**）：Node 侧 `routes/` 与前端另有各自
 *      一份；runner 不 import server/routes（会成环，且 M4 起本文件就该独立可载）。
 *      两侧同值同序，判据照 Python。
 *   ㉑ **三处新调用点沿用差异⑮①的防御姿态**：`json.loads(payload or "{}")` 后 `.get(...)`
 *      的三处新调用面（`_process_task` 的 pipeline 分支 / `_mark_retest_cases` 的
 *      `only_cases` / `_maybe_auto_retest` 的去重扫描）在 Python 只吃 `ValueError`，
 *      非对象的 `AttributeError` 会打死 worker 线程 ⇒ Node 一律「坏 JSON / 非对象 ⇒ 按
 *      `{}` 处理」（= 私有 `payloadObject`）。行为判据照 Python 的**可达面**（payload 由
 *      平台自己写，非对象只在坏数据/人工改库时出现）。
 *   ㉒ **`STAGES.index(...)` → 私有 `stageIndex(...)`**：Python `tuple.index` 缺项抛
 *      `ValueError`（`_apply_bug_result` 的 pipeline 分支据此把该轮打成失败）；Node 的
 *      `indexOf` 会**静默返回 -1**（等于静默降级）⇒ 显式抛 `RangeError`。抛/不抛与落点
 *      照 Python；错误**类名**不同属既有「Node 错误类型名」口径（同差异⑧的错误码口径）。
 *   ㉓ **正则口径**：`AFFECTED_LINE_RE` 的 `\s` 用 `lib.PY_WS`（Python `str` 正则的
 *      Unicode 空白表，见 lib.js 文件头）；`\d` 按 **ASCII**（同 lib.js 文件头「已知有意
 *      保留的差异 ③」——`CASE_DIR_RE` / `BUG_DIR_RE` / `FS\d{4}` 两侧同为 ASCII，真实
 *      输入里不可能分叉）；`BUG_DIR_RE` 的 `$` **不补**「末尾换行之前」这一支
 *      （Python `$` 匹配 `"…\n"`、JS 不匹配）——目录名带换行属荒谬输入，登记不改。
 *   ㉔ **`line[:12]` 按码点切**：Python 下标切片按**码点**，JS `String.slice` 按 UTF-16
 *      码元 ⇒ 本文件用 `[...line].slice(0, 12).join('')` 同口径（代理对不被劈开，
 *      `_extract_affected_ids` 的「含『无』即判无」窗口因此逐字符等价）。
 *   ㉕ **`_run_round` / `_run_script_retest` / `_run_load_phase` / `_should_stop` 的调用契约**：
 *      Node 名 `runRound` / `runScriptRetest` / `runLoadPhase` / `shouldStop`，形参照 Python
 *      位置参数 + 末位 options 袋；**`runRound` 返回 `[exitCode, sessionId]`**
 *      （Python 元组 → Node 数组：probe 的 tuple/list 转 JSON 后同形，对拍不需要
 *      `shape` 适配）。R1/R2 期间只写调用点、不写空壳（未实现即 `TypeError`，**响亮**），
 *      **R2/R3 已分别落地**：三处调用点现在都有实现，过渡态退场。
 *   ㉖ **`_log_task_line` 不吞异常**（对拍实测修正）：Python 的 `except (OSError, AttributeError)`
 *      两个成员的**可达面**都不需要 Node 侧再兜：OSError 已由 `appendLog` 内吞掉，
 *      AttributeError 在 `rounds[-1]["log_path"]` 这个调用形状下不可达。真正可达的是
 *      `task is None` ⇒ `task["id"]` 抛 **TypeError**——它**不在** except 元组里，Python 侧是
 *      **外抛**（对拍 A 侧实测：`kind=TypeError`，`'NoneType' object is not subscriptable`）。
 *      故 Node 侧**不写 try/catch**、同抛（错误文本随语言不同：引擎文案 vs Python 文案；
 *      本文件不去逐字复刻解释器文案，登记为残余差异）。该分支不进对拍用例（`seq` 会连错误
 *      文本一起比），只在 `backend/test/runner-bug.test.mjs` 钉「抛 TypeError」这一判据。
 *   ㉗ **`db.insertTask` 的字段袋是 camelCase**（`autoFix` / `stopType` / `stopValue` /
 *      `taskType`：db.js 既有形态），与 `updateTask` 的 **snake_case 列名袋**不同；
 *      `_maybe_auto_retest` 照 db.js 的口调用（Python 同名关键字参数两侧同序）。
 *   ㉘ **`_process_card` 的 board 走函数内 `await import('./board.js')`**：board.js
 *      模块级 import runner.js ⇒ 静态 import 成环；Python 用函数内 `import board` 防循环，
 *      Node 的等价物即函数内动态 import——**位置也照 Python**（在卡片/项目两道校验
 *      之后，三条 `return None` 分支因此不触发 board 加载）。
 *   ㉙ **本族解释器口径（M6.5 冻结契约，R2 落地）**：用户夹具脚本（`verify.py`、方案包
 *      `run.py`）是 agent 按协议生成的 **Python** ⇒ `runOneScript` 与 `loadCmd` 的脚本驱动支
 *      两侧都跑 python3：A 侧 `sys.executable`、B 侧 `whichSync('python3')`（**运行期解析一次
 *      并缓存**；解析不到抛具名 `PythonInterpreterMissing`——**绝不回落 `'python3'` 字面量、
 *      绝不抛空**）。`loadCmd` 的**场景驱动**支是平台自己的引擎：A 侧
 *      `[sys.executable, <repo>/loadgen.py, 'run', …]`、B 侧
 *      `[process.execPath, <repo>/backend/lib/loadgen.js, 'run', …]` ⇒ 两侧 argv[0]/argv[1]
 *      是「本族解释器 + 本族入口」，**逐字节不可比是设计使然**（用例对这两个位置逐路径
 *      `ignore` 并写明理由），其余九处产物路径与参数逐字节比。`PYTHONPATH=ROOT_DIR` 两侧
 *      同值保留（用户 `run.py` 要 `import loadgen` 这个 Python 库）；M8 退役 Python 时重审。
 *   ㉚ **`_script_live` 的全关键字形参 → 一个 `opts` 袋**：Python
 *      `def _script_live(self, project, *, phase=None, current=None, event=None, stats=None,
 *      label="脚本复测")`；Node `scriptLive(project, opts = {})`（键名与 Python 同名、`label`
 *      缺省同值）。两处 `if x:` 的**真值判定照 Python**：`stats`/`event` 走 `rag.pyTruthy`
 *      （JS 的 `{}` 是真值、Python 的假值 ⇒ 不写这条就会多写一笔 stats/events）、`current`
 *      用 `is not None`（`{}` 照写）。**非对象形状照 Python 抛**：live.json 顶层非对象
 *      （Python `list["k"]=…`/`None[...]` 抛 TypeError，**不在** `except (OSError, ValueError)`
 *      里）、`stats` 非对象、`events` 非列表，Node 各抛 TypeError（错误类型名/文案不同属既有
 *      口径，同⑧/㉒）。
 *   ㉛ **`_next_load_round_no`（@classmethod）/ `_load_cmd` 与 `_write_load_report`
 *      （@staticmethod）在 Node 一律写成实例方法**：① 收末位 options 袋；② **对拍可达性的
 *      硬约束**——量具 `seq` 只能经**实例**取方法（static 挂在构造函数上、**不沿原型链**，
 *      `inst[fn]` 取不到）⇒ 写成 static 就对拍不可达。`nextLoadRoundNo` 读
 *      `Runner.LOAD_ROUND_NO`（对应 `cls.LOAD_ROUND_NO`）；三个函数体都不读 `this`，
 *      语义逐点照 Python。（同⑰的处置。）
 *   ㉜ **`_spawn_load` 的三处形态映射**：`stderr=subprocess.STDOUT` → `stdio: ['ignore', fd, fd]`
 *      （同一个 `openSync(logPath,'a')` 的 fd 传两次，spawn 后父进程立即 `closeSync`）；
 *      `start_new_session=True` → `proc.spawnSession` 的 `detached: true`；`Popen` 的
 *      **同步 OSError** → `spawnSession` 后等 `'spawn'/'error'` 事件（`waitSpawned`）——
 *      Node 的启动失败是**异步**的，不等就等于把「解释器/脚本不存在」误判成「进程在跑」。
 *      停止/超时两支调 `killTree(proc.pid, {sig:'SIGTERM'})`（口径差异与实测见⑥）。
 *   ㉝ **`_wait_killed(proc, timeout=5)` 的单位与子进程错误形状**：Python 的 `timeout` 是**秒**
 *      ⇒ Node 形参 `timeoutMs = 5000`（毫秒，名字即单位；对拍只经 `spawnLoad` 间接覆盖）。
 *      子进程两族的异常逐条对应、**不合并不互相兜底**：`TimeoutExpired` ↔ 私有
 *      `ScriptTimeout`（带已收输出，照 `e.stdout/e.stderr`）、`OSError` ↔ 私有
 *      `ScriptSpawnError`（Node 的 `'error'` 事件）。`subprocess.run(timeout=…)` 超时后
 *      `process.kill()`（POSIX=SIGKILL）再收尾输出 ↔ Node `child.kill('SIGKILL')` + 等
 *      `'close'` 拿全量输出。被信号杀死：Python `returncode=-signum`、Node `'exit'` 给
 *      `(null,'SIGTERM')` ⇒ 私有 `exitCodeOf` 按 `os.constants.signals` 映射回 `-15` 这类值
 *      （对拍实测：宽限到期支两侧都 `-15`）。**错误文案不复刻**（`### 脚本启动失败: …` 里
 *      Python 是 `[Errno 2] No such file or directory: …`、Node 是 `spawn … ENOENT`）；
 *      该支已进对拍（返回值 `[1, execution_<戳>_script.md]` 相等、记录写不进去），文案差登记。
 *   ㉞ **`ThreadPoolExecutor(4)` + `as_completed` → 私有 `createCompletionPool(limit)`**：
 *      有界并发、**完成序**产出；消费方提前退出后 `drain()` = `shutdown(wait=True,
 *      cancel_futures=True)`（排队未启动的取消、已启动的等收口）；任务异常按 `Future.result()`
 *      口径在 `next()` **原样外抛**（不吞、不降级）。完成序是**可见行为**（`results` →
 *      `failed_ids` → payload.only_cases 与轮次日志/事件序），故用例夹具的 `verify.py` 耗时
 *      必须彼此分开（对拍实测：`only_cases` 顺序两侧逐字节同，未用任何归一器抹平顺序）。
 *   ㉟ **`tailText` 的落地路径**：`_finish_load` 要 `_tail_text`（发压失败原因摘要），而它属
 *      R3 的「日志/读侧」族 ⇒ R2 先落一份同名同语义的**私有**实现（同⑭的处置）。
 *      **M6.5-R3 已转为正式导出**（`_tail_text` 的 Node 名），切片按**码点**（同㉔）。
 *   ㊱ **`_run_one_script` 的并发阈值走实例属性**：Python 读 `self.SCRIPT_RETEST_TIMEOUT` /
 *      `self.SCRIPT_WORKERS`（类属性）⇒ Node 在构造器把它们**镜像到实例属性**（JS 的 static
 *      字段**不沿原型链**，`this.X` 取不到），方法体读 `this.SCRIPT_*`：单测因此可给实例覆写
 *      一个极小超时来钉超时支（对拍注入不了——A 侧类属性只能由用例之外的代码改）。
 *
 * ── M6.5-R3（轮次族 + 日志/读侧族）新增差异 ──────────────────────────────────────────
 *   ㊲ **退场族守卫抛同名 `RuntimeError`**：Python `raise RuntimeError(RETIRED_MSG)`；Node 借
 *      `prompts.js` 已导出的 `RuntimeError`（`constructor.name` = `RuntimeError`）同抛。
 *      用同名类不是洁癖：对拍 `seq` 的失败步会逐字比 `kind`（探针取 `type(exc).__name__`、
 *      worker 取 `constructor.name`），裸 `Error` 会造出一条只能靠白名单盖住的永久差异。
 *   ㊳ **轮次族是 async**：`dshdriver` 全族（`available`/`ensureSession`/`status`/`prompt`）与
 *      `prompts.first_round_prompt` 在 Node 侧都是 Promise（M2/M6-4 的既有形态差异）⇒
 *      `runRound` / `runRoundDshplugin` / `waitTurnEndDsh` 与**模块级** `buildPrompt` 一律 async
 *      （`buildPrompt` 是 Promise 这一点是 R1 就登记的契约：`runRoundDshplugin` 必须 await 它，
 *      否则写进 `### PROMPT` 行的是 `[object Promise]`）。
 *   ㊴ **`threading.Thread` → async 任务**：Python 起 `_dsh_stream_worker` 线程再
 *      `join(timeout=5)`；Node 起一个 async 任务存 promise，`finally` 里置停止标志
 *      （`stream_stop.set()` ↔ `streamStop.aborted = true`，**在 `dshStreamWorker` 边界归一成
 *      函数探针**再交给驱动）后 `await Promise.race([task, 5s 定时器])`（定时器 `unref`，同差异④
 *      的「在等活」口径）。**该任务的 rejection 只打一行 `[runner] …`**（`.catch`）：Python 线程内
 *      异常只打 traceback，绝不该带崩主流程；`feedInto` 自身已把链路异常转成 `waiter.fail()`。
 *
 *      R3 在此抓到一个**驱动侧真缺陷并已修**（记录：M6.5 记录 §三「真问题②」）：`dshdriver.js`
 *      的 `consumeEvents` 曾用与 `stopProbe` **同一条松判据**（`typeof stop.aborted === 'boolean'`）
 *      认定 AbortSignal，于是普通 `{aborted:false}` 对象被塞进 `fetch(..., {signal})`，整轮以
 *      `### 事件流异常: signal.addEventListener is not a function` 收口。现驱动侧新增
 *      `isAbortSignal()`（要求 `addEventListener` 是函数）区分「停止探针」与「真 AbortSignal」，
 *      两条形态都可传；runner 侧的「归一成函数」保留为**防御性写法**（不依赖驱动的鸭子判据）。
 *   ㊵ **`dshStreamWorker` 跳过 `null` 行**：Python 是 `append_log(log_path, None)` ⇒
 *      `None.encode` 抛 `AttributeError`（**不在** `except OSError` 里）⇒ 冒泡到
 *      `dshdriver.feed_into.handle` 的 `except Exception: pass`，**一个字节都不写**。
 *      Node 的 `appendLog` 走 `String(text)`，直接传 `null` 会写出字面量 `"null"` ⇒ 这里显式
 *      跳过 `null`，落盘字节与 Python 同效（`dshEventToLogLine` 的 `null`/`''` 语义保持分明）。
 *   ㊶ **Python 语义小工具（本文件私有）**：`pyGet`（`d.get`，非 dict 抛 `AttributeError`）、
 *      `pyGetItem`（`d[k]`，缺键抛 `KeyError`）、`pyStr`（`str(x)`：`None`→`"None"`、
 *      `True`→`"True"`）、`pyInt`（`int(x)`：bool→0/1、有限数字截断、字符串按十进制，
 *      失败抛 `ValueError`、非有限浮点抛 `OverflowError`）、`pyTypeName`/`pyReprString`。
 *      `AttributeError`/`KeyError`/`ValueError`/`OverflowError` **复用 `rag.js` 的同名类**
 *      （`constructor.name` 与 Python `type(exc).__name__` 逐字相同 ⇒ 对拍 `kind` 可比）。
 *      **不是**「顺手防御」：这五条正是「Python 会抛的地方 Node 也要抛」的落点——
 *      `readLiveSummary` 的顶层非对象、`summaryEntryText` 的缺 `kind`、`dshEventToLogLine`
 *      的非 dict 帧都**照抛**（各自对应 Python 未进 `except` 元组的那类异常）。
 *   ㊷ **`DSH_TURN_START_GRACE` 镜像到实例属性**：Python 在 `_wait_turn_end_dsh` 里读模块全局
 *      （`runner.DSH_TURN_START_GRACE`，单测可 monkeypatch）；Node 的 ESM 导出绑定外部不可写
 *      ⇒ 构造器镜像一份、方法体读 `this.DSH_TURN_START_GRACE`（同㊱的 `SCRIPT_*` 处置）。
 *      行为零差异（默认同值 120.0），目的是让单测能钉「turn 未启动」支而不用真等 120s。
 *   ㊸ **`dshEventToLogLine` 用 `null` 表示「无需落盘」**（照 Python `None`）：`turn/end`、
 *      `user/message`、`agent/status`、未知类型、以及「只有工具调用无文本」的 assistant 事件
 *      都返回 `null`——**不是空串**，`''` 与 `null` 在调用方（差异㊵）与对拍判据里含义不同。
 *   ㊹ **两处读侧切片/编码口径的修正与统一**：① `readLogTail` 的 `limit` 照 Python
 *      `readlines()[-limit:]`（`0` ⇒ 全文、负数 ⇒ 丢开头 |limit| 行）——私有前身写的
 *      `slice(max(0, len - limit))` 在 `limit<=0` 时返回空串（调用面全用正数故未暴露）；
 *      ② 读文件改走 `readText`（universal newlines 归一 `\r\n`/`\r` → `\n`，照 Python 文本模式）
 *      并保留 `errors="replace"` 的 U+FFFD 容错。
 *
 * 零 npm 依赖：只用 `node:` 内建模块 + 本仓库内模块。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RETIRED_FAMILY, RETIRED_MSG, agentFamily, whichSync } from './agents.js';
import * as chat from './chat.js';
import {
  deleteRounds,
  finishRound,
  getBoardCard,
  getProject,
  getTask,
  insertTask,
  insertRound,
  listAllTasks,
  listRounds,
  listTasks,
  nowStr,
  rowOpt,
  updateTask,
  withReadDb,
  withWriteDb,
} from './db.js';
import { sessionEffort } from './dshevents.js';
import {
  DshDriverError,
  TurnWaiter,
  applySessionDefaults,
  available as driverAvailable,
  cancel as driverCancel,
  ensureSession,
  feedInto,
  prompt as driverPrompt,
  splitModel,
  status as driverStatus,
} from './dshdriver.js';
import { matchLevel, scanCases } from './export-cases.js';
import * as loadcase from './loadcase.js';
import { strftime_local as strftime } from './loadgen.js';
import {
  PY_WS,
  VERIFY_SCRIPT_NAME,
  bugCases,
  bugCasesScripted,
  casesAllPassed,
  ensureGitignore,
  ensureRuntimeDirs,
  findCaseDirs,
  gitLogChanges,
  isDir,
  isFile,
  markCasesRetest,
  pyIntOr,
  pyIsDigits,
  pyJoin,
  pySorted,
  readText,
  runtimeDir,
  setMdField,
} from './lib.js';
import { killTree, spawnSession } from './proc.js';
import * as prompts from './prompts.js';
import { pyJsonDumps, pyJsonDumpsIndent } from './pyjson.js';
import { AttributeError, KeyError, OverflowError, ValueError } from './rag.js';
import * as rag from './rag.js';
import * as sessparse from './sessparse.js';
import { DIALOGUE_RAW_LIMIT, DIALOGUE_TEXT_LIMIT } from './taskjson.js';
import * as waitq from './waitq.js';
import {
  KIND_TASK, activeExt, activeItems, getActive, memberKey, STATE_WAITING,
} from './waitq.js';

/** 运行期机器产物目录名（`runner.LOG_DIR_NAME`；`.web` 下放轮次/对话/看板日志） */
export const LOG_DIR_NAME = '.web';

/**
 * 追加文本到日志（二进制写入，utf-8）。`runner.append_log`（runner.py:2171）直译：
 * **任何写失败都吞掉**——日志不是业务，写不进去不该把一轮任务带崩。
 *
 * `errors="replace"` 对应 Node 的 `Buffer.from(str, 'utf8')`：Node 字符串本就合法 UTF-16，
 * 编码时孤立代理项落成 U+FFFD，与 Python replace 口径一致。空路径直接返回（Python 侧
 * `open("")` 抛 OSError 被吞，等价）。
 *
 * @param {string} logPath
 * @param {string} text
 */
export function appendLog(logPath, text) {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, Buffer.from(String(text), 'utf8'));
  } catch { /* 路径空/不可写：静默（与 Python 同） */ }
}

/** parallel 模式队首责任区长度（`Runner.PARALLEL_PREFIX_N`；serial 恒 1，t: 恒 1） */
export const PARALLEL_PREFIX_N = 5;

/** 队列键前缀 → 等待项 kind（`runner._KIND_OF_KEY`；**有意不含 ext**——外部条目永不被拾取） */
export const KIND_OF_KEY = Object.freeze({
  t: 'task', c: 'card', m: 'msg', a: 'answer',
});
/** kind → 队列键前缀（`runner._KEY_PREFIX`） */
export const KEY_PREFIX = Object.freeze({
  task: 't', card: 'c', msg: 'm', answer: 'a',
});

// --------------------------------------------------------------------------
// 窗口几何（runner.py:136-164 的唯一出处 `_prefix_window_blocked` 的 Node 形）
// --------------------------------------------------------------------------

/**
 * 调度口径运行前缀成员键集（`Runner._prefix_members`，v3a R5①）：
 * `Map<project_id, Set<队列键>>` = state ∈ PREFIX_STATES（starting/running）行的队列键。
 *
 * 成员**只由行构成、唯一来源（R1）**；`finishing` 行不计（收尾窗口不再占补位名额，
 * 位次口径另含 finishing，见裁决 R7）；ext 行入场即 running，天然落入本集合。
 *
 * @param {object[]} rows 已取到的活跃行清单（调用方传，免二次全表读）
 * @returns {Map<number, Set<string>>}
 */
export function prefixMembers(rows) {
  const members = new Map();
  for (const row of rows) {
    if (row.state !== 'starting' && row.state !== 'running') continue;
    if (!members.has(row.project_id)) members.set(row.project_id, new Set());
    members.get(row.project_id).add(memberKey(row.kind, row.target_id));
  }
  return members;
}

/**
 * 运行前缀窗口闸**唯一出处**（`runner._prefix_window_blocked`，v3a R1）：
 * 前缀键集 `keys` 扣除**本单元自己的键** `key` 与折抵键 `exempt` 后 ≥ N ⇒ 留队（true）。
 *
 * 逐点照抄的三条：
 *   - `keys` = 行口径前缀成员键集；`n` = 候选单元的窗口 N；
 *   - **t: 键在场时 N 收 1**（任务串行红线）——a:/c:/m: 候选中任一前缀含 `t:` 即窗口 1；
 *   - `key = null` 表示「不排除任何键」（项目整窗读口用）。
 *
 * `a:` 候选的折抵（`exempt`）由调用方给（`_answer_exempt_keys_locked` 的等价物）；
 * `ext:` 键**不折抵**（2026-09-28 #610 收敛：外部会话同样压答案投递）。
 *
 * 纯函数（不碰连接、不读进程内状态），故对拍可直接调。
 *
 * @param {Set<string>} keys
 * @param {string|null} key 本单元自己的键（null = 不排除）
 * @param {string} kind 本单元 kind
 * @param {number} n
 * @param {Iterable<string>} [exempt]
 * @returns {boolean}
 */
export function prefixWindowBlocked(keys, key, kind, n, exempt = []) {
  let limit = n;
  const others = new Set(keys);
  if (key !== null && key !== undefined) others.delete(key);
  if (kind !== KIND_TASK) {
    for (const k of others) {
      if (k.startsWith('t:')) { limit = 1; break; }
    }
  }
  if (kind === 'answer') {
    for (const k of exempt) others.delete(k);
  }
  return others.size >= limit;
}

/**
 * 补位窗口 N（`Runner._window_n`，裁决 R5③）：`t:` 单元恒 1；看板卡单元族
 * c:/m:/a: 按项目模式 parallel → `PARALLEL_PREFIX_N`、serial → 1。
 *
 * mode 读取锚点 = `board.settings_of`（读取层已把未知/缺省值归一为 serial）。
 * **本函数就是那个锚点的内联实现**（不 import board，理由见文件头差异②）：
 * `board_settings.json` 坏 JSON / 非对象 ⇒ `{}` ⇒ mode 取默认 `serial`（与
 * `board.settings_of` 的「只认 mode 键 + 白名单归一」逐点等价）。
 *
 * @param {string} kind
 * @param {number} projectId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接
 * @returns {number}
 */
export function windowN(kind, projectId, options = {}) {
  if (kind === KIND_TASK) return 1;
  let settings = {};
  if (projectId) {
    const row = withReadDb(options, (handle) => handle
      .prepare('SELECT json FROM board_settings WHERE project_id=?').get(projectId));
    if (row !== undefined) {
      try {
        const parsed = JSON.parse(row.json);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          settings = parsed;
        }
      } catch {
        settings = {};                   // 坏 JSON 降级（同 db.get_board_settings）
      }
    }
  }
  // MODE_VALUES = ("serial", "parallel")；未知/缺省一律 serial（读取层归一）
  return settings.mode === 'parallel' ? PARALLEL_PREFIX_N : 1;
}

// --------------------------------------------------------------------------
// 两个只读口
// --------------------------------------------------------------------------

/**
 * 项目当前是否忙 = 新单元必须留队（**与 `_pick_locked` 放行口径一致**）。
 *
 * - 前缀窗口已满（serial ≡「任一前缀行即忙」；parallel N=5）；
 * - 项目存在活跃 `ext:` 行（外部会话在跑）——**与 N 无关**：parallel 下一条 ext 行
 *   也挡全部平台单元。
 *
 * 动因（照 Python docstring）：`unit_busy` 是提交时「本单元会不会排队」的展示判据
 * （`chat.submit` 的 queued 字段 / 会话 meta 的 project_busy），必须与调度侧的真实
 * 放行结论一致，否则 parallel 项目会显示「不排队」而实际留队。
 *
 * @param {number} projectId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接
 * @returns {boolean}
 */
export function unitBusy(projectId, options = {}) {
  if (!projectId) return false;
  const rows = activeItems(projectId, options);
  const keys = prefixMembers(rows).get(projectId) || new Set();
  if (prefixWindowBlocked(keys, null, 'card', windowN('card', projectId, options))) {
    return true;
  }
  return activeExt(projectId, options);
}

/**
 * 单元在统一队列中的态（会话详情页标题「队列」徽标的数据源；只读）。
 *
 * 返回 `{state:'running'|'queued'|'idle', pos, total}`（**键名与 Python 逐字同**，
 * 它直接进 JSON 响应）：
 *   - `running`：本单元有**运行中行**在场（活跃非等待行——waiting 即排队）——
 *     t:/m: 拾取即置 starting 跨整轮、c: 起跑证实后跨轮 running、a: 送达期瞬态；
 *     行不在场（未入队/已终态/键失效）按 idle；
 *   - `queued`：等待项表里仍有本单元的 waiting 行（表驱动，R2）；**v2a T4 起位次含
 *     运行前缀**：`pos` = 前缀成员数（项目内 starting/running/finishing 行）+
 *     waiting 行中 seq 更小者 + 1（1 基，即"本项目前面还有几个"），`total` = 项目成员
 *     总数（行）。他项目单元不计入位次——同项目串行才是"前面还有几个"的实际约束；
 *   - `idle`：表中数不到本单元的活跃行（未入队/已终态/键失效）。
 *
 * 逐点保留的两个细节（照 Python）：
 *   ① 运行分支的**项目比对是防御**：行在他项目（调用方传参漂移）按空闲返回，
 *      比报运行中安全；
 *   ② 位次分支里 `ahead` 的累加条件是「尚未遇到本行 ∧ 该键不在前缀里」——**同键的
 *      前方 waiting 行不重复计位**（前缀键集是集合，同单元多行只计一次前缀）。
 *
 * @param {string} key 队列键（`t:<id>` / `c:<id>` / `m:<id>` / `a:<id>`）
 * @param {number} projectId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 读连接
 * @returns {{state: string, pos: number, total: number}}
 */
export function unitState(key, projectId, options = {}) {
  const idle = { state: 'idle', pos: 0, total: 0 };
  const text = String(key === null || key === undefined ? '' : key);
  const kind = KIND_OF_KEY[text.charAt(0)];
  if (kind !== undefined && projectId) {
    // running = 本单元有运行中行（v3d 行口径）：活跃非等待即运行上报
    const row = getActive(kind, text.slice(2), options);
    if (row !== null && row.project_id === projectId && row.state !== STATE_WAITING) {
      return { state: 'running', pos: 0, total: 0 };
    }
  }
  if (kind === undefined || !projectId) return idle;
  const prefixKeys = new Set();
  const totalKeys = new Set();
  const waiting = [];                    // [成员键, 行]，seq 升序
  for (const row of activeItems(projectId, options)) {
    const rk = memberKey(row.kind, row.target_id);
    totalKeys.add(rk);
    if (row.state === STATE_WAITING) waiting.push([rk, row]);
    else prefixKeys.add(rk);             // starting/running/finishing：位次前缀（R7 全计）
  }
  let mine = false;
  let ahead = 0;
  for (const [rk, row] of waiting) {
    if (row.kind === kind && String(row.target_id) === text.slice(2)) {
      mine = true;                       // 本单元 waiting 行（活跃唯一索引保证唯一）
    } else if (!mine && !prefixKeys.has(rk)) {
      ahead += 1;                        // waiting 且 seq 更小者（升序遍历即排在前面）
    }
  }
  if (!mine) return idle;                // 表中数不到（行已终态/取消）：按空闲
  return {
    state: 'queued',
    pos: prefixKeys.size + ahead + 1,
    total: totalKeys.size,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// M4：调度内核（runner.py 模块级 helper 84-186 + Runner 类 188-1160 + 2379-2482）
// ══════════════════════════════════════════════════════════════════════════

// --------------------------------------------------------------------------
// 常量（runner.py:239-240、196-207）
// --------------------------------------------------------------------------

/** 等待项周期自检间隔（秒，`SELFCHECK_INTERVAL`；run_int 自检线程节拍） */
export const SELFCHECK_INTERVAL = 60.0;
/**
 * 行年龄豁免（秒，`SELFCHECK_MIN_AGE`）：拾取/建行 → 行置 running/证据落行的毫秒窗——
 * 年轻行自检不处置不告警，防误杀新生行。
 */
export const SELFCHECK_MIN_AGE = 15.0;

/** worker 无活可拾时的等待上限（毫秒；Python `self._cond.wait(timeout=5)` 的 5s 节拍） */
export const WAIT_TICK_MS = 5000;

/** `Runner.WORKERS`：同时在跑的单元数上限（= 循环数） */
export const WORKERS = 6;
/** `Runner.LOAD_ROUND_NO`：压测任务首次发压的轮次号（第 1 轮 agent 出方案包） */
export const LOAD_ROUND_NO = 2;

// --------------------------------------------------------------------------
// M6.5-R2：脚本复测族 + 压测发压族的模块级常量（runner.py:53-60、1519-1520）
// --------------------------------------------------------------------------

/** `Runner.SCRIPT_RETEST_TIMEOUT`：单脚本执行超时（秒；脚本只做单用例「调用+断言」） */
export const SCRIPT_RETEST_TIMEOUT = 120;
/** `Runner.SCRIPT_WORKERS`：脚本复测并发数（`ThreadPoolExecutor(4)`） */
export const SCRIPT_WORKERS = 4;
/**
 * 发压硬上限（秒，`LOAD_MAX_SECONDS`；runner.py:57）：超过即杀进程树并按失败收尾。
 * 「脚本驱动为任意代码，平台只做超时上限 + 停止宽限 + 杀进程树 + 输出回收四件事」。
 */
export const LOAD_MAX_SECONDS = 7200;
/** 用户停止后给脚本的优雅收尾宽限（秒，`LOAD_STOP_GRACE`） */
export const LOAD_STOP_GRACE = 10.0;
/** 发压进程轮询间隔（秒，`LOAD_POLL_INTERVAL`）：等退出 + 查停止请求 */
export const LOAD_POLL_INTERVAL = 0.5;
/**
 * 项目根（`runner.ROOT_DIR` = `os.path.dirname(os.path.abspath(__file__))` 的对应物）：
 * 脚本驱动的 `PYTHONPATH` 注入点（脚本可 `import loadgen`）与场景驱动入口
 * `<repo>/loadgen.py` 的所在目录。与 `db.js` 的 `REPO_ROOT` 同值（各自算，不互相 import）。
 */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `### PID <n>` 平台进度标记（`PID_MARK_RE`）：`_kill_residual` 从轮次日志尾找残留进程 */
const PID_MARK_RE = /### PID (\d+)/g;

// --------------------------------------------------------------------------
// M6.5-R3：轮次族 + 日志/读侧族的模块级常量（runner.py:44、62、2255-2260）
// --------------------------------------------------------------------------

/**
 * dsh 插件族（路线 A）轮次参数：turn 启动宽限（秒，`DSH_TURN_START_GRACE`，runner.py:62）——
 * followup 后 turn/start 由 agent loop 立刻 append，超过该宽限仍无事件即视为链路/宿主异常，
 * 收口本轮。
 *
 * 访问路径的形态差异（见文件头差异㊷）：Python 在 `_wait_turn_end_dsh` 里读**模块全局**，
 * Node 侧镜像到实例属性（`this.DSH_TURN_START_GRACE`）供单测钉「turn 未启动」支。
 */
export const DSH_TURN_START_GRACE = 120.0;

/**
 * `session.resume_hint` 的 session_id 提取正则（`SESSION_HINT_RE`，runner.py:44）。
 * `\s` 用 `PY_WS`（Python `str` 正则的 Unicode 空白表，见文件头差异㉓）；**非全局**，
 * 照 Python 的 `re.compile` 口径（`parseSessionHint` 内部另建全局副本做 `findall`）。
 */
export const SESSION_HINT_RE = new RegExp(`"session_id"${PY_WS}*:${PY_WS}*"([^"]+)"`);

/**
 * 对话条目的两个长度上限（`runner.DIALOGUE_TEXT_LIMIT` / `DIALOGUE_RAW_LIMIT`，
 * runner.py:2255-2260）：工具结果/助手摘要单条最大码点数 6000，JSON 内容直接截断时保留 1200。
 *
 * **从 `taskjson.js` 再导出**（M6 的 `read_dialogue` 已落这两个常量，值同）：不定义第二份
 * 同值常量——两处一旦分叉，`read_dialogue` 的截断与 `summary_entry_text` 的截断就会静默不一致。
 */
export { DIALOGUE_RAW_LIMIT, DIALOGUE_TEXT_LIMIT };

// --------------------------------------------------------------------------
// M6.5-R1：入口本体与 bug/复测联动的模块级常量（runner.py:51-77）
// --------------------------------------------------------------------------

/**
 * 生命周期阶段有序 key（`runner.STAGES`，runner.py:64）：与 `server.STAGES` / 前端 STAGES
 * 一致；**防循环依赖不 import server**（见文件头差异⑳）。`_apply_bug_result` 的 pipeline
 * 分支按它比较「终点是否含复测阶段」。
 */
export const STAGES = Object.freeze(
  ['gen_case', 'execute', 'report', 'analyze', 'fix', 'deploy', 'retest'],
);

/**
 * `bug_report` 目录名时间戳前缀正则（`BUG_DIR_RE`，runner.py:51；与 server.py 一致），
 * 匹配组为标题。`_pipeline_bugs` 用它过滤目录名、`_maybe_auto_retest` 用它取任务标题。
 * `\d` 按 ASCII、`$` 不补末尾换行（见文件头差异㉓）。
 */
const BUG_DIR_RE = /^\d{8}_\d{4}_(.+)$/;

/**
 * 日期范围复测：agent 输出固定行「受影响用例：FS0001、FS0002」（行后 200 字符内取 id）。
 * `\s` 用 `PY_WS`（Python `str` 正则的 Unicode 空白表）、`[^\n]` 同 Python（见差异㉓）。
 */
export const AFFECTED_LINE_RE = new RegExp(`受影响用例[：:]${PY_WS}*([^\\n]{0,200})`);

/**
 * 从文本提取「受影响用例：…」行中的用例 id（`_extract_affected_ids`，runner.py:69）：
 * 去重排序（`sorted(set(...))` 的码点序）；命中行前 12 个**码点**里含「无」即判无。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractAffectedIds(text) {
  const m = AFFECTED_LINE_RE.exec(text == null ? '' : String(text));
  if (m === null) return [];
  const line = m[1];
  // `line[:12]` 按码点切（见差异㉔）：`[...str]` 逐码点展开，代理对不被劈开
  if ([...line].slice(0, 12).join('').includes('无')) return [];
  return pySorted(new Set(line.match(/FS\d{4}/g) || []));
}

/** `_extract_affected_ids` 的 Python 名别名（照 board.js `_dequeue_start` 的既有形态） */
export const _extract_affected_ids = extractAffectedIds;

/**
 * `json.loads(payload or "{}")` 的**对象版**（见文件头差异⑮①㉑）：坏 JSON / 非对象一律 `{}`。
 * Python 侧非对象会在 `.get(...)` 处抛 `AttributeError` 打死 worker 线程——Node 按「无前段」
 * 处理（与 `answerRowSid` / `payloadParentId` 同姿态）。
 *
 * @param {unknown} payload
 * @returns {Record<string, any>}
 */
function payloadObject(payload) {
  let parsed;
  try {
    parsed = JSON.parse(payload || '{}');
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed;
}

/**
 * `STAGES.index(stage)` 的等价物（见文件头差异㉒）：缺项**抛错**（Python `tuple.index` 的
 * `ValueError`），绝不静默返回 -1——那是「静默降级」（`_apply_bug_result` 的 pipeline 分支
 * 靠这次抛出把该轮打成失败）。
 *
 * @param {string} stage
 * @returns {number}
 */
function stageIndex(stage) {
  const idx = STAGES.indexOf(stage);
  if (idx < 0) throw new RangeError(`'${stage}' is not in tuple`);
  return idx;
}

// --------------------------------------------------------------------------
// 缝（注入点；默认行为逐条见文件头「缝」）
// --------------------------------------------------------------------------

/**
 * 三个单元执行体的**未接线文案**（按到期里程碑点名）。`_worker` 分派到未接线的口时抛
 * `UnitHandlerMissing`，message = `「<本表文案>：<键> 无法执行」`。
 */
export const UNIT_HANDLER_MISSING = Object.freeze({
  task: '任务单元轮次执行体未移植（M6）',
  card: '卡片单元起跑体未移植（M5）',
  // 2026-10-16：实现体 M5 就在 `board.deliverAnswerUnit`，缺的只是 server.js 的注册
  // ⇒ 文案改成「未接线」（原「未移植」在真机上把人指向了错的排查方向）。
  answer: '答案送达体未接线（setUnitHandlers 缺 deliverAnswerUnit）',
});

/** 单元执行体未接线（`setUnitHandlers` 的缺口）：具名错误，调用方可 `instanceof` 判定 */
export class UnitHandlerMissing extends Error {
  /** @param {string} message 中文文案（点明到期里程碑 + 队列键） */
  constructor(message) {
    super(message);
    this.name = 'UnitHandlerMissing';
  }
}

/**
 * `a:` 执行体**异常兜底**放回时的退避秒数（见文件头差异⑫②）。
 *
 * 为什么是 30.0：与业务退避 `board.ANSWER_BACKOFF_S`（`_answer_retry_or_fail`）同档——
 * 「送达失败等一会儿再投」在两侧是同一个语义；**不 import board**（模块级 import 会成环，
 * 见文件头差异㉘），故此处独立定义并在单测里钉住「放回后当轮不可再拾取」。
 */
export const ANSWER_EXC_BACKOFF_S = 30.0;

/** 单元执行体注册表（`setUnitHandlers` 唯一写点；全 null = 未接线） */
let UNIT_HANDLERS = Object.freeze({
  processTask: null, processCard: null, deliverAnswerUnit: null,
});

/**
 * 注册三个单元执行体（M4 缝；**整组替换**，与 `chat.setBoardBridge` 同款语义）：
 *
 *   - `processTask(taskId)`：对应 `Runner._process_task`（**M6**：轮次循环/发压/复测）；
 *   - `processCard(cardId)`：对应 `Runner._process_card`（**M5**：卡片起跑体；返回
 *     `true`=起跑成功 / `false`=起会话失败 / `null`=卡片缺失或状态不符。**返回 `undefined`
 *     按 `null` 处理**——JS 里「没写 return」正是 Python `return None` 的等价物）；
 *   - `deliverAnswerUnit(cardId)`：对应 `board._deliver_answer_unit`（**M5**：作答送达）。
 *
 * 三个口可以是同步函数，也可以返回 promise（`runPickedUnit` 一律 await）。未接线的口被
 * 分派到时抛 `UnitHandlerMissing`——**绝不静默成功**；异常落点照 Python 的 except/finally
 * 分支收口（t:/c: 行落终态、a: 行放回 waiting）。
 *
 * ⚠ `a:` 口未接线时该单元会「放回 waiting → 立即被重拾 → 再抛」热旋（Python 同形：其
 * `board._deliver_answer_unit` 正常不抛）——运行日志里能直接看到，接线后消失。
 * **2026-10-16（M10）`server.js` 已把三路口全部接真**（`a:` 那次是真机热旋被发现后补的：
 * 50% CPU + 日志 5.5KB/s）；本文件不校验接线态，接线判据在 `server-wiring.test.mjs`「接线④」。
 *
 * 只传一个口即把其余口置空；传 `{}` / `null` 全注销（回到未接线态）。
 *
 * @param {{processTask?: Function|null, processCard?: Function|null,
 *          deliverAnswerUnit?: Function|null}|null} [handlers]
 */
export function setUnitHandlers(handlers = {}) {
  const h = handlers || {};
  UNIT_HANDLERS = Object.freeze({
    processTask: typeof h.processTask === 'function' ? h.processTask : null,
    processCard: typeof h.processCard === 'function' ? h.processCard : null,
    deliverAnswerUnit: typeof h.deliverAnswerUnit === 'function' ? h.deliverAnswerUnit : null,
  });
}

/** 当前三个单元执行体的接线态（只读快照；单测/接线自检用） */
export function unitHandlers() {
  return { ...UNIT_HANDLERS };
}

/** `board.finish` 收尾口（M5 缝；单一注册位，后注册覆盖先注册） */
let BOARD_FINISH_HOOK = null;

/**
 * 注册 `board.finish(key, reason)` 等价口（**M5 接线**；`null` 注销）。
 *
 * 调用面只有 `runPickedUnit` 的 c: finally 两支「起跑失败回滚」（`card_ok === false` 或
 * `null`）——Python 那里是 `board.finish(key, "起跑失败回滚")`，属尽力而为的回滚收尾
 * （失败只打日志）。故未接线时**只打一行** `[runner] board.finish 未接线（M5）…`、不抛。
 *
 * @param {((key: string, reason: string) => any)|null} [fn]
 */
export function setBoardFinishHook(fn) {
  BOARD_FINISH_HOOK = typeof fn === 'function' ? fn : null;
}

/** 周期自检的 board 钩子（`board.unit_managed` 收口豁免判据 / `board.refresh_ext_rows` 对账） */
let BOARD_UNIT_MANAGED = null;
let BOARD_REFRESH_EXT_ROWS = null;

/**
 * 注册周期自检的两个 board 读钩子（**M5 接线**；缺省 `null`）：
 *
 *   - `unitManaged(row)` → boolean：`board.unit_managed`（平台在管 `_RUNS` 单元的收口豁免，
 *     自检不越权收口）；未接线传 null = 无豁免判据（照 Python 缺省）；
 *   - `refreshExtRows(reason)`：`board.refresh_ext_rows`（外部条目周期对账，收僵尸 ext 行）；
 *     未接线**跳过这一拍**（等价于 Python 里该调用抛异常后只打一行的那一支）。
 *
 * @param {{unitManaged?: Function|null, refreshExtRows?: Function|null}} [hooks]
 */
export function setBoardSelfcheckHooks(hooks = {}) {
  const h = hooks || {};
  BOARD_UNIT_MANAGED = typeof h.unitManaged === 'function' ? h.unitManaged : null;
  BOARD_REFRESH_EXT_ROWS = typeof h.refreshExtRows === 'function' ? h.refreshExtRows : null;
}

/** 任务失败旁路通知口（`feishu.task_failed`；**M7 接线**） */
let FAILURE_NOTIFIER = null;

/**
 * 注册任务失败通知口（**M7 接线**；`null` 注销）。
 *
 * 签名照 `feishu.task_failed(project_id, task_id, task_name, task_type, error, skipped_n=0)`：
 * `(projectId, taskId, taskName, taskType, error, skippedN) => any`（可返回 promise）。
 * 未接线时 `notifyTaskFailed` **静默返回**——照 Python `except: pass`「通知永不影响调度
 * 主流程」；任何异常同样被吞。
 *
 * @param {Function|null} [fn]
 */
export function setFailureNotifier(fn) {
  FAILURE_NOTIFIER = typeof fn === 'function' ? fn : null;
}

// --------------------------------------------------------------------------
// Waiter：`threading.Condition` 的 Node 对应物（只保留唤醒语义，见文件头差异②）
// --------------------------------------------------------------------------

/**
 * 等待/唤醒面（`self._cond` 的 Node 形态）：`notifyAll()` 唤醒**全部**等待者，
 * `wait(timeoutMs)` 返回 promise 且**超时也 resolve**（= Python `Condition.wait(timeout)`
 * 返回 False 的那一支；返回值本文件不使用）。
 *
 * 与 Python 的两处形态差异：
 *   - **没有锁**：Node 单事件循环下没有并发交错可保护（临界区 = 同一 tick 的同步段）；
 *   - **定时器 unref**：不让一个空转的等待吊住进程退出（= Python daemon 线程语义）。
 */
export class Waiter {
  constructor() {
    /** @type {Set<Function>} 当前等待者（resolve 回调） */
    this._waiters = new Set();
  }

  /** 唤醒全部等待者（Python `notify_all()`）。 */
  notifyAll() {
    const waiters = [...this._waiters];
    this._waiters.clear();
    for (const wake of waiters) wake();
  }

  /**
   * 等一次唤醒或超时（两者都 resolve；无返回值契约）。
   * @param {number} [timeoutMs] 0/负数 = 无限等（本文件恒传 5s 节拍）
   * @returns {Promise<void>}
   */
  wait(timeoutMs = 0) {
    return new Promise((resolve) => {
      let timer = null;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this._waiters.delete(finish);
        if (timer !== null) clearTimeout(timer);
        resolve();
      };
      this._waiters.add(finish);
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(finish, timeoutMs);                  // 保持 ref：见文件头差异④
      }
    });
  }

  /** 当前等待者个数（诊断/单测用） */
  get size() {
    return this._waiters.size;
  }
}

// --------------------------------------------------------------------------
// 模块级可写单例（Python `runner.INSTANCE`）
// --------------------------------------------------------------------------

/**
 * 模块级单例引用（`runner.INSTANCE`）：server 构造单例后经 `setInstance` 赋值，board 侧与
 * 本文件的自检/对账经此访问调度器（None 时 board 退化为直起路径、对账/自检直接 return）。
 *
 * **ESM 不能从外部写导出变量**（`runnerMod.INSTANCE = x` 会 TypeError，Python 侧是普通模块
 * 全局）⇒ 写口是 `setInstance(inst)`（见文件头差异⑧）。
 *
 * @type {Runner|null}
 */
export let INSTANCE = null;

/**
 * 写模块级单例（`runner.INSTANCE = inst` 的等价口）。传 `null` 拆离（单测还原：自检循环
 * 下一拍发现 INSTANCE 为 None 即自终）。
 * @param {Runner|null} inst
 */
export function setInstance(inst) {
  INSTANCE = inst === undefined ? null : inst;
}

// --------------------------------------------------------------------------
// 私有小工具（不导出；逐条见文件头差异⑬⑭⑯）
// --------------------------------------------------------------------------

/**
 * 异常 → 文本（照 Python `str(e)`）。`DshDriverError` 覆写了 `toString()`（纯消息）故走
 * `String()`；其余 `Error` 取 `message`（不把 `Error: ` 前缀带进用户可见文案）。
 * @param {unknown} err
 * @returns {string}
 */
function errText(err) {
  if (err === null || err === undefined) return String(err);
  if (err instanceof DshDriverError) return String(err);
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 本地时间戳文本（`YYYY-MM-DD HH:MM:SS`）→ epoch 秒；解析失败抛错。
 *
 * 等价于 `time.mktime(time.strptime(text, "%Y-%m-%d %H:%M:%S"))`（月/日/时/分/秒放宽到
 * 1-2 位，照 strptime 的非补零接受面）。waitq.js 有同口径私有实现 `parseLocalSeconds`
 * 但未导出，故这里保留一份私有前身（调用方一律 try/catch 并回落「当前时刻」）。
 *
 * @param {unknown} text
 * @returns {number} epoch 秒
 */
function localSeconds(text) {
  if (typeof text !== 'string') throw new TypeError('时间戳必须是字符串');
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/.exec(text);
  if (m === null) throw new RangeError(`时间戳格式不符: ${text}`);
  const ms = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6])).getTime();
  if (Number.isNaN(ms)) throw new RangeError(`时间戳不可解析: ${text}`);
  return ms / 1000;
}

/**
 * Python 类型名（只用于错误文案；`int`/`float` 在 JS 里已不可分，按是否整数猜）。
 * 与 `rag.js` / `prompts.js` 的同名私有实现同口径（各文件不互相 import 私有名）。
 * @param {unknown} value
 * @returns {string}
 */
function pyTypeName(value) {
  if (value === null || value === undefined) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  switch (typeof value) {
    case 'boolean': return 'bool';
    case 'number': return Number.isInteger(value) ? 'int' : 'float';
    case 'string': return 'str';
    case 'object': return 'dict';
    default: return typeof value;
  }
}

/** Python `repr(str)` 的可用子集（单引号，转义反斜杠与单引号）——只用于 `KeyError` 文案 */
function pyReprString(text) {
  return `'${String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Python `d.get(k[, default])`（见文件头差异㊶）：只有**键不存在**才给默认值（键在但为
 * `None` 仍返回 `None`）；**非 dict 抛 `AttributeError`**（`'list' object has no attribute 'get'`，
 * 照 Python 的 `except` 元组口径：这类异常在 Python 侧一样外抛）。
 *
 * @param {unknown} value
 * @param {string} key
 * @param {unknown} [fallback]
 * @returns {unknown}
 */
function pyGet(value, key, fallback = undefined) {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    throw new AttributeError(`'${pyTypeName(value)}' object has no attribute 'get'`);
  }
  return Object.hasOwn(value, key) ? value[key] : fallback;
}

/** Python `d[k]`（键不存在抛 `KeyError`，消息是键的 repr） */
function pyGetItem(value, key) {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`'${pyTypeName(value)}' object is not subscriptable`);
  }
  if (!Object.hasOwn(value, key)) throw new KeyError(pyReprString(key));
  return value[key];
}

/**
 * Python `str(x)`（本文件用到的子集：`None` → `"None"`、`True/False`、数字、字符串；
 * 容器走近似的 repr）。**不能用 `String(x)`**：`None`/`True` 会变成 `null`/`true`，
 * 那是与 Python 逐字节不可比的形态（见文件头差异㊶）。
 * @param {unknown} value
 * @returns {string}
 */
function pyStr(value) {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).map((k) => `${pyRepr(k)}: ${pyRepr(value[k])}`).join(', ')}}`;
  }
  throw new TypeError(`str() 不支持 ${typeof value}`);
}

/** Python `repr(x)` 的可用子集（str 走 repr 规则，其余用 `pyStr`） */
function pyRepr(value) {
  return typeof value === 'string' ? pyReprString(value) : pyStr(value);
}

/**
 * Python `int(x)`（见文件头差异㊶）：`bool` → 0/1、有限数字**向零截断**、字符串按十进制解析
 * （容两侧空白与正负号）；解析失败抛 `ValueError`、非有限浮点抛 `OverflowError`、
 * `None` 抛 `TypeError`——**三类都不吞**，由调用方按 Python 的 `except` 元组各自处置
 * （`_should_stop` 的 duration 支三条全吃、`_run_round_dshplugin` 的 stats 支只吃
 * `(ValueError, TypeError, KeyError)` ⇒ 溢出照 Python 外抛）。
 *
 * @param {unknown} value
 * @returns {number}
 */
function pyInt(value) {
  if (value === null || value === undefined) {
    throw new TypeError(`int() argument must be a string or a number, not '${pyTypeName(value)}'`);
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new OverflowError(`cannot convert float infinity to integer`);
    return Math.trunc(value);
  }
  const n = pyIntOr(value, null);
  if (n === null) {
    throw new ValueError(`invalid literal for int() with base 10: ${pyStr(value)}`);
  }
  return n;
}

/** 流任务收口等待上限（毫秒；Python `stream_thread.join(timeout=5)` 的 5 秒） */
const STREAM_JOIN_TIMEOUT_MS = 5000;

/** 「等 `ms` 毫秒」的定时器 promise（**unref**：它是兜底上限，不该让进程因它退不出去，见差异④） */
function joinTimeout(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * 读日志末尾 `limit` 行文本（`runner.read_log_tail`，runner.py:2340）。编码容错 = Node 的
 * utf8 解码（孤立字节落 U+FFFD，照 `errors="replace"`）；换行先经 `readText` 归一
 * （Python 文本模式是 universal newlines：`\r\n`/`\r` → `\n`）。
 *
 * `limit` 的切片语义照 Python `f.readlines()[-limit:]`：`limit>0` 取末尾 limit 行、
 * `limit=0` 取**全文**（`[-0:]` 即 `[0:]`）、`limit<0` **丢掉开头 |limit| 行**（`[|limit|:]`，
 * 超过行数则空串）。**R3 修正**：M4 起的私有前身写成 `slice(max(0, len - limit))`，
 * 对 `limit<=0` 会返回空串（`slice(len)`）——与 Python 差了「0 ⇒ 全文、负数 ⇒ 丢开头」
 * 两条；调用面（`_kill_residual` / `_tail_text`）都用正数故一直没暴露。见文件头差异㊹。
 *
 * @param {string} logPath
 * @param {number} [limit]
 * @returns {string}
 */
export function readLogTail(logPath, limit = 200) {
  if (!logPath || !isFile(logPath)) return '';
  const text = readText(logPath);                    // OSError → ''（Python 同）
  // Python `readlines()` 的等价切分：**每行保留自己的换行**（末行可能没有），
  // 故不能用 `split("\n")`（那会为结尾换行多造一个空元素，limit 小的时候结果不同）。
  const lines = text.match(/[^\n]*\n|[^\n]+/g) || [];
  // `limit === 0` 必须单独判：JS 里 `len - 0 === len` ⇒ `slice(len)` 会给出空串，
  // 而 Python `[-0:]` 就是 `[0:]`（全文）。
  let start;
  if (limit > 0) start = Math.max(0, lines.length - limit);
  else if (limit === 0) start = 0;
  else start = Math.min(-limit, lines.length);
  return lines.slice(start).join('');
}

/**
 * 活跃 `c:` 行在场判定（`board._card_unit_active` 的就地等价实现，见文件头差异⑬；
 * board.js 的 M3 只读子集没有这个口）：state ∈ (starting, running, finishing)。
 *
 * 语义逐字照 board.py:1880-1899：**行在 = 单元在管**（拾取→会话证实窗口 / finishing 收尾
 * 瞬态都算），读失败按不在场（不阻断开始路径）。
 *
 * @param {number} cardId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
function cardUnitActive(cardId, options = {}) {
  try {
    const row = waitq.getActive(waitq.KIND_CARD, cardId, options);
    return row !== null && (row.state === waitq.STARTING || row.state === waitq.RUNNING
      || row.state === waitq.FINISHING);
  } catch {
    return false;
  }
}

/**
 * 卡片记错（`db.update_board_card(card_id, last_error=…, last_error_at=…)` 的就地等价实现，
 * 见文件头差异⑬）：db.js 尚无卡片写口，故就地 UPDATE 两列 + `updated_at`（SQL 与
 * `db.py:update_board_card` 同款：字段白名单内的两列、无 `column_key` ⇒ 不派生 done_at /
 * unread）。写失败上抛由调用方吞（worker 的 c: 异常分支照 Python `except Exception: pass`）。
 *
 * @param {number} cardId
 * @param {string} message 截断后的错误文本
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
function setCardLastError(cardId, message, options = {}) {
  withWriteDb(options, (handle) => {
    handle.prepare('UPDATE board_cards SET last_error=?,last_error_at=?, updated_at=?'
      + ' WHERE id=?').run(message, nowStr(), nowStr(), cardId);
  });
}

// --------------------------------------------------------------------------
// waitq 权威 helper（runner.py:84-186）
// --------------------------------------------------------------------------

/**
 * 任务失败/中断飞书旁路推送（`notify_task_failed`，runner.py:84）：读任务行取项目/名称后转
 * `feishu.task_failed`；任务行已删或任何异常静默跳过（**通知永不影响调度主流程**）。
 *
 * **async**（飞书通知可能是远端 IO，见文件头差异⑨）：未接线 M7 缝时静默返回。
 *
 * @param {number} taskId
 * @param {string} error
 * @param {number} [skippedN] 连带跳过的后段任务条数
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<void>}
 */
export async function notifyTaskFailed(taskId, error, skippedN = 0, options = {}) {
  try {
    const t = getTask(taskId, options);
    if (t === null || t === undefined) return;
    if (FAILURE_NOTIFIER === null) return;          // M7 未接线：静默（照 except: pass）
    await FAILURE_NOTIFIER(t.project_id, t.id, t.name, t.task_type || 'normal',
      error, skippedN);
  } catch {
    // 照 Python：通知异常一律吞（绝不把调度带崩）
  }
}

/**
 * answer 等待项行 meta 里的目标会话 sid（`_answer_row_sid`，runner.py:106；坏 JSON 按空串）：
 * `_pick_locked` 的「占位者即本会话自身」判定用。
 *
 * 形态差异：Python 只吃 `ValueError`（坏 JSON），非 dict 的 `AttributeError` 会外抛；Node
 * 侧一律按空串（见文件头差异⑮）。
 *
 * @param {object} row wait_items 行
 * @returns {string}
 */
export function answerRowSid(row) {
  try {
    const meta = JSON.parse((row && row.meta) || '{}');
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return '';
    return meta.sid ? String(meta.sid) : '';
  } catch {
    return '';
  }
}

/**
 * 同项目 + 同 sid 的**运行中** `m:` 行键集（`_session_msg_keys`，runner.py:115；R7 折抵判据）。
 *
 * 唯一判据出处：a: 单元折抵（`answerExemptKeysLocked`）与 `sessionHolds` 读口共用——
 * 「占位者即该会话自己的消息单元」在行口径下的等价形态。只认运行中行
 * （state ∈ PREFIX_STATES）：等待中的消息尚未占位。
 *
 * @param {object[]} rows 已取到的活跃行清单（调用方传，免二次全表读）
 * @param {number} projectId
 * @param {string} sid
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Set<string>} 队列键集（`m:<msg_id>`）
 */
export function sessionMsgKeys(rows, projectId, sid, options = {}) {
  if (!sid) return new Set();
  const mids = new Set();
  for (const r of rows) {
    if (r.project_id === projectId && r.kind === waitq.KIND_MSG
      && waitq.PREFIX_STATES.includes(r.state)) {
      mids.add(String(r.target_id));
    }
  }
  if (mids.size === 0) return new Set();
  const out = new Set();
  for (const m of waitq.msgRows({ sid }, options)) {
    if (mids.has(String(m.id))) out.add(`m:${m.id}`);
  }
  return out;
}

/**
 * 队列键拾取 → 对应等待项 claim（`_claim_unit`，runner.py:161；P4：四类全直调，权威互斥点）。
 *
 * `false` = 行已被取消（停卡/移列/停止）或被「立即送达/立即注入」抢占：调用方撤销本次接手
 * 回等待循环，终态由取消方/直投方负责。claim 瞬时故障（sqlite 抖动）不得炸掉 worker
 * 循环——异常按 claim 失败处理，行保持 waiting 待下轮。
 *
 * @param {string} key 队列键（`t:|c:|m:|a:` + target）
 * @param {string} [claimer]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {boolean}
 */
export function claimUnit(key, claimer = 'worker', options = {}) {
  const kind = KIND_OF_KEY[String(key).charAt(0)];
  if (kind === undefined) return true;             // 未知键前缀：照 Python（无 kind 即放行）
  try {
    return Boolean(waitq.claimByTarget(kind, String(key).slice(2), claimer, options));
  } catch (err) {
    console.log(`[waitq] ${kind} claim 失败（按未拾取处理）: ${errText(err)}`);
    return false;
  }
}

/**
 * 占位者明细文本（`holders_text`，runner.py:177；等待日志用）：项目运行前缀成员明细
 * 「key（evidence，Ns）」，空 → 「未知」。占位者 = 该项目前缀行（`projectHolderDetails`）。
 *
 * @param {Runner} inst
 * @param {number} projectId
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {string}
 */
export function holdersText(inst, projectId, options = {}) {
  const now = Date.now() / 1000;
  const items = inst.projectHolderDetails(projectId, options);
  if (!items.length) return '未知';
  return items.map((d) => `${d.key}（${d.evidence || '未知'}，`
    + `${Math.trunc(now - d.since)}s）`).join('，');
}

// --------------------------------------------------------------------------
// Runner（runner.py:188-1160）
// --------------------------------------------------------------------------

/**
 * 单例运行器：`submit` / `submitCard` 入队（任务与看板卡片混合 FIFO），多个执行循环按项目
 * 串行调度（同项目串行，跨项目并行）。
 *
 * 形态：Python 的 6 条 daemon 线程 → Node 的 6 个 async 循环；`self._cond`（Condition）→
 * `this._cond`（`Waiter`，只保留唤醒语义）。**所有 `*Locked` 方法体里不许出现 await**
 * （= Python 持 `_cond` 的原子段，见文件头差异③）。
 */
export class Runner {
  /**
   * 同时在跑的单元数上限（= 执行循环数）：同一项目内任务严格串行，不同项目的单元可并行；
   * agent 真实并发上限仍由「每项目前缀窗口」约束（serial 1 / parallel 5，t: 恒 1）。
   */
  static WORKERS = WORKERS;

  /**
   * 压测任务首次发压的轮次号：第 1 轮 agent 出方案包，首次发压记为第 2 轮；复压在此之上
   * 递增（此常量只作为「首次发压」的基准，存量语义）。
   */
  static LOAD_ROUND_NO = LOAD_ROUND_NO;

  /**
   * 脚本复测的单脚本超时（秒）与并发数（`SCRIPT_RETEST_TIMEOUT` / `SCRIPT_WORKERS`，
   * runner.py:1519）。构造器把它们**镜像到实例属性**（Python 是类属性、经 `self.` 读；
   * JS 静态字段不沿原型链 ⇒ `this.X` 取不到），方法体读 `this.SCRIPT_*`——单测因此可给
   * 实例覆写一个极小超时来钉超时支。
   */
  static SCRIPT_RETEST_TIMEOUT = SCRIPT_RETEST_TIMEOUT;
  static SCRIPT_WORKERS = SCRIPT_WORKERS;

  /** parallel 模式队首责任区长度（= 模块级 `PARALLEL_PREFIX_N`；serial 恒 1，t: 恒 1） */
  static PARALLEL_PREFIX_N = PARALLEL_PREFIX_N;

  /**
   * @param {boolean} [bootGate] `true`：执行循环就绪后先停在**启动闸**后，直到
   *   `releaseBootGate()` 放行（服务启动序：init_db → recover → board.recover →
   *   reconcile_units 全跑完再放行）；默认 `false` = 构造即可拾取（单测直建语义不变）。
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   *   实例级 db 选项袋（Node 追加：Python 靠模块级缺省库路径，Node 的读/写口一律收末位
   *   options；实例级袋子是该类所有方法的缺省值，单测用它把整实例钉在临时库上）。
   */
  constructor(bootGate = false, options = {}) {
    /** 等待/唤醒面（`self._cond`；无锁语义，见文件头差异②） */
    this._cond = new Waiter();
    /** 实例级 db 选项袋（见构造器 @param） */
    this._options = { ...options };
    /** task_id(int) -> 当前 agent 进程句柄（`{pid}`；仅任务单元，**键保持 int**） */
    this._procs = new Map();
    /** 已请求停止的任务 id（int 集合；`Set`） */
    this._stop_requested = new Set();
    /** 行判活探针（board 经 `setLivenessProbe` 注册；`_liveness_probe`） */
    this._liveness_probe = null;
    /**
     * 脚本复测的单脚本超时（秒）与并发数：Python 是**类属性**、经 `self.` 读
     * （`self.SCRIPT_RETEST_TIMEOUT` / `self.SCRIPT_WORKERS`）⇒ 实例上镜像一份
     * （JS 的静态字段**不沿原型链**，`this.X` 取不到；镜像后与 Python 同形：
     * 单测可给实例覆写一个极小超时来钉超时支）。类常量仍以
     * `Runner.SCRIPT_RETEST_TIMEOUT` / `Runner.SCRIPT_WORKERS` 为准。
     */
    this.SCRIPT_RETEST_TIMEOUT = Runner.SCRIPT_RETEST_TIMEOUT;
    this.SCRIPT_WORKERS = Runner.SCRIPT_WORKERS;
    /**
     * turn 启动宽限（秒，`DSH_TURN_START_GRACE`）：Python 在 `_wait_turn_end_dsh` 里读
     * **模块全局**（`runner.DSH_TURN_START_GRACE`，单测可 monkeypatch 它来钉「turn 未启动」支）；
     * Node 的 ESM 导出不可写 ⇒ 镜像到实例属性供单测覆写（同 `SCRIPT_*` 的处置，见文件头差异㊷）。
     */
    this.DSH_TURN_START_GRACE = DSH_TURN_START_GRACE;
    /** 启动闸（`null` = 无闸/已放行；见 `releaseBootGate`） */
    this._bootGate = bootGate ? createGate() : null;
    /** 执行循环的 promise（Python `_threads`；诊断用，不 await 到底） */
    this._workers = [];
    for (let i = 0; i < Runner.WORKERS; i += 1) this._workers.push(this.worker());
  }

  // ---------- 队列键规范（`_tkey` / `_ckey` / `_mkey` / `_akey`） ----------

  /** 任务队列键（`t:<task_id>`） */
  static tkey(taskId) {
    return `t:${taskId}`;
  }

  /** 看板卡片队列键（`c:<card_id>`） */
  static ckey(cardId) {
    return `c:${cardId}`;
  }

  /** 会话消息队列键（`m:<msg_id>`；msg_id 字符串，不带冒号） */
  static mkey(msgId) {
    return `m:${msgId}`;
  }

  /** 答案队列键（`a:<card_id>`；target=卡片 id，与 c: 同目标空间、前缀不同） */
  static akey(cardId) {
    return `a:${cardId}`;
  }

  /**
   * 解析本次调用的 db 选项袋：实例级 `_options` 打底，调用方给的覆盖（`null` = 原样用
   * 实例级）。
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}|null} [options]
   * @returns {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}}
   */
  opt(options = null) {
    if (options === null || options === undefined) return this._options;
    return { ...this._options, ...options };
  }

  // ---------- 对外 API ----------

  /**
   * 入队任务（`submit`，runner.py:261；调用方已把 status 置为 queued）。
   *
   * P4：权威写入即入队（`waitq.enqueue` 插 waiting 行，行即队列位次），写表成功后 notify
   * ——「先表后队」由写序天然保证。行已活跃（重复 submit/排队中 restart）时幂等复用，
   * 位次不动。
   *
   * @param {number} taskId
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   */
  submit(taskId, options = null) {
    const opts = this.opt(options);
    const t = getTask(taskId, opts);
    if (t !== null && t !== undefined) {
      waitq.enqueue(waitq.KIND_TASK, taskId, t.project_id, null, 0.0, opts);
    }
    this._cond.notifyAll();
    if (t !== null && t !== undefined && this.unitBusy(t.project_id, opts)) {
      // 排队等待诊断（P4 必带⑤）：前排成员明细格式「key（evidence，Ns）」
      console.log(`[runner] 任务排队等待：t:${taskId}`
        + `（前排：${holdersText(this, t.project_id, opts)}）`);
    }
  }

  /**
   * 看板卡片入队（`submit_card`，runner.py:277；统一队列：与任务同 FIFO，同项目串行；幂等）。
   *
   * P4：经 `waitq.enqueueCard` 一个事务写等待项 + 排队占位投影（占位已在 doing+queue 时
   * 条件跳过——不覆盖 answer 路径空 block_text）。`extra`（打回意见）/ `fromColumn`
   * （起跑失败回列目标）随 meta 持久化（重启不再丢）。
   * `afterPrefix=true`（v2b T2）：续跑/手动恢复（review/blocked）改走原子变体
   * `waitq.insertCardAfterPrefix`——插「运行前缀后」= 等待区最前（行+占位仍单事务）。
   *
   * @param {number} cardId
   * @param {string} [extra]
   * @param {string} [fromColumn]
   * @param {boolean} [afterPrefix]
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   */
  submitCard(cardId, extra = '', fromColumn = '', afterPrefix = false, options = null) {
    const opts = this.opt(options);
    const card = getBoardCard(cardId, opts);
    if (card !== null && card !== undefined) {
      const from = fromColumn || card.column_key;
      if (afterPrefix) {
        waitq.insertCardAfterPrefix(cardId, card.project_id, extra, from,
          waitq.CARD_QUEUE_TEXT, opts);
      } else {
        waitq.enqueueCard(cardId, card.project_id, extra, from, waitq.CARD_QUEUE_TEXT, opts);
      }
    }
    this._cond.notifyAll();
    if (card !== null && card !== undefined && this.unitBusy(card.project_id, opts)) {
      console.log(`[runner] 卡片排队等待：c:${cardId}`
        + `（前排：${holdersText(this, card.project_id, opts)}）`);
    }
  }

  /**
   * 会话消息入队（`submit_msg`，runner.py:302；统一队列第三类单元；幂等）。
   *
   * 等待项/消息行的权威写入归 `chat.submit`（`waitq.msgEnqueue`）——行即登记，此处只唤醒
   * 执行循环（`msgId`/`projectId`/`sid` 形参保留调用面稳定，不再登记任何内存镜像）。
   *
   * @param {string} msgId
   * @param {number} [projectId]
   * @param {string} [sid]
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   */
  submitMsg(msgId, projectId = 0, sid = '', options = null) {
    // 形参保留调用面稳定（Python 侧同样不读它们；行已由 chat.submit 写入）
    this._cond.notifyAll();
  }

  /**
   * 会话消息出队（`remove_msg`，runner.py:318；取消排队；已在执行的消息不走本接口，由
   * `chat.stop` 中断）。权威取消归 `chat.cancel`——本函数只剩唤醒（让已取消的行尽快退出
   * 拾取视野）。
   *
   * @param {string} msgId
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   */
  removeMsg(msgId, options = null) {
    this._cond.notifyAll();
  }

  /**
   * 答案单元入队（`submit_answer`，runner.py:326；统一队列第四类单元；幂等）。
   *
   * 权威在 `wait_items` 表——调用方（board 作答排队路径 / recover 重建）先写行再调本方法，
   * 此处只唤醒执行循环。可拾取性由 `pickLocked` 按 answer 行判定。
   *
   * @param {number} cardId
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   */
  submitAnswer(cardId, options = null) {
    this._cond.notifyAll();
  }

  /**
   * 答案单元出队（`remove_answer`，runner.py:338；停卡/移列放弃、「立即送达」接管时摘除；
   * 幂等）。权威取消归 board 的 `waitq.cancel`，本函数只剩唤醒。
   *
   * @param {number} cardId
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   */
  removeAnswer(cardId, options = null) {
    this._cond.notifyAll();
  }

  /**
   * 消息是否仍排队等待执行（`msg_waiting`，runner.py:345；前台展示用；查等待项表——
   * waiting 行即排队）。
   *
   * @param {string} msgId
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {boolean}
   */
  msgWaiting(msgId, options = null) {
    const row = waitq.getActive(waitq.KIND_MSG, msgId, this.opt(options));
    return row !== null && row.state === waitq.STATE_WAITING;
  }

  // ---------- 窗口几何（实例方法委托模块级实现，禁止第二份） ----------

  /**
   * 补位窗口 N（`_window_n`，runner.py:350）：t: 单元恒 1（任务串行红线）；看板卡单元族
   * c:/m:/a: 按项目模式 parallel → `PARALLEL_PREFIX_N`、serial → 1。
   *
   * **委托**模块级 `windowN(kind, projectId, options)`（注意参数序与 Python 实例方法相反：
   * 模块级是（kind, projectId））。
   *
   * @param {number} projectId
   * @param {string} kind
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {number}
   */
  windowN(projectId, kind, options = null) {
    return windowN(kind, projectId, this.opt(options));
  }

  /**
   * 前缀窗口是否已满（`_prefix_window_full`，runner.py:363）：项目运行前缀**行数**
   * （state ∈ PREFIX_STATES）≥ N；前缀内有 t: 成员时恒 1。决策体 = 模块级
   * `prefixWindowBlocked`（key=null：项目整窗，不排除任何键）。
   *
   * @param {number} projectId
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {boolean}
   */
  prefixWindowFull(projectId, options = null) {
    const opts = this.opt(options);
    const keys = this.prefixMembers(activeItems(projectId, opts)).get(projectId) || new Set();
    return prefixWindowBlocked(keys, null, waitq.KIND_CARD,
      this.windowN(projectId, waitq.KIND_CARD, opts));
  }

  /**
   * claim 后行口径窗口复判（`_unit_window_blocked`，runner.py:376；R1）：`pickLocked` 窗口闸的
   * claim 侧孪生——项目前缀行扣除**本单元自己的行**与折抵键后是否 ≥ N。
   *
   * @param {number} projectId
   * @param {string} key
   * @param {string} kind
   * @param {Iterable<string>} [exempt]
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {boolean}
   */
  unitWindowBlocked(projectId, key, kind, exempt = [], options = null) {
    const opts = this.opt(options);
    const keys = this.prefixMembers(activeItems(projectId, opts)).get(projectId) || new Set();
    return prefixWindowBlocked(keys, key, kind, this.windowN(projectId, kind, opts), exempt);
  }

  /**
   * 项目当前是否忙 = 新单元必须留队（`unit_busy`，runner.py:389；**与 `pickLocked` 放行口径
   * 一致**）：前缀窗口已满，或项目存在活跃 `ext:` 行（**与 N 无关**）。
   *
   * **委托**模块级 `unitBusy(projectId, options)`（M3 已落地，语义逐点同）。
   *
   * @param {number} projectId
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {boolean}
   */
  unitBusy(projectId, options = null) {
    return unitBusy(projectId, this.opt(options));
  }

  // ---------- 卡片起跑证实 / 收尾 ----------

  /**
   * 卡片起跑证实（`card_started`，runner.py:408；六条路径共用）：把卡行置 running
   * （`waitq.enterRunning`，行即条目）+ 证据落行（`waitq.markEvidence`）。入口幂等且恒成功，
   * 返回值保留给调用方做流控（恒 `true`）。
   *
   * @param {number} cardId
   * @param {number} projectId
   * @param {object|null} [ext] 登记证据（desc / reason / pid）
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {boolean} 恒 true
   */
  cardStarted(cardId, projectId, ext = null, options = null) {
    const opts = this.opt(options);
    const payload = { desc: '卡片会话占用' };
    Object.assign(payload, ext || {});
    waitq.enterRunning(waitq.KIND_CARD, cardId, projectId, null, opts);
    waitq.markEvidence(waitq.KIND_CARD, cardId, payload, opts);
    this._cond.notifyAll();
    return true;
  }

  /**
   * 卡片会话结束收尾（`card_finished`，runner.py:429）：行收口门禁 = (running, finishing)
   * ——starting 行不收（起跑失败行终态归 worker finally，本函数不得抢先标 done）。行收口
   * 成功时由唯一收尾点 `board.finish` 打确定性日志；本方法只做「行终态 + notify」两段。
   *
   * @param {number} cardId
   * @param {string} [reason] 收尾标签（本方法只用它出日志——实际日志归 `board.finish`）
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {boolean} 是否真实收口一行（门禁命中且落终态成功）
   */
  cardFinished(cardId, reason = '', options = null) {
    const opts = this.opt(options);
    const row = waitq.getActive(waitq.KIND_CARD, cardId, opts);
    let collected = false;
    if (row !== null && (row.state === waitq.RUNNING || row.state === waitq.FINISHING)) {
      collected = waitq.finishByTarget(waitq.KIND_CARD, cardId, waitq.STATE_DONE, '', opts);
    }
    this._cond.notifyAll();
    return collected;
  }

  /**
   * 项目占位者明细（`project_holder_details`，runner.py:454；诊断用，行口径）：
   * `[{key, since, evidence}]`。占位者 = 该项目运行前缀成员（state ∈ PREFIX_STATES 的活跃
   * 行，唯一来源）；`since` = 行创建时间（epoch 秒，坏值按当前时刻——年龄按 0 报）；
   * `evidence` = 行 evidence JSON 的 `evidence`，回落登记描述 `desc`。
   *
   * @param {number} projectId
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {Array<{key: string, since: number, evidence: string}>}
   */
  projectHolderDetails(projectId, options = null) {
    const opts = this.opt(options);
    const now = Date.now() / 1000;
    const out = [];
    for (const row of activeItems(projectId, opts)) {
      if (!waitq.PREFIX_STATES.includes(row.state)) continue;
      let ev;
      try {
        ev = JSON.parse(row.evidence || '{}');
        if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) ev = {};
      } catch {
        ev = {};
      }
      let since;
      try {
        since = localSeconds(row.created_at);
      } catch {
        since = now;                    // ValueError/TypeError/OverflowError 同侧
      }
      out.push({
        key: memberKey(row.kind, row.target_id),
        since,
        evidence: ev.evidence || ev.desc || '',
      });
    }
    return out;
  }

  /**
   * 项目运行前缀里是否有该会话自己的消息单元（`session_holds`，runner.py:482；行口径：同 sid
   * 的活跃 m: 行，`chat_msgs.sid` 反查）。用来区分「项目忙，但忙的正是本会话」——三方互等
   * 死锁（卡 391 实障）的解锁判据。
   *
   * @param {number} projectId
   * @param {string} sid
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {boolean}
   */
  sessionHolds(projectId, sid, options = null) {
    if (!sid) return false;
    const opts = this.opt(options);
    const rows = activeItems(projectId, opts);
    return sessionMsgKeys(rows, projectId, sid, opts).size > 0;
  }

  /**
   * 运行前缀成员变化（`notify_busy_change`，runner.py:500）时由 board 调用：唤醒空闲执行循环
   * 重新挑选（否则外部会话结束无人 notify，排队卡滞留；5s 节拍兜底仍在）。
   *
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   */
  notifyBusyChange(options = null) {
    this._cond.notifyAll();
  }

  /**
   * 单元在统一队列中的态（`unit_state`，runner.py:507；会话详情页「队列」徽标的数据源）。
   *
   * **委托**模块级 `unitState(key, projectId, options)`（M3 已落地：running / queued+位次 /
   * idle 三态，键名 `{state, pos, total}` 直接进 JSON 响应）。
   *
   * @param {string} key
   * @param {number} projectId
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {{state: string, pos: number, total: number}}
   */
  unitState(key, projectId, options = null) {
    return unitState(key, projectId, this.opt(options));
  }

  // ---------- 停止 / 重启 / 复压 / 续跑 / 删除 ----------

  /**
   * 停止任务（`stop`，runner.py:559）：waiting（排队中）→ 取消等待项并立即标 stopped+跳后段；
   * starting（运行中）或无行但在跑 → 杀进程，由轮边界收口。
   *
   * 排队分支的「键在队列」check-then-act 换成 `waitq.cancel` 的 rowcount 守卫（与 worker
   * claim 竞态下不双执行）；但 `cancel` 的状态守卫覆盖全部活跃态，运行中任务的行从拾取到
   * finally 整程 starting——直接 cancel 会把「停止运行中任务」误判成排队命中，故先
   * `getActive` 验行态分流：waiting → cancel+stopped（读-写竞态由 rowcount 兜底）；
   * starting/无行 → 只加 `_stop_requested` + 杀进程，轮边界统一落 stopped/跳后段。
   *
   * **async**（Python 同步调 `dshdriver.cancel`；Node 侧那是远端 IO，见文件头差异⑥）。
   *
   * @param {number} taskId
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {Promise<void>}
   */
  async stop(taskId, options = null) {
    const opts = this.opt(options);
    this._stop_requested.add(taskId);
    const row = waitq.getActive(waitq.KIND_TASK, taskId, opts);
    const queued = row !== null && row.state === waitq.STATE_WAITING
      && waitq.cancel(waitq.KIND_TASK, taskId, '用户停止', null, opts);   // rowcount 仲裁
    if (queued) {
      updateTask(taskId, { status: 'stopped', ended_at: nowStr() }, opts);
      this.skipPipelineChildren(taskId, '前段任务已停止，后段跳过', opts);
    }
    const proc = this._procs.get(taskId);
    this._cond.notifyAll();
    if (proc !== null && proc !== undefined) {
      try {
        killTree(proc.pid, { sig: 'SIGTERM' });     // 同步实现（投递 + 宽限轮询，不抛）
      } catch {
        // 照 Python `except OSError: pass`
      }
    }
    // dsh 插件族任务无本地进程可杀：直接 cancel 当前 turn（轮询循环的 _stop_requested 检查
    // 兜底；cancel 失败说明 turn 已结束，忽略）
    const t = getTask(taskId, opts);
    if (t !== null && t !== undefined && t.session_id) {
      const proj = getProject(t.project_id, opts);
      const family = proj ? agentFamily(proj.agent_path) : '';
      if (family === 'dsh_plugin') {
        try {
          await driverCancel(t.session_id);
        } catch (err) {
          if (!(err instanceof DshDriverError)) throw err;   // 照 Python 只吃 DshDriverError
        }
      }
    }
  }

  /**
   * 重启任务（`restart`，runner.py:603）：清掉停止标记，重置轮次计数与状态后重新入队。
   * 旧轮次记录一并清空（重启=从第一轮重跑，避免 round_no 重复）。
   *
   * @param {number} taskId
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   */
  restart(taskId, options = null) {
    const opts = this.opt(options);
    this._stop_requested.delete(taskId);
    deleteRounds(taskId, opts);
    const t = getTask(taskId, opts);
    updateTask(taskId, {
      status: 'queued',
      current_round: 0,
      new_bugs: 0,
      error: '',
      ended_at: null,
      session_id: t ? t.session_id : null,
    }, opts);
    this.submit(taskId, opts);
  }

  /**
   * 复压（`rerun_load`，runner.py:617）：跳过 agent 轮，用现有方案包再跑一次发压运行。
   * 与 restart 的区别：不清轮次、不动 session、不重跑 agent（方案包不改），只追加一次
   * `kind='load'` 的发压运行。`load_rerun=1` **必须落库**（排队行可跨服务重启存活）。
   *
   * @param {number} taskId
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   */
  rerunLoad(taskId, options = null) {
    const opts = this.opt(options);
    this._stop_requested.delete(taskId);
    updateTask(taskId, { status: 'queued', load_rerun: 1, error: '', ended_at: null }, opts);
    this.submit(taskId, opts);
  }

  /**
   * 续跑任务（`resume`，runner.py:634；「继续」）：保留轮次记录、轮次计数与会话，从下一轮
   * 接着跑。`fresh_prompt` 标记由 server 层在入队前置 1（续跑第一轮用完整首轮提示词）。
   *
   * @param {number} taskId
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   */
  resume(taskId, options = null) {
    const opts = this.opt(options);
    this._stop_requested.delete(taskId);
    updateTask(taskId, { status: 'queued', error: '', ended_at: null }, opts);
    this.submit(taskId, opts);
  }

  /**
   * 删除前置处理（`remove`，runner.py:647）：任务若在排队中则取消其等待项（运行中的任务由
   * server 层拒绝删除）。`waitq.cancel` 直调即出队（行即队列；幂等；非 waiting 行不被复活）。
   *
   * @param {number} taskId
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   */
  remove(taskId, options = null) {
    waitq.cancel(waitq.KIND_TASK, taskId, '任务删除', null, this.opt(options));
  }

  // ---------- 服务启动恢复 ----------

  /**
   * 服务启动恢复（`recover`，runner.py:655；P4 重启矩阵，四类单元各归其位）：
   *
   *   - 任务侧：仅执行中（running）任务打断——杀残留进程组 + interrupted + 「前段任务被服务
   *     重启中断，后段跳过」；queued 任务不再被打断（waiting t: 行存活即续跑），缺行的排队
   *     任务防御性补建；
   *   - 等待项即队列：waiting 的 t:/c:/m:/a: 行全量存活（位次以表 seq 为准）；
   *   - starting/running/finishing 按 v2a T1 映射收口：a: 放回 waiting 重投（放回计入
   *     n_requeue）；m: 记 `error=服务重启中断`（重发非幂等，`waitq.msgRecoverFail`）；
   *     t: 任务仍 queued → 放回 waiting 续跑，非 queued 维持 cancel；c: 不在此收口——交
   *     board.recover 按实况映射；
   *   - **非 waiting 收口先于 queued 防御补建**（顺序硬约束：放回的行让补建检查看到活跃行、
   *     不重复插入）；单测用 wait_items 触发器把这两步的先后钉在审计表里。
   *
   * **async**（飞书失败通知是 IO；通知在同步临界段之后逐任务 await，见文件头差异⑨）。
   *
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {Promise<void>}
   */
  async recover(options = null) {
    const opts = this.opt(options);
    const tasks = listAllTasks(opts).map((r) => ({ ...r }));
    this._procs.clear();
    this._stop_requested.clear();
    // —— 非 waiting 收口先行，waiting 行存活计数同趟 ——
    let nAlive = 0;
    let nRequeue = 0;
    for (const arow of waitq.activeItems(null, opts)) {
      const kind = arow.kind;
      const target = arow.target_id;
      if (arow.state === waitq.STATE_WAITING) {
        nAlive += 1;
        if (kind === waitq.KIND_MSG || kind === waitq.KIND_ANSWER) {
          nRequeue += 1;            // m:/a: waiting 行存活（无镜像可建）
        }
        continue;
      }
      // starting/running/finishing 行（claimed 已被 starting 吸收——同一收口面）
      if (kind === waitq.KIND_CARD) {
        continue;                   // c: 交 board.recover 按实况收口
      }
      if (kind === waitq.KIND_ANSWER) {
        waitq.returnToWaiting(arow.id, 0.0, false, opts);     // 重投
        nRequeue += 1;                                        // 放回计入重投
      } else if (kind === waitq.KIND_MSG) {
        waitq.markFailed(arow.id, '服务重启中断', opts);
        waitq.msgRecoverFail(target, '服务重启中断', opts);    // 不重投
      } else if (kind === waitq.KIND_TASK) {
        // 任务仍 queued（claim↔置 running 间崩溃）→ 放回续跑；非 queued → 维持 cancel
        const trow = pyIsDigits(target) ? getTask(pyIntOr(target, 0), opts) : null;
        if (trow !== null && trow !== undefined && trow.status === 'queued') {
          waitq.returnToWaiting(arow.id, 0.0, false, opts);
          nRequeue += 1;
        } else {
          waitq.cancel(kind, target, '服务重启中断', null, opts);
        }
      }
    }
    const interrupted = [];         // 待通知任务（await 不进同步临界段）
    for (const t of tasks) {
      if (t.status !== 'running') {
        if (t.status === 'queued' && waitq.getActive(waitq.KIND_TASK, t.id, opts) === null) {
          // 防御对账：排队任务缺等待项行（异常丢失）→ 补建（**在非 waiting 收口之后**跑，
          // 放回的行不会重复补——行活跃唯一索引 + enqueue 幂等双保险）
          waitq.enqueue(waitq.KIND_TASK, t.id, t.project_id, null, 0.0, opts);
        }
        continue;
      }
      // 仅执行中任务打断（杀残留 + interrupted + 通知 + 跳后段）；queued 存活
      this.killResidual(t.id, opts);
      this.finalizeLoadRounds(t.id, opts);
      updateTask(t.id, { status: 'interrupted', error: '服务重启中断', ended_at: nowStr() }, opts);
      this.skipPipelineChildren(t.id, '前段任务被服务重启中断，后段跳过', opts);
      interrupted.push(t.id);
    }
    for (const taskId of interrupted) {
      await notifyTaskFailed(taskId, '服务重启中断', 0, opts);
    }
    if (nAlive) {
      console.log(`[runner] 服务重启：waiting 等待项存活 ${nAlive} 条`
        + `（t:/c:/m:/a: 行即队列；m:/a: 存活 ${nRequeue} 条）`);
    }
    this._cond.notifyAll();
  }

  /**
   * 放行启动闸（`release_boot_gate`，runner.py:734；幂等）。
   *
   * 服务启动序硬约束：init_db → recover → board.recover → reconcile_units **全部跑完**后调用
   * 本方法——此后循环才开始拾取，第一次 `pickLocked` 看到的即启动对账后的权威行态。
   * 闸未开的实例（`bootGate=false` ⇒ `_bootGate === null`）调用为 no-op。
   */
  releaseBootGate() {
    if (this._bootGate === null) return;
    this._bootGate.release();
  }

  // ---------- 残留收口 / 后段跳过 ----------

  /**
   * 按最新轮次日志中记录的 PID 尝试杀进程（`_kill_residual`，runner.py:748；尽力而为）。
   *
   * 形态差异：Python `os.kill(pid, SIGTERM)` → Node `process.kill(pid, 'SIGTERM')`（**单 pid**，
   * 不是整树——与 Python 逐点同）；日志尾读取用私有 `readLogTail`（见文件头差异⑭）。
   *
   * @param {number} taskId
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   */
  killResidual(taskId, options = null) {
    const opts = this.opt(options);
    const task = getTask(taskId, opts);
    if (task === null || task === undefined) return;
    const rounds = listRounds(taskId, opts);
    for (const r of [...rounds].reverse()) {
      if (r.status !== 'running' || !r.log_path) continue;
      const text = readLogTail(r.log_path, 20);
      for (const m of text.matchAll(PID_MARK_RE)) {
        try {
          process.kill(Number(m[1]), 'SIGTERM');
        } catch {
          // 照 Python `except OSError: pass`（ESRCH/EPERM 等）
        }
      }
    }
  }

  /**
   * 把残留的进行中发压运行行收口为 interrupted（`_finalize_load_rounds`，runner.py:765；服务
   * 重启打断）。只碰 `kind='load'` 行；agent 轮次的收口沿用既有口径（轮末 `finishRound`）。
   *
   * @param {number} taskId
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   */
  finalizeLoadRounds(taskId, options = null) {
    const opts = this.opt(options);
    for (const r of listRounds(taskId, opts)) {
      if (r.kind === 'load' && r.status === 'running') {
        finishRound(r.id, 'interrupted', null, '服务重启中断', r.log_path, opts);
      }
    }
  }

  /**
   * 前段任务未正常完成（停止/失败/中断）时，跳过其排队中的后段任务（`_skip_pipeline_children`，
   * runner.py:777）：后段标 done、原因写入 error 字段；已在跑/已结束的不动。返回本次跳过的
   * 后段条数（失败通知文案用）。
   *
   * @param {number} taskId 前段任务 id
   * @param {string} reason
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {number}
   */
  skipPipelineChildren(taskId, reason, options = null) {
    const opts = this.opt(options);
    let n = 0;
    for (const t of listAllTasks(opts)) {
      if ((t.task_type || 'normal') !== 'pipeline' || t.status !== 'queued') continue;
      const parentId = payloadParentId(t.payload);
      if (parentId !== taskId) continue;
      updateTask(t.id, { status: 'done', error: reason, ended_at: nowStr() }, opts);
      waitq.cancel(waitq.KIND_TASK, t.id, reason, null, opts);
      n += 1;
    }
    return n;
  }

  // ---------- 补位器 ----------

  /**
   * 调度口径运行前缀成员（`_prefix_members`，runner.py:800）：委托模块级 `prefixMembers`
   * （M3 已落地；成员只由行构成、唯一来源 R1）。
   *
   * @param {object[]} rows
   * @returns {Map<number, Set<string>>}
   */
  prefixMembers(rows) {
    return prefixMembers(rows);
  }

  /**
   * a: 行自身占位折抵（`_answer_exempt_keys_locked`，runner.py:819）：目标会话被「同 sid 的
   * m: 运行单元」占着时该占用不计入前缀；本卡 c: 活跃行同豁免（送达答案是解锁动作，卡 391
   * 死锁修复）。外部条目（ext 行）**不在折抵面**。返回应从本单元前缀计数中折抵的键集。
   *
   * **锁内方法**（`*Locked` 命名，见文件头差异③）：体内不许 await。
   *
   * @param {object} row a: 等待项行（调用方已做 target 数字防御）
   * @param {object[]} rows 调用方已取到的活跃行清单
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {Set<string>}
   */
  answerExemptKeysLocked(row, rows, options = null) {
    const opts = this.opt(options);
    const exempt = new Set();
    const ansCid = pyIntOr(row.target_id, null);      // 调用方已做 ValueError 防御
    if (ansCid !== null && cardUnitActive(ansCid, opts)) {
      exempt.add(`c:${ansCid}`);
    }
    for (const k of sessionMsgKeys(rows, row.project_id, answerRowSid(row), opts)) {
      exempt.add(k);
    }
    return exempt;
  }

  /**
   * 补位器（`_pick_locked`，runner.py:838）：队列即 `wait_items` 表，遍历 `activeItems`
   * （seq 升序），逐项目只看等待区队首行：
   *
   *   ① 折抵后前缀长度 ≥ N(project) → 本项目本轮不启动；
   *   ② not_before 未到 / 卡片占位非 doing+queue / 任务非 queued / pipeline 前段未 done
   *      → 队首留队、**本项目本轮不再向下补位**（`headBlocked`）；无效单元就地终态化；
   *   ③ a: 行自身占位折抵（`answerExemptKeysLocked`）；
   *   ④ **项目外部条目闸**：该项目存在活跃 `ext:` 行 → 本项目本轮不补位（**与 N 无关**）；
   *   ⑤ 可启动 → 返回键，由 `claimAndStartLocked` 收口。
   *
   * **锁内方法**：体内不许 await（Python 在 `with self._cond` 里跑）。
   *
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {string|null} 队列键或 null（本轮无可补位单元）
   */
  pickLocked(options = null) {
    const opts = this.opt(options);
    const rows = activeItems(null, opts);                  // seq 升序；四活跃态全集
    const members = this.prefixMembers(rows);              // 前缀成员=行
    const extProjects = new Set(rows.filter((r) => r.kind === waitq.KIND_EXT)
      .map((r) => r.project_id));
    const headBlocked = new Set();                        // 本轮队首不可启动的项目
    const nowSec = Date.now() / 1000;
    for (const row of rows) {
      if (row.state !== waitq.STATE_WAITING) continue;     // 前缀成员行留队
      const projectId = row.project_id;
      if (headBlocked.has(projectId)) continue;            // 队首已留队：不再向下补位
      if (Number(row.not_before || 0) > nowSec) {
        headBlocked.add(projectId);                        // 退避窗口未到：留队
        continue;
      }
      const kind = row.kind;
      const uid = row.target_id;
      if (KEY_PREFIX[kind] === undefined) {
        // 未知 kind 的 waiting 行（封闭集外的理论残留）：不拾不炸，留队待自检/对账收口
        // （ext 行恒 running 入场，不会走本支）
        continue;
      }
      const key = `${KEY_PREFIX[kind]}:${uid}`;
      if (kind === waitq.KIND_CARD) {
        // 看板卡片单元：仍在排队占位态才有效（占位仅 doing+queue）
        const cid = pyIntOr(uid, null);
        if (cid === null) continue;         // c: 脏行：跳过不摘除（防 int() 炸循环）
        const card = getBoardCard(cid, opts);
        if (card === null || card.block_kind !== 'queue' || card.column_key !== 'doing') {
          waitq.cancel(waitq.KIND_CARD, uid, '占位失效', null, opts);
          continue;
        }
      } else if (kind === waitq.KIND_TASK) {
        const tid = pyIntOr(uid, null);
        if (tid === null) continue;         // t: 脏行（同 c: 防御口径）：跳过不摘除
        const task = getTask(tid, opts);
        if (task === null || task.status !== 'queued') {
          waitq.cancel(waitq.KIND_TASK, uid, '非排队态', null, opts);
          continue;
        }
        if ((task.task_type || 'normal') === 'pipeline') {
          // 后段任务：前段未 done 则留队（防前段被重启重排后后段抢先跑）
          const parentId = payloadParentId(task.payload);
          const parent = parentId ? getTask(parentId, opts) : null;
          if (parent === null || parent === undefined) {
            updateTask(tid, { status: 'done', error: '前段任务不存在，后段跳过', ended_at: nowStr() }, opts);
            waitq.cancel(waitq.KIND_TASK, uid, '前段不存在', null, opts);
            continue;
          }
          if (parent.status !== 'done') {
            headBlocked.add(projectId);
            continue;
          }
        }
      }
      // （m:/a: 行即登记：无额外有效性检查——行消失即不在扫描集内）
      // —— 前缀窗口闸：队首可启动 ⇔ 折抵后前缀长度 < N ——
      const prefix = members.get(projectId) || new Set();
      let exempt = [];
      if (kind === waitq.KIND_ANSWER) {
        if (pyIntOr(uid, null) === null) {
          // a: 脏行（target 非数字）：不可投递，就地摘除（防 int() 炸循环；窗口闸在豁免之后）
          waitq.cancel(waitq.KIND_ANSWER, uid, '脏行清理', null, opts);
          continue;
        }
        exempt = this.answerExemptKeysLocked(row, rows, opts);
      }
      if (prefixWindowBlocked(prefix, key, kind,
        this.windowN(projectId, kind, opts), exempt)) {
        headBlocked.add(projectId);                     // 前缀窗口已满：留队
        continue;
      }
      // —— 项目外部条目闸（与窗口 N 无关；判据=该行在场）——
      if (extProjects.has(projectId)) {
        headBlocked.add(projectId);
        continue;
      }
      return key;
    }
    return null;
  }

  /**
   * 锁内拾取收口（`_claim_and_start_locked`，runner.py:974；须与 `pickLocked` 同一 tick 调用）：
   * 解析单元项目 → claim 仲裁 → 行口径窗口复判。返回 `projectId`=成功接手；`null`=放弃本次
   * 拾取（回等待循环）。
   *
   * claim 必须在「锁内」且先于接手判定：表驱动拾取的除重点从内存 `_queue.remove` 移到 claim
   * 的行级 rowcount 原子性；claim 失败/复判失败即完整放弃拾取——行保持 waiting（行即队列，
   * 无需重入队），终态由取消方/直投方负责。
   *
   * **锁内方法**：体内不许 await。
   *
   * @param {string} key
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {number|null} project_id 或 null
   */
  claimAndStartLocked(key, options = null) {
    const opts = this.opt(options);
    let projectId;
    let answerRow = null;
    if (key.startsWith('c:')) {
      const cid = pyIntOr(key.slice(2), null);
      const card = cid === null ? null : getBoardCard(cid, opts);
      if (card === null || card === undefined) {
        // 挑选通过后卡片被删除（未 claim 未接手，直接回等待循环；下一轮 pick 落「占位失效」）
        return null;
      }
      projectId = card.project_id;
    } else if (key.startsWith('m:')) {
      // 会话消息单元：项目从等待项行取（权威在表）——行已消失=拾取判定与本行消失的竞态
      const mrow = waitq.getActive(waitq.KIND_MSG, key.slice(2), opts);
      if (mrow === null) return null;
      projectId = mrow.project_id;
    } else if (key.startsWith('a:')) {
      // 答案单元：项目从等待项行取（行已消失=同上的窗口竞态）
      const aid = pyIntOr(key.slice(2), null);
      answerRow = aid === null ? null : waitq.getActive(waitq.KIND_ANSWER, aid, opts);
      if (answerRow === null) return null;
      projectId = answerRow.project_id;
    } else {
      const tid = pyIntOr(key.slice(2), null);
      const task = tid === null ? null : getTask(tid, opts);
      if (task === null || task === undefined) return null;   // 任务行已删：同 c: 防御口径
      projectId = task.project_id;
    }
    // —— claim 仲裁先行（权威互斥点，全四类直调）——
    if (!claimUnit(key, 'worker', opts)) {
      this._cond.notifyAll();
      return null;
    }
    // —— 行口径窗口复判（pick 与 claim 之间可能有锁外起跑）——
    let exempt = [];
    if (key.charAt(0) === 'a') {
      exempt = this.answerExemptKeysLocked(answerRow, activeItems(null, opts), opts);
    }
    if (this.unitWindowBlocked(projectId, key, KIND_OF_KEY[key.charAt(0)], exempt, opts)) {
      const arow = waitq.getActive(KIND_OF_KEY[key.charAt(0)], key.slice(2), opts);
      if (arow !== null) waitq.returnToWaiting(arow.id, 0.0, false, opts);
      this._cond.notifyAll();
      return null;
    }
    this._cond.notifyAll();
    return projectId;
  }

  // ---------- 工作者 ----------

  /**
   * 单条执行循环（`_worker`，runner.py:1047）：启动闸 → 补位（pick/claim）→ 分派执行。
   *
   * 三段的形态见文件头差异①③⑪：`await` 只出现在「等闸 / 5s 节拍 / 等单元执行体」三处，
   * pick 与 claim 之间**没有 await**（= Python 持 `_cond` 的原子段）。
   *
   * @returns {Promise<void>} 永不 resolve（循环）；`this._workers` 持有它
   */
  async worker() {
    if (this._bootGate !== null) await this._bootGate.promise;
    while (true) {
      let key = null;
      let projectId = null;
      try {
        while (true) {
          key = this.pickLocked();
          if (key !== null) break;
          // 补位时机④：5s 节拍兜底唤醒——队首头阻塞（not_before 退避/前缀窗口满）且静场
          // 无外部事件时，无超时等待会无人再 notify，整个项目饥饿到下个事件
          await this._cond.wait(WAIT_TICK_MS);
        }
        projectId = this.claimAndStartLocked(key);
      } catch (err) {
        // Node 专属保底（见文件头差异⑪）：未捕获异常会打死整个进程，故「响亮 + 跳过本轮」
        console.log(`[runner] 补位/拾取异常（本轮跳过）: ${errText(err)}`);
        await this._cond.wait(WAIT_TICK_MS);
        continue;
      }
      if (projectId === null) continue;
      try {
        await this.runPickedUnit(key);
      } catch (err) {
        // 见文件头差异⑪②：单元收口段（finally 里的行终态写）自身抛异常时，Python 只死一条
        // 线程，Node 会打死进程 ⇒ 响亮 + 跳过本轮（行态留给周期自检/对账裁活）
        console.log(`[runner] 单元收口异常（跳过本轮）: ${key}: ${errText(err)}`);
        await this._cond.wait(WAIT_TICK_MS);
      }
    }
  }

  /**
   * 单单元执行段（`_worker` 的 try/except/finally 三分支，runner.py:1073-1159 逐条照搬；
   * 独立成方法只为让单测能**手动 pump 一步**，见文件头差异⑩）。
   *
   * 分派：`c:` → `processCard`、`m:` → `await chat.runUnit`、`a:` → `deliverAnswerUnit`、
   * 其余 → `processTask`（三个口见 `setUnitHandlers`；未接线抛 `UnitHandlerMissing`）。
   * 终态：`t:` 行由 finally 落 done/failed；`c:` 行**不在 finally 收口**（跨轮持有归
   * `board.finish`），只在确定性「无会话」结局时收口；`a:`/`m:` 由执行体自洽。
   *
   * @param {string} key
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {Promise<{err: string, cardOk: boolean|null, error: Error|null}>} 观测面
   *   （Node 追加，行为零影响）：`err` = 截断后的异常文本（终于终态的那个）、`cardOk` =
   *   卡片单元结果、`error` = 原始异常对象（未接线时即 `UnitHandlerMissing`，供单测
   *   `instanceof` 判定）
   */
  async runPickedUnit(key, options = null) {
    const opts = this.opt(options);
    let err = '';                     // 单元异常文本（finally 终态用）
    let error = null;                 // 原始异常对象（观测面）
    let cardOk = null;                // 卡片单元结果（processCard 返回值）
    try {
      if (key.startsWith('c:')) {
        // `undefined` 归一为 `null`：JS 里「没写 return」的等价物正是 Python 的 `return None`
        // （卡片缺失或状态不符 ⇒ finally 走 cancel + 回滚收尾），不归一它会静默什么都不做
        const raw = await callUnitHandler('card', key, UNIT_HANDLERS.processCard,
          pyIntOr(key.slice(2), null));
        cardOk = raw === undefined ? null : raw;
      } else if (key.startsWith('m:')) {
        // 会话消息执行体（chat.js：投递并等 turn 结束）；自身吞异常并落消息状态
        await chat.runUnit(key.slice(2), opts);
      } else if (key.startsWith('a:')) {
        await callUnitHandler('answer', key, UNIT_HANDLERS.deliverAnswerUnit,
          pyIntOr(key.slice(2), null));
      } else {
        await callUnitHandler('task', key, UNIT_HANDLERS.processTask,
          pyIntOr(key.slice(2), null));
      }
    } catch (e) {                     // 保底：任何异常不拖死循环
      error = e;
      err = errText(e).slice(0, 300); // 影子层：finally 按 err 记失败终态
      if (key.startsWith('c:')) {
        // 卡片单元异常：记错到卡片（起会话失败的排队态回滚由 board.dequeue_start 自身负责）
        try {
          const cid = pyIntOr(key.slice(2), null);
          if (cid !== null) setCardLastError(cid, err, opts);
        } catch {
          // 照 Python `except Exception: pass`
        }
      } else if (key.startsWith('m:')) {
        // 消息单元异常：状态落盘由 chat.runUnit 内部负责，此处不记任务行
      } else if (key.startsWith('a:')) {
        // 答案执行体异常兜底（业务失败已在执行体内部分流，此处只防未预期异常把行永久挂在
        // starting）：放回 waiting 重入队（**带退避**，见文件头差异⑫②），不计业务重试额度；
        // 放回失败（行已被取消）则不再重入队
        console.log(`[runner] 答案单元异常（放回等待重投）: ${key}: ${err}`);   // 见文件头差异⑫①
        try {
          const arow = waitq.getActive(waitq.KIND_ANSWER, key.slice(2), opts);
          const notBefore = Date.now() / 1000 + ANSWER_EXC_BACKOFF_S;
          if (arow !== null && waitq.returnToWaiting(arow.id, notBefore, false, opts)) {
            this.submitAnswer(pyIntOr(key.slice(2), null), opts);
          }
        } catch {
          // 放回失败（行已被取消）则不再重入队
        }
      } else {
        const tid = pyIntOr(key.slice(2), null);
        if (tid !== null) {
          updateTask(tid, { status: 'failed', error: errText(e), ended_at: nowStr() }, opts);
          const n = this.skipPipelineChildren(tid, '前段任务执行失败，后段跳过', opts);
          await notifyTaskFailed(tid, errText(e), n, opts);
        }
      }
    } finally {
      if (key.startsWith('t:')) {
        // _procs 键保持 int task_id（stop() 里 `_procs.get(taskId)` 不变）
        this._procs.delete(pyIntOr(key.slice(2), null));
      }
      this._cond.notifyAll();
      // —— 等待项终态：answer/msg 由执行体自洽；t:/c: 直调（权威）——
      if (key.charAt(0) === 't') {
        waitq.finishByTarget(waitq.KIND_TASK, key.slice(2),
          err ? waitq.STATE_FAILED : waitq.STATE_DONE, err, opts);
      } else if (key.charAt(0) === 'c') {
        // 卡片行跨轮持有（归 board.finish 唯一收尾点）：此处只处理确定性「无会话」结局；
        // err（processCard 抛异常）时会话状态不明，保守不收口——残留由周期自检/重启对账裁活
        if (err) {
          waitq.finishByTarget(waitq.KIND_CARD, key.slice(2), waitq.STATE_FAILED, err, opts);
        } else if (cardOk === false) {
          waitq.finishByTarget(waitq.KIND_CARD, key.slice(2), waitq.STATE_FAILED,
            '起会话失败', opts);
          await this.boardFinish(key, '起跑失败回滚');
        } else if (cardOk === null) {
          waitq.cancel(waitq.KIND_CARD, key.slice(2), '卡片状态不符', null, opts);
          await this.boardFinish(key, '起跑失败回滚');
        }
      }
    }
    return { err, cardOk, error };
  }

  /**
   * `board.finish(key, reason)` 的缝调用（M5；见 `setBoardFinishHook`）：未接线只打一行、
   * 不抛；钩子自身抛异常照 Python「起跑失败回滚收尾失败（自检兜底）」打一行。
   *
   * @param {string} key
   * @param {string} reason
   * @returns {Promise<void>}
   */
  async boardFinish(key, reason) {
    if (BOARD_FINISH_HOOK === null) {
      console.log(`[runner] board.finish 未接线（M5）：${key}（${reason}）——收尾子步跳过`);
      return;
    }
    try {
      await BOARD_FINISH_HOOK(key, reason);
    } catch (e) {
      console.log(`[waitq] ${key} 起跑失败回滚收尾失败（自检兜底）: ${errText(e)}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // M6.5-R1：入口本体（runner.py:1161-1300）
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 看板卡片单元（`_process_card`，runner.py:1161）：项目串行位已由队列保证（拾取即行置
   * starting 占位）。落 doing + 起会话（快路径，无多轮循环），`c:` 行跨轮 running 直到
   * board 回调 `card_finished`——`cardStarted` 把行置 running 后不终态化（行即运行前缀
   * 成员，会话结束才收口落 done）。
   *
   * 起会话失败由 `board.dequeueStart` 清占位并回 `from_column` 列，用户重按开始重新入队。
   * 返回 `true`=起跑成功 / `false`=起会话失败 / `null`=卡片缺失或状态不符（调度判定用；
   * JS 的「没写 return」= Python `return None`，由 `runPickedUnit` 归一）。
   *
   * **async**（`board.dequeueStart` 是异步 IO，见文件头差异⑱⑲）：返回 promise，缝不变。
   *
   * @param {number} cardId
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {Promise<boolean|null>}
   */
  async processCard(cardId, options = null) {
    const opts = this.opt(options);
    const card = getBoardCard(cardId, opts);
    if (card === null || card === undefined || card.block_kind !== 'queue'
      || card.column_key !== 'doing') {
      return null;
    }
    const project = getProject(card.project_id, opts);
    if (project === null || project === undefined) return null;
    // 函数内动态 import 防循环（board.js 模块级 `import * as runnerMod from './runner.js'`；
    // 位置照 Python 的 `import board`：在两道校验之后，见文件头差异㉘）
    const board = await import('./board.js');
    if (await board.dequeueStart(project, card, opts)) {
      // 起跑证实：把 c: 行置 running（行即运行成员，此后占着项目运行位）+ 登记证据落行
      // （有 proc 补 pid——进程存活裁活证据，启动对账收口 CLI 卡残留的主路径）
      const ext = { desc: '卡片会话占用' };
      const pid = board.runPid(cardId);
      if (pid) ext.pid = pid;
      return Boolean(this.cardStarted(cardId, card.project_id, ext, opts));
    }
    return false;
  }

  /**
   * 任务单元轮次执行体（`_process_task`，runner.py:1188）：入口守卫 → 写 running →
   * 四类快路径（script_retest / stress 复压 / retest_bug 预标记 / pipeline payload 固化）
   * → 轮次循环（每轮重读任务行；停止/失败/复测收尾/rag 刷新/自动复测/停止条件）。
   *
   * **async**（`rag.refresh` / `notifyTaskFailed` / R2R3 的执行体都是异步，见差异⑱）。
   * `_run_round` / `_run_script_retest` / `_run_load_phase` / `_should_stop` 属后续批次
   * （R2/R3），本批**只写调用**：未实现即 `TypeError`（响亮，见差异㉕）。
   *
   * @param {number} taskId
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {Promise<void>}
   */
  async processTask(taskId, options = null) {
    const opts = this.opt(options);
    let task = getTask(taskId, opts);
    if (task === null || task === undefined || task.status !== 'queued') return;
    const project = getProject(task.project_id, opts);
    if (project === null || project === undefined) {
      updateTask(taskId, { status: 'failed', error: '项目不存在', ended_at: nowStr() }, opts);
      await notifyTaskFailed(taskId, '项目不存在', 0, opts);
      return;
    }
    const agent = agentFamily(project.agent_path);
    if (agent === RETIRED_FAMILY) {
      // 兜底防呆：存量项目仍绑着退场族可执行名/旧虚拟前缀（迁移脚本尚未执行）时，给明确
      // 错误，而不是静默按 dsh 跑或 AttributeError。
      updateTask(taskId, { status: 'failed', error: RETIRED_MSG, ended_at: nowStr() }, opts);
      await notifyTaskFailed(taskId, RETIRED_MSG, 0, opts);
      return;
    }
    updateTask(taskId, {
      status: 'running', started_at: nowStr(), error: '', ended_at: null,
    }, opts);

    // 脚本复测任务：平台直接批量执行各用例 verify.py，不经 agent 轮次
    if ((task.task_type || 'normal') === 'script_retest') {
      await this.runScriptRetest(project, task, opts);
      return;
    }

    // 复压：跳过 agent 轮，直接用现有方案包再跑一次发压运行。
    // 标记用后即清（对齐 fresh_prompt 纪律），避免异常重入时又跑成「只发压」。
    if ((task.task_type || 'normal') === 'stress' && task.load_rerun) {
      updateTask(taskId, { load_rerun: 0 }, opts);
      await this.runLoadPhase(project, getTask(taskId, opts), opts);
      return;
    }

    // 复测任务开始前：把关联 case 的 status.md 标记为「需要复测」
    if ((task.task_type || 'normal') === 'retest_bug') {
      this.markRetestCases(project, task, opts);
    }

    // 后段任务：固化前段任务期间产出的 bug 报告清单进 payload（创建时清单还不存在）；
    // 清单为空（前段没有产出任何 bug）则无事可做直接结束
    if ((task.task_type || 'normal') === 'pipeline') {
      const bugs = this.pipelineBugs(project, task.created_at, opts);
      const payloadObj = payloadObject(task.payload);
      payloadObj.bug_dirs = bugs;
      updateTask(taskId, { payload: pyJsonDumps(payloadObj) }, opts);
      if (!bugs.length) {
        updateTask(taskId, { status: 'done', ended_at: nowStr() }, opts);
        return;
      }
      // 照 Python：此处**不加** `None` 检查（任务行被并发删除时，下一行的
      // `task.current_round` 抛 TypeError，与 Python `task["current_round"]` 同形；
      // 异常落点归 `runPickedUnit` 的 except——绝不在这里静默成「假成功」）
      task = getTask(taskId, opts);
    }

    // 首轮不空跑：起始轮次 + 任务级停止条件
    let roundNo = task.current_round + 1;
    while (true) {
      if (this._stop_requested.has(taskId)) {
        updateTask(taskId, { status: 'stopped', ended_at: nowStr() }, opts);
        this.skipPipelineChildren(taskId, '前段任务已停止，后段跳过', opts);
        return;
      }
      const [exitCode, sessionId] = await this.runRound(project, task, roundNo, agent, opts);
      task = getTask(taskId, opts);                     // 每轮后刷新
      if (task === null || task === undefined) return;
      const newSid = sessionId || task.session_id;
      // fresh_prompt 只影响本轮提示词（续跑第一轮），用后即清
      updateTask(taskId, {
        session_id: newSid, current_round: roundNo, fresh_prompt: 0,
      }, opts);
      if (exitCode !== 0) {
        if (this._stop_requested.has(taskId)) {
          updateTask(taskId, { status: 'stopped', ended_at: nowStr() }, opts);
          this.skipPipelineChildren(taskId, '前段任务已停止，后段跳过', opts);
        } else {
          updateTask(taskId, {
            status: 'failed', error: `第 ${roundNo} 轮退出码 ${exitCode}`, ended_at: nowStr(),
          }, opts);
          const n = this.skipPipelineChildren(taskId, '前段任务执行失败，后段跳过', opts);
          await notifyTaskFailed(taskId, `第 ${roundNo} 轮退出码 ${exitCode}`, n, opts);
        }
        return;
      }
      // 日期范围复测（无 bug 报告）：首轮成功后解析 agent 输出的受影响用例清单写入
      // payload.only_cases（后续轮/续跑限定复测该子集，标记可见）
      if ((task.task_type || 'normal') === 'retest_bug'
        && (task.date_from || task.date_to) && roundNo === 1) {
        await this.parseRetestRangeCases(project, task, newSid, agent, roundNo, opts);
        task = getTask(taskId, opts);
        if (task === null || task === undefined) return;
      }
      // fix / retest_bug 任务收尾：更新 bug 报告状态
      this.applyBugResult(project, task, opts);
      // RAG 索引轮后刷新：探索/回归轮次可能新增用例（同项目串行窗口，无并发写库）；
      // 刷新失败仅记任务日志，不阻塞轮次收尾
      if (['normal', 'regression'].includes(task.task_type || 'normal')) {
        try {
          const stat = await rag.refresh(project.cases_root,
            (m) => this.logTaskLine(task, m, opts));
          if (stat && stat.enabled && stat.embedded) {
            this.logTaskLine(task, `RAG 索引刷新：新嵌 ${stat.embedded} 条`, opts);
          }
        } catch (exc) {
          this.logTaskLine(task, `RAG 索引刷新失败（忽略）：${errText(exc)}`, opts);
        }
      }
      // fix 任务 自动复测=开：修复成功后自动创建复测任务（去重）
      if ((task.task_type || 'normal') === 'fix' && task.auto_retest && !task.end_stage) {
        this.maybeAutoRetest(project, task, opts);
      }
      // 停止条件判定
      if (this.shouldStop(task, roundNo, opts)) {
        if ((task.task_type || 'normal') === 'stress') {
          // 压测：轮次条件恒为 1 轮 agent，随后进入平台发压阶段
          //（内部自管最终状态 done/failed/stopped，这里直接返回）
          await this.runLoadPhase(project, task, opts);
          return;
        }
        updateTask(taskId, { status: 'done', ended_at: nowStr() }, opts);
        return;
      }
      roundNo += 1;
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // M6.5-R1：bug / 复测联动（runner.py:1301-1519、1977-1994）
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 从 payload 解析关联 bug 报告目录名（`_linked_bug_dir`，runner.py:1301），无效返回 `null`。
   * `project` 形参照 Python 保留（本函数不读它）。
   *
   * @param {object} project
   * @param {object} task
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {string|null}
   */
  linkedBugDir(project, task, options = null) {          // eslint-disable-line no-unused-vars
    return payloadObject(task.payload).bug_dir || null;
  }

  /**
   * 前段任务 `created_at` 之后产出的 bug 报告目录名列表（`_pipeline_bugs`，runner.py:1308；
   * 按分钟粒度比较）。
   *
   * 目录名格式 `YYYYMMDD_HHMM_标题`；与 `since`（`YYYY-MM-DD HH:MM:SS`）的前 16 位字符串
   * 比较；目录不存在或无 bug 报告目录时返回空列表（`os.listdir` 的 OSError 整支吞掉）。
   * 目录名排序照 Python `sorted()`（码点序，见 `pySorted`）。
   *
   * @param {object} project
   * @param {string} since
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {string[]}
   */
  pipelineBugs(project, since, options = null) {         // eslint-disable-line no-unused-vars
    let names;
    try {
      names = fs.readdirSync(project.bug_dir);
    } catch {
      return [];                                        // 照 Python `except OSError: return []`
    }
    const sinceMin = String(since || '').slice(0, 16);
    const bugs = [];
    for (const n of pySorted(names)) {
      if (!BUG_DIR_RE.test(n)) continue;
      const key = `${n.slice(0, 4)}-${n.slice(4, 6)}-${n.slice(6, 8)} `
        + `${n.slice(9, 11)}:${n.slice(11, 13)}`;
      if (key >= sinceMin && isDir(pyJoin(project.bug_dir, n))) bugs.push(n);
    }
    return bugs;
  }

  /**
   * 复测任务开始前，把关联 case 的 `status.md` 状态改写为「需要复测」（`_mark_retest_cases`，
   * runner.py:1328）。
   *
   * payload 带 `only_cases`（脚本复测失败升级的复核任务）时只标记该子集，其余已通过用例的
   * 「通过」状态保持不动。改成功才记一行任务日志（`markCasesRetest` 的返回集）。
   *
   * @param {object} project
   * @param {object} task
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   */
  markRetestCases(project, task, options = null) {
    const opts = this.opt(options);
    const bug = this.linkedBugDir(project, task, opts);
    if (!bug) return;
    let caseIds = bugCases(pyJoin(project.bug_dir, bug)).ids;
    const only = payloadObject(task.payload).only_cases || [];
    if (only.length) {
      const onlySet = new Set(only);
      caseIds = caseIds.filter((cid) => onlySet.has(cid));
    }
    const marked = markCasesRetest(project.cases_root, caseIds);
    if (marked.length) {
      this.logTaskLine(task, `平台预标记复测用例：${marked.join('、')}`, opts);
    }
  }

  /**
   * 日期范围复测：首轮后解析「受影响用例：FS…」行 → `payload.only_cases`
   * （`_parse_retest_range_cases`，runner.py:1349）。
   *
   * 解析路径依次：① 会话最后 assistant 文本（`sessparse.load`）；② 轮次日志全文窗口匹配。
   * 两者皆无时按范围内变更文件粗筛兜底（`export_cases._match_level`）；仍无候选则只记日志、
   * 不限定范围。只保留案例库中真实存在的用例 id；结果写入 `payload.only_cases`。
   *
   * **async**：RAG 语义追加支里的 `rag.refresh` 是异步（Python 同步，见差异⑱）；异常语义
   * 照 Python 的 `except Exception`（检索失败静默跳过、维持原行为）。
   *
   * @param {object} project
   * @param {object} task
   * @param {string} sessionId
   * @param {string} agent 族名（只有 `dsh_plugin` 会走到这里）
   * @param {number} roundNo
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {Promise<void>}
   */
  async parseRetestRangeCases(project, task, sessionId, agent, roundNo, options = null) {
    const opts = this.opt(options);
    // 单族化后只有 dsh 插件族会走到这里：会话按 dsh 解析族读取
    if (agent !== 'dsh_plugin') return;
    const family = 'dsh';
    if (!sessparse.FAMILIES.includes(family)) return;
    let ids = [];
    if (sessionId) {
      try {
        const data = sessparse.load(family, sessionId, 'main', 0);
        for (const e of (data.entries || [])) {
          if (e.kind === 'assistant' && e.text) {
            ids = extractAffectedIds(e.text);
            if (ids.length) break;
          }
        }
      } catch {
        ids = [];                                       // 照 Python `except Exception: ids = []`
      }
    }
    if (!ids.length) {
      try {
        const logPath = pyJoin(runtimeDir(project.work_dir, LOG_DIR_NAME),
          `task_${task.id}_round_${roundNo}.log`);
        ids = extractAffectedIds(readText(logPath));
      } catch {
        ids = [];                                       // 照 Python `except OSError`（readText 不抛）
      }
    }
    // 只在案例库按 id 定位成功的用例子集才算数
    let chosen;
    let how;
    if (ids.length && findCaseDirs(project.cases_root, ids).length === new Set(ids).size) {
      chosen = ids;
      how = 'agent 判断';
    } else {
      chosen = [];
      how = '变更文件粗筛';
      const log = gitLogChanges(project.project_dir, task.date_from, task.date_to);
      if (log.ok) {
        const changed = log.files || [];
        const more = log.commits || [];
        for (const rec of scanCases(project.cases_root)) {
          if (rec.code_files.some((cf) => changed.some((ch) => matchLevel(cf, ch)))) {
            chosen.push(rec.id);
          }
        }
        if (!chosen.length && more.length === 1) {
          // 单提交且无文件（如仅 merge/rebase）不硬凑候选
        }
        chosen = pySorted(new Set(chosen));
        // RAG 语义追加：变更文件+提交摘录作 query，语义 top-k 中非路径命中者补充进候选
        //（path 级命中恒保留；检索失败静默跳过，维持原行为）。
        // 配置门：语义追加是增强能力，未配置 RAG 时保持现状（path 粗筛原行为）
        let sem = [];
        if (rag.load_config()) {
          let semMeta = null;
          try {
            [sem, semMeta] = await rag.retrieve_detail(project.cases_root,
              rag.change_query(log), 15);
          } catch {
            // 照 Python `except Exception: pass`（sem 保持 []）
          }
          // 向量路降级可见化：查询嵌入失败记任务日志（via 分布随 how 行体现）
          if (semMeta && semMeta.configured && !semMeta.vec_ok) {
            this.logTaskLine(task, `RAG 检索向量路失败，已降级 BM25：${semMeta.vec_error}`, opts);
          }
        } else {
          sem = [];
        }
        const chosenSet = new Set(chosen);
        const extra = sem.filter((r) => !chosenSet.has(r.id)).map((r) => r.id);
        if (extra.length) {
          chosen = chosen.concat(extra);
          const nVec = sem.filter((r) => String(r.via || '').includes('vec')).length;
          how = `变更文件粗筛+语义追加${extra.length}条`
            + `（检索 bm25+vec ${nVec} / 仅bm25 ${sem.length - nVec}）`;
        }
      }
      if (!chosen.length) {
        this.logTaskLine(task, '未解析到『受影响用例』行且变更文件粗筛无候选，本轮不限复测范围',
          opts);
        return;
      }
      this.logTaskLine(task, '未解析到『受影响用例』行，按范围内变更文件粗筛', opts);
    }
    const payload = payloadObject(task.payload);
    payload.only_cases = chosen;
    updateTask(task.id, { payload: pyJsonDumps(payload) }, opts);
    this.logTaskLine(task, `受影响用例（${how}）：${chosen.join('、')}`, opts);
  }

  /**
   * fix / retest_bug / pipeline 任务一轮成功后，按结果更新 bug 报告状态
   * （`_apply_bug_result`，runner.py:1435）。
   *
   * 联动范围由 `end_stage` 决定：实际执行了「复测」阶段才按用例通过情况定论；fix 终点=
   * 报告分析置「已分析」；复测任务「仅重新部署」（end=deploy）未复测不联动；存量行
   * （end 为空）维持拆块前行为。pipeline 的终点比较用 `stageIndex`（缺项抛错，见差异㉒）。
   *
   * @param {object} project
   * @param {object} task
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   */
  applyBugResult(project, task, options = null) {
    const opts = this.opt(options);
    const taskType = task.task_type || 'normal';
    const endStage = task.end_stage || '';
    if (taskType === 'fix') {
      if (endStage === 'retest') {
        this.judgeBugByCases(project, task, opts);
      } else if (endStage === 'analyze') {
        this.setBugStatus(project, task, '已分析', null, opts);
      } else {
        this.setBugStatus(project, task, '修复完成，待复测', null, opts);
      }
    } else if (taskType === 'retest_bug') {
      if (endStage === 'deploy') return;                // 仅重新部署：未复测，不联动
      this.judgeBugByCases(project, task, opts);
    } else if (taskType === 'pipeline') {
      // 后段：终点含复测阶段时逐枚定论清单内 bug
      if (stageIndex(endStage || 'report') < stageIndex('retest')) return;
      const bugDirs = payloadObject(task.payload).bug_dirs || [];
      for (const bug of bugDirs) this.judgeOneBug(project, task, bug, opts);
    }
  }

  /**
   * 按任务关联 bug 的用例当前通过情况定论（`_judge_bug_by_cases`，runner.py:1466；复测联动
   * 共用入口）。
   *
   * @param {object} project
   * @param {object} task
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   */
  judgeBugByCases(project, task, options = null) {
    const opts = this.opt(options);
    const bug = this.linkedBugDir(project, task, opts);
    if (!bug) return;
    this.judgeOneBug(project, task, bug, opts);
  }

  /**
   * 单枚 bug：关联用例全部通过 → 已修复（复测通过），否则 → 复测未通过
   * （`_judge_one_bug`，runner.py:1473）。
   *
   * @param {object} project
   * @param {object} task
   * @param {string} bug bug 报告目录名
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   */
  judgeOneBug(project, task, bug, options = null) {
    const opts = this.opt(options);
    const caseIds = bugCases(pyJoin(project.bug_dir, bug)).ids;
    if (casesAllPassed(project.cases_root, caseIds)) {
      this.setBugStatus(project, task, '已修复（复测通过）', bug, opts);
      this.logTaskLine(task, `${bug} 关联用例全部通过，bug 状态 → 已修复（复测通过）`, opts);
    } else {
      this.setBugStatus(project, task, '复测未通过', bug, opts);
      this.logTaskLine(task, `${bug} 存在未通过用例，bug 状态 → 复测未通过`, opts);
    }
  }

  /**
   * 自动复测：fix 任务一轮成功修复后，为同一 bug 创建一轮复测任务
   * （`_maybe_auto_retest`，runner.py:1483）。
   *
   * 去重：同 bug 已存在排队/运行中的复测任务时不重复创建（fix 任务重启重跑会再次进入此
   * 逻辑，靠该检查避免复测任务堆叠）；已完成的复测任务不拦截，允许再次发起复测。创建后
   * 日志中记录任务号。选型：关联用例全部已固化时直接走平台脚本复测（零 agent 成本）。
   *
   * @param {object} project
   * @param {object} task
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   */
  maybeAutoRetest(project, task, options = null) {
    const opts = this.opt(options);
    const bug = this.linkedBugDir(project, task, opts);
    if (!bug) return;
    for (const t of listTasks(task.project_id, opts)) {
      if (!['retest_bug', 'script_retest'].includes(t.task_type)
        || !['queued', 'running'].includes(t.status)) {
        continue;
      }
      if (payloadObject(t.payload).bug_dir === bug) {
        this.logTaskLine(task, '自动复测：同 bug 已有排队/运行中的复测任务，不再新建', opts);
        return;
      }
    }
    const m = BUG_DIR_RE.exec(bug);
    const name = `复测 ${m ? m[1] : bug}`;
    // 自动复测选型：关联用例全部已固化时直接走平台脚本复测（零 agent 成本）
    const caseIds = bugCases(pyJoin(project.bug_dir, bug)).ids;
    const taskType = bugCasesScripted(project.cases_root, caseIds)
      ? 'script_retest' : 'retest_bug';
    // db.insertTask 的字段袋是 camelCase（见文件头差异㉗）
    const tid = insertTask(task.project_id, {
      name, autoFix: 0, retest: '不复测', stopType: 'rounds', stopValue: '1',
      taskType, payload: pyJsonDumps({ bug_dir: bug }),
    }, opts);
    this.submit(tid, opts);
    this.logTaskLine(task, `自动复测：已创建复测任务 #${tid}「${name}」`, opts);
  }

  /**
   * 改写 `bug_report.md` 的 **状态** 字段（`_set_bug_status`，runner.py:1977；默认取任务
   * 关联 bug，pipeline 逐枚传入 `bugDir`）。
   *
   * @param {object} project
   * @param {object} task
   * @param {string} status
   * @param {string|null} [bugDir]
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   */
  setBugStatus(project, task, status, bugDir = null, options = null) {
    const opts = this.opt(options);
    const bug = bugDir || this.linkedBugDir(project, task, opts);
    if (!bug) return;
    setMdField(pyJoin(project.bug_dir, bug, 'bug_report.md'), '状态', status);
  }

  /**
   * 追加一行平台提示到该任务最新轮次日志（`_log_task_line`，runner.py:1985）。
   *
   * 无轮次行 / 无 log_path 时静默（照 Python）。**不吞任何异常**（见文件头差异㉖）：Python 的
   * `except (OSError, AttributeError)` 里 OSError 已由 `appendLog` 内吞掉、AttributeError 在
   * 本调用形状下不可达；`task` 为 `None` 时 Python `task["id"]` 抛的是 **TypeError（不在
   * except 元组里，真的外抛）**——Node 侧同抛（错误文本随语言不同，见差异㉖）。
   *
   * @param {object} task
   * @param {string} text
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   */
  logTaskLine(task, text, options = null) {
    const opts = this.opt(options);
    const rounds = listRounds(task.id, opts);
    if (rounds.length) {
      const logPath = rounds[rounds.length - 1].log_path;
      if (logPath) appendLog(logPath, `### ${text}\n`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // M6.5-R2：脚本复测族（runner.py:1519-1706）
  //
  // Python 侧的物理顺序是 `_spawn_retest_task` → `_set_bug_status` → `_log_task_line`，
  // 后两个已随 R1 落地；本批按「脚本复测族 → 压测发压族」的顺序追加在类末尾（方法快照
  // 顺序与语义无关，逐函数的 Python 行号在各方法注释里给）。
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 解析脚本复测任务的关联用例目录，并二次校验全部已固化（`_script_case_dirs`，
   * runner.py:1521）。
   *
   * 返回 `[[case_id, 目录绝对路径], …]`；bug 无效或存在未固化用例返回 `null`
   * （创建后脚本被删等竞态的防御，调用方整单回落 agent 复测）。`[case_id, dir]` 的
   * 二元组形态与 `lib.findCaseDirs` 同（Python 也是 list of tuple，量具转数组后同形）。
   *
   * @param {object} project
   * @param {object} task
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {Array<[string, string]>|null}
   */
  scriptCaseDirs(project, task, options = null) {
    const opts = this.opt(options);
    const bug = this.linkedBugDir(project, task, opts);
    if (!bug) return null;
    const { ids: caseIds } = bugCases(pyJoin(project.bug_dir, bug));
    const dirs = findCaseDirs(project.cases_root, caseIds);
    if (!dirs.length || dirs.length !== new Set(caseIds).size) return null;
    if (dirs.some(([, d]) => !isFile(pyJoin(d, VERIFY_SCRIPT_NAME)))) return null;
    return dirs;
  }

  /**
   * 执行脚本复测：并发跑各用例 `verify.py`，按退出码回写状态并联动 bug 报告
   * （`_run_script_retest`，runner.py:1539）。
   *
   * 退出码语义（flow.md「脚本固化与复测协议」）：0=通过；1=断言不符（疑似回归，状态保持
   * 「需要复测」并升级 agent 复核）；2=环境问题（跳过不计失败）。全部通过时 bug 报告 →
   * 「已修复（复测通过）」；有失败时报告状态不动，由升级的复核任务闭环（防脚本腐化误报
   * 直接定罪）。
   *
   * 并发形态：Python `ThreadPoolExecutor(SCRIPT_WORKERS)` + `as_completed`，**完成序**决定
   * `results`（进而决定 `failed_ids` 顺序与日志/事件序）。Node 用 `createCompletionPool`
   * 同口径（见该函数注释）；消费方提前退出（用户停止）时排队未启动的取消、在跑的最多等
   * 一个脚本超时周期（= `shutdown(wait=True, cancel_futures=True)`）。
   *
   * @param {object} project
   * @param {object} task
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {Promise<void>}
   */
  async runScriptRetest(project, task, options = null) {
    const opts = this.opt(options);
    const taskId = task.id;
    ensureRuntimeDirs(project.work_dir);
    const logPath = pyJoin(runtimeDir(project.work_dir, LOG_DIR_NAME),
      `task_${taskId}_round_1.log`);
    const roundId = insertRound(taskId, 1, logPath, 'agent', '', opts);
    const envLabel = String(project.env_label || '').trim() || '本机';

    const dirs = this.scriptCaseDirs(project, task, opts);
    if (dirs === null) {
      appendLog(logPath, '### 存在未固化/解析不到的用例，本任务不执行，改建 agent 复测任务\n');
      const bug = this.linkedBugDir(project, task, opts);
      if (bug) {
        this.spawnRetestTask(project, bug, [], logPath, '复测',
          { ...opts, exclude_task_id: taskId });
      }
      finishRound(roundId, 'done', 0, '前置校验未通过，已回落 agent 复测', logPath, opts);
      updateTask(taskId, { status: 'done', ended_at: nowStr() }, opts);
      return;
    }

    appendLog(logPath, `### 脚本复测开始 ${strftime(new Date(), '%H:%M:%S')}`
      + ` 用例 ${dirs.length} 条 环境=${envLabel}\n`);
    this.scriptLive(project, { phase: 'execute', stats: { passed: 0, failed: 0, skipped: 0 } });

    const results = [];                                   // [case_id, 退出码]，按完成顺序
    const pool = createCompletionPool(this.SCRIPT_WORKERS);
    try {
      for (const [cid, d] of dirs) {
        this.scriptLive(project, {
          phase: 'execute',
          current: { id: cid, relpath: path.relative(project.cases_root, d) },
          event: {
            ts: nowStr(), type: 'case_start', case_id: cid, message: '脚本复测开始',
          },
        });
        pool.submit({ cid, d, fn: () => this.runOneScript(d, envLabel, opts) });
      }
      while (true) {
        // 停止：取消排队未启动的脚本（已启动的最多等一个超时周期），不再消费剩余结果
        if (this._stop_requested.has(taskId)) break;
        const entry = await pool.next();
        if (entry === null) break;
        const { cid, d } = entry.job;
        if (!entry.ok) throw entry.error;                 // 照 `fut.result()`：异常原样外抛
        const [code, execName] = entry.value;
        this.scriptApplyStatus(d, code, envLabel, opts);
        const etype = { 0: 'case_pass', 1: 'case_fail' }[code] || 'case_skip';
        this.scriptLive(project, {
          event: {
            ts: nowStr(), type: etype, case_id: cid, message: `脚本退出码 ${code}（${execName}）`,
          },
        });
        appendLog(logPath, `### ${cid} exit=${code} 记录=${execName}\n`);
        results.push([cid, code]);
      }
    } finally {
      // 取消排队未启动的脚本；已启动的在跑脚本最多等一个超时周期
      await pool.drain();
    }

    if (this._stop_requested.has(taskId)) {
      appendLog(logPath, `### 脚本复测被停止 ${strftime(new Date(), '%H:%M:%S')}\n`);
      finishRound(roundId, 'failed', -1, '用户停止', logPath, opts);
      updateTask(taskId, { status: 'stopped', ended_at: nowStr() }, opts);
      return;
    }

    const passed = results.filter(([, c]) => c === 0).length;
    const failed = results.filter(([, c]) => c === 1).length;
    const skipped = results.filter(([, c]) => c !== 0 && c !== 1).length;
    const summaryLine = `SCRIPT_RETEST 通过${passed}失败${failed}环境跳过${skipped}`;
    appendLog(logPath, `### ${summaryLine} ${strftime(new Date(), '%H:%M:%S')}\n`);
    finishRound(roundId, 'done', 0, summaryLine, logPath, opts);
    this.scriptLive(project, {
      phase: 'done',
      stats: { passed, failed, skipped },
      current: {},
    });

    const bug = this.linkedBugDir(project, task, opts);
    if (bug) {
      if (results.length && failed === 0 && skipped === 0) {
        this.setBugStatus(project, task, '已修复（复测通过）', null, opts);
        appendLog(logPath, '### 关联用例全部通过，bug 状态 → 已修复（复测通过）\n');
      } else if (failed) {
        const failedIds = results.filter(([, c]) => c === 1).map(([cid]) => cid);
        this.spawnRetestTask(project, bug, failedIds, logPath, '复核',
          { ...opts, exclude_task_id: taskId });
      }
    }
    updateTask(taskId, { status: 'done', ended_at: nowStr() }, opts);
  }

  /**
   * 执行单个用例的 `verify.py`，落盘 execution 记录（`_run_one_script`，runner.py:1624）。
   *
   * 返回 `[归一化退出码, 记录文件名]`：超时/启动失败/非 0/1/2 退出码统一按 1（疑似回归）
   * 处理，输出全文存证；退出码 0/1/2 原样保留。
   *
   * **本族解释器口径**（M6.5 冻结，见文件头差异㉙）：用户夹具脚本是 agent 按协议生成的
   * Python（`verify.py`）⇒ 两侧都跑 python3（A 侧 `sys.executable`、B 侧 `which python3`
   * 解析出的绝对路径），`cwd=case_dir`、env 加 `TS_ENV_LABEL`。
   *
   * @param {string} caseDir
   * @param {string} envLabel
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {Promise<[number, string]>}
   */
  async runOneScript(caseDir, envLabel, options = null) {
    this.opt(options);                                    // 形参袋照契约收下（本函数只读环境）
    const execName = `execution_${strftime(new Date(), '%Y%m%d_%H%M')}_script.md`;
    const env = { ...process.env, TS_ENV_LABEL: envLabel };
    let code;
    let output;
    try {
      const proc = await runCapture([pythonExe(), VERIFY_SCRIPT_NAME], caseDir, env,
        this.SCRIPT_RETEST_TIMEOUT * 1000);
      code = proc.code;
      output = Buffer.concat([proc.stdout, proc.stderr]);
      if (![0, 1, 2].includes(code)) {
        // 非 0/1/2 的退出码（信号杀死/OOM/脚本 sys.exit(3) 等）按设计视同退出码 1
        // （疑似回归），避免被当作环境跳过导致复测闭环静默卡死
        output = Buffer.concat([output,
          Buffer.from(`\n### 非协议退出码 ${code}，按疑似回归处理\n`, 'utf8')]);
        code = 1;
      }
    } catch (err) {
      if (err instanceof ScriptTimeout) {
        code = 1;
        output = Buffer.concat([err.stdout, err.stderr,
          Buffer.from(`\n### 执行超时（>${this.SCRIPT_RETEST_TIMEOUT}s），按疑似回归处理\n`,
            'utf8')]);
      } else if (err instanceof ScriptSpawnError) {
        code = 1;
        output = Buffer.from(`### 脚本启动失败: ${errText(err)}\n`, 'utf8');
      } else {
        throw err;
      }
    }
    const head = `# 脚本复测执行记录\n\n- **时间**: ${strftime(new Date(), '%Y-%m-%d %H:%M')}\n`
      + `- **执行环境**: ${envLabel}\n- **退出码**: ${code}\n\n`
      + '## 脚本输出\n\n```\n'
      + output.toString('utf8') + '\n```\n';
    try {
      fs.writeFileSync(pyJoin(caseDir, execName), head, 'utf8');
    } catch { /* 照 Python `except OSError: pass`（目录不可写/不存在都不算失败） */ }
    return [code, execName];
  }

  /**
   * 按脚本退出码回写用例 `status.md` 的字段行（`_script_apply_status`，runner.py:1663；
   * 「执行记录」表不动，execution 文件即记录）。四行**顺序照 Python**（字段名寻址，
   * 顺序只影响首次写入时追加行的先后）。
   *
   * 写失败由 `setMdField` 内吞（照 Python `lib.set_md_field` 的 `except OSError`）。
   *
   * @param {string} caseDir
   * @param {number} code
   * @param {string} envLabel
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   */
  scriptApplyStatus(caseDir, code, envLabel, options = null) {
    this.opt(options);
    const status = { 0: '通过', 1: '需要复测' }[code] || '跳过';
    const summary = {
      0: '脚本复测通过',
      1: '脚本复测判定失败，待人工复核（见 execution_*_script.md）',
    }[code] || '脚本复测环境异常，跳过（见 execution_*_script.md）';
    const sp = pyJoin(caseDir, 'status.md');
    setMdField(sp, '状态', status);
    setMdField(sp, '最近执行时间', strftime(new Date(), '%Y-%m-%d %H:%M'));
    setMdField(sp, '执行环境', envLabel);
    setMdField(sp, '结果摘要', summary);
  }

  /**
   * 脚本复测/压测发压共用的 `live.json` 维护：读改写 + tmp 原子覆盖
   * （`_script_live`，runner.py:1675；结构沿用 agent 写入约定）。
   *
   * Python 是**全关键字形参**（`phase=` / `current=` / `event=` / `stats=` / `label=`）⇒
   * Node 收成一个 `opts` 袋（键名与 Python 一致，`label` 缺省 `'脚本复测'`），见文件头差异㉚。
   * 读失败（不存在/坏 JSON）按空对象；**非对象顶层照 Python 抛**（Python 的 `list["x"]=…`
   * / `None[...]` 是 TypeError，不在 `except (OSError, ValueError)` 里）。
   *
   * `current` 用 `is not None` 判定（Python `if current is not None:`）；`stats`/`event`
   * 用 Python 真值判定（空 dict 跳过）——JS 的 `{}` 是真值，故走 `rag.pyTruthy`。
   *
   * @param {object} project
   * @param {{phase?: string, current?: object, event?: object, stats?: object,
   *   label?: string}} [opts]
   */
  scriptLive(project, opts = {}) {
    const { phase = null, current = null, event = null, stats = null,
      label = '脚本复测' } = opts || {};
    const livePath = pyJoin(runtimeDir(project.work_dir, '.live'), 'live.json');
    let live;
    try {
      live = JSON.parse(fs.readFileSync(livePath, 'utf8'));
    } catch {
      live = {};                                          // 照 `except (OSError, ValueError)`
    }
    if (live === null || typeof live !== 'object' || Array.isArray(live)) {
      throw new TypeError('live.json 顶层不是对象（照 Python 在此抛 TypeError，非吞）');
    }
    live.updated_at = nowStr();
    if (phase) {
      live.phase = phase;
      live.phase_label = label;
    }
    if (current !== null) live.current_case = current;
    if (rag.pyTruthy(stats)) {
      const prev = live.stats;
      if (prev !== undefined && prev !== null
        && (typeof prev !== 'object' || Array.isArray(prev))) {
        throw new TypeError('live.json 的 stats 不是对象（照 Python `dict(...)` 抛，非吞）');
      }
      live.stats = { ...(prev || {}), ...stats };
    }
    if (rag.pyTruthy(event)) {
      const prev = live.events;
      const events = (prev === undefined || prev === null) ? [] : prev;
      if (!Array.isArray(events)) {
        throw new TypeError('live.json 的 events 不是列表（照 Python `append` 抛，非吞）');
      }
      events.push(event);
      live.events = events.slice(-200);
    }
    try {
      const tmp = `${livePath}.tmp`;
      fs.writeFileSync(tmp, pyJsonDumpsIndent(live, 1), 'utf8');
      fs.renameSync(tmp, livePath);
    } catch { /* 照 Python `except OSError: pass`（.live 不在等） */ }
  }

  // ══════════════════════════════════════════════════════════════════════
  // M6.5-R2：压测发压族（runner.py:1708-1985）
  // ══════════════════════════════════════════════════════════════════════

  /**
   * stress 任务的发压阶段：解析方案包 → 统一脚本驱动发压 → 报告与状态收尾
   * （`_run_load_phase`，runner.py:1708）。
   *
   * 驱动由 `loadcase.resolve` 四级回落：run.py 自定义脚本 / scenario.json 场景
   * （平台调 loadgen 的 run 子命令）/ 存量 `scenario_<id>.json`；都缺 → failed。
   * 两种驱动共用同一套托管（`spawnLoad`）：`cwd=方案包目录`、`TS_*` 环境变量、
   * stdout+stderr 进该次运行的日志、用户停止先落 stop 文件再宽限杀进程树、
   * 超时上限 `LOAD_MAX_SECONDS`。状态自管：非 0 退出/超时 → failed；用户停止 → stopped；
   * 正常结束 → done。
   *
   * 2026-10-06 复压批次：**一次调用 = 一次发压运行**（load run）。运行键 `run_key` = 本次
   * 开始时刻（秒级），日志/指标通道/旧快照/报告全部按它切分，同一方案包可反复运行且互不
   * 覆盖；运行在 rounds 表落一行 `kind='load'`（round_no 递增），任务状态跟随最近一次运行。
   *
   * `finally` 是**兜底**：任何支路（含未预期异常）退出前都把 `live.json` 收尾到 done，
   * 避免监控卡在发压中；各支路自身的收尾调用可带 stats（`scriptLive` 为读改写合并，
   * finally 不传 stats 即保留已写入的 `load_summary`）。
   *
   * @param {object} project
   * @param {object} task
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {Promise<void>}
   */
  async runLoadPhase(project, task, options = null) {
    const opts = this.opt(options);
    const taskId = task.id;
    ensureRuntimeDirs(project.work_dir);
    const runKey = loadcase.new_run_key();
    const logPath = loadcase.load_log_path(project.work_dir, taskId, runKey);
    const snapPath = loadcase.snapshot_path(project.work_dir, taskId, runKey);
    const metricsPath = loadcase.metrics_path(project.work_dir, taskId, runKey);
    const stopPath = loadcase.stop_file_path(project.work_dir, taskId);
    // 只清停止标记：产物按运行分文件，上一次运行的报告/曲线/日志都留着
    try {
      fs.rmSync(stopPath);
    } catch { /* 照 Python `except OSError: pass` */ }
    try {
      const roundId = insertRound(taskId, this.nextLoadRoundNo(taskId, opts), logPath,
        'load', runKey, opts);
      this.scriptLive(project, { phase: 'execute', label: '压力测试' });
      const c = loadcase.resolve(project.cases_root, taskId);
      if (c.driver === null) {
        await this.failLoad(project, task, roundId, logPath,
          `压测方案缺失（${c.case_dir} 下需有 run.py 或 scenario.json，`
          + `存量布局为 load/scenario_${taskId}.json）`, opts);
        return;
      }
      const [, chartsErr] = loadcase.load_charts(c.charts_path);
      if (chartsErr) appendLog(logPath, `### 图表声明回退默认面板：${chartsErr}\n`);
      // 报告目录是机器产物：在案例库 load/.gitignore 幂等补忽略项
      ensureGitignore(pyJoin(project.cases_root, 'load'), 'report/');
      const cmd = this.loadCmd(c, project, taskId, metricsPath, snapPath, logPath, runKey);
      appendLog(logPath, `### 压测开始 ${strftime(new Date(), '%H:%M:%S')}`
        + ` 运行键=${runKey} 驱动=${c.driver} cwd=${c.case_dir}\n`
        + `### CMD ${cmd.join(' ')}\n`);
      const [code, note] = await this.spawnLoad(project, taskId, c, cmd, logPath,
        stopPath, metricsPath, opts);
      await this.finishLoad(project, task, roundId, logPath, c, code, note,
        metricsPath, runKey, opts);
    } finally {
      // 兜底：未预期异常也落 phase=done（正常/停止路径重复调用一次，幂等无害）
      this.scriptLive(project, { phase: 'done', label: '压力测试' });
    }
  }

  /**
   * 下一次发压运行的 `round_no`：已有最大轮次 + 1（`_next_load_round_no`，runner.py:1770；
   * 首次发压恒为 2）。
   *
   * 轮次编号在任务内单调递增，重启（换方案）会清空轮次重新从 1 起算；`LOAD_ROUND_NO`
   * 只作为「首次发压」的历史基准保留。Python 是 `@classmethod`（读 `cls.LOAD_ROUND_NO`）
   * ⇒ Node 读 `Runner.LOAD_ROUND_NO`（见文件头差异㉛：写成实例方法以收末位 options 袋）。
   *
   * @param {number} taskId
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {number}
   */
  nextLoadRoundNo(taskId, options = null) {
    const opts = this.opt(options);
    const rows = listRounds(taskId, opts);
    return Math.max(Runner.LOAD_ROUND_NO - 1, ...rows.map((r) => r.round_no)) + 1;
  }

  /**
   * 发压命令行：`run.py` 直接跑；场景驱动走 loadgen 的 `run` 子命令
   * （`_load_cmd`，runner.py:1780）。**Python 是 `@staticmethod`，Node 写成实例方法**
   * （同文件头差异⑰的处置）：量具的 `seq` 只能经**实例**取方法（static 挂在构造函数上，
   * `inst[fn]` 取不到）⇒ 这是对拍可达性的硬约束；函数体不读 `this`，语义逐点照 Python。
   *
   * 脚本驱动传路径靠 `TS_*` 环境变量；场景驱动额外用命令行参数把指标/快照/日志/报告/
   * 运行键五处产物交给引擎（CLI 见 loadgen.main）。
   *
   * **本族解释器口径**（文件头差异㉙）：脚本驱动两侧都是 python3（用户脚本是 Python）；
   * 场景驱动是平台自己的引擎 —— A 侧 `[sys.executable, <repo>/loadgen.py, 'run', …]`、
   * B 侧 `[process.execPath, <repo>/backend/lib/loadgen.js, 'run', …]`，两侧 argv[0]/argv[1]
   * 是「本族解释器 + 本族入口」，**逐字节不可比是设计使然**（其余九处参数逐字节比）。
   *
   * @param {object} c `loadcase.resolve` 的返回包
   * @param {object} project
   * @param {number} taskId
   * @param {string} metricsPath
   * @param {string} snapPath
   * @param {string} logPath
   * @param {string} [runKey]
   * @returns {string[]}
   */
  loadCmd(c, project, taskId, metricsPath, snapPath, logPath, runKey = '') {
    if (c.driver === loadcase.DRIVER_SCRIPT) {
      return [pythonExe(), c.script_path];
    }
    return [process.execPath, pyJoin(ROOT_DIR, 'backend', 'lib', 'loadgen.js'), 'run',
      '--scenario', c.scenario_path,
      '--metrics', metricsPath, '--snapshot', snapPath, '--log', logPath,
      '--stop-file', loadcase.stop_file_path(project.work_dir, taskId),
      '--report-dir', loadcase.report_dir(project.cases_root),
      '--task-id', String(taskId), '--run-key', runKey];
  }

  /**
   * 托管发压进程：注入 `TS_*` 环境、登记进程表、处理停止与超时
   * （`_spawn_load`，runner.py:1796）。
   *
   * 返回 `[exit_code, 说明]`：`exit_code=null` 表示被平台杀掉（超时/停止宽限到）；
   * 说明文本用于日志与失败原因。停止走「先落 stop 文件 → 宽限 `LOAD_STOP_GRACE` →
   * 杀进程树」，与用户可见的「优雅停止」语义一致。`metricsPath` 为该次运行的指标通道
   * 路径（按运行键切分），脚本只读环境变量。
   *
   * 形态差异（文件头差异㉜）：`subprocess.STDOUT` → 同一 fd 传两次 `stdio[1]/stdio[2]`；
   * `start_new_session=True` → `spawnSession` 的 `detached: true`；`platcompat.kill_tree`
   * → `killTree`（口径差异见文件头旧②）；Python `Popen` 的同步 OSError → 等 Node 的
   * `'spawn'/'error'` 事件（`spawnSession` 注释）。
   *
   * @param {object} project
   * @param {number} taskId
   * @param {object} c
   * @param {string[]} cmd
   * @param {string} logPath
   * @param {string} stopPath
   * @param {string} metricsPath
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {Promise<[number|null, string]>}
   */
  async spawnLoad(project, taskId, c, cmd, logPath, stopPath, metricsPath,
    options = null) {
    this.opt(options);
    const env = { ...process.env };
    Object.assign(env, {
      TS_TASK_ID: String(taskId),
      TS_CASE_DIR: c.case_dir,
      TS_METRICS_FILE: metricsPath,
      TS_STOP_FILE: stopPath,
      TS_WORK_DIR: project.work_dir,
      TS_PROJECT_DIR: project.project_dir,
      TS_CASES_ROOT: project.cases_root,
      TS_MAX_SECONDS: String(LOAD_MAX_SECONDS),
      // 脚本可 import loadgen（MetricsWriter / 库函数）；输出不缓冲便于日志实时可读
      PYTHONPATH: ROOT_DIR + path.delimiter + (env.PYTHONPATH || ''),
      PYTHONUNBUFFERED: '1',
    });
    let proc = null;
    try {
      const fd = fs.openSync(logPath, 'a');               // 照 Python `open(log_path, "ab")`
      try {
        proc = spawnSession(cmd, { cwd: c.case_dir, env, stdio: ['ignore', fd, fd] });
        await waitSpawned(proc);                          // Popen 的同步 OSError ↔ 'error' 事件
      } finally {
        fs.closeSync(fd);                                 // 父进程不留 fd（子进程已各自 dup）
      }
    } catch (err) {
      return [null, `发压进程启动失败: ${errText(err)}`];
    }
    appendLog(logPath, `### PID ${proc.pid}\n`);
    this._procs.set(taskId, proc);
    const deadline = Date.now() + LOAD_MAX_SECONDS * 1000;
    let stopAskedAt = null;
    try {
      while (true) {
        const code = await waitExit(proc, LOAD_POLL_INTERVAL * 1000);
        if (code !== WAIT_TIMEOUT) return [code, ''];
        const now = Date.now();
        if (stopAskedAt === null && this._stop_requested.has(taskId)) {
          stopAskedAt = now;
          try {
            fs.writeFileSync(stopPath, 'stop\n', 'utf8');
          } catch { /* 照 Python `except OSError: pass` */ }
          appendLog(logPath, `### 收到停止请求 ${strftime(new Date(), '%H:%M:%S')}`
            + '，等脚本收尾\n');
        }
        if (stopAskedAt !== null && now - stopAskedAt >= LOAD_STOP_GRACE * 1000) {
          appendLog(logPath, '### 停止宽限期到，杀进程树\n');
          killTree(proc.pid, { sig: 'SIGTERM' });
          return [await this.waitKilled(proc), '用户停止'];
        }
        if (now >= deadline) {
          appendLog(logPath, `### 超过发压上限 ${LOAD_MAX_SECONDS}s，杀进程树\n`);
          killTree(proc.pid, { sig: 'SIGTERM' });
          return [await this.waitKilled(proc), `超过发压上限 ${LOAD_MAX_SECONDS}s`];
        }
      }
    } finally {
      // 与 agent 轮次同款：退出即摘除进程表（stop() 拿不到已死进程无副作用）
      this._procs.delete(taskId);
    }
  }

  /**
   * 杀进程树后短暂等待回收；仍未退出返回 `null`（`_wait_killed`，runner.py:1861；
   * Python 的 `timeout=5` 是**秒**，Node 侧参数名与单位改为 `timeoutMs=5000`，见差异㉝）。
   *
   * @param {import('node:child_process').ChildProcess} proc
   * @param {number} [timeoutMs]
   * @returns {Promise<number|null>}
   */
  async waitKilled(proc, timeoutMs = 5000) {
    const code = await waitExit(proc, timeoutMs);
    return code === WAIT_TIMEOUT ? null : code;
  }

  /**
   * 发压收尾：报告落盘 + round/task 状态 + `live.json`（`_finish_load`，runner.py:1868；
   * 状态自管）。
   *
   * 报告：场景驱动由 loadgen CLI 落盘（沿用其 JSON+Markdown 形状）；脚本驱动由平台按
   * summary 行生成最小报告 —— 两者同目录同命名规则（`task<id>_<运行键>`），读侧按运行键/
   * 最新取用，不区分驱动。**停止优先于退出码判定**。
   *
   * @param {object} project
   * @param {object} task
   * @param {number} roundId
   * @param {string} logPath
   * @param {object} c
   * @param {number|null} code
   * @param {string} note
   * @param {string} metricsPath
   * @param {string} [runKey]
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {Promise<void>}
   */
  async finishLoad(project, task, roundId, logPath, c, code, note, metricsPath,
    runKey = '', options = null) {
    const opts = this.opt(options);
    const taskId = task.id;
    const stopped = this._stop_requested.has(taskId);
    const values = loadcase.read_summary(metricsPath);
    const summaryLine = loadcase.summarize_values(values) + (stopped ? '（用户停止）' : '');
    const mdName = this.writeLoadReport(project, taskId, c, values, stopped, logPath,
      runKey, opts);
    if (stopped) {
      appendLog(logPath, `### 压测被停止 ${strftime(new Date(), '%H:%M:%S')}\n`);
      finishRound(roundId, 'failed', -1, `用户停止 ${summaryLine}`, logPath, opts);
      updateTask(taskId, { status: 'stopped', ended_at: nowStr() }, opts);
    } else if (code !== 0) {
      const tail = tailText(logPath);
      let err = note || `发压脚本退出码 ${code === null ? 'None' : code}`;
      if (tail) err = `${err}：${tail}`;
      await this.failLoad(project, task, roundId, logPath, err, opts);
      return;
    } else {
      appendLog(logPath, `### ${summaryLine} 报告=${mdName}\n`);
      finishRound(roundId, 'done', 0, summaryLine, logPath, opts);
      updateTask(taskId, { status: 'done', ended_at: nowStr() }, opts);
    }
    this.scriptLive(project, {
      phase: 'done', label: '压力测试', stats: { load_summary: summaryLine },
    });
  }

  /**
   * 报告落盘（`_write_load_report`，runner.py:1901）。**Python 是 `@staticmethod`，Node 写成
   * 实例方法**（理由同 `loadCmd`：`seq` 经实例调用 + 收末位 options 袋；函数体不读 `this`）。
   *
   * 脚本驱动由平台生成、场景驱动读 loadgen 已写的那份；返回报告文件名（Markdown，日志里
   * 记一行便于人查）；失败只记日志不改变状态（`except OSError` 兜整段，含 listdir）。
   * 「取最新」用 `mtimeNs`（BigInt 纳秒）比较，比 `mtimeMs` 更贴 Python `getmtime` 的精度。
   *
   * @param {object} project
   * @param {number} taskId
   * @param {object} c
   * @param {object} values
   * @param {boolean} stopped
   * @param {string} logPath
   * @param {string} [runKey]
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {string}
   */
  writeLoadReport(project, taskId, c, values, stopped, logPath, runKey = '',
    options = null) {
    void options;                                         // 形参袋照契约收下（本函数只碰文件）
    const repDir = loadcase.report_dir(project.cases_root);
    try {
      if (c.driver === loadcase.DRIVER_SCRIPT) {
        const payload = {
          case: path.basename(c.case_dir),
          driver: path.basename(c.script_path || ''),
          run_key: runKey,
          started_at: strftime(new Date(), '%Y-%m-%d %H:%M:%S'),
          duration_sec: '', stopped: Boolean(stopped),
          summary: values,
        };
        const [, mdPath] = loadcase.write_minimal_report(payload, repDir, taskId, runKey);
        return path.basename(mdPath);
      }
      // 场景驱动：loadgen 已按同一运行键落盘，直接回报文件名
      if (runKey) {
        const stem = loadcase.report_stem(repDir, taskId, runKey);
        if (isFile(`${stem}.md`)) return path.basename(`${stem}.md`);
      }
      const names = fs.readdirSync(repDir)
        .filter((n) => n.startsWith(`task${taskId}_`) && n.endsWith('.md'));
      if (names.length) {
        let newest = names[0];
        let stamp = fs.statSync(pyJoin(repDir, newest), { bigint: true }).mtimeNs;
        for (const n of names.slice(1)) {
          const t = fs.statSync(pyJoin(repDir, n), { bigint: true }).mtimeNs;
          if (t > stamp) { newest = n; stamp = t; }       // 并列取先见者（同 Python `max`）
        }
        return newest;
      }
    } catch (err) {
      appendLog(logPath, `### 报告写盘失败: ${errText(err)}\n`);
    }
    return '';
  }

  /**
   * 发压失败收尾（`_fail_load`，runner.py:1934；方案缺失/启动失败/非 0 退出/超时共用一条
   * 路径）。Python 侧同步调 `notify_task_failed`，Node 侧该口是 async ⇒ 本函数 async
   * （见文件头差异⑨同源理由），调用方一律 `await`。
   *
   * @param {object} project
   * @param {object} task
   * @param {number} roundId
   * @param {string} logPath
   * @param {string} err
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {Promise<void>}
   */
  async failLoad(project, task, roundId, logPath, err, options = null) {
    const opts = this.opt(options);
    appendLog(logPath, `### ${err}\n`);
    finishRound(roundId, 'failed', -1, err, logPath, opts);
    updateTask(task.id, { status: 'failed', error: err, ended_at: nowStr() }, opts);
    await notifyTaskFailed(task.id, err, 0, opts);
    this.scriptLive(project, {
      phase: 'done', label: '压力测试', stats: { load_summary: err },
    });
  }

  /**
   * 创建 agent 复测/复核任务（`retest_bug`），带同 bug 去重（`_spawn_retest_task`，
   * runner.py:1943）。
   *
   * `onlyCases` 非空时写入 payload（失败子集复核）；`exclude_task_id`（发起方任务 id，
   * script_retest 的升级/回落调用方，**进 options 袋、名字照 Python 关键字参数**）在去重时
   * 跳过。返回任务 id，去重命中返回 `null`。
   *
   * @param {object} project
   * @param {string} bug
   * @param {string[]} onlyCases
   * @param {string} logPath
   * @param {string} prefix
   * @param {{exclude_task_id?: number, db?: object, dbPath?: string,
   *   env?: NodeJS.ProcessEnv}} [options]
   * @returns {number|null}
   */
  spawnRetestTask(project, bug, onlyCases, logPath, prefix, options = null) {
    const opts = this.opt(options);
    const excludeTaskId = opts.exclude_task_id === undefined ? null : opts.exclude_task_id;
    for (const t of listTasks(project.id, opts)) {
      // 排除当前任务自身——升级/回落调用发生在自身置 done 之前，
      // 不跳过的话自身（running、同 bug_dir）恒命中去重，任务永远建不出来
      if (t.id === excludeTaskId) continue;
      if (!['retest_bug', 'script_retest'].includes(t.task_type)
        || !['queued', 'running'].includes(t.status)) {
        continue;
      }
      // 坏 JSON / 非对象 ⇒ 按 `{}`（照差异㉑的防御姿态；Python 只吃 ValueError）
      if (payloadObject(t.payload).bug_dir === bug) {
        appendLog(logPath, `### ${prefix}：同 bug 已有排队/运行中的复测任务，不再新建\n`);
        return null;
      }
    }
    const payload = { bug_dir: bug };
    if (onlyCases && onlyCases.length) payload.only_cases = onlyCases;
    const m = BUG_DIR_RE.exec(bug);
    const title = m ? m[1] : bug;
    const name = `${prefix} ${title}`;
    // db.insertTask 的字段袋是 camelCase（见文件头差异㉗）
    const tid = insertTask(project.id, {
      name, autoFix: 0, retest: '不复测', stopType: 'rounds', stopValue: '1',
      taskType: 'retest_bug', payload: pyJsonDumps(payload),
    }, opts);
    this.submit(tid, opts);
    const extra = (onlyCases && onlyCases.length) ? `仅含 ${onlyCases.join('、')}` : '';
    appendLog(logPath, `### ${prefix}：已创建复测任务 #${tid}「${name}」${extra}\n`);
    return tid;
  }

  // ══════════════════════════════════════════════════════════════════════
  // M6.5-R3：轮次族（runner.py:1996-2156）
  //
  // Python 侧的物理顺序是 `_log_task_line` → `_run_round` → `_run_round_dshplugin` →
  // `_wait_turn_end_dsh` → `_should_stop`，前一个已随 R1/R2 落地；本批按同序追加在类末尾。
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 执行一轮：交给本族实现（单族化后只剩 dsh 插件族）。返回 `[exitCode, sessionId]`
   * （`_run_round`，runner.py:1996）。
   *
   * P7b B4：kimi/claude/opencode/hermes/deepseek(CLI) 与 kimi_web/opencode_web 的轮次路径
   * （含本地子进程 spawn、CLI compact、status 轮询等 turn 结束）全部退场；退场族任务在
   * `processTask` 入口即以 `RETIRED_MSG` 失败，走不到这里。
   *
   * 非 `dsh_plugin` 抛 `RuntimeError(RETIRED_MSG)`——**同名 JS 错误类**（借 `prompts.js` 的
   * 导出），这样对拍里 `kind` 与 Python `type(exc).__name__` 逐字相同（见文件头差异㊲）。
   * 本函数与 `runRoundDshplugin` 都是 async（`dshdriver` 全族在 Node 侧是 Promise，见差异①）。
   *
   * @param {object} project
   * @param {object} task
   * @param {number} roundNo
   * @param {string} agent
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {Promise<[number, string]>}
   */
  async runRound(project, task, roundNo, agent, options = null) {   // eslint-disable-line no-unused-vars
    if (agent !== 'dsh_plugin') throw new prompts.RuntimeError(RETIRED_MSG);   // 防御：入口守卫漏了才会到这
    return this.runRoundDshplugin(project, task, roundNo, options);
  }

  /**
   * dsh 插件族一轮：进程内常驻会话 + followup 投递 + SSE 等 turn/end
   * （`_run_round_dshplugin`，runner.py:2007）。
   *
   * 关键差异（方案 §3.2 A2、§8.1；原为 CLI/web 两族共存时的对比，现为本族固有性质）：
   *   - 会话是 **dsh 宿主进程内的 agent**（插件持 handle），不是外部 CLI 子进程：round 1 建会话、
   *     续轮 resume，多轮共享同一上下文（消灭「每轮独立会话」）；
   *   - 轮次结束由插件推来的 turn/end 帧判定（零 status 轮询）；
   *   - 停止 = driver.cancel 优雅中断（保留已流式交付的文本），不是杀进程树；
   *   - 会话事件同时翻译成平台既有轮次日志行（`### PROMPT` + `{"role":...}`），故
   *     `read_dialogue` / 「修复过程」界面无需改动即可渲染；
   *   - 无 compact 调用：dsh 自己的 agent loop 管上下文压缩。
   *
   * **线程 → async 任务**（见文件头差异㊴）：Python 起 `threading.Thread(target=_dsh_stream_worker…)`
   * 再 `join(timeout=5)`；Node 起一个 async 任务存 promise，`finally` 里置停止标志后
   * `await Promise.race([task, 5s 定时器])`——**该任务的 rejection 只打一行**（Python 线程内
   * 异常只打 traceback，不带崩主流程）。停止信号用 `{aborted:false}` 对象（`feedInto` 认识
   * `{aborted}` 形态），`stream_stop.set()` ↔ `aborted = true`。
   *
   * @param {object} project
   * @param {object} task
   * @param {number} roundNo
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {Promise<[number, string]>}
   */
  async runRoundDshplugin(project, task, roundNo, options = null) {
    const opts = this.opt(options);
    ensureRuntimeDirs(project.work_dir);
    const logPath = pyJoin(runtimeDir(project.work_dir, LOG_DIR_NAME),
      `task_${task.id}_round_${roundNo}.log`);
    const roundId = insertRound(task.id, roundNo, logPath, 'agent', '', opts);
    let sid = task.session_id || '';
    const waiter = new TurnWaiter();
    const streamStop = { aborted: false };
    let streamTask = null;
    let exitCode;
    try {
      if (!(await driverAvailable())) {
        throw new DshDriverError(
          -1, 'dsh agent 驱动不可用（插件未安装/未启用，或 agents 服务未就绪）');
      }
      // 模型值统一 `provider/id`（模型下拉口径）；宿主 `/session` 不拆前缀，
      // 这里先拆成 provider + 裸 id 下传（无前缀的存量值 provider=''，沿用宿主当前 provider）
      const [modelProvider, modelId] = splitModel(
        String(task.model || '').trim() || String(project.model || '').trim());
      sid = await ensureSession(sid, project.project_dir, `task-${task.id}`, modelId, modelProvider);
      // 项目级思考等级（2026-10-04）：会话实时态里已有显式档位就保持（用户在会话详情页改过、
      // 以及上轮应用过的项目默认都记在这里），否则回落项目默认。best-effort：档位与模型不匹配
      // 等问题只记一行日志，本轮照常跑（**权限档不下发**：任务会话没有交互作答面，
      // manual(approval=ask) 会让轮次永久挂起等一个没人能答的审批）。
      const effort = sessionEffort(sid)
        || String(rowOpt(project, 'reasoning_effort') || '').trim();
      if (effort) {
        appendLog(logPath, `### 会话默认思考等级 effort=${effort}\n`);
        await applySessionDefaults(sid, modelId, modelProvider, effort, '',
          (t) => appendLog(logPath, t));
      }
      if (sid !== (task.session_id || '')) {
        // sid 在本轮开始即精确入库（不再等轮后从 stdout/mtime 猜）：会话窗口运行期间即可按
        // exact sid 读事件；续轮直接用同一 sid resume
        updateTask(task.id, { session_id: sid }, opts);
        appendLog(logPath, pyJsonDumps({
          role: 'meta', type: 'session.resume_hint', session_id: sid,
        }) + '\n');
      }
      appendLog(logPath, `### 会话 ${sid}（dsh 插件·进程内常驻）\n`);
      // 订阅必须先于投递：否则会漏掉紧跟 followup 的 turn/start
      const since = pyInt(pyGet(await driverStatus(sid), 'last_seq', null) || 0);
      streamTask = dshStreamWorker(sid, since, waiter, logPath, streamStop);
      const prompt = await buildPrompt(task, roundNo, (m) => this.logTaskLine(task, m, opts), opts);
      appendLog(logPath, `### PROMPT ${pyJsonDumps(prompt)}\n`);
      appendLog(logPath, `### 轮次 ${roundNo} 开始 ${strftime(new Date(), '%H:%M:%S')} `
        + 'driver=dsh_plugin\n');
      await driverPrompt(sid, prompt);
      exitCode = await this.waitTurnEndDsh(task, sid, waiter, logPath, opts);
    } catch (e) {
      if (!(e instanceof DshDriverError)) throw e;      // 照 Python：只吃 DshDriverError
      finishRound(roundId, 'failed', -1, `dsh 驱动调用失败: ${e}`, logPath, opts);
      updateTask(task.id, { error: `dsh 驱动调用失败: ${e}` }, opts);
      return [-1, task.session_id];
    } finally {
      streamStop.aborted = true;
      if (streamTask !== null) {
        // P7a 缺陷 C：stop 置位后 SSE 任务由 `sse.js` 的停止探针秒级唤醒（shutdown 连接打断
        // 阻塞读，实测 ~0.1s）。此前 stop 只在读返回后才被检查，SSE 空闲时要等下一帧 keepalive
        // ——真插件 15s，于是这里必然白等满 5s。timeout 仅作兜底，正常路径不会用满；流任务若真
        // 超时也由下一轮/后续订阅自然收口。
        await Promise.race([
          streamTask.catch((e) => {
            // Python：线程内异常只打 traceback，不带崩主流程（`feedInto` 自身已吞链路异常）
            console.log(`[runner] dsh 事件流任务异常（忽略）: ${errText(e)}`);
          }),
          joinTimeout(STREAM_JOIN_TIMEOUT_MS),
        ]);
      }
    }
    appendLog(logPath, `### 轮次 ${roundNo} 结束 ${strftime(new Date(), '%H:%M:%S')} `
      + `exit=${exitCode}\n`);
    const summary = readLiveSummary(project.work_dir);
    finishRound(roundId, exitCode === 0 ? 'done' : 'failed', exitCode, summary, logPath, opts);
    try {
      const stats = pyGetItem(JSON.parse(summary), 'stats');
      updateTask(task.id, { new_bugs: pyInt(pyGet(stats, 'new_bug_reports', 0)) }, opts);
    } catch (e) {
      // 照 Python `except (ValueError, TypeError, KeyError): pass` 逐条（OverflowError 不在
      // 元组里 ⇒ 外抛；`JSON.parse` 的 SyntaxError 对应 ValueError）
      if (!(e instanceof ValueError || e instanceof TypeError || e instanceof KeyError
        || e instanceof SyntaxError)) {
        throw e;
      }
    }
    return [exitCode, sid];
  }

  /**
   * 等事件流推来的 turn/end（零远端轮询；`_wait_turn_end_dsh`，runner.py:2097）。
   *
   * 结束条件：waiter 收到 turn/end 帧（completed→0 / aborted→130 / 其余→1）。
   * 本地 5s tick 只做三件事，都不碰远端：响应任务停止标记（再补一次 cancel 兜底）、
   * 检查 SSE 链路错误、检查 turn 是否压根没起来（宽限期内无 turn/start）。
   *
   * 形参映射：`waiter.wait_turn(5.0)` → `await waiter.wait(5000)`（毫秒，见差异②）；
   * `waiter.turn_reason`/`exit_code` → `waiter.turnReason`/`waiter.exitCode`。
   *
   * @param {object} task
   * @param {string} sid
   * @param {TurnWaiter} waiter
   * @param {string} logPath
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
   * @returns {Promise<number>} 轮次退出码
   */
  async waitTurnEndDsh(task, sid, waiter, logPath, options = null) {   // eslint-disable-line no-unused-vars
    const waitStarted = Date.now() / 1000;
    for (;;) {
      const event = await waiter.wait(5000);
      if (event === 'turn_end') {
        appendLog(logPath, `### 轮次结束 turn_reason=${pyStr(waiter.turnReason)}\n`);
        return waiter.exitCode;
      }
      if (event === 'interaction') {
        // 提问/审批已推给用户：本轮不结束（dsh 侧会话挂起等作答），记一行日志后继续等
        // turn/end（用户作答后同一 turn 继续跑）
        appendLog(logPath, '### 会话等待人工输入（提问/审批）\n');
        continue;
      }
      if (event === 'error') {
        appendLog(logPath, `### 事件流异常: ${waiter.error}\n`);
        return 1;
      }
      if (this._stop_requested.has(task.id)) {
        try {
          await driverCancel(sid);        // runner.stop 已调过一次，这里兜底
        } catch (e) {
          if (!(e instanceof DshDriverError)) throw e;
          appendLog(logPath, `### cancel 失败: ${e}\n`);
        }
        return 130;
      }
      if (!waiter.started && Date.now() / 1000 - waitStarted > this.DSH_TURN_START_GRACE) {
        appendLog(logPath, `### turn 未启动（${this.DSH_TURN_START_GRACE}s 未见 turn/start）\n`);
        try {
          await driverCancel(sid);
        } catch (e) {
          if (!(e instanceof DshDriverError)) throw e;
        }
        return 1;
      }
    }
  }

  /**
   * 任务级停止条件：轮数达到 / 累计新 bug 达到 / 截止时间到 / 运行时长达到，任一命中即停
   * （`_should_stop`，runner.py:2132）。
   *
   * `deadline` 支：Python 是 `db.now_str() >= stop_value.replace("T", " ")`，`except AttributeError`
   * ——`stop_value` 为 `None`/数字（无 `.replace`）时判「不停」；Node 侧对应的异常是 `TypeError`
   * （只有 `String` 有 `replace`），逐条对齐见文件头差异㊶。
   *
   * `duration` 支：秒数解析失败（`int()` 的 `ValueError`）、起始时刻缺失/格式不符
   * （`strptime` 的 `ValueError`）都判「不停」——Node 侧的对应异常是 `ValueError`（`pyInt`）与
   * `RangeError`（`localSeconds`）。
   *
   * 未知类型兜底只跑一轮（`round_no >= 1`）。
   *
   * @param {object} task
   * @param {number} roundNo
   * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options] 本函数不读库选项
   *   （`db.now_str()` 无参），为形参表契约保留
   * @returns {boolean}
   */
  shouldStop(task, roundNo, options = null) {   // eslint-disable-line no-unused-vars
    const stopType = task.stop_type;
    const stopValue = task.stop_value;
    if (stopType === 'rounds') {
      return roundNo >= pyInt(stopValue || '1');
    }
    if (stopType === 'bugs') {
      return pyInt(task.new_bugs || 0) >= pyInt(stopValue || '1');
    }
    if (stopType === 'deadline') {
      try {
        return nowStr() >= stopValue.replace('T', ' ');
      } catch (e) {
        if (e instanceof TypeError) return false;       // 照 Python `except AttributeError`
        throw e;
      }
    }
    if (stopType === 'duration') {
      // stop_value 为秒数：从任务开始时间起算，时长达到即停
      const startedRaw = task.started_at || task.created_at || '';
      const started = startedRaw.split('.')[0];
      try {
        const secs = pyInt(stopValue || '0');
        const startedTs = localSeconds(started);
        return Date.now() / 1000 - startedTs >= secs;
      } catch (e) {
        // 照 Python `except (ValueError, TypeError, OverflowError)`：int()/strptime/mktime
        // 三类失败都判「不停」（`started.split` 的异常发生在上面的 try 之外 ⇒ 照 Python 外抛）
        if (e instanceof ValueError || e instanceof TypeError || e instanceof OverflowError
          || e instanceof RangeError) {
          return false;
        }
        throw e;
      }
    }
    return roundNo >= 1;                                // 未知类型兜底只跑一轮
  }
}

// --------------------------------------------------------------------------
// 私有小工具（Runner 之后集中一处，供类内与模块级共用）
// --------------------------------------------------------------------------

/**
 * Python 解释器绝对路径解析失败（`pythonExe` 抛它）。
 *
 * 为什么值得一个具名错误：`_run_one_script` / `_load_cmd` 的脚本驱动支**必须**跑 python3
 * （用户夹具脚本是 agent 按协议生成的 Python）。PATH 里找不到就**响亮报错**——绝不回落
 * `'python3'` 字面量（那会把「找不到解释器」变成子进程 ENOENT 的假业务失败）、绝不抛空。
 */
export class PythonInterpreterMissing extends Error {
  constructor(message) {
    super(message);
    this.name = 'PythonInterpreterMissing';
  }
}

/** 解释器解析结果缓存（运行期只解析一次；`process.env.PATH` 在本进程生命周期内不变） */
let pythonExeCache = null;

/**
 * 解析本机 python3 的**绝对路径**（A 侧 `sys.executable` 的对应物，见文件头差异㉙）。
 * 用 `agents.whichSync`（`shutil.which` 的 POSIX 子集）；解析失败抛 `PythonInterpreterMissing`。
 *
 * @returns {string}
 */
export function pythonExe() {
  if (pythonExeCache === null) {
    const found = whichSync('python3');
    if (!found) {
      throw new PythonInterpreterMissing(
        'PATH 里找不到 python3（脚本复测的 verify.py 与发压 run.py 都是 Python 夹具脚本，'
        + '必须用本机 python3 解释器执行；不回落字面量 "python3"）',
      );
    }
    pythonExeCache = found;
  }
  return pythonExeCache;
}

/** 子进程超时（`subprocess.TimeoutExpired` 的对应物；带已收到的输出，照 `e.stdout/e.stderr`） */
class ScriptTimeout extends Error {
  constructor(stdout, stderr) {
    super('script timeout');
    this.name = 'ScriptTimeout';
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/**
 * 子进程**启动失败**（`subprocess` 的 OSError 分支：ENOENT/EACCES/坏 cwd 等）。
 * 与 `ScriptTimeout` 分开是为了让调用方照 Python 的 `except TimeoutExpired` / `except OSError`
 * 两条子句逐条对应（**不合并、不互相兜底**）。
 */
class ScriptSpawnError extends Error {
  constructor(cause) {
    super(cause && cause.message !== undefined ? cause.message : String(cause));
    this.name = 'ScriptSpawnError';
    this.cause = cause;
  }
}

/** `'exit'` 事件 → Python `returncode`：正常退出给 code，信号杀死给 `-signum`（照 CPython） */
function exitCodeOf(code, signal) {
  if (code !== null && code !== undefined) return code;
  if (signal) {
    const n = os.constants && os.constants.signals ? os.constants.signals[signal] : undefined;
    return typeof n === 'number' ? -n : -1;
  }
  return -1;
}

/**
 * 跑一个子进程并收全 stdout/stderr（`subprocess.run(capture_output=True, timeout=…)` 的
 * 最小等价物；M6.5-R2 私有）。
 *
 * 逐条对齐 CPython 的语义：
 *   - 超时：`process.kill()`（POSIX 上是 SIGKILL）后**继续收输出**，再抛 `TimeoutExpired`
 *     （带已收到的 stdout/stderr）；
 *   - 启动失败：抛 `ScriptSpawnError`（对应 `OSError`）；
 *   - 退出码：信号杀死 → `-signum`（见 `exitCodeOf`）；
 *   - `env` 是**完整环境**（调用方给 `{...process.env, …}`，照 `dict(os.environ)`）。
 *
 * @param {string[]} argv
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @param {number} timeoutMs
 * @returns {Promise<{code: number, stdout: Buffer, stderr: Buffer}>}
 */
function runCapture(argv, cwd, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new ScriptSpawnError(error));
      return;
    }
    const out = [];
    const err = [];
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch { /* 照 CPython `process.kill()`：尽力而为 */ }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ScriptSpawnError(error));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(err);
      if (timedOut) {
        reject(new ScriptTimeout(stdout, stderr));
        return;
      }
      resolve({ code: exitCodeOf(code, signal), stdout, stderr });
    });
  });
}

/** 等进程退出（毫秒）的哨兵：`waitExit` 超时返回它（Python `TimeoutExpired` 的返回位） */
const WAIT_TIMEOUT = Symbol('wait-timeout');

/**
 * 等进程退出最多 `timeoutMs`：退出给归一后的退出码，超时给 `WAIT_TIMEOUT`。
 * `proc.wait(timeout=…)` 的对应物（`waitKilled` / `spawnLoad` 的轮询都用它）。
 *
 * @param {import('node:child_process').ChildProcess} proc
 * @param {number} timeoutMs
 * @returns {Promise<number|typeof WAIT_TIMEOUT>}
 */
function waitExit(proc, timeoutMs) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve(exitCodeOf(proc.exitCode, proc.signalCode));
      return;
    }
    let timer = null;
    const onExit = (code, signal) => {
      if (timer !== null) clearTimeout(timer);
      resolve(exitCodeOf(code, signal));
    };
    proc.once('exit', onExit);
    timer = setTimeout(() => {
      proc.removeListener('exit', onExit);
      resolve(WAIT_TIMEOUT);
    }, timeoutMs);
  });
}

/**
 * 等 `spawn` 真正落地：`'spawn'` 事件解决，`'error'` 事件抛 `ScriptSpawnError`。
 * 存在理由是 Node 与 Python 的**失败时点**不同（Python `Popen` 同步抛 OSError，
 * Node 走事件）——见 `proc.spawnSession` 注释与文件头差异㉜。
 *
 * @param {import('node:child_process').ChildProcess} proc
 * @returns {Promise<void>}
 */
function waitSpawned(proc) {
  return new Promise((resolve, reject) => {
    proc.once('spawn', () => resolve());
    proc.once('error', (error) => reject(new ScriptSpawnError(error)));
  });
}

/**
 * 有界并发「完成序」池（Python `ThreadPoolExecutor(max_workers=limit)` + `as_completed`
 * 的等价物，M6.5-R2 私有）。
 *
 * 语义逐条照 `_run_script_retest` 的用法（runner.py:1560-1600）：
 *   - `submit` 全部先提交（排队），最多 `limit` 个在跑（提交序启动）；
 *   - `next()` 按**完成序**产出 `{job, ok, value|error}`（不是提交序）——完成序是可见行为，
 *     `results` 的顺序决定 `failed_ids` 与日志/事件序；
 *   - 消费方提前 `break` 后调 `drain()` = `shutdown(wait=True, cancel_futures=True)`：
 *     排队未启动的取消，已在跑的最多等一个脚本超时周期（本实现直接等它们收口）；
 *   - 任务抛出的异常按 `Future.result()` 口径在 `next()` 时**原样外抛**（不吞、不降级）。
 *
 * @param {number} limit
 * @returns {{submit: Function, next: Function, drain: Function}}
 */
function createCompletionPool(limit) {
  const queue = [];                    // 已提交未启动
  const running = new Set();           // 在跑的 Promise
  const done = [];                     // 完成序结果队列
  let notify = null;                   // 单消费者唤醒
  let closed = false;

  const wake = () => {
    if (notify !== null) {
      const fn = notify;
      notify = null;
      fn();
    }
  };
  const pump = () => {
    while (!closed && running.size < limit && queue.length > 0) {
      const job = queue.shift();
      const task = (async () => {
        try {
          return { job, ok: true, value: await job.fn() };
        } catch (error) {
          return { job, ok: false, error };
        }
      })();
      const tracked = task.then((entry) => {
        running.delete(tracked);
        done.push(entry);
        pump();
        wake();
      });
      running.add(tracked);
    }
  };

  return {
    submit(job) {
      queue.push(job);
      pump();
    },
    async next() {
      while (done.length === 0 && running.size > 0) {
        await new Promise((res) => { notify = res; });
      }
      return done.length > 0 ? done.shift() : null;
    },
    async drain() {
      closed = true;
      queue.length = 0;
      wake();
      await Promise.all([...running]);
    },
  };
}

/** Python `str.splitlines()` 的切分点（`\r\n` 算一个边界；比 `split("\n")` 多 8 个字符） */
const SPLITLINES_RE = /\r\n|\r|\n|\v|\f|\x1c|\x1d|\x1e|\x85|\u2028|\u2029/;

/** Python `str.splitlines()`（`_tail_text` 用；同 builtin-assets.js 的私有实现口径） */
function splitLines(text) {
  const s = String(text);
  return s.length === 0 ? [] : s.split(SPLITLINES_RE);
}

/**
 * 发压失败原因摘要：取日志尾部非平台标记行（`runner._tail_text`，runner.py:2351）。
 *
 * "### " 开头是平台自己写的进度/状态标记，对用户不是有效信息，故剔除；空行同样剔除；
 * 其余行各自 `strip()` 后用**单空格**连接，最后按**码点**取末尾 `limit` 个字符
 * （`" ".join(lines)[-limit:]`，照文件头差异㉔）。
 *
 * R2 曾以私有先行版本落地（差异㉟），R3 起本函数就是正式实现（`_finish_load` 与
 * 对拍用例共用同一份）。
 *
 * @param {string} logPath
 * @param {number} [limit]
 * @returns {string}
 */
export function tailText(logPath, limit = 300) {
  const lines = splitLines(readLogTail(logPath, 40))
    .map((ln) => ln.trim())
    .filter((ln) => ln && !ln.startsWith('### '));
  const joined = lines.join(' ');
  return [...joined].slice(-limit).join('');
}

/**
 * 建启动闸（`threading.Event` 的 Node 形态）：`promise` 被 await、`release()` 放行（幂等）。
 * @returns {{promise: Promise<void>, release: Function}}
 */
function createGate() {
  let release = null;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release: () => { if (release !== null) release(); } };
}

/**
 * 调用单元执行体（未接线抛具名错误 `UnitHandlerMissing`，文案点明到期里程碑）。
 *
 * @param {'task'|'card'|'answer'} port
 * @param {string} key 队列键（进文案）
 * @param {Function|null} fn 已注册的执行体
 * @param {number|null} unitId
 * @returns {Promise<any>}
 */
async function callUnitHandler(port, key, fn, unitId) {
  if (typeof fn !== 'function') {
    throw new UnitHandlerMissing(`${UNIT_HANDLER_MISSING[port]}：${key} 无法执行`);
  }
  return await fn(unitId);
}

/**
 * `json.loads(task["payload"] or "{}").get("parent_task_id")` 的防御版（见文件头差异⑮）：
 * 坏 JSON / 非对象 / 缺键一律 `null`（= 无前段）。
 * @param {unknown} payload
 * @returns {number|null}
 */
function payloadParentId(payload) {
  try {
    const parsed = JSON.parse(payload || '{}');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const pid = parsed.parent_task_id;
    if (pid === null || pid === undefined || pid === '') return null;
    return pyIntOr(pid, null);
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// M6.5-R3：日志 / 读侧族（runner.py:2159-2385 的模块级部分）
//
// Python 侧的物理顺序：`build_prompt` → `append_log`（M3 已落）→ `_content_text` →
// `dsh_event_to_log_line` → `_dsh_stream_worker` → `parse_session_hint` → 两个长度常量 →
// `read_dialogue`（M6 落 `taskjson.js`）→ `summary_entry_text` → `read_log_tail` →
// `_tail_text` → `read_live_summary`。其中 `readLogTail` / `tailText` 在 R2 已以私有先行版本
// 存在（差异⑭/㉟），本批转为正式导出（见差异㊹）。
// ══════════════════════════════════════════════════════════════════════════

/**
 * 本轮提示词选择：round 1 或 `fresh_prompt=1`（「继续」续跑第一轮）用完整首轮提示词；
 * 其余续轮用短提示词（`build_prompt`，runner.py:2159）。
 *
 * `log` 可选任务日志回调，透传首轮构建（日期范围复测的 RAG 检索统计落日志）。
 *
 * **async**（见文件头差异㊳）：`prompts.first_round_prompt` 在 Node 侧是 async（M6-4 的
 * 「prompt 构建要读 rag/提交摘录」异步着色）⇒ 本函数返回 Promise，调用方必须 `await`
 * （`runRoundDshplugin` 已 await）。`options` 是 `db.get_project` 的 Node 选项袋。
 *
 * @param {object} task
 * @param {number} roundNo
 * @param {((text: string) => void)|null} [log]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<string>}
 */
export async function buildPrompt(task, roundNo, log = null, options = null) {
  if (roundNo === 1 || task.fresh_prompt) {
    const project = getProject(task.project_id, options === null ? {} : options);
    return await prompts.firstRoundPrompt(project, task, log);
  }
  return prompts.nextRoundPrompt(roundNo, task);
}

/**
 * dsh 消息 content（块数组）里的 text 块拼接；非数组/无文本返回空串（`_content_text`，
 * runner.py:2180）。
 *
 * `isinstance(content, str)` → `typeof === 'string'`；`str(block.get("text") or "")` →
 * `pyStr(...)`（`None` 落 `""`，`True` 落 `"True"`——**不是** JS 的 `"true"`，见差异㊶）。
 *
 * @param {unknown} content
 * @returns {string}
 */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block !== null && typeof block === 'object' && !Array.isArray(block)
      && block.type === 'text') {
      parts.push(pyStr(block.text || ''));
    }
  }
  return parts.join('');
}

/**
 * 把 dsh 会话事件帧翻译成平台既有轮次日志行（`dsh_event_to_log_line`，runner.py:2193）；
 * 无需落盘的事件返回 `null`（照 Python `None`，**不是**空串——见差异㊸）。
 *
 * 复用 `read_dialogue` 已识别的三种行形态，因此「修复过程」界面零改动：
 *   - assistant/message → `{"role":"assistant","content":<文本>}`
 *   - tool/call → `{"role":"assistant","content":"","tool_calls":[{function:{name,arguments}}]}`
 *   - tool/result → `{"role":"tool","tool_call_id":<callId>,"content":<文本>}`
 * 其余事件（turn/step 边界、request/*、审批审计等）落到 `### ` 前缀的平台标记行，
 * 对用户可读但不参与对话渲染。
 *
 * @param {object} frame SSE 帧 `{seq, time, type, session_id, data}`
 * @returns {string|null} 行文本（含结尾换行）或 `null`
 */
export function dshEventToLogLine(frame) {
  const ftype = pyGet(frame, 'type', null);
  const data = pyGet(frame, 'data', null) || {};
  if (ftype === 'assistant/message') {
    const msg = pyGet(data, 'message', null) || {};
    const text = contentText(pyGet(msg, 'content', null));
    if (!text) return null;             // 只请求工具、无文本的 assistant 事件：由 tool/call 行承载
    const marker = pyGet(data, 'interrupted', null) ? '（本轮被中断，以下为已交付内容）' : '';
    return pyJsonDumps({ role: 'assistant', content: marker + text, tool_calls: [] }) + '\n';
  }
  if (ftype === 'tool/call') {
    return pyJsonDumps({
      role: 'assistant',
      content: '',
      tool_calls: [{
        function: {
          name: pyStr(pyGet(data, 'name', null) || ''),
          arguments: pyStr(pyGet(data, 'arguments', null) || ''),
        },
      }],
    }) + '\n';
  }
  if (ftype === 'tool/result') {
    const msg = pyGet(data, 'message', null) || {};
    let text = contentText(pyGet(msg, 'content', null));
    const err = pyGet(data, 'error', null) || {};
    if (rag.pyTruthy(err)) {
      text = (text ? `${text}\n` : '') + `[工具错误 ${pyGet(err, 'name', '')}: `
        + `${pyGet(err, 'code', '')} ${pyGet(err, 'reason', '')}]`;
    }
    return pyJsonDumps({
      role: 'tool',
      tool_call_id: pyStr(pyGet(msg, 'toolCallId', null) || ''),
      content: text,
    }) + '\n';
  }
  if (ftype === 'turn/end') {
    return null;                        // 结束行由 waitTurnEndDsh 统一写（含 reason）
  }
  if (ftype === 'driver/interaction') {
    return '### 会话等待人工输入（提问/审批已推给用户）\n';
  }
  if (ftype === 'user/message') {
    return null;                        // 平台 prompt 已由 ### PROMPT 行记录，避免重复
  }
  if (ftype === 'agent/status') {
    return null;
  }
  return null;
}

/**
 * SSE 订阅任务体：把会话事件翻译落日志并喂给 `TurnWaiter`（失败即唤醒等待者）
 * （`_dsh_stream_worker`，runner.py:2239）。
 *
 * 轮次主线程只等 waiter 的 turn/end，不做任何远端轮询——这是方案 §3.3「事件驱动替代轮询」
 * 在任务侧的落点。
 *
 * **停止信号在 `feedInto` 边界统一成函数**（照 `chat.js` 的既有形态）：调用方给它
 * `{aborted:boolean}` 对象（照 Python `threading.Event` 的 `is_set()` 语义，
 * `runRoundDshplugin` 里 `stream_stop.set()` ↔ `streamStop.aborted = true`）或直接给函数，
 * 这里归一成 `() => boolean` 再传给驱动。**为什么不把 `{aborted}` 对象直接交给 `feedInto`**：
 * `dshdriver.js:consumeEvents` 会把「带 `aborted` 布尔字段的对象」当成 **AbortSignal** 塞给
 * `fetch`（`opts.signal = stop`），普通对象没有 `addEventListener` ⇒ 实测
 * `### 事件流异常: signal.addEventListener is not a function`，整轮被判超时失败
 * （见 R3 记录「真问题」第 1 条；修 `dshdriver.js` 不在 R3 写作用域内）。
 *
 * **`null` 行不落盘**（见差异㊵）：Python 是 `append_log(log_path, None)` → `None.encode` 抛
 * AttributeError → 被 `feed_into.handle` 吞掉、**一个字节都不写**；Node 的 `appendLog` 走
 * `String(text)` 会把 `null` 写成字面量 `"null"` ⇒ 这里显式跳过，字节级同效。
 *
 * @param {string} sid
 * @param {number} since
 * @param {TurnWaiter} waiter
 * @param {string} logPath
 * @param {(() => any)|{aborted: boolean}|AbortSignal|null} stop
 * @param {((frame: object) => void)|null} [onFrame] Node 追加的可选附加处理（Python 无）
 * @returns {Promise<{frames:number,lastSeq:number,stopped:boolean}|null>}
 */
export function dshStreamWorker(sid, since, waiter, logPath, stop, onFrame = null) {
  const probe = typeof stop === 'function'
    ? () => Boolean(stop())
    : () => Boolean(stop !== null && stop !== undefined && stop.aborted === true);
  return feedInto(sid, since, waiter, probe, (frame) => {
    const line = dshEventToLogLine(frame);
    if (line !== null) appendLog(logPath, line);
    if (typeof onFrame === 'function') onFrame(frame);
  });
}

/**
 * 从日志尾部解析 `session.resume_hint` 的 session_id（`parse_session_hint`，runner.py:2250；
 * 只认最后的 meta 行）。无命中返回 `null`（照 Python `None`）。
 *
 * @param {string} logPath
 * @returns {string|null}
 */
export function parseSessionHint(logPath) {
  const text = readLogTail(logPath, 200);
  const found = [...text.matchAll(new RegExp(SESSION_HINT_RE.source, 'g'))];
  return found.length ? found[found.length - 1][1] : null;
}

/**
 * 对话条目的单行摘要（前端折叠态/列表用），避免渲染超长工具结果
 * （`summary_entry_text`，runner.py:2327）。
 *
 * `entry["kind"]` 是**下标取键**（缺键抛 `KeyError`，消息是键的 repr ⇒ Node 侧 `pyGetItem`
 * 同形，见差异㊶）；`user`/`meta` 不截断，`assistant`/`tool_result` 截到
 * `DIALOGUE_RAW_LIMIT`（**码点**口径，见差异㉔）；未知 kind 返回空串。
 *
 * @param {object} entry
 * @returns {string}
 */
export function summaryEntryText(entry) {
  const kind = pyGetItem(entry, 'kind');
  if (kind === 'user') return pyGet(entry, 'text', '');
  if (kind === 'assistant') return headText(pyGet(entry, 'text', ''), DIALOGUE_RAW_LIMIT);
  if (kind === 'tool_result') return headText(pyGet(entry, 'text', ''), DIALOGUE_RAW_LIMIT);
  if (kind === 'meta') return pyGet(entry, 'text', '');
  return '';
}

/** Python `s[:limit]` 的**码点**口径（非 str 抛 `TypeError`，照 Python 的下标语义；差异㉔） */
function headText(value, limit) {
  if (typeof value !== 'string') {
    throw new TypeError(`'${pyTypeName(value)}' object is not subscriptable`);
  }
  return [...value].slice(0, limit).join('');
}

/**
 * 读 `<工作目录>/.live/live.json` 的核心字段作为轮次摘要（JSON 字符串）
 * （`read_live_summary`，runner.py:2361）。
 *
 * 缺文件/读不动（Python `OSError`）或坏 JSON（Python `ValueError`）⇒ 空串；顶层非对象
 * （Python `live.get` 的 `AttributeError`，**不在** except 元组里）⇒ 外抛（见差异㊶）。
 * 四个键的**顺序**照 Python 的 dict 字面量（`pyJsonDumps` 保序）⇒ 与 `json.dumps` 逐字节同。
 *
 * @param {string} workDir
 * @returns {string}
 */
export function readLiveSummary(workDir) {
  const file = pyJoin(runtimeDir(workDir, '.live'), 'live.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return '';                                          // OSError（不存在/不可读/是目录）
  }
  let live;
  try {
    live = JSON.parse(raw);
  } catch {
    return '';                                          // ValueError（json.JSONDecodeError）
  }
  if (live === null || typeof live !== 'object' || Array.isArray(live)) {
    throw new AttributeError(`'${pyTypeName(live)}' object has no attribute 'get'`);
  }
  return pyJsonDumps({
    phase: pyGet(live, 'phase', ''),
    round: pyGet(live, 'round', null),
    stats: pyGet(live, 'stats', {}),
    stop_condition: pyGet(live, 'stop_condition', {}),
  });
}


// ══════════════════════════════════════════════════════════════════════════

/**
 * `startUnitSelfcheck` 幂等守卫（`_SELFCHECK_STARTED`）：生产路径（`stop=None`）重复启动直接
 * return；注入 stop 的单测路径不记账（每例自带终止信号）。
 */
let SELFCHECK_STARTED = false;

/**
 * 注册行判活探针（`set_liveness_probe`，runner.py:2385；board 注册，v3c 行口径）：仅在
 * `reconcileUnits` / `startUnitSelfcheck` 的锁外上下文调用，允许慢 REST（web busy）。
 *
 * 照 Python 措辞：`INSTANCE` 为 None 时直接 return（单例未构造 = 无处可注册）。
 *
 * @param {((row: object) => string|null)|null} fn 探针（返回 `alive`/`dead`/`unknown`/null）
 */
export function setLivenessProbe(fn) {
  if (INSTANCE !== null) INSTANCE._liveness_probe = fn;
}

/**
 * 启动对账收尾（`reconcile_units`，runner.py:2392；顺序硬约束：`runner.recover` →
 * `board.recover` 之后）：按活跃等待项行裁活（证据链见 `waitq.unitVerdict`——web busy 三态
 * 探针 / 任务与消息行状态 / 卡行存在性 / 行 evidence 的 pid 存活）；可证死 → 行收口
 * （标签「启动对账：可证明失效」），活/未知保留。处置清单逐条打日志 + 一行汇总
 * （活跃行数为 0 时也落一行：稳定的「对账已跑」证据）。**有收口必唤醒执行循环**。
 *
 * `INSTANCE` 为 None 时直接 return（照 Python）。`options` 缺省取 INSTANCE 的实例级选项袋。
 *
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}|null} [options]
 */
export function reconcileUnits(options = null) {
  const inst = INSTANCE;
  if (inst === null) return;
  const opts = inst.opt(options);
  const probe = inst._liveness_probe === undefined ? null : inst._liveness_probe;
  let nRows = 0;
  let nClosed = 0;
  for (const d of waitq.reconcileUnits(probe, opts)) {
    nRows += 1;
    if (d.closed) nClosed += 1;
    console.log(`[waitq] 对账 ${d.key}（项目 ${d.project_id}）：${d.verdict}`
      + (d.closed ? '，已收口' : ''));
  }
  console.log(`[waitq] 对账完成：活跃行 ${nRows} 条，收口 ${nClosed} 条`);
  if (nClosed) inst._cond.notifyAll();
}

/**
 * 等待项周期自检循环（`start_unit_selfcheck`，runner.py:2425）：**仅可证明失效**自动收口，
 * 其余告警；健康时静默。收口豁免：每拍注入 `BOARD_UNIT_MANAGED`（`board.unit_managed`）作
 * `managed` 判据——平台在管单元的行收尾归巡视，自检不越权。周期尾部顺带
 * `waitq.pruneFinished()` 回收终态行；`refreshExtRows` 钩子（未接线跳过）做外部条目周期对账。
 *
 * 形态（见文件头差异①②④）：Python 是 daemon 线程 + `_SELFCHECK_STARTED` 幂等守卫；Node 用
 * **递归 `setTimeout` + `unref()`**（首轮宽限 = 先等一个周期再首查；`unref` 保证进程不因此
 * 不退出），拍与拍之间**不重叠**（下一拍在本拍体跑完后才排）。
 *
 * `stop` 支持两种形态（缺省 `null` = 生产路径，走幂等守卫）：
 *   - **AbortSignal**：`signal.aborted` 或 `abort` 事件即终止（推荐，单测用
 *     `AbortSignal.timeout(ms)` 或自建 controller）；
 *   - **`{promise, cancel}`**：`promise` resolve 即终止（`cancel` 只在句柄上，形态自由）。
 * 传了 `stop` 就越过幂等守卫（同一进程可起多个受控实例，供单测）。
 *
 * `INSTANCE` 为 None 时直接 return（`null` 句柄）；循环内每拍重读 INSTANCE，拆离即自终。
 *
 * @param {number} [interval] 周期（秒；`SELFCHECK_INTERVAL`）
 * @param {number} [minAge] 行年龄豁免（秒；`SELFCHECK_MIN_AGE`）
 * @param {AbortSignal|{promise?: Promise<any>, cancel?: Function}|null} [stop]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}|null} [options]
 * @returns {{cancel: Function, done: Promise<void>}|null} 句柄（Node 追加：测试可确定性收尾）
 */
export function startUnitSelfcheck(interval = SELFCHECK_INTERVAL, minAge = SELFCHECK_MIN_AGE,
  stop = null, options = null) {
  if (INSTANCE === null) return null;
  if (stop === null || stop === undefined) {
    if (SELFCHECK_STARTED) return null;
    SELFCHECK_STARTED = true;
  }
  const intervalMs = Math.max(0, Number(interval) || 0) * 1000;
  let stopped = false;
  let timer = null;
  let finishLoop = null;
  const done = new Promise((resolve) => { finishLoop = resolve; });
  const onStop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    finishLoop();
  };
  if (stop && typeof stop.addEventListener === 'function') {          // AbortSignal
    if (stop.aborted) onStop();
    else stop.addEventListener('abort', onStop, { once: true });
  } else if (stop && typeof stop.then === 'function') {               // Promise
    stop.then(onStop, onStop);
  } else if (stop && stop.promise && typeof stop.promise.then === 'function') {
    stop.promise.then(onStop, onStop);
  }
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(tick, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();             // 见文件头差异④
  };
  const tick = async () => {
    timer = null;
    try {
      const inst = INSTANCE;
      if (inst === null) {          // 单例已拆（测试还原）：循环自终
        onStop();
        return;
      }
      const opts = inst.opt(options);
      const probe = inst._liveness_probe === undefined ? null : inst._liveness_probe;
      // managed：平台在管（_RUNS）单元的收口豁免判据（未接线传 null = 无豁免）
      const lines = waitq.selfcheckUnits(probe, minAge, BOARD_UNIT_MANAGED, opts);
      for (const line of lines) console.log(`[waitq-selfcheck] ${line}`);
      if (lines.some((l) => l.startsWith('自检收口可证死行'))) {
        // 自检收口的串行位立即唤醒执行循环补位（等下个外部事件会让排队单元无谓停滞）
        inst._cond.notifyAll();
      }
      if (BOARD_REFRESH_EXT_ROWS !== null) {
        try {
          await BOARD_REFRESH_EXT_ROWS('外部条目周期对账');
        } catch (e) {               // 同 Python 的兜底口径：只打一行，不打断自检
          console.log(`[waitq-selfcheck] 外部条目对账异常: ${errText(e)}`);
        }
      }
      const n = waitq.pruneFinished(undefined, opts);   // 周期尾部：终态等待项回收
      if (n) console.log(`[waitq-selfcheck] 终态等待项回收 ${n} 条`);
    } catch (e) {
      console.log(`[waitq-selfcheck] 异常: ${errText(e)}`);   // 循环不 crash
    }
    schedule();
  };
  schedule();
  return { cancel: onStop, done };
}
