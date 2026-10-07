#!/usr/bin/env python3
"""Touchstone 任务执行引擎：守护线程池 + 按项目串行调度，驱动 agent 多轮执行。

每轮 = 一次 agent 调用（prompt 约束 agent 只执行一轮）；单族化（P7b B4）后 agent
只有 dsh 插件一族——轮次经进程内 agent 驱动（dshdriver）投递并等事件流 turn/end，
多轮共享同一常驻会话（无本地 CLI 子进程、无 status 轮询）。
进程输出实时落盘：<工作目录>/.web/task_<id>_round_<N>.log。

调度（v2a T3 补位器，裁决 R5；v3a 读口切行，v3d 去占用）：统一队列即 wait_items
表（行即成员），承载任务 / 看板卡片 / 会话消息 / 作答四类单元（键 "t:<id>"/"c:<id>"
/"m:<msg_id>"/"a:<id>"）；补位器逐项目从等待区队首启动，直到该项目运行前缀
（state ∈ starting/running 的**行**，唯一来源——c: 行在起跑证实后跨轮 running
存活）达到窗口 N——serial N=1、看板 parallel N=5（t: 单元恒 1：任务串行红线不动，
同项目任务不与任何单元并发改代码）；跨项目并行，同时在跑的项目数上限为 WORKERS；
其余单元留在队列中按序等待。
会话消息单元（2026-09-10）承载「会话详情页发出的消息」：项目忙时与其他单元一样
留队等待，拾起后执行 chat.run_unit（起续聊子进程 / web 驱动 prompt），执行期间
占着项目运行位（= 本单元在「正在开发」队列里有活跃行，v3d 起为唯一表征），
故消息也不会与项目内任务并发改代码。
"""

import concurrent.futures
import json
import os
import platcompat
import re
import signal
import subprocess
import sys
import threading
import time

import db
import dshevents
import dshdriver
import export_cases
import feishu
import lib
import loadcase
import loadgen
import prompts
import rag
import sessparse
import waitq
from agents import agent_family, RETIRED_FAMILY, RETIRED_MSG
# 族判定归属 agents 模块（本文件 re-export 同名属性供外部 runner.agent_family 调用）

SESSION_HINT_RE = re.compile(r'"session_id"\s*:\s*"([^"]+)"')
PID_MARK_RE = re.compile(r"### PID (\d+)")
# 与 server.py 一致：bug_report 目录名时间戳前缀，匹配组为标题
BUG_DIR_RE = re.compile(r"^\d{8}_\d{4}_(.+)$")
LOG_DIR_NAME = ".web"
# 发压阶段工程约束（2026-09-19 压测面板重构批次）：脚本驱动为任意代码，
# 平台只做「超时上限 + 停止宽限 + 杀进程树 + 输出回收」四件事
LOAD_MAX_SECONDS = 7200      # 单次发压硬上限（秒），超过杀进程树并按失败收尾
LOAD_STOP_GRACE = 10.0       # 用户停止后给脚本的优雅收尾宽限（秒）
LOAD_POLL_INTERVAL = 0.5     # 发压进程轮询间隔（秒）：等退出 + 查停止请求
# 项目根（脚本驱动的 PYTHONPATH 注入点：脚本可 import loadgen.MetricsWriter）
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
# dsh 插件族（路线 A）轮次参数：turn 启动宽限（秒）——followup 后 turn/start 由
# agent loop 立刻 append，超过该宽限仍无事件即视为链路/宿主异常，收口本轮
DSH_TURN_START_GRACE = 120.0
# 生命周期阶段有序 key（与 server.STAGES / 前端 STAGES 一致；防循环依赖不 import server）
STAGES = ("gen_case", "execute", "report", "analyze", "fix", "deploy", "retest")
# 日期范围复测：agent 输出固定行「受影响用例：FS0001、FS0002」（行后 200 字符内取 id）
AFFECTED_LINE_RE = re.compile(r"受影响用例[：:]\s*([^\n]{0,200})")


def _extract_affected_ids(text):
    """从文本提取「受影响用例：…」行中的用例 id（去重排序；「无」返回 []）。"""
    m = AFFECTED_LINE_RE.search(text or "")
    if not m:
        return []
    line = m.group(1)
    if line[:12].find("无") >= 0:
        return []
    return sorted(set(re.findall(r"FS\d{4}", line)))

# Runner 模块级单例引用：server.py 构造单例后赋值，board 侧经此访问统一队列
# （None 时 board 退化为直起路径，不走队列）
INSTANCE = None


def notify_task_failed(task_id, error, skipped_n=0):
    """任务失败/中断飞书旁路推送（M1）：读任务行取项目/名称后转 feishu.task_failed；
    任务行已删或任何异常静默跳过（通知永不影响调度主流程）。"""
    try:
        t = db.get_task(task_id)
        if t is None:
            return
        feishu.task_failed(t["project_id"], t["id"], t["name"],
                           t["task_type"] or "normal", error, skipped_n=skipped_n)
    except Exception:
        pass


# ---------- waitq 权威 helper（统一队列） ----------
# P4 起等待项（wait_items）写入全部权威直调（失败即业务失败）；调度放行只认行
# （唯一来源），无第二表征需要维护（影子安全壳已退场）。

_KIND_OF_KEY = {"t": waitq.KIND_TASK, "c": waitq.KIND_CARD,
                "m": waitq.KIND_MSG, "a": waitq.KIND_ANSWER}
_KEY_PREFIX = {v: k for k, v in _KIND_OF_KEY.items()}   # kind -> 队列键前缀（t/c/m/a）


def _answer_row_sid(row):
    """answer 等待项行 meta 里的目标会话 sid（坏 JSON 按空串；
    _pick_locked 的「占位者即本会话自身」判定用）。"""
    try:
        return str(json.loads(row["meta"] or "{}").get("sid") or "")
    except ValueError:
        return ""


def _session_msg_keys(rows, project_id, sid):
    """同项目 + 同 sid 的**运行中** m: 行键集（R7 折抵判据；sid 反查 chat_msgs 行）。

    唯一判据出处：a: 单元折抵（`_answer_exempt_keys_locked`）与 `session_holds`
    读口共用——「占位者即该会话自己的消息单元」在行口径下的等价形态。
    只认运行中行（state ∈ PREFIX_STATES）：等待中的消息尚未占位，语义与旧
    「运行位在场」逐点等价（拾取才在）。rows=已取到的活跃行清单
    （调用方传入，免二次全表读）。
    """
    if not sid:
        return set()
    mids = {r["target_id"] for r in rows
            if r["project_id"] == project_id and r["kind"] == waitq.KIND_MSG
            and r["state"] in waitq.PREFIX_STATES}
    if not mids:
        return set()
    return {f"m:{m['id']}" for m in waitq.msg_rows(sid=sid) if str(m["id"]) in mids}


def _prefix_window_blocked(keys, key, kind, n, exempt=frozenset()):
    """运行前缀窗口闸**唯一出处**（v3a R1，评审 Important-2 收口）：前缀键集
    `keys` 扣除**本单元自己的键** `key` 与折抵键 `exempt` 后 ≥ N ⇒ 留队（True）。

    - `keys` = 行口径前缀成员键集（`Runner._prefix_members(...)` 单项目视图）；
      `n` = 候选单元的窗口 N（调用方给 `Runner._window_n(project_id, kind)`）；
    - t: 键在场时 N 收 1（任务串行红线，任务自身恒 1）——a:/c:/m: 候选中任一
      前缀含 t: 即窗口 1；
    - a: 候选另折抵 `exempt`（`_answer_exempt_keys_locked`：本卡 c: / 同会话 m:，
      解锁「等答案的目标会话自身」）；`ext:` 键**不折抵**（2026-09-28 #610 实障
      收敛：原 P2 R1「外部会话不压答案投递」豁免撤销——送达会唤醒目标会话继续
      跑，与别人的外部会话即真实并发改代码，a: 与其他平台单元同口径等外部会话）；
    - `key=None` 表示「不排除任何键」（项目整窗读口 `_prefix_window_full` 用）。

    **调用面固定三处，必须同口径**：`_pick_locked` 的队首窗口闸、
    `_claim_and_start_locked` 的 claim 后行口径复判、`_prefix_window_full` 的
    项目整窗读口。三处曾各自手抄同一决策——一旦分叉（pick 放行 / claim 拒绝）
    即产生「放回 waiting → 每 5s 重拾」的热旋，且回滚写持 `_cond` 等 DB 锁会
    拖停全体 worker（2026-09-23 隔离实例实测），故收敛为单点，禁止就地展开。"""
    others = keys - {key}
    if kind != waitq.KIND_TASK and any(k.startswith("t:") for k in others):
        n = 1
    if kind == waitq.KIND_ANSWER:
        others = others - set(exempt)
    return len(others) >= n


def _claim_unit(key, claimer="worker"):
    """队列键拾取 → 对应等待项 claim（P4：四类全直调，权威互斥点）。

    False=行已被取消（停卡/移列/停止）或被「立即送达/立即注入」抢占：调用方
    撤销本次接手回等待循环，终态由取消方/直投方负责。claim 瞬时故障（sqlite
    抖动）不得炸掉 worker 线程——异常按 claim 失败处理，行保持 waiting 待下轮。"""
    kind = _KIND_OF_KEY.get(key[0])
    if not kind:
        return True
    try:
        return waitq.claim_by_target(kind, key[2:], claimer)
    except Exception as e:
        print(f"[waitq] {kind} claim 失败（按未拾取处理）: {e}", flush=True)
        return False


def holders_text(inst, project_id):
    """占位者明细文本（等待日志用）：项目运行前缀成员明细「key（evidence，Ns）」，
    空 → 「未知」。占位者=该项目前缀行（`project_holder_details` 行口径）。"""
    now = time.time()
    items = inst.project_holder_details(project_id)
    if not items:
        return "未知"
    return "，".join(f"{d['key']}（{d['evidence'] or '未知'}，"
                     f"{int(now - d['since'])}s）" for d in items)


class Runner:
    """单例运行器：submit/submit_card 入队（任务与看板卡片混合 FIFO），
    多工作线程按项目串行调度（同项目串行，跨项目并行）。"""

    # 同时在跑的单元数上限（= worker 线程数）：同一项目内任务严格串行，
    # 不同项目的单元可并行，超出上限的项目任务在队列中等待。
    # v2a T3（裁决 R2）4→6：v2 并行窗口 N=5 须可达（单项目并行 5 + 1 余量给
    # m:/a: 瞬态投递单元，防饿死）。代价评估：每 worker 一个常驻 daemon 线程，
    # 4→6 仅多 2 条线程栈、空闲时 cond.wait 零消耗；agent 真实并发上限仍由
    # 「每项目前缀窗口」约束（serial 1 / parallel 5，t: 恒 1），WORKERS=6 只
    # 放大「跨项目并行项目数」与「并行模式窗口填充率」，不放大约束内并发。
    # worker 不足时前缀余量等 worker 空出 = 正常态（R2 明示）。
    WORKERS = 6
    # 压测任务首次发压的轮次号：第 1 轮 agent 出方案包，首次发压记为第 2 轮；
    # 复压在此之上递增（2、3、4…），见 _next_load_round_no。此常量只作为
    # 「首次发压」的基准（存量语义），不再写死每次发压都占第 2 轮。
    LOAD_ROUND_NO = 2
    # parallel 模式队首责任区长度（v2 §2.2【已定】，裁决 R5③；serial 恒 1，
    # t: 单元恒 1——任务串行红线不动）
    PARALLEL_PREFIX_N = 5

    def __init__(self, boot_gate=False):
        """boot_gate=True：worker 线程就绪后先停在**启动闸**后，直到
        `release_boot_gate()` 放行（服务启动序见 server.py；默认 False＝构造即可
        拾取，单测直建 Runner() 的既有语义不变）。"""
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        # P6（移交⑧）：`_msgs`/`_msg_sid` 内存镜像已退场——读侧全查表
        # （项目来源=msg 等待项行，sid=chat_msgs 行）
        self._procs = {}          # task_id -> Popen 当前 agent 进程（仅任务单元，键保持 int）
        self._stop_requested = set()  # 已请求停止的任务 id
        self._liveness_probe = None   # Optional[cb(wait_row)->verdict] board 注册的
                                      # 行判活探针（v3c 行版：web 族卡 busy 三态）
        # 启动闸（P7a 缺陷 F）：worker 线程在**模块导入期**（server.py 构造本实例）
        # 即就绪，而启动对账（runner.recover → board.recover → reconcile_units）在
        # main 里跑。不加闸时，库里上一实例遗留的 waiting `a:`/`t:` 行会被 worker
        # 先 claim（state→starting），随后 recover 的 return_to_waiting 把它放回
        # waiting 并**清掉 not_before**——与在途投递竞态（同一失败打两条「第 1 次」
        # 日志、retries 双增），存活横幅也因 n_alive=0 而消失。
        # server.py 传 boot_gate=True 并在对账全部跑完后 release_boot_gate()。
        self._boot_gate = threading.Event()
        if not boot_gate:
            self._boot_gate.set()
        self._threads = [threading.Thread(target=self._worker, daemon=True,
                                          name=f"touchstone-runner-{i}")
                         for i in range(self.WORKERS)]
        for t in self._threads:
            t.start()

    # ---------- 队列键规范 ----------

    @staticmethod
    def _tkey(task_id):
        """任务队列键。"""
        return f"t:{task_id}"

    @staticmethod
    def _ckey(card_id):
        """看板卡片队列键。"""
        return f"c:{card_id}"

    @staticmethod
    def _mkey(msg_id):
        """会话消息队列键（chat.py 登记的 msg_id，字符串，不带冒号）。"""
        return f"m:{msg_id}"

    @staticmethod
    def _akey(card_id):
        """答案队列键（target=卡片 id；与 c: 同目标空间、前缀不同）。"""
        return f"a:{card_id}"

    # ---------- 对外 API ----------

    def submit(self, task_id):
        """入队任务（调用方已把 status 置为 queued）。

        P4：权威写入即入队（waitq.enqueue 插 waiting 行，行即队列位次），写表
        成功后 notify——「先表后队」由写序天然保证。行已活跃（重复 submit/排队中
        restart）时幂等复用，位次不动（等价原「键已在队列不重复入队」）。"""
        t = db.get_task(task_id)
        if t is not None:
            waitq.enqueue(waitq.KIND_TASK, task_id, t["project_id"])
        with self._cond:
            self._cond.notify_all()
        if t is not None and self.unit_busy(t["project_id"]):
            # 排队等待诊断（P4 必带⑤）：前排成员明细格式「key（evidence，Ns）」
            print(f"[runner] 任务排队等待：t:{task_id}"
                  f"（前排：{holders_text(self, t['project_id'])}）", flush=True)

    def submit_card(self, card_id, extra="", from_column="", after_prefix=False):
        """看板卡片入队（统一队列：与任务同 FIFO，同项目串行；幂等）。

        P4：经 waitq.enqueue_card 一个事务写等待项 + 排队占位投影（占位已在
        doing+queue 时条件跳过——不覆盖 answer 路径空 block_text，裁决 R6）。
        extra（打回意见）/from_column（起跑失败回列目标，裁决 R7）随 meta
        持久化（重启不再丢）。
        after_prefix=True（v2b T2，裁决 R9）：续跑/手动恢复（review/blocked）
        改走原子变体 waitq.insert_card_after_prefix——插「运行前缀后」=
        等待区最前（行+占位仍单事务）；默认 False=todo 首次起跑落等待区末尾。"""
        card = db.get_board_card(card_id)
        if card is not None:
            if after_prefix:
                waitq.insert_card_after_prefix(
                    card_id, card["project_id"], extra=extra,
                    from_column=from_column or card["column_key"])
            else:
                waitq.enqueue_card(card_id, card["project_id"], extra=extra,
                                   from_column=from_column or card["column_key"])
        with self._cond:
            self._cond.notify_all()
        if card is not None and self.unit_busy(card["project_id"]):
            print(f"[runner] 卡片排队等待：c:{card_id}"
                  f"（前排：{holders_text(self, card['project_id'])}）", flush=True)

    def submit_msg(self, msg_id, project_id, sid=""):
        """会话消息入队（统一队列第三类单元：与任务/卡片同 FIFO，同项目串行；幂等）。

        项目忙时留队等待（判据=`unit_busy`：项目前缀行数 ≥ N，或项目存在活跃
        `ext:` 行——外部会话不受平台控制，平台起的单元一律等它结束，**与 N 无关**），
        空闲则 worker 立刻拾起执行 chat.run_unit。执行期间占着项目运行位（行
        即表征），反向阻塞该项目后续任务/卡片（双向串行，不留竞态窗口）。

        等待项/消息行的权威写入归 chat.submit（waitq.msg_enqueue），P4 起
        `_queue` 退场——行即登记（chat.submit 已写 msg 等待项），此处只唤醒
        worker。P6 起 `_msgs`/`_msg_sid` 内存镜像亦退场（移交⑧）：拾取时项目
        来源读等待项行、sid 读 chat_msgs 行；msg_id/project_id/sid
        形参保留调用面稳定，不再登记。"""
        with self._cond:
            self._cond.notify_all()

    def remove_msg(self, msg_id):
        """会话消息出队（取消排队；已在执行的消息不走本接口，由 chat.stop 中断）。

        P3 起权威取消归 chat.cancel；P4 起 `_queue` 退场、P6 起内存镜像退场
        （移交⑧）——本函数只剩唤醒 worker（让已取消的行尽快退出拾取视野）。"""
        with self._cond:
            self._cond.notify_all()

    def submit_answer(self, card_id):
        """答案单元入队（统一队列第四类单元：与任务/卡片/消息同 FIFO，同项目
        串行；幂等）。

        权威在 wait_items 表——调用方（board 作答排队路径 / recover 重建）先写
        行再调本方法；P4 起 `_queue` 退场，行已由调用方写入，此处只唤醒 worker。
        可拾取性由 _pick_locked 按 answer 行判定（waiting、not_before 已到、
        外部条目闸放行、折抵自身占位后前缀窗口未满——v2a T3 补位器口径，R5⑥；
        2026-09-28 起外部会话同样压答案投递，#610 实障）。"""
        with self._cond:
            self._cond.notify_all()

    def remove_answer(self, card_id):
        """答案单元出队（停卡/移列放弃、「立即送达」接管时摘除；幂等，不在则
        no-op）。P4 起 `_queue` 退场只剩唤醒——权威取消归 board 的
        waitq.cancel，本函数不再触碰任何持久状态。"""
        with self._cond:
            self._cond.notify_all()

    def msg_waiting(self, msg_id):
        """消息是否仍排队等待执行（前台展示用；P4 起查等待项表——waiting 行即排队）。"""
        row = waitq.get_active(waitq.KIND_MSG, msg_id)
        return row is not None and row["state"] == waitq.STATE_WAITING

    def _window_n(self, project_id, kind):
        """补位窗口 N（裁决 R5③）：t: 单元恒 1（任务串行红线不动——同项目任务
        不与任何单元并发改代码，§11 裁决①）；看板卡单元族 c:/m:/a: 按项目模式
        parallel → PARALLEL_PREFIX_N、serial → 1。
        mode 读取锚点=board.settings_of（board.py:504 判定区同款；读取层已把
        未知/缺省值归一为 serial）。函数内 import 防循环（board 模块级 import
        runner）。"""
        if kind == waitq.KIND_TASK:
            return 1
        import board  # 函数内 import 防循环
        mode = board.settings_of(project_id).get("mode")
        return self.PARALLEL_PREFIX_N if mode == "parallel" else 1

    def _prefix_window_full(self, project_id):
        """前缀窗口是否已满（裁决 R5⑦「前缀窗口已满」的行读口）：
        项目运行前缀**行数**（state ∈ PREFIX_STATES）≥ N（serial 1 / parallel 5，
        `_window_n`）；前缀内有 t: 成员时恒 1（任务串行红线，与补位器同口径）。
        行即成员、唯一来源（R1）——c: 行起跑证实后跨轮 running 存活，无需任何
        去重；serial N=1 ≡ 现状「任一前缀行即忙」（行为不变），parallel N=5。
        决策体 = `_prefix_window_blocked`（key=None：项目整窗，不排除任何键）。"""
        keys = self._prefix_members(
            waitq.active_items(project_id)).get(project_id) or set()
        return _prefix_window_blocked(
            keys, None, waitq.KIND_CARD,
            self._window_n(project_id, waitq.KIND_CARD))

    def _unit_window_blocked(self, project_id, key, kind, exempt=frozenset()):
        """claim 后行口径窗口复判（R1）：`_pick_locked` 窗口闸的 claim 侧
        孪生——项目前缀行扣除**本单元自己的行**（claim 后本行已 starting，属
        前缀）与折抵键后是否 ≥ N；无第二来源参与放行。

        决策体 = `_prefix_window_blocked`（与 pick 闸**同一处代码**，防两侧分叉
        成热旋）；折抵（exempt）由调用方按 a: 单元自身占位折抵口径给出
        （`_answer_exempt_keys_locked`），与 `_pick_locked` 同源。"""
        keys = self._prefix_members(
            waitq.active_items(project_id)).get(project_id) or set()
        return _prefix_window_blocked(keys, key, kind,
                                      self._window_n(project_id, kind), exempt)

    def unit_busy(self, project_id):
        """项目当前是否忙=新单元必须留队（**与 `_pick_locked` 放行口径一致**）：

        - 前缀窗口已满（R5⑦，serial ≡「任一前缀行即忙」；parallel N=5）；或
        - 项目存在活跃 `ext:` 行（外部会话在跑）——外部条目不受平台控制，
          平台起的单元一律等它结束（**与 N 无关**：parallel 下一条 ext 行也挡
          全部平台单元），与 `_pick_locked` 的项目队首闸同源（判据直接来自行，
          无探针注册面）。

        口径一致性动因：`unit_busy` 是提交时「本单元会不会排队」的展示判据
        （`chat.submit` 的 queued 字段 / 会话 meta 的 project_busy），
        必须与调度侧的真实放行结论一致，否则 parallel 项目会显示「不排队」
        而实际留队。`a:` 单元的豁免不在此表现（`unit_busy` 只服务 m: 等提交面）。
        """
        with self._cond:
            if self._prefix_window_full(project_id):
                return True
            return bool(project_id) and waitq.active_ext(project_id)

    def card_started(self, card_id, project_id, ext=None):
        """卡片起跑证实（六条路径共用）：把卡行置 running（`waitq.enter_running`，
        行即条目）+ 证据落行（`waitq.mark_evidence`）：worker 起跑 / force 直起 /
        recover 重建 / 交互阻塞解除归位 / 答案送达 / 立即送达。

        v3d 去占用后本入口**不再登记任何第二表征**（第二表征连同 forced 并存
        概念退场，§2.5）：起跑证实的语义收敛为「确保 c: 行存在且为 running」——
        本卡自此占着项目运行位（占用 = 行在场），会话结束由 `card_finished` 收口。
        入口幂等且恒成功（无活跃行则建行 / 终态行重开 / 活跃行升格）；返回值保留
        给调用方做流控（恒 True，与旧「登记成功/被拒」判别不同：被拒形态已不存在）。

        ext：登记证据（desc / reason / pid——CLI 族卡由调用方补 pid，判活证据）。
        """
        payload = {"desc": "卡片会话占用"}
        payload.update(ext or {})
        waitq.enter_running(waitq.KIND_CARD, card_id, project_id)
        waitq.mark_evidence(waitq.KIND_CARD, card_id, payload)
        with self._cond:
            self._cond.notify_all()
        return True

    def card_finished(self, card_id, reason=""):
        """卡片会话结束收尾（收尾原语：v2d T1 起生产调用面归 board.finish 唯一
        收尾点，本方法承担行终态 + notify 两段；测试/旧路径直调同型幂等）。
        reason 为收尾标签：本方法只用它出日志——行收口成功时由唯一收尾点
        `board.finish` 打一行确定性日志（`[board] 卡片收尾：c:<id>（<reason>）`，
        v3 终审修复：v3d 删租约层后运行/收尾态行的 reason 原本无任何落点）。
        行收口门禁 = (running, finishing)——v3a 起起跑证实即 running（六条起跑
        路径统一 `enter_running`），行整程跨轮存活、会话结束在此收口落 done；
        v2d T1 扩 finishing（finish() 的 mark_finishing 先把 running 行置
        finishing——finishing 态唯一生产路径，门禁不接纳则该行无人终态化）；
        starting 行不收——起跑失败行终态归 worker finally（failed「起会话
        失败」，本函数不得抢先标 done——dequeue_start 失败分支会经 finish()
        调本函数回滚，若收 starting，仍 starting 的拾取行先被标 done、
        worker finally 的 finish FAILED 成 no-op，基线行终态被翻转）。无活跃
        行或非 (running,finishing) 行：行收口跳过（各释放路径全部幂等）。
        返回是否真实收口一行（门禁命中且落终态成功）——调用方据此判日志落点
        （幂等重入/门禁跳过不算收口，不落日志）。"""
        row = waitq.get_active(waitq.KIND_CARD, card_id)
        collected = False
        if row is not None and row["state"] in (waitq.RUNNING, waitq.FINISHING):
            collected = waitq.finish_by_target(waitq.KIND_CARD, card_id)
        with self._cond:
            self._cond.notify_all()
        return collected

    def project_holder_details(self, project_id):
        """项目占位者明细（诊断用，行口径）：[{key, since, evidence}]。

        占位者 = 该项目运行前缀成员（state ∈ PREFIX_STATES 的活跃行，唯一来源）；
        since=行创建时间（epoch 秒，`created_at` 文本时间戳解析，坏值按当前时刻
        ——年龄按 0 报，不误报超长占用）；evidence=行心跳证据（evidence JSON 的
        `evidence`）回落登记描述（`desc`）。供队列等待日志输出「谁在前面」。"""
        now = time.time()
        out = []
        for row in waitq.active_items(project_id):
            if row["state"] not in waitq.PREFIX_STATES:
                continue
            try:
                ev = json.loads(row["evidence"] or "{}")
                if not isinstance(ev, dict):
                    ev = {}
            except ValueError:
                ev = {}
            try:
                since = time.mktime(time.strptime(row["created_at"],
                                                  "%Y-%m-%d %H:%M:%S"))
            except (ValueError, TypeError, OverflowError):
                since = now
            out.append({"key": waitq.member_key(row["kind"], row["target_id"]),
                        "since": since,
                        "evidence": ev.get("evidence") or ev.get("desc") or ""})
        return out

    def session_holds(self, project_id, sid):
        """项目运行前缀里是否有该会话自己的消息单元（行口径：同 sid 的活跃
        m: 行，`chat_msgs.sid` 反查；判据唯一出处见模块级 `_session_msg_keys`）。

        用来区分「项目忙，但忙的正是本会话」：消息单元（"m:<msg_id>"）执行期间
        占着项目运行位并等目标会话 turn 结束，而该 turn 可能正挂在 agent 提问上
        ——此时按「项目忙」延后作答即三方互等（答案等单元结束、单元等 turn
        结束、turn 等答案），卡片滞留「排队中」直到超时或服务重启
        （2026-09-19 实障：卡 391 会话被「grill-me」消息单元占住、作答死锁）。
        占位者即本会话时送达答案不会与任何单元并发改代码（同会话本由驱动侧
        串行），是唯一的解锁动作。锁内 DB 点查，先例同 _pick_locked。
        """
        if not sid:
            return False
        with self._cond:
            rows = waitq.active_items(project_id)
        return bool(_session_msg_keys(rows, project_id, sid))

    def notify_busy_change(self):
        """运行前缀成员变化（外部条目 ext 行建/消——调和器节拍与入队/恢复前
        同步刷新）时由 board 调用：唤醒空闲 worker 重新挑选（否则外部会话结束
        无人 notify，排队卡滞留；补位时机③的即时唤醒，5s 节拍兜底仍在）。"""
        with self._cond:
            self._cond.notify_all()

    def unit_state(self, key, project_id):
        """单元在统一队列中的态（会话详情页标题「队列」徽标的数据源；只读）。

        返回 {"state": "running"|"queued"|"idle", "pos": int, "total": int}：
        - running：本单元有**运行中行**在场（行口径，v3d：c:/t:/m:/a: 四类的活跃
          非等待行——waiting 即排队，见下支）——t:/m: 拾取即置 starting 跨整轮、
          c: 起跑证实后跨轮 running（六条起跑路径统一 enter_running）、a: 送达期
          瞬态；行不在场（未入队/已终态/键失效）按 idle（如送达生效前的瞬态
          残留，下轮挑选自会清理）；
        - queued：等待项表里仍有本单元的 waiting 行（P4 起表驱动，R2）；
          **v2a T4 起位次含运行前缀（裁决 R7，「claimed 不计」口径废止）；
          v3a 起前缀成员口径 = 行（唯一来源，R1/R2）**：
          pos = 前缀成员数（项目内 starting/running/finishing 行）+ waiting 行中
          seq 更小者 + 1（1 基，即"本项目前面还有几个"），total = 项目成员总数
          （行）。行即运行成员的完整表征（c: 行在起跑证实后跨轮 running 存活）。
          他项目单元不计入位次——同项目串行才是"前面还有几个"的实际约束；
        - idle：表中数不到本单元的活跃行（未入队/已终态/键失效；下轮挑选自会
          清理残留脏行）。
        """
        with self._cond:
            kind = _KIND_OF_KEY.get(key[0])
            if kind is not None and project_id:
                # running = 本单元有运行中行（v3d 行口径）：活跃非等待即运行上报
                # ——waiting 行落 queued 支计位次（排队语义）。项目比对是防御
                # （行在他项目=调用方传参漂移）：按空闲返回比报运行中安全。
                row = waitq.get_active(kind, key[2:])
                if row is not None and row["project_id"] == project_id \
                        and row["state"] != waitq.STATE_WAITING:
                    return {"state": "running", "pos": 0, "total": 0}
            if kind is None or not project_id:
                return {"state": "idle", "pos": 0, "total": 0}
            prefix_keys, total_keys = set(), set()
            waiting = []                      # [(成员键, 行)]，seq 升序
            for row in waitq.active_items(project_id):
                rk = waitq.member_key(row["kind"], row["target_id"])
                total_keys.add(rk)
                if row["state"] == waitq.STATE_WAITING:
                    waiting.append((rk, row))
                else:
                    prefix_keys.add(rk)       # starting/running/finishing：位次前缀（R7 全计）
            mine = False
            ahead = 0
            for rk, row in waiting:
                if row["kind"] == kind and row["target_id"] == key[2:]:
                    mine = True               # 本单元 waiting 行（活跃唯一索引保证唯一）
                elif not mine and rk not in prefix_keys:
                    ahead += 1                # waiting 且 seq 更小者（升序遍历即排在前面）
            if not mine:      # 表中数不到（行已终态/取消）：按空闲（下轮挑选自会清理）
                return {"state": "idle", "pos": 0, "total": 0}
            return {"state": "queued", "pos": len(prefix_keys) + ahead + 1,
                    "total": len(total_keys)}

    def stop(self, task_id):
        """停止任务：waiting（排队中）→ 取消等待项并立即标 stopped+跳后段；
        starting（运行中）或无行但在跑 → 杀进程，由轮边界收口。

        P4（R9）+评审修正：排队分支的「键在 _queue」check-then-act 换成
        waitq.cancel 的 rowcount 守卫（与 worker claim 竞态下不双执行，同
        chat.cancel 仲裁模式）；但 cancel 的状态守卫覆盖全部活跃态，运行中
        任务的行从拾取到 finally 整程 starting——
        直接 cancel 会把「停止运行中任务」误判成排队命中（同步取消 starting 行 +
        立即 stopped + 提前跳后段，监控瞬间翻转、终态证据变 cancelled）。故先
        get_active 验行态分流：waiting → cancel+stopped（读-写竞态由 rowcount
        兜底）；starting/无行 → 只加 _stop_requested + 杀进程，轮边界统一落
        stopped/跳后段（等待项终态证据保持 done/failed（finally
        `FAILED if err else DONE`）而非 cancelled，children 在父任务死透后才
        跳过——P5 必带①文案修正）。"""
        with self._cond:
            self._stop_requested.add(task_id)
            row = waitq.get_active(waitq.KIND_TASK, task_id)
            queued = row is not None and row["state"] == waitq.STATE_WAITING \
                and waitq.cancel(waitq.KIND_TASK, task_id, "用户停止")   # rowcount 仲裁（R9）
            if queued:
                db.update_task(task_id, status="stopped", ended_at=db.now_str())
                self._skip_pipeline_children(task_id, "前段任务已停止，后段跳过")
            proc = self._procs.get(task_id)
            self._cond.notify_all()
        if proc is not None:
            try:
                platcompat.kill_tree(proc.pid, signal.SIGTERM)
            except OSError:
                pass
        # dsh 插件族任务无本地进程可杀：直接 cancel 当前 turn
        # （轮询循环的 _stop_requested 检查兜底；cancel 失败说明 turn 已结束，忽略）
        t = db.get_task(task_id)
        if t and t["session_id"]:
            proj = db.get_project(t["project_id"])
            family = agent_family(proj["agent_path"]) if proj else ""
            if family == "dsh_plugin":
                # 路线 A：会话在 dsh 宿主进程内，cancel 优雅中断当前 turn
                # （保留已流式交付的文本；无本地子进程可杀）
                try:
                    dshdriver.cancel(t["session_id"])
                except dshdriver.DshDriverError:
                    pass

    def restart(self, task_id):
        """重启任务：清掉停止标记，重置轮次计数与状态后重新入队。

        旧轮次记录一并清空（重启=从第一轮重跑，避免 round_no 重复）。
        P4：置 queued 后调 self.submit（权威写入即入队——先改状态后写行，
        worker 拾取时状态校验必通过）。
        """
        with self._cond:
            self._stop_requested.discard(task_id)
            db.delete_rounds(task_id)
            db.update_task(task_id, status="queued", current_round=0, new_bugs=0,
                           error="", ended_at=None, session_id=db.get_task(task_id)["session_id"])
        self.submit(task_id)

    def rerun_load(self, task_id):
        """复压：跳过 agent 轮，用现有方案包再跑一次发压运行（2026-10-06）。

        与 restart 的区别：不清轮次、不动 session、不重跑 agent（方案包不改），
        只追加一次 `kind='load'` 的发压运行——语义是「同一方案再压一次」。
        与 resume 的区别：不复用会话、不跑 agent 轮。

        `load_rerun=1` 必须落库（不能放内存）：排队行可跨服务重启存活，recover
        放回 waiting 后仍要按「只跑发压」执行。P4 写序同 restart——先置状态与
        标记再 submit，worker 拾取时状态校验必通过。
        """
        with self._cond:
            self._stop_requested.discard(task_id)
            db.update_task(task_id, status="queued", load_rerun=1,
                           error="", ended_at=None)
        self.submit(task_id)

    def resume(self, task_id):
        """续跑任务（「继续」）：保留轮次记录、轮次计数与会话，从下一轮接着跑。

        与 restart 的区别：不清空轮次、不重置计数，session 由 build_cmd 按
        session_id 自动恢复；fresh_prompt 标记由 server 层在入队前置 1，
        使续跑第一轮使用完整首轮提示词（携带用户新修改的参数）。
        P4：置 queued 后调 self.submit（同 restart 的写序纪律）。
        """
        with self._cond:
            self._stop_requested.discard(task_id)
            db.update_task(task_id, status="queued", error="", ended_at=None)
        self.submit(task_id)

    def remove(self, task_id):
        """删除前置处理：任务若在排队中则取消其等待项（运行中的任务由 server 层
        拒绝删除）。

        P4：`_queue` 退场，waitq.cancel 直调即出队（行即队列；幂等，无活跃行
        返回 False；非 waiting 行不被复活——rowcount 守卫）。"""
        waitq.cancel(waitq.KIND_TASK, task_id, "任务删除")

    def recover(self):
        """服务启动恢复（P4 重启矩阵，四类单元各归其位；P5 必带②③重排；
        v2a T1 七枚举映射，裁决 R3）：

        - 任务侧：仅执行中（running）任务打断——杀残留进程组 + interrupted +
          「前段任务被服务重启中断，后段跳过」（现状口径，不变⑤）；queued 任务
          不再被打断（明示变更①：waiting t: 行存活即续跑，设计 §2.3「排队项
          保留」落地），缺行的排队任务防御性补建；
        - 等待项即队列：waiting 的 t:/c:/m:/a: 行全量存活——t:/c: 行在即排队
          （位次以表 seq 为准），m:/a: 行存活（P6 起 `_msgs`/`_msg_sid` 镜像
          退场：读侧全查表，无镜像可建——移交⑧）；
        - starting/running/finishing 按 v2a T1 映射收口（claimed 已被 starting
          吸收，三态同型处理）：a: 放回 waiting 重投（P2，投递幂等，
          必带③：放回计入 n_requeue）；m: 记 error=服务重启中断（P3，重发非
          幂等）；t: 任务仍 queued → 放回 waiting 续跑（必带②：消除「claim↔置
          running 间崩溃 → 行 starting 滞留」微窗口），非 queued 维持 cancel；
          c: 不在此收口——交 board.recover 按实况映射（占位/无实况
          starting→cancelled 并对账补建、无实况 running/finishing→failed+
          卡落 review、实况 busy→行置 running；非 waiting 行必须
          终态化或证实，否则活跃唯一索引会被 enqueue 幂等复用成「永不拾取」
          幽灵）。**非 waiting 收口先于 queued 防御补建**（必带②顺序硬约束：
          放回的行让补建检查看到活跃行、不重复插入）；
        - 队列与运行态**全按行重建**（v3d）：无任何第二表征需要清理；残留
          占位行由 runner.recover 之后的 `reconcile_units()` 按**行证据**裁活
          （顺序硬约束：board.recover 重建 busy web 卡的行/在管条目之后才对账，
          否则误杀）。"""
        with self._cond:
            tasks = [dict(r) for r in db.list_all_tasks()]
            self._procs = {}
            self._stop_requested = set()
            # —— 非 waiting 收口先行（必带②），waiting 行存活计数同趟 ——
            n_alive = n_requeue = 0
            for arow in waitq.active_items():
                kind, target = arow["kind"], arow["target_id"]
                if arow["state"] == waitq.STATE_WAITING:
                    n_alive += 1
                    if kind in (waitq.KIND_MSG, waitq.KIND_ANSWER):
                        n_requeue += 1      # m:/a: waiting 行存活（无镜像可建，移交⑧）
                    continue
                # starting/running/finishing 行（v2a T1 映射；claimed 已被
                # starting 吸收——同一收口面，三态同型处理）
                if kind == waitq.KIND_CARD:
                    continue            # c: 交 board.recover 按实况收口（见其重建段）
                if kind == waitq.KIND_ANSWER:
                    waitq.return_to_waiting(arow["id"])          # P2：重投
                    n_requeue += 1                               # 必带③：放回计入重投
                elif kind == waitq.KIND_MSG:
                    waitq.mark_failed(arow["id"], "服务重启中断")
                    waitq.msg_recover_fail(target)               # P3：不重投
                elif kind == waitq.KIND_TASK:
                    # 必带②：任务仍 queued（claim↔置 running 间崩溃）→ 放回续跑；
                    # 非 queued（running 任务在下方照旧 interrupted）→ 维持 cancel
                    trow = db.get_task(int(target)) if target.isdigit() else None
                    if trow is not None and trow["status"] == "queued":
                        waitq.return_to_waiting(arow["id"])
                        n_requeue += 1
                    else:
                        waitq.cancel(kind, target, "服务重启中断")
            for t in tasks:
                if t["status"] != "running":
                    if t["status"] == "queued" \
                            and waitq.get_active(waitq.KIND_TASK, t["id"]) is None:
                        # 防御对账：排队任务缺等待项行（异常丢失）→ 补建（同 board.recover
                        # 对账哲学；必带②——在非 waiting 收口之后跑，放回的行不会重复补）
                        waitq.enqueue(waitq.KIND_TASK, t["id"], t["project_id"])
                    continue
                # 仅执行中任务打断（现状口径：杀残留 + interrupted + 通知 + 跳后段）；
                # queued 存活（明示变更①，设计 §2.3「排队项保留」落地）
                self._kill_residual(t["id"])
                self._finalize_load_rounds(t["id"])
                db.update_task(t["id"], status="interrupted", error="服务重启中断",
                               ended_at=db.now_str())
                notify_task_failed(t["id"], "服务重启中断")
                self._skip_pipeline_children(t["id"], "前段任务被服务重启中断，后段跳过")
            if n_alive:
                print(f"[runner] 服务重启：waiting 等待项存活 {n_alive} 条"
                      f"（t:/c:/m:/a: 行即队列；m:/a: 存活 {n_requeue} 条）", flush=True)
            self._cond.notify_all()

    def release_boot_gate(self):
        """放行启动闸（P7a 缺陷 F；幂等，裸实例/无闸实例调用安全）。

        server.py 启动序硬约束：init_db → runner.recover → board.recover →
        reconcile_units **全部跑完**后调用本方法——此后 worker 才开始拾取，第一次
        `_pick_locked` 看到的即启动对账后的权威行态，不会出现「worker 先 claim
        遗留 waiting 行 → recover 的 return_to_waiting 清掉在途投递的 not_before
        退避」竞态（同一失败两条「第 1 次」日志、retries 双增、存活横幅因
        n_alive=0 消失）。闸未开的实例（boot_gate=False）调用为 no-op。"""
        gate = getattr(self, "_boot_gate", None)   # 裸 Runner（__new__，单测主力）：无闸
        if gate is None:
            return
        gate.set()

    def _kill_residual(self, task_id):
        """按最新轮次日志中记录的 PID 尝试杀进程（尽力而为）。"""
        task = db.get_task(task_id)
        if task is None:
            return
        rounds = db.list_rounds(task_id)
        for r in reversed(rounds):
            if r["status"] != "running" or not r["log_path"]:
                continue
            text = read_log_tail(r["log_path"], 20)
            for m in PID_MARK_RE.finditer(text):
                try:
                    os.kill(int(m.group(1)), signal.SIGTERM)
                except OSError:
                    pass

    @staticmethod
    def _finalize_load_rounds(task_id):
        """把残留的进行中发压运行行收口为 interrupted（服务重启打断）。

        发压进程随服务退出而死，运行行不能永远停在 running（否则运行列表里该次
        运行看起来一直在跑）。本收口只碰 `kind='load'` 行；agent 轮次的收口沿用
        既有口径（round 行由 finish_round 在轮末落定）。
        """
        for r in db.list_rounds(task_id):
            if r["kind"] == "load" and r["status"] == "running":
                db.finish_round(r["id"], "interrupted", None, "服务重启中断",
                                r["log_path"])

    def _skip_pipeline_children(self, task_id, reason):
        """前段任务未正常完成（停止/失败/中断）时，跳过其排队中的后段任务。

        后段标 done、原因写入 error 字段（任务列表可见）；已在跑/已结束的不动。
        不在队列中的僵尸行（若残留）由 _pick_locked 的状态清理分支移除。
        返回本次跳过的后段条数（失败通知文案用；调用方可忽略）。
        """
        n = 0
        for t in db.list_all_tasks():
            if (t["task_type"] or "normal") != "pipeline" or t["status"] != "queued":
                continue
            try:
                if json.loads(t["payload"] or "{}").get("parent_task_id") != task_id:
                    continue
            except ValueError:
                continue
            db.update_task(t["id"], status="done", error=reason, ended_at=db.now_str())
            waitq.cancel(waitq.KIND_TASK, t["id"], reason)
            n += 1
        return n

    # ---------- 工作者 ----------

    @staticmethod
    def _prefix_members(rows):
        """调度口径运行前缀成员（裁决 R5①；v3a 读口切行）：{project_id: {队列键…}}
        = wait_items state∈PREFIX_STATES（starting/running）行的队列键。

        成员**只由行构成、唯一来源（R1）**——c: 行在起跑证实后保持 running 跨轮
        存活（`card_started`→`waitq.enter_running` 不再终态化），行本身即运行成员。
        ext 行入场即 running，天然落入本集合（键按 `ext:<卡 id>` 直拼；同卡的
        平台持有者由 board._platform_holds 互斥保证）。
        finishing 行不计（收尾窗口不再占补位名额；位次口径另含 finishing，
        见裁决 R7/v2a T4）。
        """
        members = {}
        for row in rows:
            if row["state"] in waitq.PREFIX_STATES:
                members.setdefault(row["project_id"], set()).add(
                    waitq.member_key(row["kind"], row["target_id"]))
        return members

    def _answer_exempt_keys_locked(self, row, rows):
        """a: 行自身占位折抵（裁决 R5⑥/R7 行口径）：目标会话被「同 sid 的 m:
        运行单元」占着时该占用不计入前缀；本卡 c: 活跃行（`board._card_unit_active`
        ——行即持有者，不另造第二判据）同豁免（保留原 _own_occupancy 双判据——
        送达答案是解锁动作，2026-09-19 卡 391 死锁修复）。返回应从本单元前缀计数
        中折抵的键集（选择性折抵：豁免只覆盖自身占位，同场他主行照常计数）。
        外部条目（ext 行）**不在折抵面**（2026-09-28 #610 收敛：原 P2 R1 探针
        豁免撤销——外部会话同样压答案投递，ext: 键由窗口闸照常计数）。
        rows=调用方已取到的活跃行清单（a: 折抵只关心其中同项目的 m: 行）。
        必须用 _locked 判据变体：普通 Lock 下持锁重入即死锁
        （test_pick_locked_own_hold_no_relock_deadlock）。"""
        exempt = set()
        ans_cid = int(row["target_id"])          # 调用方已做 ValueError 防御
        import board  # 函数内 import 防循环（board 模块级 import runner）
        if board._card_unit_active(ans_cid):
            exempt.add(f"c:{ans_cid}")
        exempt |= _session_msg_keys(rows, row["project_id"], _answer_row_sid(row))
        return exempt

    def _pick_locked(self):
        """补位器（v2 §2.2 队首启动规则，v2a T3 重写，裁决 R5）：队列即
        wait_items 表（行即成员——starting/running 行留队构成运行前缀），
        遍历 active_items（seq 升序），逐项目只看等待区队首行：

        ① 折抵后前缀长度 ≥ N(project) → 本项目本轮不启动（前缀内已有运行
          条目，含外部条目 ext 行；**前缀成员=前缀态行，唯一来源**，
           见 _prefix_members——R1）。判定=共用谓词
           `_prefix_window_blocked`（与 claim 侧复判**同一处代码**）；
        ② not_before 未到 / 卡片占位非 doing+queue / 任务非 queued / pipeline
          前段未 done → 队首留队、本项目本轮不再向下补位（各项判定逐字保留；
          无效单元就地终态化——行已消失不占队首位，下一行补上）；
        ③ a: 行卡 391 豁免（R5⑥）：自身占位折抵前缀计数，见
          _answer_exempt_keys_locked；
        ④ **项目外部条目闸**（v3d 修复轮裁决）：该项目存在活跃 `ext:` 行 →
          本项目本轮不补位（**与 N 无关**，parallel N=5 同样留队）——外部会话
          不受平台控制，平台起的单元一律等它结束；判据直接来自 ext: 行
          （行即成员，唯一来源），不经任何探针注册面。a: 候选**同受本闸**
          （2026-09-28 #610 实障收敛，原「a: 单元豁免/送达是解锁动作」撤销——
          答案送达唤醒的是目标会话自身，解锁语义由 ③ 自身占位折抵承担；
          与别人的外部会话并发是真实改代码并发。⚡立即送达仍为用户自担风险的
          人工通道）；
        ⑤ 可启动 → 返回键，由 _claim_and_start_locked 收口（waiting→starting
          原子迁移 + **行口径窗口复判**——放行只认行）。
        N(project)=PARALLEL_PREFIX_N（看板 parallel）或 1（serial）；候选为
        t: 或前缀内已有 t: 成员时恒 1（任务串行红线不动，R5③）。
        外部条目（ext 行）不再经独立探针 gating（R8 探针退役）——其**语义**
        （外部在跑 ⇒ 平台不补位）由 ④ 的 ext 行闸以行判据保留，与 `unit_busy`
        同口径。
        拾取唯一权威=队序（wait_items seq 升序，v2c T2 裁决 R11 双轨并单轨；
        列序挑先 column_order_lt 已退场——调序落点已改 wait_items 位次）。
        返回队列键（"t:"/"c:"/"m:"/"a:" 前缀）或 None=本轮无可补位单元。
        """
        rows = waitq.active_items()                  # seq 升序；四活跃态全集
        members = self._prefix_members(rows)         # 前缀成员=行（v3a 读口切行）
        # 有活跃 ext: 行的项目集（项目外部条目闸判据；行即成员，唯一来源——
        # 判据直接来自本次已取到的行集，无探针注册面、无第二次查询）
        ext_projects = {r["project_id"] for r in rows
                        if r["kind"] == waitq.KIND_EXT}
        head_blocked = set()          # 本轮队首不可启动的项目（只看队首，R5②）
        for i, row in enumerate(rows):
            if row["state"] != waitq.STATE_WAITING:
                continue          # 前缀成员行留队（不重复启动，R5④）
            project_id = row["project_id"]
            if project_id in head_blocked:
                continue          # 队首已留队：本项目本轮不再向下补位
            if row["not_before"] > time.time():
                head_blocked.add(project_id)      # 退避窗口未到（answer 送达退避）：留队
                continue
            kind = row["kind"]
            uid = row["target_id"]
            if kind not in _KEY_PREFIX:
                # 未知 kind 的 waiting 行（封闭集外的理论残留）：不拾不炸，
                # 留队待自检/对账收口（ext 行恒 running 入场，不会走本支；
                # `_KEY_PREFIX` 也不含 ext——外部条目永不被平台拾取）
                continue
            key = f"{_KEY_PREFIX[kind]}:{uid}"
            card = None
            if kind == waitq.KIND_CARD:
                # 看板卡片单元：仍在排队占位态才有效（P4 单态化：占位仅
                # doing+queue，存量 blocked+queue 由启动迁移归位）
                try:
                    card = db.get_board_card(int(uid))
                except ValueError:
                    # c: 脏行（target 非数字；生产不可达，测试字符串 target 残留
                    # 实障）：跳过不摘除（防 int() 炸 worker 线程；行归属方自会
                    # 清理——摘除语义见 a: 分支，但 c:/t: 脏行永远不会被拾取，
                    # 无需摘）
                    continue
                if card is None or card["block_kind"] != "queue" \
                        or card["column_key"] != "doing":
                    waitq.cancel(waitq.KIND_CARD, uid, "占位失效")
                    continue
            elif kind == waitq.KIND_TASK:
                try:
                    task = db.get_task(int(uid))
                except ValueError:
                    continue          # t: 脏行（同 c: 防御口径）：跳过不摘除
                if task is None or task["status"] != "queued":
                    waitq.cancel(waitq.KIND_TASK, uid, "非排队态")
                    continue
                if (task["task_type"] or "normal") == "pipeline":
                    # 后段任务：前段未 done 则留队（防前段被重启重排后后段抢先跑）
                    try:
                        parent_id = json.loads(task["payload"] or "{}").get("parent_task_id")
                    except ValueError:
                        parent_id = None
                    parent = db.get_task(parent_id) if parent_id else None
                    if parent is None:
                        db.update_task(int(uid), status="done",
                                       error="前段任务不存在，后段跳过",
                                       ended_at=db.now_str())
                        waitq.cancel(waitq.KIND_TASK, uid, "前段不存在")
                        continue
                    if parent["status"] != "done":
                        head_blocked.add(project_id)
                        continue
            # （m:/a: 行即登记：无额外有效性检查——行消失即不在扫描集内）
            # —— 前缀窗口闸（R5②）：队首可启动 ⇔ 折抵后前缀长度 < N ——
            # 决策体唯一出处 `_prefix_window_blocked`（与 claim 侧复判同点，
            # 防两侧分叉成热旋）；候选行此刻是 waiting、不在前缀集内，故
            # `- {key}` 为 no-op，与 `_unit_window_blocked` 逐字等价。
            prefix = members.get(project_id) or set()
            exempt = frozenset()
            if kind == waitq.KIND_ANSWER:
                try:
                    int(uid)
                except ValueError:
                    # a: 脏行（target 非数字，理论项）：不可投递，就地摘除
                    # （对齐 recover/卡片分支的防御姿态，防 ValueError 炸 worker）；
                    # 旧版只在 busy 分支摘除，补位器起一律摘除（窗口闸在豁免之后）
                    waitq.cancel(waitq.KIND_ANSWER, uid, "脏行清理")
                    continue
                # a: 自身占位折抵（本卡 c: / 同会话 m:，见 _answer_exempt_keys_locked）：
                # 解锁「等答案的目标会话自身」，他主行/别的单元占用照常计数——含
                # ext: 键（2026-09-28 #610 实障收敛：原 P2 R1「投递只看前缀窗口
                # 不看外部探针」豁免撤销，外部会话同样压答案投递）——折抵规则都在
                # `_prefix_window_blocked` 内，调用方只供 exempt。
                exempt = self._answer_exempt_keys_locked(row, rows)
            if _prefix_window_blocked(prefix, key, kind,
                                      self._window_n(project_id, kind), exempt):
                head_blocked.add(project_id)      # 前缀窗口已满：留队
                continue
            # —— 项目外部条目闸（裁决：外部会话不受平台控制，平台起的单元
            # 与它不并发改代码）——与窗口 N 无关：parallel（N=5）下一条活跃
            # ext: 行同样让本项目本轮不补位；判据=该行在场（行即成员，唯一来源，
            # 不用任何探针注册面）。a: 单元同受本闸（2026-09-28 #610 实障收敛，
            # 原 P2 R1「外部会话不压答案投递」豁免撤销——送达唤醒目标会话继续
            # 跑，与外部会话即真实并发；自身占位折抵见上，⚡立即送达仍为人工
            # 自担风险通道）——
            if project_id in ext_projects:
                head_blocked.add(project_id)
                continue
            return key
        return None

    def _claim_and_start_locked(self, key):
        """锁内拾取收口（_worker 专用，须持 _cond 调用）：解析单元项目 → claim
        仲裁 → 行口径窗口复判。返回 project_id=成功接手；
        None=放弃本次拾取（回等待循环）。

        P4 评审修正（fix round 1，F2）：claim 必须在锁内且先于接手判定。表驱动
        拾取的除重点从内存 `_queue.remove`（锁内摘键）移到 claim 的行级 rowcount
        原子性；若 claim 在锁外做，双拾取竞态下落败方的回滚会误把胜利者刚置
        starting 的行放回——项目位假空闲，排队任务可在答案送达期间并发起跑
        （串行不变量破窗）。claim 完成后：胜利者 claim 即把行置 starting，后续
        worker 的 _pick_locked 跳过非 waiting 行，同键二次拾取在结构上不可达；
        唯一剩余的失败路径是外部线程（取消/立即注入/锁外起跑）在 pick 之后翻掉
        行或占满前缀，此时按 claim 失败同型回滚（行放回 waiting）。
        claim / 复判均为行级写，waitq 不取 runner 锁（无死锁面；
        _pick_locked 锁内读 waitq 有先例）。
        v3d（去占用，R1/R8）：接手=「行置 starting」，**不再登记任何第二表征**
        （第二表征与 forced 并存写入退场）；放行判定归行——claim 后
        `_unit_window_blocked` 按前缀行复判，任何第二来源不得参与放行。
        失败即完整放弃拾取：行保持 waiting（行即队列，无需重入队），终态由
        取消方/直投方负责。
        """
        if key.startswith("c:"):
            card = db.get_board_card(int(key[2:]))
            if card is None:
                # 挑选通过后卡片被删除（看板删卡不持本锁，存在窗口）：未 claim
                # 未接手，直接回等待循环（下一轮 pick 落「占位失效」终态化）。
                # 未经 finally 与经过等价：等待项未登记该 key，
                # finally 的 pop 均为 no-op；notify 由后续入队事件承担。
                return None
            project_id = card["project_id"]
        elif key.startswith("m:"):
            # 会话消息单元：项目从等待项行取（权威在表，与 a: 分支同构；P6 起
            # `_msgs` 镜像退场——移交⑧）。行已消失=拾取判定与本行消失的窗口
            # 竞态，回等待循环，下轮 _pick_locked 自然不再可见
            mrow = waitq.get_active(waitq.KIND_MSG, key[2:])
            if mrow is None:
                return None
            project_id = mrow["project_id"]
        elif key.startswith("a:"):
            # 答案单元：项目从等待项行取（权威在表；行已消失=拾取判定与本行
            # 消失的窗口竞态，回等待循环，下轮 _pick_locked 自然不再可见）
            row = waitq.get_active(waitq.KIND_ANSWER, int(key[2:]))
            if row is None:
                return None
            project_id = row["project_id"]
        else:
            task = db.get_task(int(key[2:]))
            project_id = task["project_id"]                        # 任务单元分支
        # —— claim 仲裁先行（权威互斥点，全四类直调）——
        if not _claim_unit(key):
            # claim 失败 = 行已被取消或被「立即送达/立即注入」抢走：直接回等待循环
            self._cond.notify_all()
            return None
        # —— 行口径窗口复判（R1：任何第二来源不得参与放行）——
        # pick 与 claim 之间可能有锁外起跑（force 直起 / 送达恢复 / recover
        # 重建等不经 _cond 的写行路径），故 claim 后按**前缀行**重判一次：
        # 前缀行（扣除本单元自己的行）≥ N → 按 claim 失败同型回滚（行放回
        # waiting 位次保序）。a: 自身占位折抵与 pick 闸同口径（本卡 c: /
        # 同会话 m: 键折抵；ext: 键不折抵——2026-09-28 #610 起外部会话同样压
        # 答案投递），修好卡 391 死锁在行口径下的等价形态。
        exempt = frozenset()
        if key[0] == "a":
            exempt = self._answer_exempt_keys_locked(row, waitq.active_items())
        if self._unit_window_blocked(project_id, key, _KIND_OF_KEY[key[0]], exempt):
            arow = waitq.get_active(_KIND_OF_KEY[key[0]], key[2:])
            if arow is not None:
                waitq.return_to_waiting(arow["id"])
            self._cond.notify_all()
            return None
        # —— 接手完成：行已 starting（claim 即占位表征）——
        self._cond.notify_all()
        return project_id

    def _worker(self):
        # 启动闸（P7a 缺陷 F）：boot_gate=True 的实例（server.py 服务入口）在
        # `release_boot_gate()` 前不拾取任何行——保证 worker 第一次 _pick_locked
        # 看到的行态已是启动对账（recover → board.recover → reconcile_units）后
        # 的权威态；默认实例闸已开（set），行为与既有逐字一致。
        # 裸 Runner（`__new__` 手工字段，单测主力）无闸字段：getattr 容错，
        # 照旧直接进入拾取循环（tests/test_runner_pick_prefix 直接起 _worker 线程）。
        gate = getattr(self, "_boot_gate", None)
        if gate is not None:
            gate.wait()
        while True:
            with self._cond:
                while True:
                    key = self._pick_locked()
                    if key is not None:
                        break
                    # 补位时机④（裁决 R5⑤）：5s 节拍兜底唤醒——队首头阻塞
                    # （not_before 退避/前缀窗口满）且静场无外部事件时，
                    # 无超时等待会无人再 notify，整个项目饥饿到下个事件
                    # （answer 退避 30s×3≈90s 实障，v2a 子批终审 Critical；
                    # v2b 作答一律入队会进一步放大）。每拍醒来重跑补位器：
                    # not_before 到期/行收口/外部条目变化自然补位。
                    self._cond.wait(timeout=5)
                project_id = self._claim_and_start_locked(key)
                if project_id is None:
                    continue
            err = ""          # 单元异常文本（finally 终态用）
            card_ok = None    # 卡片单元结果（_process_card 返回值）
            try:
                if key.startswith("c:"):
                    card_ok = self._process_card(int(key[2:]))
                elif key.startswith("m:"):
                    # 会话消息执行体（chat.py：起续聊子进程 / web 驱动 prompt 并
                    # 等 turn 结束）；自身吞异常并落消息状态，此处仅防线程拖死
                    import chat
                    chat.run_unit(key[2:])
                elif key.startswith("a:"):
                    # 答案执行体（board.py：读表取载荷送达，终态/退避/放弃自洽，
                    # 正常不抛异常）；函数内 import 防循环（同 _process_card）
                    import board
                    board._deliver_answer_unit(int(key[2:]))
                else:
                    self._process_task(int(key[2:]))
            except Exception as e:  # 保底：任何异常不拖死线程
                err = str(e)[:300]            # 影子（P1）：finally 按 err 记失败终态
                if key.startswith("c:"):
                    # 卡片单元异常：记错到卡片（起会话失败的排队态回滚由
                    # board.dequeue_start 自身负责）；任务分支原有逻辑不动
                    try:
                        db.update_board_card(int(key[2:]), last_error=str(e)[:300],
                                             last_error_at=db.now_str())
                    except Exception:
                        pass
                elif key.startswith("m:"):
                    # 消息单元异常：状态落盘由 chat.run_unit 内部负责，此处不记任务行
                    pass
                elif key.startswith("a:"):
                    # 答案执行体异常兜底（业务失败已在执行体内部分流，此处只防
                    # 未预期异常把行永久挂在 starting）：放回 waiting 重入队，
                    # 不计业务重试额度（与原调和器「异常不外抛、下轮再投」一致）；
                    # 放回失败（行已被取消）则不再重入队
                    try:
                        arow = waitq.get_active(waitq.KIND_ANSWER, key[2:])
                        if arow is not None and waitq.return_to_waiting(arow["id"]):
                            self.submit_answer(int(key[2:]))
                    except Exception:
                        pass
                else:
                    tid = int(key[2:])
                    db.update_task(tid, status="failed", error=str(e),
                                   ended_at=db.now_str())
                    n = self._skip_pipeline_children(tid, "前段任务执行失败，后段跳过")
                    notify_task_failed(tid, str(e), skipped_n=n)
            finally:
                with self._lock:
                    if key.startswith("t:"):
                        # _procs 键保持 int task_id（stop() 里 _procs.get(task_id) 不变）
                        self._procs.pop(int(key[2:]), None)
                    self._cond.notify_all()
                # —— 等待项终态：answer/msg 由执行体自洽（P2/P3）；t:/c: 直调（权威）。
                # c: 行不在此收口——跨轮持有归 card_finished（唯一收尾点 board.finish）
                if key[0] == "t":
                    waitq.finish_by_target(waitq.KIND_TASK, key[2:],
                                           waitq.STATE_FAILED if err else waitq.STATE_DONE, err)
                elif key[0] == "c":
                    # 卡片行跨轮持有（归 board.finish 唯一收尾点，v2d T1 / v3a 行即
                    # 条目：起跑证实后行 running 存活），此处只处理确定性「无会话」
                    # 结局（起跑失败/状态不符——dequeue 未成或卡已不可起）的即时
                    # 收尾：行终态直调（starting 行归本 finally 域，finish() 不抢标），
                    # 随后经唯一收尾点 board.finish 补位唤醒/搬列（行已终态时其收口
                    # 子步幂等 no-op）。err（_process_card 抛异常）时会话状态不明，
                    # 保守不收口——残留由周期自检/重启对账裁活。finish 调用失败不拖死
                    # worker（自检兜底）。
                    if err:
                        waitq.finish_by_target(waitq.KIND_CARD, key[2:],
                                               waitq.STATE_FAILED, err)
                    elif card_ok is False:
                        waitq.finish_by_target(waitq.KIND_CARD, key[2:],
                                               waitq.STATE_FAILED, "起会话失败")
                        try:
                            import board  # 函数内 import 防循环（同 _process_card）
                            board.finish(key, "起跑失败回滚")
                        except Exception as e:
                            print(f"[waitq] {key} 起跑失败回滚收尾失败（自检兜底）: {e}",
                                  flush=True)
                    elif card_ok is None:
                        waitq.cancel(waitq.KIND_CARD, key[2:], "卡片状态不符")
                        try:
                            import board
                            board.finish(key, "起跑失败回滚")
                        except Exception as e:
                            print(f"[waitq] {key} 起跑失败回滚收尾失败（自检兜底）: {e}",
                                  flush=True)

    def _process_card(self, card_id):
        """看板卡片单元：项目串行位已由队列保证（拾取即行置 starting 占位）。落
        doing + 起会话（快路径，无多轮循环），c: 行跨轮 running 直到 board 回调
        card_finished（`card_started` 把行置 running 后不终态化——行即运行前缀
        成员，会话结束才收口落 done）。
        起会话失败由 board.dequeue_start 清占位并回 from_column 列（R7），
        用户重按开始重新入队。
        返回 True=起跑成功 / False=起会话失败 / None=卡片缺失或状态不符（P4 调度判定用）。"""
        card = db.get_board_card(card_id)
        if card is None or card["block_kind"] != "queue" \
                or card["column_key"] != "doing":
            return None
        project = db.get_project(card["project_id"])
        if project is None:
            return None
        import board  # 函数内 import 防循环（board 模块级 import runner）
        if board.dequeue_start(project, card):
            # 起跑证实：把 c: 行置 running（行即运行成员，此后占着项目运行位）
            # + 登记证据落行（有 proc 补 pid——R11④ 进程存活裁活证据，启动对账
            # 收口 CLI 卡残留的主路径）
            ext = {"desc": "卡片会话占用"}
            pid = board.run_pid(card_id)
            if pid:
                ext["pid"] = pid
            return bool(self.card_started(card_id, card["project_id"], ext=ext))
        return False

    def _process_task(self, task_id):
        task = db.get_task(task_id)
        if task is None or task["status"] != "queued":
            return
        project = db.get_project(task["project_id"])
        if project is None:
            db.update_task(task_id, status="failed", error="项目不存在", ended_at=db.now_str())
            notify_task_failed(task_id, "项目不存在")
            return
        agent = agent_family(project["agent_path"])
        if agent == RETIRED_FAMILY:
            # 兜底防呆（B0）：存量项目仍绑着退场族可执行名/旧虚拟前缀（迁移脚本
            # 尚未执行）时，给明确错误，而不是静默按 dsh 跑或 AttributeError。
            db.update_task(task_id, status="failed", error=RETIRED_MSG,
                           ended_at=db.now_str())
            notify_task_failed(task_id, RETIRED_MSG)
            return
        db.update_task(task_id, status="running", started_at=db.now_str(),
                       error="", ended_at=None)

        # 脚本复测任务：平台直接批量执行各用例 verify.py，不经 agent 轮次
        if (task["task_type"] or "normal") == "script_retest":
            self._run_script_retest(project, task)
            return

        # 复压（2026-10-06）：跳过 agent 轮，直接用现有方案包再跑一次发压运行。
        # 标记用后即清（对齐 fresh_prompt 纪律），避免异常重入时又跑成「只发压」。
        if (task["task_type"] or "normal") == "stress" and task["load_rerun"]:
            db.update_task(task_id, load_rerun=0)
            self._run_load_phase(project, db.get_task(task_id))
            return

        # 复测任务开始前：把关联 case 的 status.md 标记为「需要复测」
        if (task["task_type"] or "normal") == "retest_bug":
            self._mark_retest_cases(project, task)

        # 后段任务：固化前段任务期间产出的 bug 报告清单进 payload（创建时清单还不
        # 存在）；清单为空（前段没有产出任何 bug）则无事可做直接结束
        if (task["task_type"] or "normal") == "pipeline":
            bugs = self._pipeline_bugs(project, task["created_at"])
            try:
                payload_obj = json.loads(task["payload"] or "{}")
            except ValueError:
                payload_obj = {}
            payload_obj["bug_dirs"] = bugs
            db.update_task(task_id, payload=json.dumps(payload_obj, ensure_ascii=False))
            if not bugs:
                db.update_task(task_id, status="done", ended_at=db.now_str())
                return
            task = db.get_task(task_id)

        # 首轮不空跑：起始轮次 + 任务级停止条件
        round_no = task["current_round"] + 1
        while True:
            if task_id in self._stop_requested:
                db.update_task(task_id, status="stopped", ended_at=db.now_str())
                self._skip_pipeline_children(task_id, "前段任务已停止，后段跳过")
                return
            exit_code, session_id = self._run_round(project, task, round_no, agent)
            task = db.get_task(task_id)  # 每轮后刷新
            if task is None:
                return
            new_sid = session_id or task["session_id"]
            # fresh_prompt 只影响本轮提示词(续跑第一轮), 用后即清
            db.update_task(task_id, session_id=new_sid, current_round=round_no,
                           fresh_prompt=0)
            if exit_code != 0:
                if task_id in self._stop_requested:
                    db.update_task(task_id, status="stopped", ended_at=db.now_str())
                    self._skip_pipeline_children(task_id, "前段任务已停止，后段跳过")
                else:
                    db.update_task(task_id, status="failed",
                                   error=f"第 {round_no} 轮退出码 {exit_code}",
                                   ended_at=db.now_str())
                    n = self._skip_pipeline_children(task_id, "前段任务执行失败，后段跳过")
                    notify_task_failed(task_id, f"第 {round_no} 轮退出码 {exit_code}",
                                       skipped_n=n)
                return
            # 日期范围复测（无 bug 报告）：首轮成功后解析 agent 输出的受影响用例
            # 清单写入 payload.only_cases（后续轮/续跑限定复测该子集，标记可见）
            if (task["task_type"] or "normal") == "retest_bug" \
                    and (task["date_from"] or task["date_to"]) and round_no == 1:
                self._parse_retest_range_cases(project, task, new_sid, agent, round_no)
                task = db.get_task(task_id)
                if task is None:
                    return
            # fix / retest_bug 任务收尾：更新 bug 报告状态
            self._apply_bug_result(project, task)
            # RAG 索引轮后刷新：探索/回归轮次可能新增用例（同项目串行窗口，无并发写库）；
            # 刷新失败仅记任务日志，不阻塞轮次收尾
            if (task["task_type"] or "normal") in ("normal", "regression"):
                try:
                    stat = rag.refresh(project["cases_root"],
                                       log=lambda m: self._log_task_line(task, m))
                    if stat.get("enabled") and stat.get("embedded"):
                        self._log_task_line(task, f"RAG 索引刷新：新嵌 {stat['embedded']} 条")
                except Exception as exc:
                    self._log_task_line(task, f"RAG 索引刷新失败（忽略）：{exc}")
            # fix 任务 自动复测=开：修复成功后自动创建复测任务（去重）
            if (task["task_type"] or "normal") == "fix" and task["auto_retest"] \
                    and not task["end_stage"]:
                self._maybe_auto_retest(project, task)
            # 停止条件判定
            if self._should_stop(task, round_no):
                if (task["task_type"] or "normal") == "stress":
                    # 压测：轮次条件恒为 1 轮 agent，随后进入平台发压阶段
                    #（内部自管最终状态 done/failed/stopped，这里直接返回）
                    self._run_load_phase(project, task)
                    return
                db.update_task(task_id, status="done", ended_at=db.now_str())
                return
            round_no += 1

    def _linked_bug_dir(self, project, task):
        """从 payload 解析关联 bug 报告目录名，无效返回 None。"""
        try:
            return json.loads(task["payload"] or "{}").get("bug_dir", "") or None
        except ValueError:
            return None

    def _pipeline_bugs(self, project, since):
        """前段任务 created_at 之后产出的 bug 报告目录名列表（按分钟粒度比较）。

        目录名格式 YYYYMMDD_HHMM_标题；与 since（YYYY-MM-DD HH:MM:SS）的前 16 位
        字符串比较；目录不存在或无 bug 报告目录时返回空列表。
        """
        try:
            names = sorted(os.listdir(project["bug_dir"]))
        except OSError:
            return []
        since_min = (since or "")[:16]
        bugs = []
        for n in names:
            if not BUG_DIR_RE.match(n):
                continue
            key = f"{n[0:4]}-{n[4:6]}-{n[6:8]} {n[9:11]}:{n[11:13]}"
            if key >= since_min and os.path.isdir(os.path.join(project["bug_dir"], n)):
                bugs.append(n)
        return bugs

    def _mark_retest_cases(self, project, task):
        """复测任务开始前，把关联 case 的 status.md 状态改写为「需要复测」。

        payload 带 only_cases（脚本复测失败升级的复核任务）时只标记该子集，
        其余已通过用例的「通过」状态保持不动。
        """
        bug = self._linked_bug_dir(project, task)
        if not bug:
            return
        _, case_ids = lib.bug_cases(os.path.join(project["bug_dir"], bug))
        try:
            only = json.loads(task["payload"] or "{}").get("only_cases") or []
        except ValueError:
            only = []
        if only:
            only_set = set(only)
            case_ids = [cid for cid in case_ids if cid in only_set]
        marked = lib.mark_cases_retest(project["cases_root"], case_ids)
        if marked:
            self._log_task_line(task, "平台预标记复测用例：" + "、".join(marked))

    def _parse_retest_range_cases(self, project, task, session_id, agent, round_no):
        """日期范围复测：首轮后解析「受影响用例：FS…」行 → payload.only_cases。

        解析路径依次：① 会话最后 assistant 文本（sessparse.load）；
        ② 轮次日志全文窗口匹配。两者皆无时按范围内变更文件粗筛兜底
        （export_cases._match_level）；仍无候选则只记日志、不限定范围。
        只保留案例库中真实存在的用例 id；结果写入 payload.only_cases。
        """
        # 单族化（P7b B4/B5）后只有 dsh 插件族会走到这里：会话按 dsh 解析族读取
        if agent != "dsh_plugin":
            return
        family = "dsh"
        if family not in sessparse.FAMILIES:
            return
        ids = []
        if session_id:
            try:
                data = sessparse.load(family, session_id, "main", 0)
                for e in (data.get("entries") or []):
                    if e.get("kind") == "assistant" and e.get("text"):
                        ids = _extract_affected_ids(e["text"])
                        if ids:
                            break
            except Exception:
                ids = []
        if not ids:
            try:
                log_path = os.path.join(lib.runtime_dir(project["work_dir"], LOG_DIR_NAME),
                                        f"task_{task['id']}_round_{round_no}.log")
                ids = _extract_affected_ids(lib.read_text(log_path))
            except OSError:
                ids = []
        # 只在案例库按 id 定位成功的用例子集才算数
        if ids and len(lib.find_case_dirs(project["cases_root"], ids)) == len(set(ids)):
            chosen, how = ids, "agent 判断"
        else:
            chosen = []
            how = "变更文件粗筛"
            log = lib.git_log_changes(project["project_dir"],
                                      task["date_from"], task["date_to"])
            if log.get("ok"):
                changed = log.get("files") or []
                more = log.get("commits") or []
                for rec in export_cases.scan_cases(project["cases_root"]):
                    if any(export_cases._match_level(cf, ch)
                           for cf in rec["code_files"] for ch in changed):
                        chosen.append(rec["id"])
                if not chosen and len(more) == 1:
                    pass  # 单提交且无文件（如仅 merge/rebase）不硬凑候选
                chosen = sorted(set(chosen))
                # RAG 语义追加：变更文件+提交摘录作 query，语义 top-k 中非路径命中者
                # 补充进候选（path 级命中恒保留；检索失败静默跳过，维持原行为）
                # 配置门：语义追加是增强能力，未配置 RAG 时保持现状（path 粗筛原行为）
                if rag.load_config():
                    sem, sem_meta = [], None
                    try:
                        sem, sem_meta = rag.retrieve_detail(project["cases_root"],
                                                            rag.change_query(log), k=15)
                    except Exception:
                        pass
                    # 向量路降级可见化：查询嵌入失败记任务日志（via 分布随 how 行体现）
                    if sem_meta and sem_meta.get("configured") \
                            and not sem_meta.get("vec_ok"):
                        self._log_task_line(task, "RAG 检索向量路失败，已降级 BM25："
                                            f"{sem_meta.get('vec_error')}")
                else:
                    sem = []
                extra = [r["id"] for r in sem if r["id"] not in set(chosen)]
                if extra:
                    chosen += extra
                    n_vec = sum(1 for r in sem if "vec" in r.get("via", ""))
                    how = (f"变更文件粗筛+语义追加{len(extra)}条"
                           f"（检索 bm25+vec {n_vec} / 仅bm25 {len(sem) - n_vec}）")
            if not chosen:
                self._log_task_line(task, "未解析到『受影响用例』行且变更文件粗筛无候选，"
                                          "本轮不限复测范围")
                return
            self._log_task_line(task, "未解析到『受影响用例』行，按范围内变更文件粗筛")
        try:
            payload = json.loads(task["payload"] or "{}")
        except ValueError:
            payload = {}
        payload["only_cases"] = chosen
        db.update_task(task["id"], payload=json.dumps(payload, ensure_ascii=False))
        self._log_task_line(task, f"受影响用例（{how}）：{'、'.join(chosen)}")

    def _apply_bug_result(self, project, task):
        """fix / retest_bug / pipeline 任务一轮成功后，按结果更新 bug 报告状态。

        联动范围由 end_stage 决定：实际执行了「复测」阶段才按用例通过情况定论；
        fix 终点=报告分析置「已分析」；复测任务「仅重新部署」（end=deploy）未复测
        不联动；存量行（end 为空）维持拆块前行为。
        """
        task_type = task["task_type"] or "normal"
        end_stage = task["end_stage"] or ""
        if task_type == "fix":
            if end_stage == "retest":
                self._judge_bug_by_cases(project, task)
            elif end_stage == "analyze":
                self._set_bug_status(project, task, "已分析")
            else:
                self._set_bug_status(project, task, "修复完成，待复测")
        elif task_type == "retest_bug":
            if end_stage == "deploy":   # 仅重新部署：未复测，不联动
                return
            self._judge_bug_by_cases(project, task)
        elif task_type == "pipeline":
            # 后段：终点含复测阶段时逐枚定论清单内 bug
            if STAGES.index(end_stage or "report") < STAGES.index("retest"):
                return
            try:
                bug_dirs = json.loads(task["payload"] or "{}").get("bug_dirs") or []
            except ValueError:
                bug_dirs = []
            for bug in bug_dirs:
                self._judge_one_bug(project, task, bug)

    def _judge_bug_by_cases(self, project, task):
        """按任务关联 bug 的用例当前通过情况定论（复测联动共用入口）。"""
        bug = self._linked_bug_dir(project, task)
        if not bug:
            return
        self._judge_one_bug(project, task, bug)

    def _judge_one_bug(self, project, task, bug):
        """单枚 bug：关联用例全部通过 → 已修复（复测通过），否则 → 复测未通过。"""
        _, case_ids = lib.bug_cases(os.path.join(project["bug_dir"], bug))
        if lib.cases_all_passed(project["cases_root"], case_ids):
            self._set_bug_status(project, task, "已修复（复测通过）", bug_dir=bug)
            self._log_task_line(task, f"{bug} 关联用例全部通过，bug 状态 → 已修复（复测通过）")
        else:
            self._set_bug_status(project, task, "复测未通过", bug_dir=bug)
            self._log_task_line(task, f"{bug} 存在未通过用例，bug 状态 → 复测未通过")

    def _maybe_auto_retest(self, project, task):
        """自动复测：fix 任务一轮成功修复后，为同一 bug 创建一轮复测任务。

        去重：同 bug 已存在排队/运行中的复测任务时不重复创建（fix 任务重启重跑
        会再次进入此逻辑，靠该检查避免复测任务堆叠）；已完成的复测任务不拦截，
        允许再次发起复测。创建后日志中记录任务号。
        """
        bug = self._linked_bug_dir(project, task)
        if not bug:
            return
        for t in db.list_tasks(task["project_id"]):
            if t["task_type"] not in ("retest_bug", "script_retest") \
                    or t["status"] not in ("queued", "running"):
                continue
            try:
                if json.loads(t["payload"] or "{}").get("bug_dir") == bug:
                    self._log_task_line(task, "自动复测：同 bug 已有排队/运行中的复测任务，不再新建")
                    return
            except ValueError:
                continue
        name = "复测 " + (BUG_DIR_RE.match(bug).group(1) if BUG_DIR_RE.match(bug) else bug)
        # 自动复测选型：关联用例全部已固化时直接走平台脚本复测（零 agent 成本）
        _, case_ids = lib.bug_cases(os.path.join(project["bug_dir"], bug))
        task_type = ("script_retest"
                     if lib.bug_cases_scripted(project["cases_root"], case_ids)
                     else "retest_bug")
        tid = db.insert_task(task["project_id"], name, auto_fix=0, retest="不复测",
                             stop_type="rounds", stop_value="1", task_type=task_type,
                             payload=json.dumps({"bug_dir": bug}, ensure_ascii=False))
        self.submit(tid)
        self._log_task_line(task, f"自动复测：已创建复测任务 #{tid}「{name}」")

    # ---------- 脚本复测（script_retest：平台直跑各用例 verify.py）----------

    # 单脚本执行超时（秒）与并发线程数：脚本只做单用例「调用+断言」，2 分钟足够
    SCRIPT_RETEST_TIMEOUT = 120
    SCRIPT_WORKERS = 4

    def _script_case_dirs(self, project, task):
        """解析脚本复测任务的关联用例目录，并二次校验全部已固化。

        返回 [(case_id, 目录绝对路径)]；bug 无效或存在未固化用例返回 None
        （创建后脚本被删等竞态的防御，调用方整单回落 agent 复测）。
        """
        bug = self._linked_bug_dir(project, task)
        if not bug:
            return None
        _, case_ids = lib.bug_cases(os.path.join(project["bug_dir"], bug))
        dirs = lib.find_case_dirs(project["cases_root"], case_ids)
        if not dirs or len(dirs) != len(set(case_ids)):
            return None
        if any(not os.path.isfile(os.path.join(d, lib.VERIFY_SCRIPT_NAME))
               for _, d in dirs):
            return None
        return dirs

    def _run_script_retest(self, project, task):
        """执行脚本复测：并发跑各用例 verify.py，按退出码回写状态并联动 bug 报告。

        退出码语义（flow.md「脚本固化与复测协议」）：0=通过；1=断言不符（疑似
        回归，状态保持「需要复测」并升级 agent 复核）；2=环境问题（跳过不计失败）。
        全部通过时 bug 报告 →「已修复（复测通过）」；有失败时报告状态不动，
        由升级的复核任务闭环（防脚本腐化误报直接定罪）。
        """
        task_id = task["id"]
        lib.ensure_runtime_dirs(project["work_dir"])
        log_path = os.path.join(lib.runtime_dir(project["work_dir"], LOG_DIR_NAME),
                                f"task_{task_id}_round_1.log")
        round_id = db.insert_round(task_id, 1, log_path)
        env_label = (project["env_label"] or "").strip() or "本机"

        dirs = self._script_case_dirs(project, task)
        if dirs is None:
            append_log(log_path, "### 存在未固化/解析不到的用例，本任务不执行，改建 agent 复测任务\n")
            bug = self._linked_bug_dir(project, task)
            if bug:
                self._spawn_retest_task(project, bug, [], log_path, "复测",
                                        exclude_task_id=task_id)
            db.finish_round(round_id, "done", 0, "前置校验未通过，已回落 agent 复测", log_path)
            db.update_task(task_id, status="done", ended_at=db.now_str())
            return

        append_log(log_path, f"### 脚本复测开始 {time.strftime('%H:%M:%S')} "
                             f"用例 {len(dirs)} 条 环境={env_label}\n")
        self._script_live(project, phase="execute",
                          stats={"passed": 0, "failed": 0, "skipped": 0})

        results = []  # (case_id, 退出码)，按完成顺序
        pool = concurrent.futures.ThreadPoolExecutor(self.SCRIPT_WORKERS)
        futs = {}
        try:
            for cid, d in dirs:
                self._script_live(project, phase="execute",
                                  current={"id": cid,
                                           "relpath": os.path.relpath(d, project["cases_root"])},
                                  event={"ts": db.now_str(), "type": "case_start",
                                         "case_id": cid, "message": "脚本复测开始"})
                futs[pool.submit(self._run_one_script, d, env_label)] = (cid, d)
            for fut in concurrent.futures.as_completed(futs):
                if task_id in self._stop_requested:
                    break  # 停止：取消排队未启动的脚本（已启动的最多等一个超时周期），不再消费剩余结果
                cid, d = futs[fut]
                code, exec_name = fut.result()
                self._script_apply_status(d, code, env_label)
                etype = {0: "case_pass", 1: "case_fail"}.get(code, "case_skip")
                self._script_live(project, event={"ts": db.now_str(), "type": etype,
                                                  "case_id": cid,
                                                  "message": f"脚本退出码 {code}（{exec_name}）"})
                append_log(log_path, f"### {cid} exit={code} 记录={exec_name}\n")
                results.append((cid, code))
        finally:
            # 取消排队未启动的脚本；已启动的在跑脚本最多等一个超时周期
            pool.shutdown(wait=True, cancel_futures=True)

        if task_id in self._stop_requested:
            append_log(log_path, f"### 脚本复测被停止 {time.strftime('%H:%M:%S')}\n")
            db.finish_round(round_id, "failed", -1, "用户停止", log_path)
            db.update_task(task_id, status="stopped", ended_at=db.now_str())
            return

        passed = sum(1 for _, c in results if c == 0)
        failed = sum(1 for _, c in results if c == 1)
        skipped = sum(1 for _, c in results if c not in (0, 1))
        summary_line = f"SCRIPT_RETEST 通过{passed}失败{failed}环境跳过{skipped}"
        append_log(log_path, f"### {summary_line} {time.strftime('%H:%M:%S')}\n")
        db.finish_round(round_id, "done", 0, summary_line, log_path)
        self._script_live(project, phase="done",
                          stats={"passed": passed, "failed": failed, "skipped": skipped},
                          current={})

        bug = self._linked_bug_dir(project, task)
        if bug:
            if results and failed == 0 and skipped == 0:
                self._set_bug_status(project, task, "已修复（复测通过）")
                append_log(log_path, "### 关联用例全部通过，bug 状态 → 已修复（复测通过）\n")
            elif failed:
                failed_ids = [cid for cid, c in results if c == 1]
                self._spawn_retest_task(project, bug, failed_ids, log_path, "复核",
                                        exclude_task_id=task_id)
        db.update_task(task_id, status="done", ended_at=db.now_str())

    def _run_one_script(self, case_dir, env_label):
        """执行单个用例的 verify.py，落盘 execution 记录。

        返回 (归一化退出码, 记录文件名)：超时/启动失败/非 0/1/2 退出码统一按 1（疑似
        回归）处理，输出全文存证；退出码 0/1/2 原样保留。
        """
        ts = time.strftime("%Y%m%d_%H%M")
        exec_name = f"execution_{ts}_script.md"
        env = dict(os.environ)
        env["TS_ENV_LABEL"] = env_label
        try:
            proc = subprocess.run([sys.executable, lib.VERIFY_SCRIPT_NAME],
                                  cwd=case_dir, env=env, capture_output=True,
                                  timeout=self.SCRIPT_RETEST_TIMEOUT)
            code = proc.returncode
            output = proc.stdout + proc.stderr
            if code not in (0, 1, 2):
                # 非 0/1/2 的退出码（信号杀死/OOM/脚本 sys.exit(3) 等）按设计视同
                # 退出码 1（疑似回归），避免被当作环境跳过导致复测闭环静默卡死
                output += f"\n### 非协议退出码 {code}，按疑似回归处理\n".encode("utf-8")
                code = 1
        except subprocess.TimeoutExpired as e:
            code = 1
            output = (e.stdout or b"") + (e.stderr or b"")
            output += f"\n### 执行超时（>{self.SCRIPT_RETEST_TIMEOUT}s），按疑似回归处理\n".encode("utf-8")
        except OSError as e:
            code = 1
            output = f"### 脚本启动失败: {e}\n".encode("utf-8")
        head = (f"# 脚本复测执行记录\n\n- **时间**: {time.strftime('%Y-%m-%d %H:%M')}\n"
                f"- **执行环境**: {env_label}\n- **退出码**: {code}\n\n"
                "## 脚本输出\n\n```\n"
                + output.decode("utf-8", errors="replace") + "\n```\n")
        try:
            with open(os.path.join(case_dir, exec_name), "w", encoding="utf-8") as f:
                f.write(head)
        except OSError:
            pass
        return code, exec_name

    def _script_apply_status(self, case_dir, code, env_label):
        """按脚本退出码回写用例 status.md 的字段行（「执行记录」表不动，execution 文件即记录）。"""
        status = {0: "通过", 1: "需要复测"}.get(code, "跳过")
        summary = {0: "脚本复测通过",
                   1: "脚本复测判定失败，待人工复核（见 execution_*_script.md）"}.get(
            code, "脚本复测环境异常，跳过（见 execution_*_script.md）")
        sp = os.path.join(case_dir, "status.md")
        lib.set_md_field(sp, "状态", status)
        lib.set_md_field(sp, "最近执行时间", time.strftime("%Y-%m-%d %H:%M"))
        lib.set_md_field(sp, "执行环境", env_label)
        lib.set_md_field(sp, "结果摘要", summary)

    def _script_live(self, project, *, phase=None, current=None, event=None, stats=None,
                     label="脚本复测"):
        """脚本复测/压测发压共用的 live.json 维护：读改写 + tmp 原子覆盖（结构沿用 agent 写入约定）。"""
        path = os.path.join(lib.runtime_dir(project["work_dir"], ".live"), "live.json")
        try:
            with open(path, encoding="utf-8") as f:
                live = json.load(f)
        except (OSError, ValueError):
            live = {}
        live["updated_at"] = db.now_str()
        if phase:
            live["phase"] = phase
            live["phase_label"] = label
        if current is not None:
            live["current_case"] = current
        if stats:
            merged = dict(live.get("stats") or {})
            merged.update(stats)
            live["stats"] = merged
        if event:
            events = live.get("events") or []
            events.append(event)
            live["events"] = events[-200:]
        try:
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(live, f, ensure_ascii=False, indent=1)
            os.replace(tmp, path)
        except OSError:
            pass

    # ---------- 压测（stress：agent 出方案包 + 平台统一脚本驱动发压）----------

    def _run_load_phase(self, project, task):
        """stress 任务的发压阶段：解析方案包 → 统一脚本驱动发压 → 报告与状态收尾。

        驱动由 loadcase.resolve 四级回落：run.py 自定义脚本 / scenario.json 场景
        （平台调 loadgen.py run）/ 存量 scenario_<id>.json；都缺 → failed。
        两种驱动共用同一套托管（_spawn_load）：cwd=方案包目录、TS_* 环境变量、
        stdout+stderr 进该次运行的日志、用户停止先落 stop 文件再宽限杀进程树、
        超时上限 LOAD_MAX_SECONDS。状态自管：非 0 退出/超时 → failed；用户停止 →
        stopped；正常结束 → done。

        2026-10-06 复压批次：**一次调用 = 一次发压运行**（load run）。运行键
        `run_key` = 本次开始时刻（秒级），日志 / 指标通道 / 旧快照 / 报告全部按它
        切分，同一方案包可反复运行且互不覆盖；运行在 rounds 表落一行
        `kind='load'`（round_no 递增），任务状态跟随最近一次运行。首次发压由
        agent 轮成功后自动接（round 2），之后的复压跳过 agent 直接进这里。
        """
        task_id = task["id"]
        lib.ensure_runtime_dirs(project["work_dir"])
        web_dir = lib.runtime_dir(project["work_dir"], LOG_DIR_NAME)
        run_key = loadcase.new_run_key()
        log_path = loadcase.load_log_path(project["work_dir"], task_id, run_key)
        snap_path = loadcase.snapshot_path(project["work_dir"], task_id, run_key)
        metrics_path = loadcase.metrics_path(project["work_dir"], task_id, run_key)
        stop_path = loadcase.stop_file_path(project["work_dir"], task_id)
        # 只清停止标记：产物按运行分文件，上一次运行的报告/曲线/日志都留着
        try:
            os.remove(stop_path)
        except OSError:
            pass
        # 主体包 try/finally：任何支路（含未预期异常）退出前都把 live.json 收尾到
        # done，避免监控卡在发压中；各支路自身的收尾调用可带 stats（_script_live
        # 为读改写合并，finally 不传 stats 即保留已写入的 load_summary）
        try:
            round_id = db.insert_round(task_id, self._next_load_round_no(task_id),
                                       log_path, kind="load", run_key=run_key)
            self._script_live(project, phase="execute", label="压力测试")
            case = loadcase.resolve(project["cases_root"], task_id)
            if case["driver"] is None:
                self._fail_load(project, task, round_id, log_path,
                                f"压测方案缺失（{case['case_dir']} 下需有 run.py 或 "
                                f"scenario.json，存量布局为 load/scenario_{task_id}.json）")
                return
            _, charts_err = loadcase.load_charts(case["charts_path"])
            if charts_err:
                append_log(log_path, f"### 图表声明回退默认面板：{charts_err}\n")
            # 报告目录是机器产物：在案例库 load/.gitignore 幂等补忽略项
            lib.ensure_gitignore(os.path.join(project["cases_root"], "load"), "report/")
            cmd = self._load_cmd(case, project, task_id, metrics_path, snap_path,
                                 log_path, run_key)
            append_log(log_path, f"### 压测开始 {time.strftime('%H:%M:%S')}"
                                 f" 运行键={run_key} 驱动={case['driver']}"
                                 f" cwd={case['case_dir']}\n"
                                 f"### CMD {' '.join(cmd)}\n")
            code, note = self._spawn_load(project, task_id, case, cmd, log_path,
                                          stop_path, metrics_path)
            self._finish_load(project, task, round_id, log_path, case, code, note,
                              metrics_path, run_key)
        finally:
            # 兜底：未预期异常也落 phase=done（正常/停止路径重复调用一次，幂等无害）
            self._script_live(project, phase="done", label="压力测试")

    @classmethod
    def _next_load_round_no(cls, task_id):
        """下一次发压运行的 round_no：已有最大轮次 + 1（首次发压恒为 2）。

        轮次编号在任务内单调递增，重启（换方案）会清空轮次重新从 1 起算；
        `LOAD_ROUND_NO` 只作为「首次发压」的历史基准保留。
        """
        rows = db.list_rounds(task_id)
        return max([r["round_no"] for r in rows] + [cls.LOAD_ROUND_NO - 1]) + 1

    @staticmethod
    def _load_cmd(case, project, task_id, metrics_path, snap_path, log_path,
                  run_key=""):
        """发压命令行：run.py 直接跑；场景驱动走 loadgen.py 的 run 子命令。

        脚本驱动传路径靠 TS_* 环境变量；场景驱动额外用命令行参数把指标/快照/
        日志/报告/运行键五处产物交给引擎（CLI 见 loadgen.main）。
        """
        if case["driver"] == loadcase.DRIVER_SCRIPT:
            return [sys.executable, case["script_path"]]
        return [sys.executable, os.path.join(ROOT_DIR, "loadgen.py"), "run",
                "--scenario", case["scenario_path"],
                "--metrics", metrics_path, "--snapshot", snap_path, "--log", log_path,
                "--stop-file", loadcase.stop_file_path(project["work_dir"], task_id),
                "--report-dir", loadcase.report_dir(project["cases_root"]),
                "--task-id", str(task_id), "--run-key", run_key]

    def _spawn_load(self, project, task_id, case, cmd, log_path, stop_path,
                    metrics_path):
        """托管发压进程：注入 TS_* 环境、登记进程表、处理停止与超时。

        返回 (exit_code, 说明)：exit_code=None 表示被平台杀掉（超时/停止宽限到）；
        说明文本用于日志与失败原因。停止走「先落 stop 文件 → 宽限 LOAD_STOP_GRACE
        → 杀进程树」，与用户可见的「优雅停止」语义一致。
        metrics_path 为该次运行的指标通道路径（按运行键切分），脚本只读环境变量。
        """
        env = dict(os.environ)
        env.update({
            "TS_TASK_ID": str(task_id),
            "TS_CASE_DIR": case["case_dir"],
            "TS_METRICS_FILE": metrics_path,
            "TS_STOP_FILE": stop_path,
            "TS_WORK_DIR": project["work_dir"],
            "TS_PROJECT_DIR": project["project_dir"],
            "TS_CASES_ROOT": project["cases_root"],
            "TS_MAX_SECONDS": str(LOAD_MAX_SECONDS),
            # 脚本可 import loadgen（MetricsWriter / 库函数）；输出不缓冲便于日志实时可读
            "PYTHONPATH": ROOT_DIR + os.pathsep + env.get("PYTHONPATH", ""),
            "PYTHONUNBUFFERED": "1",
        })
        try:
            with open(log_path, "ab") as logf:
                proc = platcompat.spawn_session(cmd, cwd=case["case_dir"], env=env,
                                                stdout=logf, stderr=subprocess.STDOUT)
        except OSError as e:
            return None, f"发压进程启动失败: {e}"
        append_log(log_path, f"### PID {proc.pid}\n")
        with self._lock:
            self._procs[task_id] = proc
        deadline = time.time() + LOAD_MAX_SECONDS
        stop_asked_at = None
        try:
            while True:
                try:
                    return proc.wait(timeout=LOAD_POLL_INTERVAL), ""
                except subprocess.TimeoutExpired:
                    pass
                now = time.time()
                if stop_asked_at is None and task_id in self._stop_requested:
                    stop_asked_at = now
                    try:
                        with open(stop_path, "w", encoding="utf-8") as f:
                            f.write("stop\n")
                    except OSError:
                        pass
                    append_log(log_path, f"### 收到停止请求 {time.strftime('%H:%M:%S')}"
                                         "，等脚本收尾\n")
                if stop_asked_at is not None and now - stop_asked_at >= LOAD_STOP_GRACE:
                    append_log(log_path, "### 停止宽限期到，杀进程树\n")
                    platcompat.kill_tree(proc.pid, signal.SIGTERM)
                    return self._wait_killed(proc), "用户停止"
                if now >= deadline:
                    append_log(log_path,
                               f"### 超过发压上限 {LOAD_MAX_SECONDS}s，杀进程树\n")
                    platcompat.kill_tree(proc.pid, signal.SIGTERM)
                    return self._wait_killed(proc), f"超过发压上限 {LOAD_MAX_SECONDS}s"
        finally:
            # 与 agent 轮次同款：退出即摘除进程表（stop() 拿不到已死进程无副作用）
            with self._lock:
                self._procs.pop(task_id, None)

    @staticmethod
    def _wait_killed(proc, timeout=5):
        """杀进程树后短暂等待回收；仍未退出返回 None（状态按「被杀」处理）。"""
        try:
            return proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            return None

    def _finish_load(self, project, task, round_id, log_path, case, code, note,
                     metrics_path, run_key=""):
        """发压收尾：报告落盘 + round/task 状态 + live.json（状态自管）。

        报告：场景驱动由 loadgen CLI 落盘（沿用其 JSON+Markdown 形状）；脚本驱动
        由平台按 summary 行生成最小报告 —— 两者同目录同命名规则（`task<id>_<运行键>`），
        读侧按运行键/最新取用，不区分驱动。停止优先于退出码判定。
        """
        task_id = task["id"]
        stopped = task_id in self._stop_requested
        values = loadcase.read_summary(metrics_path)
        summary_line = loadcase.summarize_values(values) + ("（用户停止）" if stopped else "")
        md_name = self._write_load_report(project, task_id, case, values, stopped,
                                          log_path, run_key)
        if stopped:
            append_log(log_path, f"### 压测被停止 {time.strftime('%H:%M:%S')}\n")
            db.finish_round(round_id, "failed", -1, "用户停止 " + summary_line, log_path)
            db.update_task(task_id, status="stopped", ended_at=db.now_str())
        elif code != 0:
            tail = _tail_text(log_path)
            err = note or f"发压脚本退出码 {code}"
            if tail:
                err = f"{err}：{tail}"
            self._fail_load(project, task, round_id, log_path, err)
            return
        else:
            append_log(log_path, f"### {summary_line} 报告={md_name}\n")
            db.finish_round(round_id, "done", 0, summary_line, log_path)
            db.update_task(task_id, status="done", ended_at=db.now_str())
        self._script_live(project, phase="done", label="压力测试",
                          stats={"load_summary": summary_line})

    @staticmethod
    def _write_load_report(project, task_id, case, values, stopped, log_path,
                           run_key=""):
        """报告落盘（脚本驱动由平台生成，场景驱动读 loadgen 已写的那份）。

        返回报告文件名（Markdown，日志里记一行便于人查）；失败只记日志不改变状态。
        """
        rep_dir = loadcase.report_dir(project["cases_root"])
        try:
            if case["driver"] == loadcase.DRIVER_SCRIPT:
                payload = {"case": os.path.basename(case["case_dir"]),
                           "driver": os.path.basename(case["script_path"] or ""),
                           "run_key": run_key,
                           "started_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                           "duration_sec": "", "stopped": bool(stopped),
                           "summary": values}
                _, md_path = loadcase.write_minimal_report(payload, rep_dir, task_id,
                                                           run_key=run_key)
                return os.path.basename(md_path)
            # 场景驱动：loadgen 已按同一运行键落盘，直接回报文件名
            if run_key:
                stem = loadcase.report_stem(rep_dir, task_id, run_key)
                if os.path.isfile(stem + ".md"):
                    return os.path.basename(stem + ".md")
            names = [n for n in os.listdir(rep_dir)
                     if n.startswith(f"task{task_id}_") and n.endswith(".md")]
            if names:
                newest = max(names, key=lambda n: os.path.getmtime(
                    os.path.join(rep_dir, n)))
                return newest
        except OSError as e:
            append_log(log_path, f"### 报告写盘失败: {e}\n")
        return ""

    def _fail_load(self, project, task, round_id, log_path, err):
        """发压失败收尾（方案缺失/启动失败/非 0 退出/超时共用一条路径）。"""
        append_log(log_path, f"### {err}\n")
        db.finish_round(round_id, "failed", -1, err, log_path)
        db.update_task(task["id"], status="failed", error=err, ended_at=db.now_str())
        notify_task_failed(task["id"], err)
        self._script_live(project, phase="done", label="压力测试",
                          stats={"load_summary": err})

    def _spawn_retest_task(self, project, bug, only_cases, log_path, prefix,
                           exclude_task_id=None):
        """创建 agent 复测/复核任务（retest_bug），带同 bug 去重。

        only_cases 非空时写入 payload（失败子集复核）；exclude_task_id 为发起方任务 id
        （script_retest 的升级/回落调用方），去重时跳过。返回任务 id，去重命中返回 None。
        """
        for t in db.list_tasks(project["id"]):
            # 排除当前任务自身——升级/回落调用发生在自身置 done 之前，
            # 不跳过的话自身（running、同 bug_dir）恒命中去重，任务永远建不出来
            if t["id"] == exclude_task_id:
                continue
            if t["task_type"] not in ("retest_bug", "script_retest") \
                    or t["status"] not in ("queued", "running"):
                continue
            try:
                if json.loads(t["payload"] or "{}").get("bug_dir") == bug:
                    append_log(log_path, f"### {prefix}：同 bug 已有排队/运行中的复测任务，不再新建\n")
                    return None
            except ValueError:
                continue
        payload = {"bug_dir": bug}
        if only_cases:
            payload["only_cases"] = only_cases
        title = BUG_DIR_RE.match(bug).group(1) if BUG_DIR_RE.match(bug) else bug
        name = f"{prefix} {title}"
        tid = db.insert_task(project["id"], name, auto_fix=0, retest="不复测",
                             stop_type="rounds", stop_value="1", task_type="retest_bug",
                             payload=json.dumps(payload, ensure_ascii=False))
        self.submit(tid)
        extra = f"仅含 {'、'.join(only_cases)}" if only_cases else ""
        append_log(log_path, f"### {prefix}：已创建复测任务 #{tid}「{name}」{extra}\n")
        return tid

    def _set_bug_status(self, project, task, status, bug_dir=None):
        """改写 bug_report.md 的 **状态** 字段（默认取任务关联 bug；pipeline 逐枚传入）。"""
        bug = bug_dir or self._linked_bug_dir(project, task)
        if not bug:
            return
        lib.set_md_field(os.path.join(project["bug_dir"], bug, "bug_report.md"),
                         "状态", status)

    def _log_task_line(self, task, text):
        """追加一行平台提示到该任务最新轮次日志。"""
        try:
            rounds = db.list_rounds(task["id"])
            if rounds:
                log_path = rounds[-1]["log_path"]
                if log_path:
                    append_log(log_path, f"### {text}\n")
        except (OSError, AttributeError):
            pass

    def _run_round(self, project, task, round_no, agent):
        """执行一轮：交给本族实现（单族化后只剩 dsh 插件族）。返回 (exit_code, session_id)。

        P7b B4：kimi/claude/opencode/hermes/deepseek(CLI) 与 kimi_web/opencode_web 的
        轮次路径（含本地子进程 spawn、CLI compact、status 轮询等 turn 结束）全部退场；
        退场族任务在 `_process_task` 入口即以 RETIRED_MSG 失败，走不到这里。
        """
        if agent != "dsh_plugin":
            raise RuntimeError(RETIRED_MSG)      # 防御：入口守卫漏了才会到这
        return self._run_round_dshplugin(project, task, round_no)

    def _run_round_dshplugin(self, project, task, round_no):
        """dsh 插件族一轮：进程内常驻会话 + followup 投递 + SSE 等 turn/end。

        关键差异（方案 §3.2 A2、§8.1；原为 CLI/web 两族共存时的对比，现为本族固有性质）：
        - 会话是 **dsh 宿主进程内的 agent**（插件持 handle），不是外部 CLI 子进程：
          round 1 建会话、续轮 resume，多轮共享同一上下文（消灭「每轮独立会话」）；
        - 轮次结束由插件推来的 turn/end 帧判定（零 status 轮询）；
        - 停止 = driver.cancel 优雅中断（保留已流式交付的文本），不是杀进程树；
        - 会话事件同时翻译成平台既有轮次日志行（### PROMPT + {"role":...}），
          故 read_dialogue / 「修复过程」界面无需改动即可渲染；
        - 无 compact 调用：dsh 自己的 agent loop 管上下文压缩。
        """
        lib.ensure_runtime_dirs(project["work_dir"])
        log_path = os.path.join(lib.runtime_dir(project["work_dir"], LOG_DIR_NAME),
                                f"task_{task['id']}_round_{round_no}.log")
        round_id = db.insert_round(task["id"], round_no, log_path)
        sid = task["session_id"] or ""
        waiter = dshdriver.TurnWaiter()
        stream_stop = threading.Event()
        stream_thread = None
        try:
            if not dshdriver.available():
                raise dshdriver.DshDriverError(
                    -1, "dsh agent 驱动不可用（插件未安装/未启用，或 agents 服务未就绪）")
            # 模型值统一 `provider/id`（模型下拉口径）；宿主 `/session` 不拆前缀，
            # 这里先拆成 provider + 裸 id 下传（无前缀的存量值 provider=''，沿用宿主当前 provider）
            model_provider, model_id = dshdriver.split_model(
                (task["model"] or "").strip() or (project["model"] or "").strip())
            sid = dshdriver.ensure_session(
                sid, cwd=project["project_dir"], task=f"task-{task['id']}",
                model=model_id, provider=model_provider)
            # 项目级思考等级（2026-10-04）：会话实时态里已有显式档位就保持（用户在
            # 会话详情页改过、以及上轮应用过的项目默认都记在这里），否则回落项目默认。
            # best-effort：档位与模型不匹配等问题只记一行日志，本轮照常跑
            # （**权限档不下发**：任务会话没有交互作答面，manual(approval=ask) 会让
            #  轮次永久挂起等一个没人能答的审批——项目权限档只对看板卡会话生效）。
            effort = dshevents.session_effort(sid) or \
                str(db.row_opt(project, "reasoning_effort") or "").strip()
            if effort:
                append_log(log_path, f"### 会话默认思考等级 effort={effort}\n")
                dshdriver.apply_session_defaults(
                    sid, model=model_id, provider=model_provider,
                    reasoning_effort=effort, log=lambda t: append_log(log_path, t))
            if sid != (task["session_id"] or ""):
                # sid 在本轮开始即精确入库（不再等轮后从 stdout/mtime 猜）：会话窗口
                # 运行期间即可按 exact sid 读事件；续轮直接用同一 sid resume
                db.update_task(task["id"], session_id=sid)
                append_log(log_path, json.dumps(
                    {"role": "meta", "type": "session.resume_hint",
                     "session_id": sid}, ensure_ascii=False) + "\n")
            append_log(log_path, f"### 会话 {sid}（dsh 插件·进程内常驻）\n")
            # 订阅必须先于投递：否则会漏掉紧跟 followup 的 turn/start
            since = int(dshdriver.status(sid).get("last_seq") or 0)
            stream_thread = threading.Thread(
                target=_dsh_stream_worker, args=(sid, since, waiter, log_path, stream_stop),
                name=f"dsh-stream-{task['id']}", daemon=True)
            stream_thread.start()
            prompt = build_prompt(task, round_no,
                                  log=lambda m: self._log_task_line(task, m))
            append_log(log_path, f"### PROMPT {json.dumps(prompt, ensure_ascii=False)}\n")
            append_log(log_path, f"### 轮次 {round_no} 开始 {time.strftime('%H:%M:%S')} "
                                 f"driver=dsh_plugin\n")
            dshdriver.prompt(sid, prompt)
            exit_code = self._wait_turn_end_dsh(task, sid, waiter, log_path)
        except dshdriver.DshDriverError as e:
            db.finish_round(round_id, "failed", -1, f"dsh 驱动调用失败: {e}", log_path)
            db.update_task(task["id"], error=f"dsh 驱动调用失败: {e}")
            return -1, task["session_id"]
        finally:
            stream_stop.set()
            if stream_thread is not None:
                # P7a 缺陷 C：stop 置位后 SSE 线程由 dshdriver._stop_watcher 秒级唤醒
                # （shutdown 连接打断阻塞 read1，实测 ~0.1s）。此前 stop 只在 read1
                # 返回后才被检查，SSE 空闲时要等下一帧 keepalive——真插件 15s，于是
                # 这里必然白等满 5s（实测轮次时间线：驱动侧 /prompt→turn/end 0.21s，
                # 平台日志却是「开始 09:07:54 / 结束 09:07:59」）。timeout 仅作兜底，
                # 正常路径不会用满；线程若真超时也由下一轮/后续订阅自然收口。
                stream_thread.join(timeout=5)
        append_log(log_path, f"### 轮次 {round_no} 结束 {time.strftime('%H:%M:%S')} "
                             f"exit={exit_code}\n")
        summary = read_live_summary(project["work_dir"])
        db.finish_round(round_id, "done" if exit_code == 0 else "failed",
                        exit_code, summary, log_path)
        try:
            stats = json.loads(summary)["stats"]
            db.update_task(task["id"], new_bugs=int(stats.get("new_bug_reports", 0)))
        except (ValueError, TypeError, KeyError):
            pass
        return exit_code, sid

    def _wait_turn_end_dsh(self, task, sid, waiter, log_path):
        """等事件流推来的 turn/end（零远端轮询）。

        结束条件：waiter 收到 turn/end 帧（completed→0 / aborted→130 / 其余→1）。
        本地 5s tick 只做三件事，都不碰远端：响应任务停止标记（再补一次 cancel
        兜底）、检查 SSE 链路错误、检查 turn 是否压根没起来（宽限期内无 turn/start）。
        """
        wait_started = time.time()
        while True:
            event = waiter.wait_turn(5.0)
            if event == "turn_end":
                append_log(log_path, f"### 轮次结束 turn_reason={waiter.turn_reason}\n")
                return waiter.exit_code
            if event == "interaction":
                # 提问/审批已推给用户：本轮不结束（dsh 侧会话挂起等作答），
                # 记一行日志后继续等 turn/end（用户作答后同一 turn 继续跑）
                append_log(log_path, "### 会话等待人工输入（提问/审批）\n")
                continue
            if event == "error":
                append_log(log_path, f"### 事件流异常: {waiter.error}\n")
                return 1
            if task["id"] in self._stop_requested:
                try:
                    dshdriver.cancel(sid)      # runner.stop 已调过一次，这里兜底
                except dshdriver.DshDriverError as e:
                    append_log(log_path, f"### cancel 失败: {e}\n")
                return 130
            if not waiter.started and time.time() - wait_started > DSH_TURN_START_GRACE:
                append_log(log_path, f"### turn 未启动（{DSH_TURN_START_GRACE}s 未见 turn/start）\n")
                try:
                    dshdriver.cancel(sid)
                except dshdriver.DshDriverError:
                    pass
                return 1

    def _should_stop(self, task, round_no):
        """任务级停止条件：轮数达到 / 累计新 bug 达到 / 截止时间到 / 运行时长达到，任一命中即停。"""
        stop_type = task["stop_type"]
        stop_value = task["stop_value"]
        if stop_type == "rounds":
            return round_no >= int(stop_value or "1")
        if stop_type == "bugs":
            return int(task["new_bugs"] or 0) >= int(stop_value or "1")
        if stop_type == "deadline":
            try:
                return db.now_str() >= stop_value.replace("T", " ")
            except AttributeError:
                return False
        if stop_type == "duration":
            # stop_value 为秒数：从任务开始时间起算，时长达到即停
            try:
                secs = int(stop_value or "0")
                started = (task["started_at"] or task["created_at"] or "").split(".")[0]
                started_ts = time.mktime(time.strptime(started, "%Y-%m-%d %H:%M:%S"))
                return time.time() - started_ts >= secs
            except (ValueError, TypeError, OverflowError):
                return False
        return round_no >= 1  # 未知类型兜底只跑一轮


# ---------- agent 适配 ----------

def build_prompt(task, round_no, log=None):
    """本轮提示词选择：round 1 或 fresh_prompt=1
    （「继续」续跑第一轮）用完整首轮提示词；其余续轮用短提示词。
    log 可选任务日志回调，透传首轮构建（日期范围复测的 RAG 检索统计落日志）。"""
    if round_no == 1 or task["fresh_prompt"]:
        p = db.get_project(task["project_id"])
        return prompts.first_round_prompt(p, task, log)
    return prompts.next_round_prompt(round_no, task)


# ---------- 日志与解析辅助 ----------

def append_log(path, text):
    """追加文本到日志（以二进制写入，编码 utf-8）。"""
    try:
        with open(path, "ab") as f:
            f.write(text.encode("utf-8", errors="replace"))
    except OSError:
        pass


def _content_text(content):
    """dsh 消息 content（块数组）里的 text 块拼接；非数组/无文本返回空串。"""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(str(block.get("text") or ""))
    return "".join(parts)


def dsh_event_to_log_line(frame):
    """把 dsh 会话事件帧翻译成平台既有轮次日志行（返回行文本，无需落盘的事件返回 None）。

    复用 read_dialogue 已识别的三种行形态，因此「修复过程」界面零改动：
    - assistant/message → {"role":"assistant","content":<文本>}
    - tool/call         → {"role":"assistant","content":"","tool_calls":[{function:{name,arguments}}]}
    - tool/result       → {"role":"tool","tool_call_id":<callId>,"content":<文本>}
    其余事件（turn/step 边界、request/*、审批审计等）落到 ### 前缀的平台标记行，
    对用户可读但不参与对话渲染。
    """
    ftype = frame.get("type")
    data = frame.get("data") or {}
    if ftype == "assistant/message":
        msg = data.get("message") or {}
        text = _content_text(msg.get("content"))
        if not text:
            return None                     # 只请求工具、无文本的 assistant 事件：由 tool/call 行承载
        marker = "（本轮被中断，以下为已交付内容）" if data.get("interrupted") else ""
        return json.dumps({"role": "assistant", "content": marker + text,
                           "tool_calls": []}, ensure_ascii=False) + "\n"
    if ftype == "tool/call":
        return json.dumps({"role": "assistant", "content": "",
                           "tool_calls": [{"function": {
                               "name": str(data.get("name") or ""),
                               "arguments": str(data.get("arguments") or "")}}]},
                          ensure_ascii=False) + "\n"
    if ftype == "tool/result":
        msg = data.get("message") or {}
        text = _content_text(msg.get("content"))
        err = data.get("error") or {}
        if err:
            text = (text + "\n" if text else "") + f"[工具错误 {err.get('name','')}: " \
                                                  f"{err.get('code','')} {err.get('reason','')}]"
        return json.dumps({"role": "tool", "tool_call_id": str(msg.get("toolCallId") or ""),
                           "content": text}, ensure_ascii=False) + "\n"
    if ftype == "turn/end":
        return None                         # 结束行由 _wait_turn_end_dsh 统一写（含 reason）
    if ftype == "driver/interaction":
        return "### 会话等待人工输入（提问/审批已推给用户）\n"
    if ftype == "user/message":
        return None                         # 平台 prompt 已由 ### PROMPT 行记录，避免重复
    if ftype == "agent/status":
        return None
    return None


def _dsh_stream_worker(sid, since, waiter, log_path, stop_event):
    """SSE 订阅线程：把会话事件翻译落日志并喂给 TurnWaiter（失败即唤醒等待者）。

    轮次主线程只等 waiter 的 turn/end（条件变量），不做任何远端轮询——这是方案
    §3.3「事件驱动替代轮询」在任务侧的落点。
    """
    dshdriver.feed_into(sid, since, waiter, stop_event,
                        on_frame=lambda frame: append_log(log_path,
                                                          dsh_event_to_log_line(frame)))


def parse_session_hint(log_path):
    """从日志尾部解析 session.resume_hint 的 session_id（只认最后的 meta 行）。"""
    text = read_log_tail(log_path, 200)
    candidates = SESSION_HINT_RE.findall(text)
    return candidates[-1] if candidates else None


# 工具结果/助手摘要单条可返回的最大字符数（超出截断，前端可展开原始全量）
DIALOGUE_TEXT_LIMIT = 6000
# 单条对话条目中 JSON 内容直接按长度截断时保留的字符数
DIALOGUE_RAW_LIMIT = 1200


def read_dialogue(rounds):
    """解析任务多轮日志为结构化对话条目（供「修复过程」对话界面渲染）。

    识别内容：
    - ### PROMPT <json>   -> 平台给 agent 的提示词（user）
    - {"role":"assistant"} -> 模型文本回复 / 工具调用请求
    - {"role":"tool"}      -> 工具执行结果（超长截断）
    - {"role":"meta","type":"session.resume_hint"} -> 会话 ID 提示

    返回 [{kind, round, ...}]，按日志出现顺序排列。
    """
    entries = []
    for r in sorted(rounds, key=lambda x: x["round_no"]):
        path = r["log_path"]
        if not path or not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
        except OSError:
            continue
        for raw in lines:
            line = raw.rstrip("\n")
            # 平台标志行
            if line.startswith("### PROMPT "):
                text = line[len("### PROMPT "):]
                try:
                    text = json.loads(text)
                except ValueError:
                    pass
                entries.append({"kind": "user", "round": r["round_no"], "text": text})
                continue
            if not line.startswith('{"role"'):
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            role = obj.get("role")
            if role == "meta":
                if obj.get("type") == "session.resume_hint":
                    entries.append({"kind": "meta", "round": r["round_no"],
                                    "text": obj.get("session_id", "")})
                continue
            if role == "assistant":
                content = obj.get("content") or ""
                tcs = [{"name": tc.get("function", {}).get("name", ""),
                        "args": tc.get("function", {}).get("arguments", "")}
                       for tc in (obj.get("tool_calls") or [])]
                entries.append({"kind": "assistant", "round": r["round_no"],
                                "text": content, "tool_calls": tcs})
                continue
            if role == "tool":
                content = obj.get("content") or ""
                truncated = len(content) > DIALOGUE_TEXT_LIMIT
                entries.append({"kind": "tool_result", "round": r["round_no"],
                                "tool_call_id": obj.get("tool_call_id", ""),
                                "text": content[:DIALOGUE_TEXT_LIMIT],
                                "truncated": truncated,
                                "tool_calls": []})
                continue
    return entries


def summary_entry_text(entry):
    """对话条目的单行摘要（前端折叠态/列表用），避免渲染超长工具结果。"""
    if entry["kind"] == "user":
        return entry.get("text", "")
    if entry["kind"] == "assistant":
        return entry.get("text", "")[:DIALOGUE_RAW_LIMIT]
    if entry["kind"] == "tool_result":
        return entry.get("text", "")[:DIALOGUE_RAW_LIMIT]
    if entry["kind"] == "meta":
        return entry.get("text", "")
    return ""


def read_log_tail(path, limit=200):
    """读日志末尾 limit 行文本（编码容错）。"""
    if not path or not os.path.isfile(path):
        return ""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return "".join(f.readlines()[-limit:])
    except OSError:
        return ""


def _tail_text(path, limit=300):
    """发压失败原因摘要：取日志尾部非平台标记行（脚本的 stderr 通常落在尾部）。

    "### " 开头是平台自己写的进度/状态标记，对用户不是有效信息，故剔除。
    """
    lines = [ln.strip() for ln in read_log_tail(path, 40).splitlines()
             if ln.strip() and not ln.startswith("### ")]
    return " ".join(lines)[-limit:]


def read_live_summary(work_dir):
    """读 <工作目录>/.live/live.json 的核心字段作为轮次摘要（JSON 字符串）。"""
    path = os.path.join(lib.runtime_dir(work_dir, ".live"), "live.json")
    try:
        with open(path, encoding="utf-8") as f:
            live = json.load(f)
        return json.dumps({
            "phase": live.get("phase", ""),
            "round": live.get("round"),
            "stats": live.get("stats", {}),
            "stop_condition": live.get("stop_condition", {}),
        }, ensure_ascii=False)
    except (OSError, ValueError):
        return ""


# ---------- 等待项自检线程（P5 取代 P1 影子比对线程；v3c 起行口径） ----------

SELFCHECK_INTERVAL = 60.0       # 等待项周期自检间隔（秒）
SELFCHECK_MIN_AGE = 15.0        # 行年龄豁免（秒）：拾取/建行 → 行置 running/证据
                                # 落行的毫秒窗——年轻行自检不处置不告警，防误杀
                                # 新生行


def set_liveness_probe(fn):
    """注册行判活探针（board 注册，v3c 行口径）：仅在
    reconcile_units/selfcheck_units 的锁外上下文调用，允许慢 REST（web busy）。"""
    if INSTANCE is not None:
        INSTANCE._liveness_probe = fn


def reconcile_units():
    """启动对账收尾（R5 顺序硬约束：
    runner.recover → board.recover 之后）：按活跃等待项行裁活（证据链见
    `waitq._unit_verdict`——web busy 三态探针 / 任务与消息行状态 / 卡行存在性 /
    行 evidence 的 pid 存活）；可证死 → 行收口（标签「启动对账：可证明失效」），
    活/未知保留。处置清单逐条打日志 + 一行汇总。新生窗口豁免在 waitq 判据内
    （评审 Important-1：t:/m: 对应行 queued=拾取→置 running 窗口判 unknown 不裁，
    终态/缺行/pid 退无论行龄照裁）。**有收口必唤醒 worker**（fix round 1 逐字
    保留：recover 的 notify 先于对账，其间扫描见残留占位回 cond.wait() 的 worker
    不再唤醒则排队单元停滞到下个外部事件——e2e_board_continue 阶段五实测踩中）。
    """
    if INSTANCE is None:
        return
    probe = getattr(INSTANCE, "_liveness_probe", None)
    n_rows = n_closed = 0
    for d in waitq.reconcile_units(probe):
        n_rows += 1
        n_closed += 1 if d["closed"] else 0
        print(f"[waitq] 对账 {d['key']}（项目 {d['project_id']}）："
              f"{d['verdict']}" + ("，已收口" if d["closed"] else ""), flush=True)
    # 汇总行（v3c）：稳定的「对账已跑」证据——活跃行数为 0 时也落一行（e2e 据
    # 此断言启动对账是否执行；行为对拍用）
    print(f"[waitq] 对账完成：活跃行 {n_rows} 条，收口 {n_closed} 条", flush=True)
    if n_closed:
        with INSTANCE._cond:
            INSTANCE._cond.notify_all()


_SELFCHECK_STARTED = False   # start_unit_selfcheck 幂等守卫（P6 移交⑤，对照
                             # 已退场 _SHADOW_STARTED 模式）：重复启动直接 return；
                             # 注入 stop 的单测路径不记账（每例自带终止事件）


def start_unit_selfcheck(interval=SELFCHECK_INTERVAL, min_age=SELFCHECK_MIN_AGE,
                         stop=None):
    """等待项周期自检线程：仅可
    证明失效自动收口，其余告警（R11/R11a）；健康时静默。线程内不持 runner 锁
    （慢 REST 探测合法），与 worker 写竞争沿用 db.py busy timeout（设计 §6.3）。
    首轮宽限（T4）：先睡一个周期再首查——启动对账（reconcile_units）刚收尾
    无需立即复查，且 min_age 豁免需要越过拾取→行置 running/证据落行窗口才生效；
    INSTANCE 拆离（套件还原）后线程自终。stop 仅供单测注入终止。
    收口豁免：每拍注入 `board.unit_managed` 作 `managed` 判据（v3c 修复轮
    Important-2）——平台在管（`_RUNS`）单元的行收尾归巡视，自检不越权收口。
    周期尾部顺带 `waitq.prune_finished()` 回收 wait_items 终态行（P6，R14）。
    幂等：生产路径（stop=None）重复调用直接 return（模块级 _SELFCHECK_STARTED）。"""
    if INSTANCE is None:
        return
    global _SELFCHECK_STARTED
    if stop is None:
        if _SELFCHECK_STARTED:
            return
        _SELFCHECK_STARTED = True
    stop_ev = stop if stop is not None else threading.Event()

    def _loop():
        while not stop_ev.wait(interval):       # 首轮宽限 + 固定周期
            try:
                inst = INSTANCE
                if inst is None:                # 单例已拆（测试还原）：线程自终
                    return
                probe = getattr(inst, "_liveness_probe", None)
                import board   # 函数内 import 防循环（board 模块级 import runner）
                # managed：平台在管（`_RUNS`）单元的收口豁免判据（v3c 修复轮
                # Important-2）——收尾归巡视 `_finish_run`（R4），自检不越权收口
                lines = waitq.selfcheck_units(probe, min_age=min_age,
                                              managed=board.unit_managed)
                for line in lines:
                    print(f"[waitq-selfcheck] {line}", flush=True)
                if any(l.startswith("自检收口可证死行") for l in lines):
                    # 自检收口的串行位立即唤醒 worker 补位（与 reconcile 同款：
                    # 等下个外部事件会让排队单元无谓停滞一个周期以上）
                    with inst._cond:
                        inst._cond.notify_all()
                n = waitq.prune_finished()      # 周期尾部：终态等待项回收（R14）
                if n:
                    print(f"[waitq-selfcheck] 终态等待项回收 {n} 条", flush=True)
            except Exception as e:      # 守护线程不 crash
                print(f"[waitq-selfcheck] 异常: {e}", flush=True)

    threading.Thread(target=_loop, daemon=True, name="waitq-selfcheck").start()
