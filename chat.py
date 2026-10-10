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
"""

import json
import os
import threading
import time

import db
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


def dsh_busy(sid):
    """dsh 插件会话是否正在跑 turn（驱动不可用按 False，交由发送路径报错）。

    读插件内存态（`/status`），不是轮询远端 agent——会话状态由 dsh 侧
    `agent/status` 事件维护，这里只是同步读一次。
    """
    try:
        return dshdriver.status(sid).get("status") == "running"
    except dshdriver.DshDriverError:
        return False


def dsh_send(sid, message, inject=False):
    """dsh 插件族投递（chat 与 board 共用）：记基线 → prompt / steer → 返回基线 seq。

    投递语义：dsh 的 `followup` 在会话忙时排进 agent inbox（服务端排队），`steer`
    则注入当前 turn 的最近 step 边界——平台的「发送 / 立即注入」两种语义因此
    一一对应，无需 spawn 子进程。异常抛 DshDriverError 由调用方处置。
    """
    if not sid:
        raise dshdriver.DshDriverError(-1, "会话 id 为空，无法投递")
    try:
        since = int(dshdriver.status(sid).get("last_seq") or 0)
    except dshdriver.DshDriverError:
        since = 0
    if inject:
        dshdriver.steer(sid, message)
    else:
        dshdriver.prompt(sid, message)
    _DSH_BASELINE[sid] = since
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


def _dsh_send_now(project, sid, message, inject):
    """dsh 插件族消息投递体：写对话日志 → 投递 → 等 turn 结束。

    turn 结束由插件推来的 turn/end 帧判定（事件驱动，零轮询）；「挂起等作答」
    由 driver/interaction 帧实时告知。"""
    lib.ensure_runtime_dirs(project["work_dir"])
    log_dir = lib.runtime_dir(project["work_dir"], runner.LOG_DIR_NAME)
    log_path = os.path.join(log_dir, f"chat_dsh_{int(time.time())}.log")
    with open(log_path, "ab") as logf:
        logf.write((f"### PROMPT {json.dumps(message, ensure_ascii=False)}\n"
                    f"### DRIVER dsh_plugin sid={sid} "
                    f"{'steer' if inject else 'followup'}\n").encode("utf-8", errors="replace"))
    since = dsh_send(sid, message, inject)
    _register(sid, None, message, dsh_plugin=True, since=since, log_path=log_path)
    # 显式传入本会话日志：总时限超时（缺陷 G）的原因行要落到这条对话日志上
    return dsh_wait_turn(sid, since, log_path=log_path)


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
