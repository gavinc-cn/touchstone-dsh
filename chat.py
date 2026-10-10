#!/usr/bin/env python3
"""Touchstone session 对话管理：向已有 agent 会话续发消息（走统一队列，项目内串行）。

与 runner 的任务轮次执行的区别：
- 对话是用户在 session 窗口里随手发的单条消息，不走轮次/配额，但**进统一队列**：
  消息作为第三类单元（"m:<msg_id>"）入 runner 队列，项目忙时按入队顺序等待，
  项目空闲则立即执行——避免与项目内在跑的任务/卡片会话并发改同一份代码；
  单元执行期间持有项目占用，故该项目后续任务/卡片也要等它结束（双向串行）；
  turn 挂起等用户作答（driver/interaction）则提前让位（STATE_YIELDED，
  2026-09-27）——消息已送达、运行位释放，队首单元照常起跑，作答后会话恢复并
  重新成为占用源。
- 投递走 dsh 插件驱动（进程内会话，见 dshdriver）：写对话日志 → followup/steer →
  订阅事件流等 turn/end（零状态轮询；对话内容以 agent 自己的 session 存储为准，
  前端轮询 session 文件即可看到流式更新）；
- 会话登记在内存 _CHATS（session_id -> 记录），供状态查询与停止；消息登记 P3 起
  权威在 chat_msgs 表（等待项 wait_items kind=msg 管队列拾取互斥），重启后排队
  消息照常执行、执行中被中断的记 error（msg 重发非幂等不重投，见 recover）。

并发约束（由 server 层保证）：同一会话同时最多一个对话单元；同一会话可连发多条
消息（按入队顺序串行执行）。

排队消息「立即注入」（2026-09-14）：平台排队中的消息可不等队列，用户点按钮即
撤销排队并立即投递到目标会话（dsh：steer 注入当前 turn 的最近 step 边界，会话
空闲则立即起轮）——见 inject_now。

外部会话（C 批 T5，2026-10-10）：用户在 dsh GUI 里直跑/接管的会话（`owned:false`）
也可投递，但要先在**入队前**过 `_external_preflight`（宿主有活 agent ∧ 平台已向
驱动声明看管，`board._ensure_watch`）；前提不成立即抛 `DeliveryRefused`，消息
**不落 chat_msgs/wait_items 行**（「必然失败的静默排队」变成「发送即明确文案」）。
"""

import json
import os
import queue
import threading
import time

import db
import dshevents
import dshdriver
import lib
import runner
import waitq

# session_id -> {"task_id", "started_at", "message", "exit_code", "log_path"}
# dsh_plugin（路线 A）记录另带 "dsh_plugin": True 与 "since"（投递前会话 last_seq）：
# 会话活在 dsh 宿主进程内、无本地子进程，运行态以插件推来的事件/status 为准
_CHATS = {}
_lock = threading.Lock()

_MSG_SEQ = [0]                       # msg_id 自增序号（仅发号用；记录本体 P3 起在 chat_msgs 表）

MESSAGE_MAX = 20000  # 单条对话消息长度上限
STATE_QUEUED = "queued"          # 已入队，等项目空闲
STATE_RUNNING = "running"        # 正在执行（发送中 / 等 turn 结束）
STATE_DONE = "done"              # 已送达且 turn 结束
STATE_YIELDED = "yielded"        # 已送达；turn 挂起等作答，运行位已让出（2026-09-27）
STATE_ERROR = "error"            # 执行失败（error 字段为原因）
STATE_CANCELLED = "cancelled"    # 排队中被取消

MSG_KEEP_SEC = 600   # 终态记录保留时长（前端取过失败原因后回收）
MSG_MAX = 200        # 登记表规模上限（超出丢最旧的终态记录）
TURN_START_GRACE = 60  # turn 启动宽限（未见 turn/started 判未启动）
TICK = 2             # 等 turn 结束的本地检查节拍（秒，与 runner 轮次轮询一致）
# dsh 等 turn 结束的**总时限**（秒，P7a 缺陷 G 兜底；见 dsh_wait_turn）：
# 链路保活正常但服务端就是不推 turn/end 时，只等 TurnWaiter 会永远等下去——
# 实测（假 driver 单订阅缺陷期间）chat_msgs 卡 running、wait_items 的 m: 行卡
# starting 4 分钟以上、项目运行位永久被占，只有重启能解。到点写一行会话日志并按
# 「本轮结束」返回 None，让行收口、补位继续；纯本地 deadline，不引入远端轮询。
# 45 分钟口径：runner 侧没有轮次硬超时（一轮跑到 turn/end，唯一时间护栏是
# DSH_TURN_START_GRACE=120s 的「turn 压根没起来」），故取「一轮合法长跑」的
# 经验上限，够长到不误杀正常长轮；环境变量可覆盖（单测调小用）。
DSH_WAIT_TURN_TIMEOUT = 2700.0
DSH_WAIT_TURN_TIMEOUT_ENV = "TS_DSH_WAIT_TURN_TIMEOUT"


class InjectRefused(RuntimeError):
    """「立即注入」被拒（消息已不在排队中 / 不支持注入）：消息未动，仍在队列。

    与投递失败的区分：被拒 → 端点 400、消息继续排队；投递失败 → 端点 502、
    消息按原位次退回排队（return_to_waiting 不动 seq，见 inject_now）。
    """


class DeliveryRefused(RuntimeError):
    """外部会话投递前置闸拒绝（C 批 T5，2026-10-10）：消息**未入队、未落行**。

    与投递失败（`DshDriverError`，消息落 `chat_msgs.state=error`）的区分：本异常在
    入队**之前**由 `_external_preflight` 抛出，chat_msgs/wait_items 都查不到这次
    发送——把「必然失败的静默排队（用户等 16ms 才看到 404 + toast）」变成「点发送
    即刻的明确文案」。触发面只有外部会话（`owned:false`）且前提不成立：
    宿主无活 agent（会话已结束）/ 看管声明失败（未获投递许可）/ 回滚阀关闭。
    池内会话与未对齐（未知）路径**不会**抛本异常（不变量：现状一个字节不变）。
    """


# 外部会话投递总开关（回滚阀，设计 §10）：`TS_EXTERNAL_DELIVER=0` ⇒ 外部会话一律
# 拒投（前置闸退化为「外部会话一律拒绝」），池内会话完全不受影响。**每次调用现读**
# （与 `_dsh_wait_turn_limit` 同口径）：值在进程内可热改，不必重启平台。
EXTERNAL_DELIVER_ENV = "TS_EXTERNAL_DELIVER"


# 可会话续聊的 agent 族（P7b 单族化：只剩 dsh 插件形态）。
# dsh_plugin（路线 A）：会话在 dsh 宿主进程内常驻，投递 = followup/steer，
# 且 sid 由插件在轮次开始即精确返回（不再靠 mtime 猜）。已退场族不在列——
# 会话窗对它们不再显示输入区，服务端 chat 端点也按「族已下线」拒绝。
CHAT_FAMILIES = ("dsh_plugin",)


# ---------- 消息登记（统一队列单元的状态侧；P3 起权威在 chat_msgs 表） ----------

def _new_msg_id():
    """消息 id：毫秒时间戳-自增序号（无冒号，可直接作队列键后缀）。"""
    with _lock:                      # 与 _CHATS 共用模块锁（消息登记锁已随表退场）
        _MSG_SEQ[0] += 1
        return f"{int(time.time() * 1000)}-{_MSG_SEQ[0]}"


def _external_deliver_enabled():
    """外部会话投递是否开启（`TS_EXTERNAL_DELIVER=0` 关闭；缺省/非法值按开启）。"""
    return (os.environ.get(EXTERNAL_DELIVER_ENV) or "").strip() != "0"


def _external_preflight(sid):
    """投递前置闸（C 批 T5）：外部会话前提不成立时 **raise DeliveryRefused**（不入队）。

    判定阶梯（设计 §5.2；顺序即优先级）：
      ① 空 sid ⇒ 放行（既有路径自己报「会话 id 为空」，不改语义）；
      ② 注册表未知（`dshevents.get` 为 None：未连接 / 没见过该 sid）⇒ 放行；
      ③ 注册表未对齐（`dshevents.aligned()` 为假：热重载后 /live 空表，快照不可信）
         ⇒ 放行——**未知 ≠ 外部**，绝不据不可信快照拒投（与「断连=未知」同一不变量）；
      ④ `owned` 为真（平台自持会话）⇒ 放行，走池内原路**一个字节不变**；
      ⑤ 其余＝外部会话（用户在 dsh GUI 里直跑/接管）：要求「宿主有活 agent」
         （`status != 'unknown'`，同插件 `live ? live.status : 'unknown'` 口径）
         ∧「看管声明成功」（`board._ensure_watch`，幂等，失败不重试）——任一不满足
         即拒投，并按分类文案抛错。
    回滚阀 `TS_EXTERNAL_DELIVER=0`：第 ⑤ 步整段退化为「外部会话一律拒绝」（连看管
    都不声明），池内/未知路径照旧放行。

    为什么放在 `submit` 首行：投递的**唯一入口**是统一队列（chat_msgs 行 + m: 等待项
    一个事务），一旦落行就必然要等 worker 拾取、失败也只能落 error 终态——闸必须在
    落行之前。**循环导入红线**：`board` 顶层 `import chat`，故 `import board` 写在
    函数体内（同文件 `_rebuild_run`/`_rebuild_inject` 既有先例）。
    """
    if not sid:
        return
    st = dshevents.get(sid)
    if st is None:
        return                      # 未知：保持现状（真失败仍由投递错误兜底）
    if not dshevents.aligned():
        return                      # 不可信快照：不据此拒投（未知 ≠ 外部）
    if st.get("owned"):
        return                      # 平台自持会话：池内原路
    # —— 以下为外部会话（用户在 dsh GUI 直跑/接管）：需要显式许可 ——
    if not _external_deliver_enabled():
        raise DeliveryRefused(
            "该会话是 dsh 直跑会话，平台已关闭外部会话投递"
            f"（{EXTERNAL_DELIVER_ENV}=0），请到 dsh 会话窗口发送")
    if str(st.get("status") or "") == "unknown":
        # 宿主里没有活 agent（会话已结束/被销毁）：投递必然 404，别让用户白等
        raise DeliveryRefused("会话已结束，无法投递（宿主无活动 agent）")
    import board                    # 函数内 import：board 顶层 import chat，防循环导入
    if not board._ensure_watch(sid):
        raise DeliveryRefused(
            "该会话是 dsh 直跑会话，平台未获投递许可（看管声明失败：插件过旧或不可达），"
            "请到 dsh 会话窗口发送")


def submit(project_id, sid, message, task_id=None, card_id=None, comment_id=None,
           inject=False, family="", model="", extra_meta=None):
    """登记一条会话消息并投入统一队列（项目忙则排队，空闲则立即执行）。

    P3 起权威在 chat_msgs 表 + msg 等待项（waitq.msg_enqueue 一个事务双写）。
    执行体不再用闭包（闭包不可持久化，设计 §5.3）：family/model 在提交时定格进
    等待项 meta，执行时按行＋快照重建（_rebuild_run，与闭包捕获语义等价）；
    dsh_plugin 的消息可「立即注入」（_rebuild_inject）。
    comment_id：卡片评论投递路径的评论行 id（终态写回 db.update_board_comment 用），
    随 meta 持久化（chat_msgs 无此列，P3 计划裁决 R1）。
    extra_meta：调用方附加载荷（如飞书回流的 {"feishu": {...}}），键与
    family/model/comment_id **平铺**进同一个 meta；键名由调用方自带命名空间
    （飞书侧统一 `{"feishu": {...}}`），避免与既有键相撞。
    task_id 与 card_id 同时为空＝纯会话消息（飞书通用对话等）：无任务轮次、无
    卡片评论写回，按行重建时走纯会话投递分支（见 _rebuild_run/_rebuild_inject）。
    runner 单例不可用（单测/独立脚本）时同步执行并原样抛出异常（保持既有行为，
    行照常落表、不写等待项——P5 R13 收口：无拾取方，等待项只会成为孤儿行）。
    返回消息记录 dict（含 id/state/queued，供端点响应）。
    """
    _external_preflight(sid)        # 首行前置闸（C 批 T5）：外部会话未获许可即拒投（不落行）
    msg_id = _new_msg_id()
    waitq.msg_prune(MSG_KEEP_SEC, MSG_MAX)          # 终态回收（msg_prune 表版，R8）
    inst = runner.INSTANCE
    payload_meta = {"family": family, "model": model,
                    **({"comment_id": comment_id} if comment_id else {}),
                    **(extra_meta or {})}
    waitq.msg_enqueue(msg_id, project_id, sid, message, task_id=task_id,
                      card_id=card_id, inject=bool(inject),
                      meta=payload_meta, queue=inst is not None)
    if inst is None:
        # 无统一队列：同步执行（异常上抛）；消息行照常落表、不写等待项
        # （P5 R13 收口：孤儿等待项清零）。载荷不经等待行重建——提交参数直传。
        if not waitq.msg_claim(msg_id):
            return {"id": msg_id, "state": STATE_QUEUED, "queued": False}
        try:
            res = _rebuild_run(msg_id, meta=payload_meta)()
        except Exception as e:
            waitq.msg_finish(msg_id, STATE_ERROR, str(e)[:300])   # error 落行（⑧）+ 随异常上抛给端点
            raise
        final = STATE_YIELDED if res == STATE_YIELDED else STATE_DONE
        waitq.msg_finish(msg_id, final)
        return {"id": msg_id, "state": final, "queued": False}
    # 提交时项目已被占用 → 本消息必然排队（前台据此显示「排队中」）
    queued = bool(inst.unit_busy(project_id))
    inst.submit_msg(msg_id, project_id, sid)
    return {"id": msg_id, "state": STATE_QUEUED, "queued": queued}


def _msg_meta(wrow):
    """等待项行 meta 解析（坏 JSON 按空对象；与 board 执行体同型）。"""
    try:
        meta = json.loads((wrow["meta"] if wrow is not None else "") or "{}")
        return meta if isinstance(meta, dict) else {}
    except ValueError:
        return {}


def _msg_payload(msg_id):
    """执行体重建的公共载荷（消息行 / 等待项 meta / 项目行）。

    family/model 为提交时快照（裁决 R2，与闭包捕获等价）；project 行执行时
    现读（与任务轮次同口径）；项目缺失抛 RuntimeError（落消息 error）。"""
    row = waitq.msg_get(msg_id)
    if row is None:
        raise RuntimeError("消息行不存在")
    meta = _msg_meta(waitq.get_active(waitq.KIND_MSG, msg_id))
    project = db.get_project(row["project_id"])
    if project is None:
        raise RuntimeError("项目不存在")
    return row, meta, project


def _rebuild_run(msg_id, meta=None):
    """按行重建消息执行体（P3：闭包改按 kind 分派——设计 §5.3/§6.2）。

    纯会话消息（task_id 与 card_id 皆空，如飞书通用对话）→ _send_now（合成
    task dict 只为沿用既有调用形状：单族世界里 _send_now 只做族校验与 dsh 分派，
    不再消费其中的 id/model）；
    任务侧消息（task_id 非空）→ _send_now（合成 task dict 同上）；
    卡片评论（card_id 非空）→ board._deliver_unit（合成 card/comment dict，
    执行体只消费 id/session_id/model 与 comment id）；
    函数内 import 防循环（同 runner._worker 对 board 的先例）。
    meta：调用方已有载荷时直接给定（P5 R13 同步路径不写等待项，提交时定格的
    family/model 无行可重建，由 chat.submit 透传；缺省读等待项行）。"""
    row, _meta, project = _msg_payload(msg_id)
    if meta is None:
        meta = _meta
    if row["task_id"] is None and row["card_id"] is None:
        # 纯会话消息（飞书通用对话等）：无任务无卡片，直接投递会话
        return lambda: _send_now({"id": None, "model": meta.get("model", "")},
                                 project, meta.get("family", ""),
                                 row["sid"], row["message"], bool(row["inject"]))
    if row["task_id"] is not None:
        task = {"id": row["task_id"], "model": meta.get("model", "")}
        return lambda: _send_now(task, project, meta.get("family", ""),
                                 row["sid"], row["message"], bool(row["inject"]))
    card = {"id": row["card_id"], "session_id": row["sid"],
            "model": meta.get("model", "")}
    comment = {"id": meta.get("comment_id") or 0}
    import board
    return lambda: board._deliver_unit(project, card, comment,
                                       row["message"], bool(row["inject"]))


def _rebuild_inject(msg_id):
    """「立即注入」投递体重建（与 _rebuild_run 同载荷源）：
    纯会话消息（task_id 与 card_id 皆空）→ _inject_send（steer 注入当前 turn，
    投递后即返回，不落卡片）；任务侧 → _inject_send（同上，带任务 id）；
    卡片评论 → board._deliver_now(inject=True)。族不支持由 inject_now 前置拦截。"""
    row, meta, project = _msg_payload(msg_id)
    if row["task_id"] is None and row["card_id"] is None:
        return lambda: _inject_send(project, row["sid"], None,
                                    row["message"], meta.get("model", ""))
    if row["task_id"] is not None:
        return lambda: _inject_send(project, row["sid"], row["task_id"],
                                    row["message"], meta.get("model", ""))
    card = {"id": row["card_id"], "session_id": row["sid"],
            "model": meta.get("model", "")}
    comment = {"id": meta.get("comment_id") or 0}
    import board
    return lambda: board._deliver_now(project, card, comment,
                                      row["message"], inject=True)


_MSG_DONE_HOOK = None      # 消息单元终态钩子 fn(msg_id, state)（飞书回流用，单一注册位）


def set_msg_done_hook(fn):
    """注册/注销（fn=None）消息单元终态钩子；回调异常由 _fire_msg_done 吞掉。

    单一注册位（后注册覆盖先注册）：注册方是 feishu_conv.start（server.main 经
    feishu.start_notifier 调用一次）。未注册时 run_unit 行为与加钩子前逐字等价。
    """
    global _MSG_DONE_HOOK
    _MSG_DONE_HOOK = fn


def _fire_msg_done(msg_id, state):
    """触发消息单元终态钩子（done/yielded/error 各一次）；异常绝不影响队列收口。

    钩子是旁路（飞书回流的答复推送）：它跑在**终态记录已落库之后**，自身抛错
    （推送失败、会话读失败等）只留痕——队列收口与钩子成败解耦。
    """
    fn = _MSG_DONE_HOOK
    if fn is None:
        return
    try:
        fn(msg_id, state)
    except Exception as e:
        print(f"[chat] 终态钩子异常: {msg_id}: {e}", flush=True)


def run_unit(msg_id):
    """统一队列执行体（runner worker 调用）：执行一条待跑消息；异常落记录不抛出。

    P3：状态权威在 chat_msgs——msg_claim 原子 queued→running（与 inject_now 的
    waitq.claim 互斥互补：等待项被取消/被注入抢先时此处让行）；执行体按行＋
    快照重建；终态 done/yielded/error 落表，等待项行终态在同函数闭环（裁决 R6——
    终态归执行体，runner 影子终态段不再管 m:）。yielded=挂起让位（2026-09-27）：
    turn 等用户作答，运行位即行——行终态即释放，队首单元照常起跑。
    三条终态路各触发一次 `_fire_msg_done`（Task 6 飞书回流钩子：done=推答复、
    yielded=不推（交既有作答链路）、error=推失败回执）。"""
    try:
        row = waitq.msg_get(msg_id)
        if row is None or row["state"] != STATE_QUEUED:
            _reap_orphan_claim(msg_id)      # 竞态窗口 A 收口（P4 必带⑦）
            return
        if not waitq.msg_claim(msg_id):
            _reap_orphan_claim(msg_id)      # 竞态窗口 A 收口（P4 必带⑦）
            return
        try:
            res = _rebuild_run(msg_id)()
        except Exception as e:
            waitq.msg_finish(msg_id, STATE_ERROR, str(e))
            waitq.finish_by_target(waitq.KIND_MSG, msg_id, waitq.STATE_FAILED, str(e))
            _fire_msg_done(msg_id, STATE_ERROR)
            return
        if res == STATE_YIELDED:
            print(f"[chat] 消息单元挂起让位：m:{msg_id}（turn 等待作答）", flush=True)
            waitq.mark_evidence(waitq.KIND_MSG, msg_id,
                                {"desc": "消息投递挂起让位",
                                 "reason": "turn 等待作答"})
            waitq.msg_finish(msg_id, STATE_YIELDED)
            waitq.finish_by_target(waitq.KIND_MSG, msg_id, waitq.STATE_DONE)
            _fire_msg_done(msg_id, STATE_YIELDED)
            return
        waitq.msg_finish(msg_id, STATE_DONE)
        waitq.finish_by_target(waitq.KIND_MSG, msg_id, waitq.STATE_DONE)
        _fire_msg_done(msg_id, STATE_DONE)
    except Exception as e:      # 防线程拖死（DB 故障等）；行滞留由 selfcheck 兜底
        print(f"[chat] 消息单元异常: {msg_id}: {e}", flush=True)
        try:    # 尽力把等待项落 failed（chat_msgs 已不可写时由 selfcheck 兜底）
            waitq.finish_by_target(waitq.KIND_MSG, msg_id,
                                   waitq.STATE_FAILED, str(e)[:300])
        except Exception:
            pass
        _fire_msg_done(msg_id, STATE_ERROR)     # 最外层异常同样只触发一次


def _reap_orphan_claim(msg_id):
    """竞态窗口 A 收口（P4 必带⑦）：早退时若等待项仍挂在「本执行体」名下
    （claimed_by=worker——排除「立即注入」的 claim，inject-now 路径自行收口），
    而消息行已不在排队，说明 claim 后、状态迁移前行被并发取消——等待项补终态，
    防 starting 永挂（v2a T1：claimed 改名 starting）。窗口 B（inject capture/
    cancel 交错）由 waitq.claim 原子性天然闭合（claim 失败即拒绝），无需代码。"""
    wrow = waitq.get_active(waitq.KIND_MSG, msg_id)
    if wrow is not None and wrow["state"] == waitq.STATE_STARTING \
            and wrow["claimed_by"] == "worker":
        waitq.finish_by_target(waitq.KIND_MSG, msg_id,
                               waitq.STATE_FAILED, "消息已不在排队中")


def cancel(msg_id):
    """取消排队中的消息（已开始执行的返回 False）。返回是否命中。

    P3：chat_msgs 的 queued→cancelled 原子守卫为仲裁点（R12），等待项权威取消
    与内存键摘除随后——与 worker claim 竞态下不双执行、不复活终态行。"""
    if not waitq.msg_cancel(msg_id):
        return False
    waitq.cancel(waitq.KIND_MSG, msg_id, "已取消")
    if runner.INSTANCE is not None:
        runner.INSTANCE.remove_msg(msg_id)
    return True


def cancel_queued(sid=None, card_id=None):
    """取消排队中的消息（按会话 sid 或卡片 id 过滤）；返回取消条数。停止入口共用。"""
    if not sid and not card_id:
        return 0
    rows = waitq.msg_rows(sid=sid, card_id=card_id, states=(STATE_QUEUED,))
    return sum(1 for r in rows if cancel(r["id"]))


def msgs_of_sid(sid):
    """本会话消息的展示视图（排队/执行中 + 近期失败）：{id,text,state,error,created_at}。

    终态正常记录（done/yielded/cancelled）不发——前端 chip 由「被会话收录」自行清除。
    P3 起查 chat_msgs（created_at 升序，idx_chat_msgs_sid 覆盖）。"""
    if not sid:
        return []
    rows = waitq.msg_rows(sid=sid,
                          states=(STATE_QUEUED, STATE_RUNNING, STATE_ERROR))
    out = [{"id": r["id"], "text": r["message"][:120], "state": r["state"],
            "error": r["error"], "created_at": r["created_at"]} for r in rows]
    out.sort(key=lambda r: r["created_at"])
    return out


def live_of_sid(sid):
    """本会话是否有排队/执行中的消息单元（"m:" 入队后到结束/取消之间）。

    看板调和器判定「本卡会话即将或正在由平台消息驱动」用：消息进统一队列后、
    轮到执行前会话并不 busy，仅凭 web busy 会漏判——阻塞列卡片在消息排队/执行
    期间应视作运行中（回「正在开发」列）。P3 起查表：state∈{queued,running}
    任一行即真。"""
    if not sid:
        return False
    return bool(waitq.msg_rows(sid=sid, states=(STATE_QUEUED, STATE_RUNNING)))


def queued_card_ids():
    """有**排队中**消息（尚未轮到执行）的卡片 id 集合（看板 payload 批量预计算用，
    2026-09-14）：卡片会话的「排队中」徽标数据源——消息进统一队列后、轮到执行前，
    平台已收下消息、等空闲送达，卡片按「排队中」呈现且不点亮「会话运行中」
    （与作答待送达 answer_pending 同款展示语义，见 board.card_json）。

    仅统计 state=queued 且带卡片 id 的记录（执行中/终态不计；任务侧消息无
    卡片 id 天然排除）。P3 起查表：仅 state=queued 且带卡片 id 的行。
    """
    return waitq.msg_queued_card_ids()


def msg_info(msg_id):
    """消息记录只读摘要（端点归属校验用）：id/sid/project_id/task_id/card_id/state。

    记录不存在（含终态回收后）返回 None；终态 600s 回收窗口不变（R8）。"""
    r = waitq.msg_get(msg_id) if msg_id else None
    if r is None:
        return None
    return {"id": r["id"], "sid": r["sid"], "project_id": r["project_id"],
            "task_id": r["task_id"], "card_id": r["card_id"], "state": r["state"]}


def inject_now(msg_id):
    """「立即注入」：把平台排队中的消息单元立即投递到目标会话，不再等统一队列。

    P3：互斥点改为等待项 waitq.claim 原子抢占（同 P2「立即送达」模式）——与
    worker 的 _claim_unit（全类直调）只有一方成功；chat_msgs 的
    queued→running 由 msg_claim 承载状态迁移。抢到后先把单元从统一队列摘除
    （runner.remove_msg，内存键专用、不碰等待项行）。

    被拒（消息不在排队中/不支持注入）抛 InjectRefused——消息未动、仍在队列；
    投递失败：等待项 return_to_waiting（行 id 稳定、seq 不动＝按原位次放回，
    裁决 R4——原「wait 行换 id、meta 丢失」红旗就此修复）+ chat_msgs 退回
    queued，原样上抛（端点转 502）；成功返回 None（终态 done）。"""
    row = waitq.msg_get(msg_id)
    if row is None:
        raise InjectRefused("消息不存在或已回收")
    if row["state"] != STATE_QUEUED:
        raise InjectRefused("该消息已不在排队中（可能已开始发送）")
    wrow = waitq.get_active(waitq.KIND_MSG, msg_id)
    meta = _msg_meta(wrow)
    if meta.get("family") != "dsh_plugin":
        raise InjectRefused("该消息不支持立即注入")
    if wrow is None or not waitq.claim(wrow["id"], "inject-now"):
        raise InjectRefused("该消息已不在排队中（可能已开始发送）")
    inst = runner.INSTANCE
    if inst is not None:
        inst.remove_msg(msg_id)          # 出队：唤醒 worker 重挑（权威取消在下行 claim）
    if not waitq.msg_claim(msg_id):      # 状态迁移（被取消的竞态：放回等待）
        waitq.return_to_waiting(wrow["id"])
        raise InjectRefused("该消息已不在排队中（可能已开始发送）")
    try:
        _rebuild_inject(msg_id)()
    except Exception:
        # 投递失败：等待项放回（行 id 稳定、seq 不动＝按原位次放回，meta 随行
        # 保留）+ 状态退回排队——消息不丢，语义与「投递失败仍可在队列里等下一轮」一致；
        # 错误由调用方上报前端 toast（端点 502）
        waitq.return_to_waiting(wrow["id"])
        waitq.msg_requeue(msg_id)
        if inst is not None:
            inst.submit_msg(msg_id, row["project_id"], row["sid"])
        raise
    waitq.msg_finish(msg_id, STATE_DONE)
    waitq.finish_by_target(waitq.KIND_MSG, msg_id, waitq.STATE_DONE)


# ---------- 消息投递（消息单元执行体；唯一族 dsh 插件） ----------

def _register(sid, task_id, message, log_path="", dsh_plugin=False, since=None):
    """登记对话会话（_CHATS）：供 state 查询与 stop 停止。"""
    rec = {"task_id": task_id, "started_at": int(time.time() * 1000),
           "message": message[:200], "exit_code": None, "log_path": log_path}
    if dsh_plugin:
        # since = 投递前会话 last_seq（等 turn/end 的 SSE 续传起点）
        rec.update({"dsh_plugin": True, "since": since})
    with _lock:
        _CHATS[sid] = rec


# ---------- dsh 插件族（路线 A：进程内会话，事件驱动等待） ----------

# sid -> 投递前会话 last_seq：等 turn/end 的 SSE 续传起点。
# 只在本进程、同一「投递→等待」序列内使用；wait 取走即弃（防陈旧基线误判）。
_DSH_BASELINE = {}

# sid -> 本次投递是否 steer（「立即注入」/inject=True）——与 `_DSH_BASELINE` 同款
# 「投递时记、等待时取走即弃」的旁表（I1 终审修复，2026-10-10）。
# 用途只有一个：`dsh_wait_turn_via_events` 判定「本轮 turn/start 帧早于订阅」时，
# 仅当**本次投递是 steer 注入**才按「已在跑」播种 `started`（见该函数 docstring）；
# 每次 `dsh_send` 都写（True/False 都写，旧值必须被覆盖——否则上一次 steer 的
# 残留 True 会毒化下一次 followup 的等待）。池内等待器 `dsh_wait_turn` 不读它。
_DSH_INJECT = {}

# ---------- 投递前预订阅（缺陷 A 修复，2026-10-10 T9b 真机复跑发现） ----------
#
# 缺陷（真机 run1–run7，6/6 命中）：外部会话的普通 followup 投递里，`turn/start`
# 帧到中枢在 +0.072~0.143s，而等待器的 `dshevents.subscribe` 在 +0.084~0.152s
# ⇒ **帧早到 9~13ms**；全局状态流对进程内订阅者**无回放** ⇒ 该帧永远看不到
# ⇒ `started` 恒假 ⇒ 本轮 `turn/end` 被丢弃 ⇒ 只能等满 `TURN_START_GRACE`(60s)
# 收口（`m:` 行在 turn/end 帧后 56~57s 才落 done）。有卡路由 `ext:` 行兜住占用
# （无实害，只是状态滞后 60s）；**无卡路（任务侧直送 / 飞书绑定会话）会真的提前
# 释放项目运行位**，与仍在跑的外部 turn 并发改同一工作区 ⇒ 违「任务按项目串行」
# 红线。
#
# 修法：把「订阅 + 帧队列」从等待器里抽成 `_TurnSubscription`，`dsh_send` 在
# **投递之前**先建订阅并放进旁表 `_DSH_SUB`（与 `_DSH_BASELINE`/`_DSH_INJECT` 同款
# 「投递时记、等待时取走即弃」）；`dsh_wait_turn_via_events` 优先取走预订阅，取不到
# 再退回「现订阅」（老行为——覆盖「预订阅与等待之间才转外部」等窗口）。
# 硬约束（逐条落在下面的实现里）：
#   ① **只对会走事件流路的那一档建**（`dshevents.get(sid)["owned"] is False`，正是
#      `chat.wait_turn` 分流到事件流的判据）：池内/未知的投递零改动、零多余订阅
#      ——池内等待器 `dsh_wait_turn`（按会话 SSE）根本不读这张旁表；
#   ② **不等待的投递不留悬挂订阅**（`chat._inject_send`、`board._deliver_now(
#      inject=True)`、卡片首投等）：旁表有界（条数上限 `DSH_SUB_MAX` + TTL 惰性过期
#      `DSH_SUB_TTL`），出表/取走/投递抛异常一律 `dshevents.unsubscribe`（订阅回调
#      常驻中枢消费者列表，泄漏会让每次状态帧都白调一次）；
#   ③ 帧队列**只收本 sid 的帧**（状态帧低频 ⇒ 无人取走的队列也有界），等待器
#      `_consume` 里的 sid 过滤照旧（双保险）；
#   ④ **不拿 `status == "running"` 无条件播种 `started`**（I1 安全阀不许写宽）：
#      预订阅只解决「帧早到」，`started` 的判定阶梯一个字未改。
DSH_SUB_MAX = 32        # `_DSH_SUB` 条数上限（超出按建订阅时刻从旧到新回收）
DSH_SUB_TTL = 120.0     # 预订阅惰性过期（秒）：投递后无人取走即回收


class _TurnSubscription:
    """投递前建立的一次性全局状态流订阅：本 sid 的帧 → 线程安全队列。

    一个实例＝一次投递的「帧口袋」：`dsh_send` 建它（`_dsh_sub_open`）→
    `dsh_wait_turn_via_events` 取走并当帧队列用（`_dsh_sub_take`）→ 等待器 `finally`
    或回收路径 `close()`（退订，幂等）。取不到预订阅时等待器自建同款实例（老行为）。
    """

    def __init__(self, sid):
        self.sid = str(sid or "")
        self.frames = queue.Queue()     # 回调（消费线程）→ 等待器（本线程）的交接口
        self.created = time.time()
        self._closed = False
        # 回调存成**对象同一性稳定**的引用：订阅与退订必须传同一个对象（`dshevents`
        # 的订阅者列表按 `==` 摘除本就够用，但既有用例按 `is` 钉「退订的就是订阅的
        # 那一个回调」——回调常驻列表的泄漏判据；每次属性访问都会新建 bound method，
        # 故存一次，两个方向都稳）。
        self._cb = self._on_frame

    def _on_frame(self, frame):
        """中枢订阅回调：只收本 sid 的帧并入队。

        契约要求短小（跑在事件消费线程里）：这里只做一次字符串比较 + `put`。
        按 sid 过滤（等待器 `_consume` 里还有一层同样的过滤）让「无人取走的预订阅」
        队列也保持有界——状态帧是低频事件，不会像按 token 的流那样爆量。
        """
        if self._closed:
            return
        if str(frame.get("session_id") or "") != self.sid:
            return
        self.frames.put(frame)

    def close(self):
        """退订（幂等）：回调必须从中枢订阅者列表里摘掉，否则常驻泄漏。"""
        if self._closed:
            return
        self._closed = True
        dshevents.unsubscribe(self._cb)


_DSH_SUB = {}                       # sid -> _TurnSubscription（投递时建、等待时取走即弃）
_DSH_SUB_LOCK = threading.Lock()


def _dsh_sub_reap_locked():
    """旁表惰性回收（**调用方须持 `_DSH_SUB_LOCK`**）：过 TTL 与超条数上限的条目出表。

    返回**待退订**列表（出锁后再 `close()`）：`close()` 要拿中枢的订阅锁，不在本锁内
    做，免得两把锁的获取顺序成为隐患（业务侧没有任何路径反向获取本锁）。
    """
    now = time.time()
    stale = []
    for sid, sub in list(_DSH_SUB.items()):
        if now - sub.created > DSH_SUB_TTL:
            stale.append(_DSH_SUB.pop(sid))
    over = len(_DSH_SUB) - DSH_SUB_MAX
    if over > 0:
        # 超限：按建订阅时刻从旧到新回收（同一时刻大量投递时也收敛回上限之内）
        oldest = sorted(_DSH_SUB.items(), key=lambda kv: kv[1].created)[:over]
        for sid, _sub in oldest:
            stale.append(_DSH_SUB.pop(sid))
    return stale


def _dsh_sub_open(sid):
    """投递**之前**建预订阅并放进旁表；返回该订阅（同 sid 的旧订阅覆盖即退订）。

    只应由 `dsh_send` 在「会话是外部（`owned is False`）」时调用——那是
    `chat.wait_turn` 会分流到事件流路、等待器会取用它的唯一一档。
    """
    sub = _TurnSubscription(sid)
    dshevents.subscribe(sub._cb)
    with _DSH_SUB_LOCK:
        old = _DSH_SUB.get(sub.sid)
        _DSH_SUB[sub.sid] = sub
        # 入表**之后**回收：条数上限对「当前表」恒成立（新订阅 created 最新，
        # 不会被自己的这一次回收摘掉）
        stale = _dsh_sub_reap_locked()
    for item in stale:
        item.close()                    # 过期/超限的旧订阅：真退订
    if old is not None:
        old.close()                     # 同 sid 上一次没被取走的预订阅：回收
    return sub


def _dsh_sub_take(sid):
    """取走该 sid 的预订阅（无则 `None`）：取走即从旁表删除。

    退订责任随之转移给调用方（等待器在 `finally` 里 `close()`）——旁表只负责
    「投递到取走」这段短窗口内的保管，取走即弃与 `_DSH_BASELINE` 同款语义。
    """
    with _DSH_SUB_LOCK:
        stale = _dsh_sub_reap_locked()
        sub = _DSH_SUB.pop(str(sid or ""), None)
    for item in stale:
        item.close()
    return sub


def _dsh_sub_drop(sub):
    """按对象回收一个预订阅（投递失败路径）：仅当旁表里仍是它才删，随后退订。"""
    if sub is None:
        return
    with _DSH_SUB_LOCK:
        if _DSH_SUB.get(sub.sid) is sub:
            _DSH_SUB.pop(sub.sid, None)
    sub.close()


def dsh_busy(sid):
    """dsh 插件会话是否正在跑 turn（驱动不可用按 False，交由发送路径报错）。

    读插件内存态（`/status`），不是轮询远端 agent——会话状态由 dsh 侧
    `agent/status` 事件维护，这里只是同步读一次。
    """
    try:
        return dshdriver.status(sid).get("status") == "running"
    except dshdriver.DshDriverError:
        return False


# ---------- 宿主会话存活兜底（2026-10-10，修卡 934） ----------
#
# 现场：dsh 会话活在宿主进程内，插件**热重载 / 宿主重启**会把所有会话 dispose 掉
# ——真机实证 2026-10-10 01:06:48 两张卡的会话同时落
# `turn/end {kind:"aborted", reason:{kind:"disposed"}}`。平台侧卡片/任务的
# `session_id` 仍在库、卡照旧在列，用户再发评论 / 点「立即注入」时驱动回 404
# 「会话不在驱动池中」（卡 934 报障：前端 toast 只有这句内部链路文案，用户无从
# 判断该怎么办）。
#
# 判据与调和器「会话确已结束」同源（`board._iw_once`）：`dshevents.aligned()`
# （中枢可信）∧ 注册表里没有这个 sid ⇒ 宿主确实不再持有它。此时按平台既有
# 「有 sid 就 resume」的语义（`board._start_web` 的续接腿、`runner` 的
# `dshdriver.ensure_session` 同一出口）把会话接回池内，再走原投递。
# 未知（未对齐 / 断连）一律不动：未知 ≠ 已失去，零请求、既有行为一个字节不变。

HOST_REVIVE_ENV = "TS_HOST_SESSION_REVIVE"


def _host_revive_enabled():
    """接回总开关（回滚阀）：`TS_HOST_SESSION_REVIVE=0` ⇒ 不接回，退回修复前行为。"""
    return (os.environ.get(HOST_REVIVE_ENV) or "").strip() != "0"


def host_session_lost(sid):
    """宿主是否**确已**不再持有该会话（可信快照 ∧ 注册表无此 sid）。

    两个条件是「确已」的全部证据：`aligned()` 为假（中枢断连 / 热重载后快照未
    对齐）时注册表本就不可信，读不到 sid 只代表**未知**——按全局不变量「未知 ≠
    已结束」，一律返回 False（调用方不动）。读口异常同样按未知处理。
    """
    if not sid:
        return False
    try:
        if not dshevents.aligned():
            return False
        return dshevents.get(sid) is None
    except Exception:                      # noqa: BLE001 — 读口异常按未知，不阻断投递
        return False


def revive_host_session(sid, cwd="", task=""):
    """把「宿主已失去」的会话按既有 resume 语义接回；返回是否**可以投递**。

    True：会话本来就在宿主里（零请求），或刚被成功接回，或回滚阀关闭（退回旧行为，
    失败仍由驱动 404 兜底）。
    False：确已失去且接不回（会话文件不存在 / 驱动不可达 / 令牌错）——调用方据此
    给用户明确文案，而不再发一次必然 404 的投递。
    `cwd`/`task` 只在真接回时下传（前者对齐 `board.card_workspace`：worktree 卡；
    后者是驱动侧的会话标签，与 `_start_web` 同形）。
    """
    if not _host_revive_enabled() or not host_session_lost(sid):
        return True
    try:
        dshdriver.resume_session(sid, cwd=cwd, task=task)
    except dshdriver.DshDriverError as e:
        print(f"[chat] 会话接回失败 sid={sid}: {e}", flush=True)
        return False
    print(f"[chat] 宿主已失去会话，按 resume 接回：sid={sid}"
          f"（cwd={cwd or '-'} task={task or '-'}）", flush=True)
    return True


def _dsh_baseline_since(sid):
    """投递基线 seq（等 turn/end 的起点）：驱动 `/status` 拿不到就回落中枢注册表。

    判据是「**拿不到** `last_seq`」而不是「`/status` 抛错」（2026-10-10 T6 修正）：
    T2 落地后，watched + 活 agent 的外部会话 `/status` 由 `_externalTarget` 干跑后
    按外部形状回 200，响应里**刻意没有** `last_seq`——只 catch 异常会让回落分支
    永不触发、`since` 恒 0（等轮次会把基线之前的历史帧当成本轮）。
    两个来源按「先权威后本地」取：
      ① 驱动 `/status`（池内会话的权威口径，一次同步读，不是轮询）；
      ② `dshevents.get(sid)["last_seq"]`（中枢已折好的**本地**值，零请求；
         外部会话、驱动不可达时用它）。
    两者都取不到返回 0（保持既有「无基线」语义）。
    """
    try:
        seq = dshdriver.status(sid).get("last_seq")
    except dshdriver.DshDriverError:
        seq = None
    if seq is None:
        seq = (dshevents.get(sid) or {}).get("last_seq")
    try:
        return int(seq or 0)
    except (TypeError, ValueError):
        return 0


def dsh_send(sid, message, inject=False):
    """dsh 插件族投递（chat 与 board 共用）：记基线 → prompt / steer → 返回基线 seq。

    投递语义：dsh 的 `followup` 在会话忙时排进 agent inbox（服务端排队），`steer`
    则注入当前 turn 的最近 step 边界——平台的「发送 / 立即注入」两种语义因此
    一一对应，无需 spawn 子进程。异常抛 DshDriverError 由调用方处置。
    基线来源见 `_dsh_baseline_since`（外部会话没有 `last_seq` ⇒ 回落中枢）。
    投递的同时把「本次是否 steer」记进旁表 `_DSH_INJECT`（I1）：外部会话的等待器
    据此决定要不要按「已在跑的 turn」播种 `started`。
    **投递前预订阅（缺陷 A 修复）**：外部会话先建 `_TurnSubscription` 放进 `_DSH_SUB`
    ——`turn/start` 帧可能在 `POST` 返回前后几毫秒到达，等投递返回再订阅就永远看不到
    （全局状态流对进程内订阅者无回放）；投递失败当场回收该预订阅。
    """
    if not sid:
        raise dshdriver.DshDriverError(-1, "会话 id 为空，无法投递")
    # 外部会话（`owned is False`）＝ `chat.wait_turn` 会分流到事件流路的那一档：
    # 投递前先订阅（见 `_TurnSubscription`）；池内/未知不建（池内等待器不读它）。
    sub = None
    if (dshevents.get(sid) or {}).get("owned") is False:
        sub = _dsh_sub_open(sid)
    try:
        since = _dsh_baseline_since(sid)
        if inject:
            dshdriver.steer(sid, message)
        else:
            dshdriver.prompt(sid, message)
    except Exception:
        # 投递失败：预订阅无人会取走，当场回收（不留悬挂订阅）
        _dsh_sub_drop(sub)
        raise
    _DSH_BASELINE[sid] = since
    _DSH_INJECT[sid] = bool(inject)      # I1：True/False 都写（覆盖上一次投递的旧值）
    return since


def _dsh_wait_turn_limit():
    """等 turn 结束的总时限（秒）：常量默认 + 环境变量覆盖（非法/非正值回落常量）。"""
    raw = (os.environ.get(DSH_WAIT_TURN_TIMEOUT_ENV) or "").strip()
    if raw:
        try:
            val = float(raw)
        except ValueError:
            val = 0.0
        if val > 0:
            return val
    return DSH_WAIT_TURN_TIMEOUT


def dsh_wait_turn(sid, since=None, yield_on_interaction=True, log_path=""):
    """等 dsh 会话一次 turn 结束（事件驱动，零远端轮询）。

    返回 None（turn 正常/异常/超时收口）或 STATE_YIELDED（turn 挂起等作答，让出运行位）。
    since 缺省取本次投递记录的基线；基线丢失（进程重启等）时退回读当前 last_seq。
    log_path：超时原因行的落点（缺省取本会话对话日志 `_CHATS[sid]["log_path"]`）。
    P7a 缺陷 G：整轮等待带**总时限**（DSH_WAIT_TURN_TIMEOUT，环境变量可覆盖）——
    链路保活正常但服务端不推 turn/end 时不再永久挂起；到点写一行
    `### 会话等待 turn 结束超时（N s 无 turn/end）` 并按「本轮结束」返回 None，
    消息单元据此收口（m: 行 done、项目运行位释放、补位继续）。
    """
    if since is None:
        since = _DSH_BASELINE.pop(sid, None)
    if since is None:
        try:
            since = int(dshdriver.status(sid).get("last_seq") or 0)
        except dshdriver.DshDriverError:
            return None
    if not log_path:
        with _lock:
            rec = _CHATS.get(sid)
        log_path = (rec or {}).get("log_path") or ""
    limit = _dsh_wait_turn_limit()
    waiter = dshdriver.TurnWaiter()
    stop = threading.Event()
    threading.Thread(target=dshdriver.feed_into,
                     args=(sid, since, waiter, stop), daemon=True).start()
    started = time.time()
    deadline = started + limit
    try:
        while True:
            # 等待窗口 = min(轮询节拍, 距总时限剩余)：既保留 TICK 节拍（未启动宽限的
            # 本地检查点），又让总时限到点即返回（不再多等一个 TICK）
            event = waiter.wait_turn(max(0.05, min(TICK, deadline - time.time())))
            if event == "turn_end":
                return None
            if time.time() >= deadline:
                # 总时限兜底：写清原因后按「本轮结束」返回，绝不把行永远钉在执行态
                # （log_path 为空时 runner.append_log 静默跳过，不影响收口）
                runner.append_log(
                    log_path,
                    f"### 会话等待 turn 结束超时（{limit:g}s 无 turn/end）\n")
                return None
            if event == "interaction":
                if yield_on_interaction:
                    return STATE_YIELDED     # 已送达；挂起让位（运行位即释放）
                continue
            if event == "error":
                return None
            if not waiter.started and time.time() - started > TURN_START_GRACE:
                return None                  # turn 未启动：不占着项目位
    finally:
        stop.set()


def _log_wait_timeout(log_path, detail):
    """写「等待 turn 结束超时」留痕：会话日志 + 平台日志（插件形态落 plugin-backend.log）。

    断连与总时限两条收口共用同一行文案（不变量：断连也必须按**超时口径**收口并留痕，
    绝不判「正常结束」）；`detail` 只补原因，便于事后区分是哪条收口。
    `runner.append_log` 对空/不可写路径静默跳过（既有语义），故再打一行平台日志
    兜底——外部卡片投递可能没有 `_CHATS` 记录（`log_path` 为空），此时留痕不能丢。
    """
    line = f"### 会话等待 turn 结束超时（{detail}）"
    runner.append_log(log_path, line + "\n")
    print(f"[chat] {line}（日志: {log_path or '无'}）", flush=True)


def dsh_wait_turn_via_events(sid, since=None, log_path="", yield_on_interaction=True):
    """等 dsh 会话一次 turn 结束——**全局状态流版**（外部会话专用，C 批 T6）。

    与 `dsh_wait_turn`（按会话 SSE）的分工：外部会话不在驱动池中，
    `/events?session_id=` 与 `/status` 同属池内门禁（404）⇒ 按会话 SSE 一帧都收不到，
    旧实现随即按「本轮结束」返回（把「读不到」误判成功）。这里改订阅插件的**全局
    状态流**（`dshevents`：插件对每个会话都发 `turn/start`/`turn/end`/
    `driver/interaction`，见 `dshevents._on_frame`），平台侧**零请求**——等待只是从
    进程内队列取帧，加上每 `TICK` 一次的本地判定（不是远端状态轮询）。

    返回 None（本轮结束/超时/断连收口）或 STATE_YIELDED（挂起等作答，让出运行位）。
    `since`：本轮起点 seq（缺省先取本次投递基线 `_DSH_BASELINE`，再回落中枢
    `last_seq`）——只用于过滤 `turn/start`（`event_seq > since` 才算「本轮起来了」），
    避免上一轮遗留的 turn/start 被误当本轮。
    **帧口袋优先用投递前的预订阅**（缺陷 A）：`dsh_send` 对**外部会话**在投递之前就
    `dshevents.subscribe` 并把帧排进 `_TurnSubscription.frames`（旁表 `_DSH_SUB`），
    这里 `_dsh_sub_take` 取走即用——`turn/start` 帧即便在投递返回后立刻到达也已在
    口袋里；取不到（池内转外部、非 `dsh_send` 投递、旁表已回收）退回「现订阅」
    （老行为：窗口只是收窄，不再是常态）。**举证责任在订阅**：`started` 的判定
    阶梯一个字未改（不许无条件按 `status=='running'` 播种，见第 ⓪ 条）。
    判定阶梯（顺序即优先级）：
      ⓪ **steer 注入「已在跑的 turn」按已在跑播种 `started`**（I1，两个条件缺一不可，
         见下方 `started` 初始化处的长注释）；
      ① 本 sid `turn/start` 且 `data.event_seq > since` ⇒ 记 started；
      ② started 且本 sid `turn/end` ⇒ 返回 None（本轮结束）；
      ③ 本 sid `driver/interaction{state:'asked'}` ⇒ STATE_YIELDED（让位）；
      ④ 中枢断连（`dshevents.connected()` 为假）⇒ 超时行留痕 + 返回 None
         （断连=未知：绝不判「正常结束」，也绝不把项目运行位钉死）；
      ⑤ 到 `_dsh_wait_turn_limit()` 总时限 ⇒ 同款超时行 + 返回 None；
      ⑥ started 为假且超 `TURN_START_GRACE` ⇒ 返回 None（turn 压根没起来，不占位）。
    `log_path` 缺省取本会话对话日志（`_CHATS[sid]["log_path"]`，同 `dsh_wait_turn`）。
    """
    if not sid:
        return None
    if since is None:
        since = _DSH_BASELINE.pop(sid, None)     # 本次投递记下的基线（取走即弃）
    injected = bool(_DSH_INJECT.pop(sid, None))  # 本次投递是否 steer（同上取走即弃）
    if since is None:
        since = (dshevents.get(sid) or {}).get("last_seq")
    try:
        since = int(since or 0)
    except (TypeError, ValueError):
        since = 0
    if not log_path:
        with _lock:
            rec = _CHATS.get(sid)
        log_path = (rec or {}).get("log_path") or ""
    limit = _dsh_wait_turn_limit()
    t0 = time.time()
    deadline = t0 + limit
    # —— I1（终审，2026-10-10）：steer 注入「已在跑的 turn」按已在跑播种 started ——
    # 两个条件**缺一不可**（下面两行即全部条件）：
    #   ① `injected`：本次投递是 steer 注入（`dsh_send` 投递时记下的已知事实）；
    #   ② 入口本地读一次中枢注册表，实况 `status == "running"`（零请求，不是轮询）。
    # 为什么需要：steer 的目标是**已经在跑的** turn，它的 `turn/start` 帧早于本订阅
    # （全局状态流对进程内订阅者无回放），而 `since`（外部会话取中枢 `last_seq`）恒
    # ≥ 该 turn/start 的 `event_seq` ⇒ 过滤条件 `seq > since` 恒假 ⇒ `started` 恒假
    # ⇒ 本轮 `turn/end` 被丢弃，只能等满 TURN_START_GRACE(60s)：`m:` 行落 done、项目
    # 运行位提前释放，而外部 turn 仍在跑 ⇒ 下一个排队单元与它**并发写同一工作区**
    # （违「任务按项目串行」红线）。播种后由真 `turn/end` 帧收口。
    # 为什么不能无条件读 `status=='running'` 当初值：followup 排在正在跑的**旧** turn
    # 之后时（消息已进 agent inbox、本轮尚未 turn/start），旧 turn 的 `turn/end` 会被
    # 误判成本轮结束——正是 T6 修掉的那类误判；故条件①必须同时成立。
    started = injected and (dshevents.get(sid) or {}).get("status") == "running"
    # —— 帧口袋（缺陷 A）：优先取投递前的预订阅，取不到再自建（老行为）——
    # 预订阅在 `dsh_send` 里建于**投递之前** ⇒ `turn/start` 帧只要在本轮等待开始
    # 之后到达就不会漏（真机实测帧早于「投递后订阅」9~13ms）。自建分支覆盖
    # 「预订阅不存在」的形态：非 `dsh_send` 投递、池内转外部、旁表已回收/过期。
    sub = _dsh_sub_take(sid)
    if sub is None:
        sub = _TurnSubscription(sid)
        dshevents.subscribe(sub._cb)
    inbox = sub.frames                # 消费线程 → 本函数：原始帧的线程安全交接

    def _consume(frame):
        """处理一帧：返回结论（None / 'turn_end' / 'interaction'），必要时推进 started。

        只认本 sid 的帧（全局流上混着所有会话的帧）；跨会话帧直接忽略。
        """
        nonlocal started
        if str(frame.get("session_id") or "") != sid:
            return None
        typ = str(frame.get("type") or "")
        data = frame.get("data") or {}
        if typ == "turn/start":
            seq = data.get("event_seq")
            if isinstance(seq, int) and seq > since:
                started = True
            return None
        if typ == "turn/end":
            # started 是「本轮起来了」的闩：started 之前到达的 turn/end 属于上一轮
            # （投递排队/在途时的遗留帧），不能当成本轮结束。started 有两个来源：
            # ① 本函数按 `turn/start`（seq > since）置真；② 入口按 I1 播种（steer
            # 注入已在跑的 turn——其 turn/start 帧早于订阅，见 started 初始化处）。
            return "turn_end" if started else None
        if typ == "driver/interaction" and str(data.get("state") or "") == "asked":
            if yield_on_interaction:
                return "interaction"
            # 不让位时继续等：提问意味着 turn 已在跑（同 TurnWaiter.feed 口径）
            started = True
        return None

    try:
        while True:
            try:
                frame = inbox.get_nowait()
            except queue.Empty:
                # 队列已取空：做一轮本地判定（链路/时限/宽限），再按节拍阻塞等帧
                now = time.time()
                if not dshevents.connected():
                    _log_wait_timeout(
                        log_path, f"状态流断连：{now - t0:g}s 无 turn/end")
                    return None
                if now >= deadline:
                    _log_wait_timeout(log_path, f"{limit:g}s 无 turn/end")
                    return None
                if not started and now - t0 > TURN_START_GRACE:
                    return None          # turn 未启动：不占着项目位
                # 阻塞等下一帧：窗口 = min(节拍, 距总时限余量, 未起轮时的启动宽限余量)
                # ——让宽限/时限到点即判定，不被 TICK 推迟（TICK 可被环境放大）
                window = min(TICK, deadline - now)
                if not started:
                    window = min(window, TURN_START_GRACE - (now - t0))
                try:
                    frame = inbox.get(timeout=max(0.05, window))
                except queue.Empty:
                    continue
            verdict = _consume(frame)
            if verdict == "turn_end":
                return None
            if verdict == "interaction":
                return STATE_YIELDED     # 已送达；挂起让位（运行位即释放）
    finally:
        # 订阅必须回收（回调常驻中枢消费者列表里）；预订阅与自建订阅同款：
        # 取走即弃（`_dsh_sub_take` 已出旁表）+ 这里 `close()` 幂等退订。
        sub.close()


def _dsh_send_now(project, sid, message, inject):
    """dsh 插件族消息投递体：写对话日志 → 投递 → 等 turn 结束。

    turn 结束由插件推来的 turn/end 帧判定（事件驱动，零轮询）；「挂起等作答」
    由 driver/interaction 帧实时告知。
    等轮次走 `wait_turn` 分流口（T6 收口）：外部会话（无卡消息路径的飞书绑定会话、
    平台重启后变 `owned:false` 的任务会话）订阅**全局状态流**——按会话 SSE 对
    池外会话是 404（「读不到」会被误判成本轮结束）。本会话的基线 `since` 与
    对话日志落点 `log_path` 逐字透传（缺陷 G 的总时限原因行必须落这条日志）。
    """
    lib.ensure_runtime_dirs(project["work_dir"])
    log_dir = lib.runtime_dir(project["work_dir"], runner.LOG_DIR_NAME)
    log_path = os.path.join(log_dir, f"chat_dsh_{int(time.time())}.log")
    with open(log_path, "ab") as logf:
        logf.write((f"### PROMPT {json.dumps(message, ensure_ascii=False)}\n"
                    f"### DRIVER dsh_plugin sid={sid} "
                    f"{'steer' if inject else 'followup'}\n").encode("utf-8", errors="replace"))
    since = dsh_send(sid, message, inject)
    _register(sid, None, message, dsh_plugin=True, since=since, log_path=log_path)
    # 分流口：池内/未知 ⇒ 既有按会话 SSE（显式传本会话日志 + 基线，语义同旧直调）；
    # 外部 ⇒ 全局状态流（同参数透传，见 wait_turn）
    return wait_turn(project["work_dir"], sid, "dsh_plugin",
                     since=since, log_path=log_path)


def wait_web_busy(project_dir, sid, family):
    """等一次会话 turn 结束（dsh 单族：订阅事件流等 turn/end，挂起即让位）。

    dsh_plugin（路线 A）：不走轮询——直接订阅插件推来的事件流等 turn/end，
    「挂起等作答」由 driver/interaction 帧实时告知（见 dsh_wait_turn）。不设总时长
    上限（跑到 turn 结束，点「停止」可中断），turn 未启动的宽限判定（
    TURN_START_GRACE）与总时限兜底（DSH_WAIT_TURN_TIMEOUT）都在 dsh_wait_turn 内。
    挂起让位（2026-09-27）：turn 挂起等用户作答时返回 STATE_YIELDED——消息已送达，
    调用方据此落让位终态并释放运行位，队首单元照常起跑；用户作答后会话恢复，卡会话
    经调和器 ext 行重新成为占用源（对齐 ext 行「挂起即出队」，豁免面②同源语义）。

    非 dsh 族（已全部退场）：无 turn 可等，恒返回 None（无投递路径，不会走到）。
    """
    if family != "dsh_plugin":
        return None
    return dsh_wait_turn(sid)


def wait_turn(project_dir, sid, family, since=None, log_path=""):
    """等一次会话 turn 结束的**分流口**（C 批 T6）：按会话归属选等待通道。

    外部会话（用户在 dsh GUI 里直跑/接管，注册表 `owned:false`）不在驱动池中，
    `/events?session_id=` 与 `/status` 同属池内门禁（404）⇒ 按会话 SSE 等不到任何
    帧，「等不到」又被当成「本轮结束」（外部会话被误判成功的根因）。故外部会话改走
    **全局状态流**（`dsh_wait_turn_via_events`：插件每会话都发 `turn/start`/
    `turn/end`，平台侧零请求）。

    其余情况一律走既有 `wait_web_busy`（按会话 SSE），**行为一个字节不变**：
      - `owned:true` 平台自持会话：权威等待通道就是按会话 SSE（重连补发、基线
        续传都在那边）；
      - 注册表未知（`dshevents.get` 返回 None：链路断连 / 没见过该 sid）：
        **未知 ≠ 外部**（与 `chat._external_preflight` 同一判定阶梯）——此时无法
        判定它是外部会话，若改走事件流路，链路降级期会把池内会话立刻按超时收口
        （运行位提前释放），是净回归。
    未对齐（热重载后 /live 空快照、旧表保留）不单独判：链路仍在线、帧照旧折叠，
    行里的 `owned` 仍是可用的判定依据（与前置闸同口径：只有「读不到行」才算未知）。

    `since` / `log_path`（可选，C 批 T6 收口）：承载「本轮基线」与「缺陷 G 总时限
    原因行的落点」（`_dsh_send_now` 消息路径显式传这两个；`board._deliver_unit`
    不传）。语义分两种调用形状：
      - **都不传**（既有形状）：池内/未知照旧原样调 `wait_web_busy(project_dir,
        sid, family)` —— 含非 dsh 族的 None 守卫与 `_DSH_BASELINE` 兜底，逐字等价；
      - **传了任一个**：池内/未知改走 `dsh_wait_turn(sid, since, log_path=log_path)`
        —— 与旧 `_dsh_send_now` 直调同参数同返回值（绝不换成丢掉这两个参数的
        `wait_web_busy(...)`，那会让基线丢回 0、缺陷 G 原因行落错日志）。
    外部分支两种形状一致：`dsh_wait_turn_via_events(sid, since, log_path=log_path)`
    （`since` 为 None 时该函数自带基线回落：先 `_DSH_BASELINE` 再中枢 `last_seq`）。
    """
    st = dshevents.get(sid) if sid else None
    if st is None or st.get("owned"):
        if since is None and not log_path:
            return wait_web_busy(project_dir, sid, family)   # 既有形状：一字未动
        if family != "dsh_plugin":
            return None                     # 族守卫（与 wait_web_busy 同口径）
        return dsh_wait_turn(sid, since, log_path=log_path)
    return dsh_wait_turn_via_events(sid, since, log_path=log_path)


def _send_now(task, project, family, sid, message, inject):
    """任务会话消息的实际发送（统一队列单元执行体调用）。

    dsh_plugin（唯一族）：投递 = driver 的 followup/steer，等 turn 结束由事件流判定
    （见 _dsh_send_now）；turn 挂起等作答则返回 STATE_YIELDED（挂起让位，
    2026-09-27）——返回时才释放项目占用，执行期间不会与项目内其他单元并发
    （让位除外：挂起即提前释放，对齐 ext 行「挂起即出队」）。
    """
    if family != "dsh_plugin":
        # 单族世界：其余族已全部退场（B0 防呆口径），走到这儿说明有残留调用路径
        raise RuntimeError(
            f"该智能体族已下线，请在项目设置里改绑 dsh 插件：{family or '未知'}")
    return _dsh_send_now(project, sid, message, inject)


def _inject_send(project, sid, task_id, message, model):
    """「立即注入」投递体（chat.inject_now 调用；不等本轮结束）。

    dsh_plugin（唯一族）：直接 steer（dsh 的 steer 语义就是注入最近 step 边界，
    空闲则起一轮）——不轮询 turn 结束、不持有项目占用，因为用户点「立即注入」的
    语义就是不要排队。project/model 保留为兼容既有调用签名（dsh 投递不带模型）。
    """
    since = dsh_send(sid, message, inject=True)
    _register(sid, task_id, message, dsh_plugin=True, since=since)


def start(task, project, message, inject=False):
    """发起对话（走统一队列）：登记消息单元并提交 runner，返回消息记录 dict。

    - 项目空闲：worker 立刻拾起执行（毫秒级），queued=False；
    - 项目忙（同项目有任务/卡片会话在跑）：按入队顺序排队，queued=True。
    排队中的消息可「立即注入」（不等队列直接投递，见 inject_now）：dsh 族支持
    （steer 注入当前 turn），family/model 提交时定格进等待项 meta，执行时按快照
    重建（见 submit）。
    """
    family = runner.agent_family(project["agent_path"])
    sid = task["session_id"]
    model = (task["model"] or "").strip() or (project["model"] or "").strip()
    return submit(project["id"], sid, message, task_id=task["id"], inject=inject,
                  family=family, model=model)


def state(sid):
    """对话状态：{running, queued, msgs, started_at?, message?, exit_code?}。

    running=有进行中的对话（dsh 族读插件内存态会话状态）；queued=排队中消息数；
    msgs=排队/执行中与近期失败消息（前端排队 chip 与失败提示用）。
    """
    msgs = msgs_of_sid(sid)
    base = {"running": False,
            "queued": len([m for m in msgs if m["state"] == STATE_QUEUED]),
            "msgs": msgs}
    if not sid:
        return base
    with _lock:
        rec = _CHATS.get(sid)
        if rec is None:
            return base
    if not rec.get("dsh_plugin"):
        return base          # 防呆：非 dsh 记录不再产生，按空闲呈现
    # dsh_plugin 无本地进程：running 读插件内存态（agent/status 事件维护），
    # 一次同步读，不做轮询；turn 结束按 exit 0 呈现
    busy = dsh_busy(sid)
    if not busy and rec["exit_code"] is None:
        rec["exit_code"] = 0
    return {**base, "running": busy, "started_at": rec["started_at"],
            "message": rec["message"], "exit_code": rec["exit_code"]}


def running(sid):
    """是否有进行中的对话。"""
    return state(sid)["running"]


def stop(sid):
    """停止进行中的对话：先取消排队中的消息，再中断正在跑的 turn。

    dsh 插件族：cancel 优雅中断当前 turn（保留已流式交付的文本）；inbox 里的排队项
    一并清掉（停止 = 不再执行这条会话上排着的工作）。返回是否命中了运行中的对话
    （排队取消不算命中）。
    """
    cancel_queued(sid=sid)
    with _lock:
        rec = _CHATS.get(sid)
    if rec is None or not rec.get("dsh_plugin"):
        return False
    try:
        dshdriver.cancel(sid)
        return True
    except dshdriver.DshDriverError:
        return False
