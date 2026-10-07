#!/usr/bin/env python3
"""统一等待项核心（容器即队列：行即条目，v3 模型）。

设计：doc_ai/plan/202609/20260917_0718_排队与占用统一模型.md
- 等待项五类 kind：task / card / msg / answer / ext（外部条目，v2d T4，裁决 R13），
  状态机七枚举（v2a T1，裁决 R3）
  waiting → starting → running → finishing → done | failed | cancelled
  （claimed 被 starting 吸收，存量行由 db.migrate 归一；starting/running/finishing
  可经 return_to_waiting 放回）；
- seq 为 REAL 分数序：落尾 MAX(seq)+1 不变，中点插入/拖拽改序经
  insert_after_prefix / reposition（v2a T2，裁决 R4；间隙挤压等距重排、行 id 稳定）；
- 一切等待项变更必须经本模块函数（唯一写路径）；其他模块禁止直接 SQL 写
  wait_items / chat_msgs 两表；
- P4/P5 起：等待项为权威直调（P1 影子写/shadow() 安全壳已全面退场），写入失败
  即业务失败；泄漏由启动对账 reconcile_units + 周期自检 selfcheck_units 收口
  （仅可证明失效自动收口；v3c 起按行口径）。
- v3a 起（看板队列模型 v3「容器即队列」首批）：调度权威是 **wait_items 行本身**
  ——c: 行在起跑证实后保持 running 跨轮存活（enter_running），前缀/窗口/位次读口
  只认行；前缀成员唯一来源 = state ∈ PREFIX_STATES 的行。
- v3c（本模块第三批）：**证据与心跳迁到行**（§2.4）——wait_items.last_seen/
  evidence 两列承载 pid/desc/reason 登记证据与 busy=…(poll|sse) 心跳证据，
  启动对账（reconcile_units）与周期自检（selfcheck_units）改按**活跃行**口径判活
  （判活证据链逐字保留：探针三态 / 内建 DB 证据 / 行 evidence 的 pid 进程证据，
  R11/R11a 边界不动）。
- v3d（本模块第四批）：**「占用」概念退场**——占用 = 该单元在「正在开发」队列里
  有活跃行；`leases` 表与整套租约 API（acquire/release/has_lease/…）删除，
  迁移在 db.migrate 幂等 DROP（存量库的历史租约行无读口，直接丢弃）。
"""

import json
import sqlite3
import time

import db
import platcompat

KIND_TASK = "task"
KIND_CARD = "card"
KIND_MSG = "msg"
KIND_ANSWER = "answer"
# 外部条目（v2d T4，裁决 R13）：外部直跑会话入场即 running 的队列成员——
# target=看板卡 id、meta 带 sid；不由平台启动，结束/消失收归 board.finish
KIND_EXT = "ext"
KINDS = (KIND_TASK, KIND_CARD, KIND_MSG, KIND_ANSWER, KIND_EXT)

# 状态机七枚举（v2a T1，v2 §2.5.2-5，裁决 R3）：claimed 被 starting 吸收
# （原子认领迁移同为 rowcount 守卫，仅目标态改名），starting/running/finishing
# 行留队构成运行前缀（行即成员——v2a T3 补位器已接线调度窗口，T4 接线位次）。
WAITING, STARTING, RUNNING, FINISHING = "waiting", "starting", "running", "finishing"
DONE, FAILED, CANCELLED = "done", "failed", "cancelled"
ACTIVE_STATES = (WAITING, STARTING, RUNNING, FINISHING)   # 活跃唯一索引 / active_items 扫描口径
PREFIX_STATES = (STARTING, RUNNING)   # 调度口径运行前缀（位次口径另含 FINISHING，见 R7）
# STATE_* 旧名保留为别名（存量引用面不动；claimed 无别名——唯一引用点
# chat._reap_orphan_claim 已随改名切到 STATE_STARTING）
STATE_WAITING, STATE_STARTING = WAITING, STARTING
STATE_RUNNING, STATE_FINISHING = RUNNING, FINISHING
STATE_DONE, STATE_FAILED, STATE_CANCELLED = DONE, FAILED, CANCELLED

_ACTIVE_IN = ",".join(f"'{s}'" for s in ACTIVE_STATES)      # SQL IN 片段（唯一出处）
# return_to_waiting 可放回态 = 活跃非 waiting（starting/running/finishing）
_RETURNABLE_IN = ",".join(f"'{s}'" for s in ACTIVE_STATES if s != WAITING)

# 成员键前缀（行即成员；v3a 起前缀/位次/窗口的键空间）。拾取侧 runner._KEY_PREFIX
# 有意不含 ext——外部条目永不被平台拾取；本表含 ext 行（前缀/位次成员面：
# 外部条目入场即 running，是运行前缀的正式成员）。
_MEMBER_PREFIX = {KIND_TASK: "t", KIND_CARD: "c", KIND_MSG: "m",
                  KIND_ANSWER: "a", KIND_EXT: "ext"}


def member_key(kind, target_id):
    """等待项行 → 成员键（`t:`/`c:`/`m:`/`a:`/`ext:` + target_id）。

    前缀/位次/窗口的唯一键空间（行即成员，唯一来源 R1；v3d 起无第二来源）。
    """
    return f"{_MEMBER_PREFIX.get(kind, kind)}:{target_id}"


def _merge_meta_locked(conn, row, patch):
    """行内 meta JSON 合入 patch（持连接调用；坏 JSON 按空对象处理）。"""
    try:
        cur = json.loads(row["meta"] or "{}")
        if not isinstance(cur, dict):
            cur = {}
    except ValueError:
        cur = {}
    cur.update(patch)
    conn.execute("UPDATE wait_items SET meta=? WHERE id=?",
                 (json.dumps(cur, ensure_ascii=False), row["id"]))


def enqueue(kind, target_id, project_id, meta=None, not_before=0.0):
    """入队等待项（幂等：同类同目标已有活跃行 → 返回既有行 id）。

    并发安全：INSERT 优先、活跃唯一索引兜底；撞唯一索引说明并发下已有活跃行，
    重查并复用其 id（避免 check-then-insert 竞态抛 IntegrityError 被影子壳静默吞掉）。
    """
    if kind not in KINDS:
        raise ValueError(f"未知等待项 kind: {kind}")
    target_id = str(target_id)
    with db.connect() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO wait_items (project_id, kind, target_id, state, seq,"
                " created_at, not_before, meta)"
                " VALUES (?,?,?,'waiting',"
                " (SELECT COALESCE(MAX(seq),0)+1 FROM wait_items),?,?,?)",
                (project_id, kind, target_id, db.now_str(), float(not_before or 0),
                 json.dumps(meta or {}, ensure_ascii=False)))
            return cur.lastrowid
        except sqlite3.IntegrityError:
            row = conn.execute(
                "SELECT id FROM wait_items WHERE kind=? AND target_id=?"
                f" AND state IN ({_ACTIVE_IN})", (kind, target_id)).fetchone()
            if row is None:
                raise               # 非活跃唯一索引冲突：上抛，交给调用方/影子壳
            return row["id"]


def get_item(item_id):
    """按 id 取等待项行（无则 None）。"""
    if item_id is None:
        return None
    with db.connect() as conn:
        return conn.execute("SELECT * FROM wait_items WHERE id=?",
                            (item_id,)).fetchone()


def get_active(kind, target_id):
    """取同类同目标的活跃等待项行（无则 None）。"""
    with db.connect() as conn:
        return conn.execute(
            "SELECT * FROM wait_items WHERE kind=? AND target_id=?"
            f" AND state IN ({_ACTIVE_IN})",
            (kind, str(target_id))).fetchone()


def active_items(project_id=None):
    """活跃等待项列表（seq 升序；project_id 给定时仅该项目）。"""
    sql = f"SELECT * FROM wait_items WHERE state IN ({_ACTIVE_IN})"
    args = ()
    if project_id is not None:
        sql += " AND project_id=?"
        args = (project_id,)
    sql += " ORDER BY seq"
    with db.connect() as conn:
        return conn.execute(sql, args).fetchall()


def answer_pending_card_ids():
    """有活跃 answer 等待项（已作答·待送达）的卡片 id 集合（看板 queue_state
    批量派生用，P6——替代 board.is_answer_pending 逐卡点查的 N+1 形态；
    口径同为四活跃态行）。"""
    with db.connect() as conn:
        return {int(r[0]) for r in conn.execute(
            "SELECT DISTINCT target_id FROM wait_items"
            f" WHERE kind=? AND state IN ({_ACTIVE_IN})", (KIND_ANSWER,))}


def starting_card_ids():
    """c: 等待项为 starting 态的卡片 id 集合（看板 queue_state `starting` 枚举
    批量派生用，v2a T4，裁决 R6——已交 runner 拾起、会话未证实运行的卡片；
    与 answer_pending_card_ids 同型一次查询，免逐卡点查 N+1）。"""
    with db.connect() as conn:
        return {int(r[0]) for r in conn.execute(
            "SELECT DISTINCT target_id FROM wait_items"
            " WHERE kind=? AND state='starting'", (KIND_CARD,))}


def active_ext(project_id):
    """项目是否有活跃 ext 行（外部条目读口，v2d T4，裁决 R13）。

    调用面（v3d 收口）：`runner.unit_busy`（忙判定含 ext 分量）与展示派生
    （`board.ext_active` 薄壳 → `queue_states` 的 foreign 派生 / server
    `_session_queue_state` 的 foreign_busy）；**调度侧的项目外部条目闸不查本函数**
    ——`runner._pick_locked` 直接用本轮已取到的行集（同一判据的批量化，免第二次
    查询、无探针注册面）。EXISTS 点查，锁内 DB 读先例同 `active_items`（已退役的
    `_SYNC_BUSY` 纯内存读口径的等价承接：外部会话在跑 ⇔ 项目活跃 ext 行在场）。"""
    with db.connect() as conn:
        return conn.execute(
            "SELECT 1 FROM wait_items WHERE project_id=? AND kind=?"
            f" AND state IN ({_ACTIVE_IN}) LIMIT 1",
            (project_id, KIND_EXT)).fetchone() is not None


def active_ext_items(project_id=None):
    """活跃 ext 行列表（seq 升序；project_id 给定时仅该项目）——调和器/启动
    对账逐行核对外部条目的实况（建/消），外部条目行的批量读口径。"""
    sql = f"SELECT * FROM wait_items WHERE kind=? AND state IN ({_ACTIVE_IN})"
    args = [KIND_EXT]
    if project_id is not None:
        sql += " AND project_id=?"
        args.append(project_id)
    sql += " ORDER BY seq"
    with db.connect() as conn:
        return conn.execute(sql, args).fetchall()


def position(item_id):
    """同项目 waiting 等待项位次 (pos, total)（1 基；非 waiting 返回 (0, 0)）。

    v2a T4 归一（裁决 R7，位次含运行前缀；「claimed 不计」口径 P6 R12 废止）：
    pos = 前缀长度 + waiting 中 seq 更小者 + 1；total = 项目成员总数。
    **v3a 读口切行（R1/R2）**：前缀成员 = starting/running/finishing 行，唯一
    来源——c: 行在起跑证实后跨轮 running 存活（`enter_running`，v3d 起亦无第二
    来源），与 runner.unit_state 手算同口径。
    无生产调用方（生产位次走 unit_state），留自测。"""
    row = get_item(item_id)
    if row is None or row["state"] != STATE_WAITING:
        return 0, 0
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT id, kind, target_id, state FROM wait_items WHERE project_id=?"
            f" AND state IN ({_ACTIVE_IN}) ORDER BY seq",
            (row["project_id"],)).fetchall()
    prefix_keys, total_keys = set(), set()
    waiting = []                              # [(行 id, 成员键)]，seq 升序
    for r in rows:
        rk = member_key(r["kind"], r["target_id"])
        total_keys.add(rk)
        if r["state"] == STATE_WAITING:
            waiting.append((r["id"], rk))
        else:
            prefix_keys.add(rk)               # starting/running/finishing：位次前缀
    ahead = 0
    for rid_, rk in waiting:
        if rid_ == item_id:
            # 本行即查询目标：位次=前缀成员数 + 前方未计前缀的等待行数 + 1
            return len(prefix_keys) + ahead + 1, len(total_keys)
        if rk in prefix_keys:
            continue                          # 同键已计前缀（同单元不重复计位）
        ahead += 1                            # waiting 且 seq 更小者（升序遍历）
    return 0, 0


# ---------- 分数序插入（v2 §2.2 唯一插入规则地基；v2a T2，裁决 R4） ----------
# seq 为 REAL 分数序（SQLite INTEGER 亲和列原样存小数，无需 DDL 迁移）：落尾仍
# MAX(seq)+1（现行语义不变），中间插入取相邻中点；间隙 < 阈值先对项目区间行
# 等距重排（仅 UPDATE seq，行 id 稳定——沿用 P3 inject 裁决 R4 口径）。

_SEQ_REBALANCE_EPS = 1e-9   # 间隙阈值：低于此值先对区间行等距重排（仅 UPDATE seq）再插入
_PREFIX_IN = ",".join(f"'{s}'" for s in PREFIX_STATES)   # 前缀态 SQL IN 片段


def _rebalance_interval(conn, project_id, hi):
    """间隙挤压再平衡：本项目 seq ≤ hi 的全部行按序等距重排到 (floor, hi]
    （floor=区间最小行的全局前驱 seq，无前驱取 最小行 seq-1；hi 行本身落在
    原值不动）。仅 UPDATE seq，行 id 稳定、行序不变；他项目行不改写（跨项目
    交错行可能被本项目行越过——间隙挤压下的可接受扰动，小口径记录；呼出方
    需持连接，与本模块其他写函数同事务语义）。返回重排行数。"""
    rows = conn.execute(
        "SELECT id, seq FROM wait_items WHERE project_id=? AND seq <= ?"
        " ORDER BY seq, id", (project_id, hi)).fetchall()
    n = len(rows)
    if n == 0:
        return 0
    pred = conn.execute("SELECT MAX(seq) s FROM wait_items WHERE seq < ?",
                        (rows[0]["seq"],)).fetchone()["s"]
    floor = pred if pred is not None else rows[0]["seq"] - 1.0
    step = (hi - floor) / n       # n 个点：floor+step … floor+n*step=hi（hi 行不动）
    for i, r in enumerate(rows):
        conn.execute("UPDATE wait_items SET seq=? WHERE id=?",
                     (floor + step * (i + 1), r["id"]))
    return n


def _mid_seq(conn, project_id, lo, hi):
    """(lo, hi) 开区间中点 seq；间隙 < _SEQ_REBALANCE_EPS 先对项目区间等距
    重排（行 id 稳定），再取本项目 hi 前最末行与 hi 的中点（落点紧贴 hi 前）。"""
    if hi - lo >= _SEQ_REBALANCE_EPS:
        return (lo + hi) / 2
    _rebalance_interval(conn, project_id, hi)
    last = conn.execute(
        "SELECT MAX(seq) s FROM wait_items WHERE project_id=? AND seq < ?",
        (project_id, hi)).fetchone()["s"]
    # 重排后本项目 hi 前无行的兜底取 (lo,hi) 浮点中点（float64 中点恒可表示且
    # 必落区间内；旧 hi-1.0 在亚 eps 间隙会跌出下界——终审 Minor-1）
    return ((last + hi) / 2) if last is not None else (lo + hi) / 2


def _after_prefix_seq(conn, project_id):
    """「最后一个运行中条目之后」= 等待区最前的位次（锁内/事务内调用；
    insert_after_prefix 几何唯一出处，v2b T2 起 insert_card_after_prefix 共用）。

    位次几何（全局 seq 轴）：P=本项目前缀行（state∈PREFIX_STATES）最大 seq；
    W=本项目等待行最小 seq。W 存在 → 下界 L=max(P.seq, W 的全局前驱.seq)，
    seq_new=(L+W.seq)/2（保项目内「前缀全在等待前」不变量）；
    W 不存在 → seq_new=全局 MAX(seq)+1（落尾，与现行 enqueue 兼容）。
    间隙 < _SEQ_REBALANCE_EPS 时对项目区间行按序等距重排（行 id 稳定）。"""
    pfx = conn.execute(
        "SELECT MAX(seq) s FROM wait_items WHERE project_id=?"
        f" AND state IN ({_PREFIX_IN})", (project_id,)).fetchone()["s"]
    w = conn.execute(
        "SELECT MIN(seq) s FROM wait_items WHERE project_id=?"
        " AND state='waiting'", (project_id,)).fetchone()["s"]
    if w is None:
        return conn.execute(
            "SELECT COALESCE(MAX(seq),0)+1 s FROM wait_items").fetchone()["s"]
    pred = conn.execute(
        "SELECT MAX(seq) s FROM wait_items WHERE seq < ?", (w,)).fetchone()["s"]
    lows = [x for x in (pfx, pred) if x is not None]
    lo = max(lows) if lows else w - 1.0      # 无前驱：界外一步
    return _mid_seq(conn, project_id, lo, w)


def insert_after_prefix(kind, target, project_id, meta=None, not_before=0):
    """「最后一个运行中条目之后」= 等待区最前（设计 §2.2 插入规则基本形态）。

    位次几何见 _after_prefix_seq；活跃唯一索引冲突时幂等复用现行语义
    （返回既有行）。返回 (row_id, seq_new)。"""
    if kind not in KINDS:
        raise ValueError(f"未知等待项 kind: {kind}")
    target = str(target)
    with db.connect() as conn:
        try:
            seq_new = _after_prefix_seq(conn, project_id)
            cur = conn.execute(
                "INSERT INTO wait_items (project_id, kind, target_id, state, seq,"
                " created_at, not_before, meta)"
                " VALUES (?,?,?,'waiting',?,?,?,?)",
                (project_id, kind, target, seq_new, db.now_str(),
                 float(not_before or 0),
                 json.dumps(meta or {}, ensure_ascii=False)))
            return cur.lastrowid, seq_new
        except sqlite3.IntegrityError:
            row = conn.execute(
                "SELECT id, seq FROM wait_items WHERE kind=? AND target_id=?"
                f" AND state IN ({_ACTIVE_IN})", (kind, target)).fetchone()
            if row is None:
                raise               # 非活跃唯一索引冲突：上抛，交给调用方
            return row["id"], row["seq"]


def _msg_insert_seq(conn, project_id):
    """会话消息落点（v2 §2.2 插入规则的消息分支，2026-09-25 对齐「待对齐项」）：
    「最后一个运行中条目之后」，且排在同项目已排队的用户动作行（waiting m:/a:）
    之后——消息优先于等待区卡片/任务（c:/t:），同项目用户动作之间保持到达序
    FIFO（否则第二条消息会插到第一条之前，同会话消息序被反转）。

    几何（复用 _mid_seq 区间语义，锁内/事务内调用）：base＝本项目 前缀行 ∪
    等待用户动作行 的最大 seq；base 为空（无前缀无用户动作）退化为
    _after_prefix_seq（等待区最前）；hi＝本项目 seq>base 的首个等待行，
    无 hi 落全局尾；lo＝max(base, hi 的全局前驱)，取 (lo, hi) 中点。"""
    base = conn.execute(
        f"SELECT MAX(seq) s FROM wait_items WHERE project_id=?"
        f" AND (state IN ({_PREFIX_IN})"
        f" OR (state='waiting' AND kind IN ('{KIND_MSG}','{KIND_ANSWER}')))",
        (project_id,)).fetchone()["s"]
    if base is None:
        return _after_prefix_seq(conn, project_id)
    hi = conn.execute(
        "SELECT MIN(seq) s FROM wait_items WHERE project_id=?"
        " AND state='waiting' AND seq > ?", (project_id, base)).fetchone()["s"]
    if hi is None:
        return conn.execute(
            "SELECT COALESCE(MAX(seq),0)+1 s FROM wait_items").fetchone()["s"]
    pred = conn.execute(
        "SELECT MAX(seq) s FROM wait_items WHERE seq < ?", (hi,)).fetchone()["s"]
    lo = max(base, pred) if pred is not None else base
    return _mid_seq(conn, project_id, lo, hi)


def reposition(row_id, prev_seq, next_seq):
    """拖拽落点改序：seq=(prev_seq+next_seq)/2；仅 UPDATE seq，行 id 稳定（P3 inject R4 口径）；
    间隙挤压先重排。prev/next 由调用方按落点邻行给出（None 表示区首/区尾，取界外一步）。

    行不存在返回 False；两界皆空或区间倒置（prev ≥ next）抛 ValueError。

    行态守卫说明（v2c T2 补记，v2a 移交项）：本函数**有意不设行态守卫**——
    调序手势/补位几何需要挪 starting/running 行（行即成员，运行前缀也按 seq
    展示与插位）；终态行被挪无害（读侧全部只认活跃行，seq 改动无消费方）。
    并发语义由调用方承载：worker 已 claim 的行被挪序不影响该次起跑（仅位次
    展示瞬态漂移），手势侧幂等兜底见 board._doing_gesture。"""
    if prev_seq is None and next_seq is None:
        raise ValueError("reposition 需至少给一侧邻行 seq")
    if prev_seq is not None and next_seq is not None \
            and float(prev_seq) >= float(next_seq):
        raise ValueError("reposition 区间倒置：prev_seq 必须小于 next_seq")
    with db.connect() as conn:
        row = conn.execute("SELECT project_id FROM wait_items WHERE id=?",
                           (row_id,)).fetchone()
        if row is None:
            return False
        lo = float(prev_seq) if prev_seq is not None else float(next_seq) - 1.0
        hi = float(next_seq) if next_seq is not None else float(prev_seq) + 1.0
        seq_new = _mid_seq(conn, row["project_id"], lo, hi)
        conn.execute("UPDATE wait_items SET seq=? WHERE id=?", (seq_new, row_id))
        return True


def claim(item_id, claimer=""):
    """拾取（waiting→starting，原子：rowcount 判定，已被抢返回 False）。

    v2a T1（裁决 R3）：目标态 claimed 改名 starting（claimed 语义被吸收），
    认领迁移同为 rowcount 守卫，互斥语义逐字不变。"""
    if item_id is None:
        return False
    with db.connect() as conn:
        cur = conn.execute(
            "UPDATE wait_items SET state='starting', claimed_at=?, claimed_by=?"
            " WHERE id=? AND state='waiting'", (db.now_str(), claimer, item_id))
        return cur.rowcount == 1


def claim_by_target(kind, target_id, claimer=""):
    """按 (kind,target) 拾取：先查活跃行再原子 claim；无活跃行/已被抢返回 False。"""
    row = get_active(kind, target_id)
    return claim(row["id"], claimer) if row is not None else False


def mark_running(kind, target_id):
    """starting → running：证实运行（proc 存活 / web busy / turn 基线确认）后由起跑路径调用；
    非 starting 行返回 False（幂等守卫，不炸调用方）。

    v3a 补充：起跑证实（六条起跑路径）改经 `enter_running`——本函数保留原语义
    不变（严格 starting→running，recover 映射 / starting 超时自愈等既有调用方
    逐字不动）。"""
    with db.connect() as conn:
        cur = conn.execute(
            "UPDATE wait_items SET state='running' WHERE kind=? AND target_id=?"
            " AND state='starting'", (kind, str(target_id)))
        return cur.rowcount == 1


def enter_running(kind, target_id, project_id, meta=None):
    """确保 (kind,target) 有且只有一条 running 行（v3a 起跑证实统一入口）。

    「行即条目」（v3 §2.2）：c: 行在起跑证实后**保持 running 跨轮存活**，直到
    会话结束/出队——旧口径在起跑瞬间把行终态化、跨轮占用另立表征，v3a 起退场。
    本函数是 `mark_running` 的超集（后者严格 starting→running，保留给既有
    调用方）：

    - 活跃行（waiting/starting/finishing）→ running（waiting 直接升格：起跑证实
      即运行，不重排队、不新插行）；
    - 已是 running → 幂等 True（行原样不动）；
    - 终态行（done/failed/cancelled）→ **复用同一行**（同 id、同 seq）重开 running
      ——出队（落阻塞/停止/移列/删除）后再起跑不新造行，位次与审计线索延续；
    - 无行 → 插入一行 state=running，位次几何与 `insert_after_prefix` 一致
      （`_after_prefix_seq`：运行前缀尾 / 等待区最前）——force 直起、送达恢复、
      阻塞解除归位、recover 重建等「无活跃行」路径在此补齐「行即成员」。

    返回 True=行已在 running（本入口幂等且不可失败：起跑证实的成败由起跑方
    自行判定，行只是证据面）。并发安全：先查活跃行；写入撞活跃唯一索引
    (kind,target_id)（他人刚插入/重开活跃行）→ 重查复用其行，幂等不抛。meta
    仅在新建/重开时合并（活跃行 meta 不动，避免踩 extra/from_column 审计线索）；
    **行证据同理**——重开终态行=新生命周期，evidence/last_seen 一并清零（旧会话
    证据不得残留到下一条命：pid 陈旧会误判判活/判死），活跃行证据不动（由
    `mark_evidence` / `touch_unit` 续写）。
    """
    target = str(target_id)
    with db.connect() as conn:
        row = conn.execute(
            "SELECT id, state FROM wait_items WHERE kind=? AND target_id=?"
            f" AND state IN ({_ACTIVE_IN})", (kind, target)).fetchone()
        if row is not None:
            if row["state"] != RUNNING:
                conn.execute("UPDATE wait_items SET state='running' WHERE id=?", (row["id"],))
            return True
        prev = conn.execute(
            "SELECT id, meta FROM wait_items WHERE kind=? AND target_id=?"
            " ORDER BY id DESC LIMIT 1", (kind, target)).fetchone()
        if prev is not None:                      # 终态行重开（同 id 同 seq，不新插行）
            try:
                conn.execute(
                    "UPDATE wait_items SET state='running', ended_at=NULL,"
                    " claimed_at=NULL, claimed_by=NULL, not_before=0,"
                    " last_seen=0, evidence='' WHERE id=?",
                    (prev["id"],))
            except sqlite3.IntegrityError:
                row = conn.execute(                # 并发：他人已重开同键行 → 落在活跃行上
                    "SELECT id FROM wait_items WHERE kind=? AND target_id=?"
                    f" AND state IN ({_ACTIVE_IN})", (kind, target)).fetchone()
                if row is None:
                    raise
                conn.execute("UPDATE wait_items SET state='running' WHERE id=?",
                             (row["id"],))
            if meta:
                _merge_meta_locked(conn, prev, meta)
            return True
        seq_new = _after_prefix_seq(conn, project_id)
        try:
            conn.execute(
                "INSERT INTO wait_items (project_id, kind, target_id, state, seq,"
                " created_at, meta) VALUES (?,?,?,'running',?,?,?)",
                (project_id, kind, target, seq_new, db.now_str(),
                 json.dumps(meta or {}, ensure_ascii=False)))
        except sqlite3.IntegrityError:
            row = conn.execute(                    # 并发：他人刚建活跃行 → 复用其行
                "SELECT id FROM wait_items WHERE kind=? AND target_id=?"
                f" AND state IN ({_ACTIVE_IN})", (kind, target)).fetchone()
            if row is None:
                raise
            conn.execute("UPDATE wait_items SET state='running' WHERE id=?", (row["id"],))
        return True


def mark_finishing(kind, target_id):
    """running → finishing：唯一收尾点入口（v2d T1，生产面唯此一条——board.finish
    只对 running 行调用）。SQL 另容忍 starting 作防御面（无生产调用方：起跑失败/
    starting 超时行的终态走 `finish_by_target`/worker finally，不经本迁移；v2d
    收口轮把 docstring 收敛到真实调用面）。"""
    with db.connect() as conn:
        cur = conn.execute(
            "UPDATE wait_items SET state='finishing' WHERE kind=? AND target_id=?"
            " AND state IN ('starting','running')", (kind, str(target_id)))
        return cur.rowcount == 1


def _set_terminal(item_id, state, error=""):
    """活跃项落终态（done/failed）；非活跃返回 False。

    状态守卫落在 UPDATE 上（rowcount 判定），避免读-写之间被并发抢先落终态；
    error 的 meta 合并在同一事务内、仅落终态成功（rowcount==1）时执行。
    """
    if item_id is None:
        return False
    with db.connect() as conn:
        cur = conn.execute(
            "UPDATE wait_items SET state=?, ended_at=?"
            f" WHERE id=? AND state IN ({_ACTIVE_IN})",
            (state, db.now_str(), item_id))
        if cur.rowcount != 1:
            return False
        if error:
            row = conn.execute("SELECT id, meta FROM wait_items WHERE id=?",
                               (item_id,)).fetchone()
            _merge_meta_locked(conn, row, {"error": error})
        return True


def mark_done(item_id):
    """标记完成（投递/送达/会话起跑成功的终态）。"""
    return _set_terminal(item_id, STATE_DONE)


def mark_failed(item_id, error=""):
    """标记执行失败（起会话失败/送达失败等；error 落 meta）。"""
    return _set_terminal(item_id, STATE_FAILED, error=error)


def finish_by_target(kind, target_id, state=STATE_DONE, error=""):
    """按 (kind,target) 落终态；无活跃行返回 False。"""
    row = get_active(kind, target_id)
    if row is None:
        return False
    if state == STATE_DONE:
        return mark_done(row["id"])
    return mark_failed(row["id"], error)


def return_to_waiting(item_id, not_before=0.0, bump_retry=False):
    """starting/running/finishing→waiting 放回（重试退避：not_before 最早可拾取时间；bump_retry 累加计数）。

    状态守卫落在 UPDATE 上（活跃非 waiting 三态 + rowcount 判定）：终态行不会被
    复活（否则会与活跃唯一索引冲突）；retries 在 SQL 内累加，免先读后写。
    v2a T1：claimed 改名 starting；放回面扩到 running/finishing（recover 映射：
    a: 行三态同型放回重投）。"""
    if item_id is None:
        return False
    with db.connect() as conn:
        cur = conn.execute(
            "UPDATE wait_items SET state='waiting', claimed_at=NULL, claimed_by=NULL,"
            f" not_before=?, retries=retries+? WHERE id=? AND state IN ({_RETURNABLE_IN})",
            (float(not_before or 0), 1 if bump_retry else 0, item_id))
        return cur.rowcount == 1


def cancel(kind, target_id, reason="", states=None):
    """取消活跃等待项（幂等：无活跃行返回 False；reason 落 meta）。

    状态守卫落在 UPDATE 上（四活跃态 + rowcount 判定，
    与 _set_terminal 同型）：避免读-写之间被并发抢先落终态——终态行不再被改写成
    cancelled；reason 的 meta 合并在同一事务内、仅取消成功（rowcount==1）时执行。
    states 收窄可取消行态（默认 None=四活跃态，既有调用面逐字不变；v2d T1：
    作答排队防御只取 waiting——running/finishing 行终态化归 board.finish 唯一
    收尾点、starting 归 worker finally，行态口径统一，v2b 终审记录①）。
    空元组防御（v2d T1 minor 收口）：states=() 语义为「无可取消态」，直接返回
    False——原样拼 SQL 会得到 `state IN ()` 语法错。
    """
    if states is not None and not states:
        return False                                    # 无可取消态：直接 no-op
    scope = _ACTIVE_IN if states is None \
        else ",".join(f"'{s}'" for s in states)
    with db.connect() as conn:
        row = conn.execute(
            "SELECT id, meta FROM wait_items WHERE kind=? AND target_id=?"
            f" AND state IN ({scope})", (kind, str(target_id))).fetchone()
        if row is None:
            return False
        cur = conn.execute(
            "UPDATE wait_items SET state='cancelled', ended_at=?"
            f" WHERE id=? AND state IN ({scope})",
            (db.now_str(), row["id"]))
        if cur.rowcount != 1:
            return False            # 读-写之间被并发落终态：不复活也不改写终态行
        if reason:
            _merge_meta_locked(conn, row, {"cancel_reason": reason})
        return True


def cancel_all_active(reason="", exclude_kind=None):
    """清空全部活跃等待项（返回条数）。P1 语义：服务重启时内存队列丢失，
    表按同语义清空（保证影子比对基线一致）。

    P2/P3 起支持 exclude_kind（str 或 tuple）：answer/msg 已切权威（重启存活），
    recover 传 (KIND_ANSWER, KIND_MSG) 保留两类行（runner.recover 按表重建内存
    单元）；task/card 仍随重启清空（P4 逐类改为保留后本参数逐步收窄）。
    P4 起 recover 不再使用（waiting 全量存活、starting 按类收口，R1）——函数
    保留供 selfcheck/未来对账复用。"""
    excludes = {exclude_kind} if isinstance(exclude_kind, str) else set(exclude_kind or ())
    n = 0
    for row in active_items():
        if row["kind"] in excludes:
            continue
        if cancel(row["kind"], row["target_id"], reason):
            n += 1
    return n


# ---------- 行证据与心跳（v3c：证据 / 心跳迁到行，v3 §2.4，裁决 R2/R11） ----------
# last_seen=最近一次心跳时间戳、evidence=证据 JSON 文本（desc/reason/pid 登记证据
# + busy=…(poll|sse) 心跳证据）。写入口唯一：本段两函数 + enter_running 的重开清
# 证据；读口：evidence_pid（进程证据）与 _unit_verdict（对账/自检判活）。

def _evidence_text(row, patch=None):
    """行 evidence JSON 合入 patch → 序列化文本。

    坏 JSON / 非对象按空对象处理；列初值为空串（db.migrate 默认）等价空对象。
    """
    try:
        cur = json.loads(row["evidence"] or "{}")
        if not isinstance(cur, dict):
            cur = {}
    except ValueError:
        cur = {}
    cur.update(patch or {})
    return json.dumps(cur, ensure_ascii=False)


def touch_unit(kind, target_id, evidence=""):
    """行心跳：刷新活跃行 last_seen；evidence 非空时合入行 evidence JSON
    （键 `evidence` / `evidence_at`）。

    刷新面=**活跃行**（等待/起始/运行/收尾）：终态行不打点（心跳只对在场条目
    有意义，收口后的行不复活）；无活跃行返回 False（不抛）。
    调用面：board 调和器（5s 节拍，仅对在管卡，`busy=1/0(poll)`）与 opencode
    SSE 钩子（`busy=1(sse)`）。
    """
    now = time.time()
    with db.connect() as conn:
        row = conn.execute(
            "SELECT id, evidence FROM wait_items WHERE kind=? AND target_id=?"
            f" AND state IN ({_ACTIVE_IN})",
            (kind, str(target_id))).fetchone()
        if row is None:
            return False
        patch = {"evidence": evidence, "evidence_at": now} if evidence else None
        conn.execute("UPDATE wait_items SET last_seen=?, evidence=? WHERE id=?",
                     (now, _evidence_text(row, patch), row["id"]))
        return True


def mark_evidence(kind, target_id, patch):
    """登记型证据写入（`card_started` 的 desc / reason / pid 登记面）：
    合入活跃行 evidence JSON（同键覆盖）。

    无活跃行或 patch 为空返回 False（幂等 no-op）。**不动 last_seen**——心跳归
    `touch_unit`；判活读口只认活跃行，故无活跃行时写入无意义。
    """
    if not patch:
        return False
    with db.connect() as conn:
        row = conn.execute(
            "SELECT id, evidence FROM wait_items WHERE kind=? AND target_id=?"
            f" AND state IN ({_ACTIVE_IN})",
            (kind, str(target_id))).fetchone()
        if row is None:
            return False
        conn.execute("UPDATE wait_items SET evidence=? WHERE id=?",
                     (_evidence_text(row, patch), row["id"]))
        return True


def evidence_pid(row):
    """行 evidence 的 pid 读取口（R11④ 进程证据；无行/无 pid/坏 JSON → None）。

    v3c 起读行 evidence（`card_started` 写入）——CLI 族卡起跑成功后必有；
    web 族/拾取窗口无 pid 落 unknown（宁多等不误杀）。
    bool 不算 pid（isinstance(True, int) 为真，显式排除）。
    """
    if row is None:
        return None
    try:
        ev = json.loads(row["evidence"] or "{}")
    except ValueError:
        return None
    if not isinstance(ev, dict):
        return None
    pid = ev.get("pid")
    return pid if isinstance(pid, int) and not isinstance(pid, bool) else None


# ---------- 自检与对账（P1 骨架 selfcheck 纯报告；P5 补 selfcheck_units 周期处置与 reconcile_units 启动对账；v3c 全切行口径） ----------

CLAIM_STALE_S = 1800     # 活跃态超龄阈值（秒）：超过且无可证明证据 = 可疑泄漏
                         # （v2d T3 起判据覆盖 starting/running/finishing 三态）


def selfcheck(probe=None):
    """纯 DB 不变量自检，返回问题描述清单（空列表=健康）。

    检查项（v3c 行口径，裁决 R12）：
    ① 同 (kind,target) 多条活跃等待项（独索引失效/绕过）；
    ② 活跃态（starting/running/finishing，v2d T3 扩面——原仅 starting）**超龄
       且无可证明证据**（claimed_at 越过 `CLAIM_STALE_S` 且判活三态非 alive、
       last_seen 心跳也不再新鲜）——可疑泄漏，纯报告面：
       行不因超龄被改写（可证死才自动收口的判据在 `_unit_verdict`/
       `selfcheck_units`，R11 边界沿用）。running/finishing 覆盖 force 落表行
       （行留队构成运行前缀）与收尾瞬态；正常持轮会话有 pid 证据或 5s 心跳在场，
       不误报。`claimed_at IS NULL` 的行不参与 ②（等待行本就长期在场：排队卡/
       消息/答案，超龄对其无意义）。
    ③ **I1 违约报告**（R12 新增，纯报告只告警不改行）：卡片不在「正在开发」
       容器却有活跃 c: 行（阻塞/待审核/已完成/待开发一律出队，v3 §2.1 I1）；
       卡行已删同列报告（行无主）。经唯一出队原语迁移的路径行先终态、列后搬，
       故稳态不报（仅搬列窗口的毫秒级瞬态可被 60s 自检撞见，无害）。
    ext 行（v2d T4 外部条目）不参与 ②（claimed_at 恒空——外部直跑不由平台启动、
    非认领行）；其生灭归调和器/入队刷新按项目活跃会话集合对账，**且全程不在 ③
    的扫描集内**——③ 只取 `kind=KIND_CARD` 的活跃行，ext 行永不被 ③ 覆盖
    （v3 终审修复：原文「③ 只对『卡行已删』形态告警」不成立；③ 的实际报告面
    是两类 c: 行形态——卡不在 doing（列已非开发容器）+ 卡行已删（行无主））。
    probe：行判活探针（web busy 三态；`selfcheck_units` 透传，直调缺省 None）。
    """
    problems = []
    now = time.time()
    cutoff = time.strftime("%Y-%m-%d %H:%M:%S",
                           time.localtime(now - CLAIM_STALE_S))
    with db.connect() as conn:
        dup = conn.execute(
            "SELECT kind, target_id, COUNT(*) n FROM wait_items"
            f" WHERE state IN ({_ACTIVE_IN})"
            " GROUP BY kind, target_id HAVING n > 1").fetchall()
        for r in dup:
            problems.append(f"等待项重复: kind={r['kind']} target={r['target_id']}"
                            f" n={r['n']}")
        stale = conn.execute(
            "SELECT * FROM wait_items"
            " WHERE state IN ('starting','running','finishing')"
            " AND claimed_at IS NOT NULL AND claimed_at < ?",
            (cutoff,)).fetchall()
        crow = conn.execute(
            "SELECT id, target_id, state FROM wait_items WHERE kind=?"
            f" AND state IN ({_ACTIVE_IN})", (KIND_CARD,)).fetchall()
        # 卡列只取活跃 c: 行涉及的卡（60s 自检不做全表扫描；空集免查）
        ids = sorted({r["target_id"] for r in crow})
        cards = {}
        if ids:
            cards = {str(r["id"]): r["column_key"] for r in conn.execute(
                "SELECT id, column_key FROM board_cards WHERE id IN (%s)"
                % ",".join("?" * len(ids)), ids)}
    for r in stale:
        if _unit_verdict(r, probe) == "alive":
            continue                       # 有可证明证据（探针/内建 DB/pid 存活）
        if r["last_seen"] and now - r["last_seen"] < CLAIM_STALE_S:
            continue                       # 心跳新鲜：在管打点即活性佐证
        problems.append(f"{r['state']} 超龄无证据: id={r['id']} kind={r['kind']}"
                        f" target={r['target_id']} claimed_at={r['claimed_at']}")
    for r in crow:                         # ③ I1 违约报告（只告警不改行）
        col = cards.get(r["target_id"])
        if col is None:
            problems.append(f"I1 违约: 卡行已删却有活跃 c: 行 id={r['id']}"
                            f" target={r['target_id']} state={r['state']}")
        elif col != "doing":
            problems.append(f"I1 违约: 卡 {r['target_id']} 不在正在开发容器"
                            f"（column={col}）却有活跃 c: 行 id={r['id']}"
                            f" state={r['state']}")
    return problems


def _unit_age(row):
    """行年龄（秒，自最近一次活动）：last_seen 心跳优先，回落 claimed_at /
    created_at（文本时间戳，同库口径）。

    解析失败按 0（=**最年轻**，与「刚活动过的新生行」同侧）：唯一消费面
    `selfcheck_units` 的判据是「`_unit_age(row) < min_age` → 跳过处置与告警」
    （年龄豁免），0 落豁免侧——宁可晚一拍再处置，也不对无时间戳的行抢先收口
    （v3 终审修复：原文写「视为最老，不误豁免」，与代码相反）。"""
    if row["last_seen"]:
        return max(0.0, time.time() - float(row["last_seen"]))
    ts = row["claimed_at"] or row["created_at"]
    try:
        return max(0.0, time.time() - time.mktime(time.strptime(ts, "%Y-%m-%d %H:%M:%S")))
    except (ValueError, TypeError, OverflowError):
        return 0.0


def _close_dead_unit(row, reason):
    """可证死活跃行收口（启动对账 / 周期自检共用，v3c）：起步前（waiting/
    starting）→ cancelled；起步后（running/finishing）→ failed（error=reason）。

    分流口径承 `runner.recover` 的按行收口映射（「服务重启中断」同款：未起跑
    的行本就是取消语义、已起跑的行按失败收口）；两者都是一次 rowcount 守卫的
    终态写入（终态行不再被改写，与行状态机「出队即终态」一致）。命中即打一行
    日志（含 reason 标签——reason 同时落行 meta）。
    返回是否命中收口。
    """
    if row["state"] in (WAITING, STARTING):
        hit = cancel(row["kind"], row["target_id"], reason)
    else:
        hit = mark_failed(row["id"], reason)
    if hit:
        print(f"[waitq] 收口可证死行 {member_key(row['kind'], row['target_id'])}"
              f"（{reason}）", flush=True)
    return hit


def _unit_verdict(row, probe):
    """单条活跃行的判活（宁多等不误放行）：返回 "alive"/"dead"/"unknown"。

    判据次序（v3c 行口径）：
    ① 注入探针（会话 busy 一类外部证据；waitq 不 import board/dshdriver，维持纯
    DB 模块边界）给出确活 → alive；② 探针判死**不采信**，降级 unknown（裁决 R11a：
    web 会话 idle/不在场是跨轮间隙常态，判死即误杀串行位）；③ 探针缺席/失败/
    不明 → 内建 DB 证据兜底（任务行状态、消息行状态、卡行存在性、**行 evidence
    的 pid 进程存活**——R11 清单①②③④⑤）；④ 皆无结论 → unknown。
    **t:/m: 对应任务/消息行 queued 一律 unknown 不证死**（评审 Important-1）：
    queued 是「拾取 → 行置 running」新生窗口的天然形态，与行龄无关——做旧的
    queued 残留由 recover 放回/重建后重新拾起，无需以收口清场；可证死只认
    **终态行/行缺失/pid 进程退**（均非瞬态证据）。
    ext: 行（外部条目，v2d T4）只认「卡行已删」一支——外部会话实况归调和器按
    项目活跃会话集合对账，本函数不裁其活。
    """
    if probe is not None:
        try:
            v = probe(row)
        except Exception:
            v = None                                    # 探测失败=状态不明，走内建
        if v == "alive":
            return "alive"
        if v == "dead":
            return "unknown"                            # R11a：探针判死不擅动
    kind, target = row["kind"], row["target_id"]
    if kind == KIND_TASK:
        t = db.get_task(int(target)) if target.isdigit() else None
        if t is None:
            return "dead"                               # 任务行已删/引用不可解析（§7.2 ②）
        if t["status"] == "running":
            return "alive"
        return "unknown" if t["status"] == "queued" else "dead"   # queued=新生窗口
    if kind == KIND_MSG:
        m = msg_get(target)
        if m is None:
            return "dead"                               # 消息行缺失（§7.2 ③）
        if m["state"] == "running":
            return "alive"
        return "unknown" if m["state"] == "queued" else "dead"    # queued=新生窗口
    if kind in (KIND_CARD, KIND_ANSWER):
        card = db.get_board_card(int(target)) if target.isdigit() else None
        if card is None:
            return "dead"                               # 卡行已删/引用不可解析（§7.2 ①）
        # R11④ 进程证据（CLI 族卡起跑成功后由 card_started 写入行 evidence.pid，
        # v3c 起读行）：进程已退即可证死（启动对账收口 CLI 卡残留的主路径），
        # 存活即确活；pid 复用的误判方向是「确活」=宁多等。无 pid（拾取窗口/
        # web 族）落 unknown——宁多等不误杀。
        pid = evidence_pid(row)
        if pid is not None:
            return "alive" if platcompat.pid_alive(pid) else "dead"
        return "unknown"
    if kind == KIND_EXT:
        # 外部条目：卡行已删即无主（可证死）；其余交调和器按实况集合对账
        card = db.get_board_card(int(target)) if target.isdigit() else None
        return "dead" if card is None else "unknown"
    return "unknown"


def reconcile_units(probe=None):
    """启动对账（v3c 起行口径；设计 §7.1/R11）：按**活跃
    等待项行**逐条判活；可证死 → 行收口（reason 标签「启动对账：可证明失效」）；
    活/未知 → 保留。返回处置清单 [{project_id, key, kind, verdict, closed}]；
    卡/任务的用户可见收尾沿用既有路径（调和器归位/interrupted），本函数只管
    队列层。

    调用顺序硬约束：必须在 runner.recover → board.recover 之后跑——board.recover
    已把 busy web 卡的行置 running 并重建在管条目，提前对账会把在跑的会话误判
    （见 runner.reconcile_units）。
    新生窗口豁免（评审 Important-1）落在 `_unit_verdict`：t:/m: 对应行 queued
    判 unknown 不裁（拾取→行置 running 的毫秒窗，与行龄无关——blanket 行龄豁免
    会把「重启前刚拾取即被打断」的真死行也放过，收口退化为等自检）；ext: 行除
    「卡行已删」外不裁（生灭归调和器按活跃会话集合对账）。"""
    out = []
    for row in active_items():
        v = _unit_verdict(row, probe)
        closed = False
        if v == "dead":
            closed = _close_dead_unit(row, "启动对账：可证明失效")
        out.append({"project_id": row["project_id"],
                    "key": member_key(row["kind"], row["target_id"]),
                    "kind": row["kind"], "verdict": v, "closed": closed})
    return out


def selfcheck_units(probe=None, min_age=0.0, managed=None):
    """周期自检处置（v3c 起行口径；设计 §7.2/R11）：
    仅对**可证明失效**的活跃行自动收口并返回告警/动作清单；状态不明只告警
    （R11/R11a：运行期 web idle 不判死——跨轮间隙误杀面，权威收口路径
    （_finish_run / 出队原语）在进程内可靠）。
    min_age：**行年龄豁免**（秒）——行自最近一次活动（last_seen 心跳回落
    claimed_at/created_at）距今不足 min_age 的跳过处置与告警（拾取/建行 → 行置
    running 稍后的毫秒窗口，防误杀新生行，与判据内的新生窗口豁免互补防御）。
    缺省 0=不豁免（纯函数旧语义）。
    managed：**平台在管豁免判据**（v3c 修复轮 Important-2；`board.unit_managed`
    经 `runner.start_unit_selfcheck` 注入，缺省 None=不豁免）——行所属单元仍在
    平台在管条目（`_RUNS`）时，其收尾归巡视 `_finish_run`（R4 收尾归属），自检
    **不越权收口**：否则 CLI 卡 agent 进程刚退出（行 evidence.pid 已退=可证死
    形态）、巡视 30s 节拍未到时，自检会把一次成功会话的行抢先标 `failed`
    （污染作为调度权威的审计行，并瞬时造出「卡在 doing 却无活跃行」的
    I1 违约自报）；`card_finished` 门禁 (running, finishing) 届时已见终态行，
    错误标签定死。豁免只作用于**收口面**：`_RUNS` 无条目的卡死行（自检是唯一
    恢复路径）照常收口，不因本守卫停滞。
    告警面（v3c 修复轮 Important-1）只覆盖**平台认领的在跑行**：waiting 行
    （排队单元/积压卡——天然无证据，属常态）与 ext: 行（外部条目生灭归调和器
    按活跃会话集合对账）不告警——逐条遍历会把 N 条积压变成每 60s N 行日志，
    违背「健康时静默」并淹没 R12 报告；`dead` 收口面不受此限（waiting 泄漏行
    照常收口）。waiting 行同样免探针（无会话可探，且探针在其上只会把 dead
    降级 unknown——省 N 次 REST）。
    R12 的报告扩展（I1 违约报告、「活跃行超龄且无可证明证据」）在 `selfcheck()`
    并入返回——**报告项只告警不改行**，自动收口只走 `dead` 一支。"""
    problems = []
    for row in active_items():
        if min_age > 0 and _unit_age(row) < min_age:
            continue                                    # 年龄豁免：新生行不动不告警
        # waiting 行免探针（见 docstring）；其余行按注入探针裁活
        v = _unit_verdict(row, None if row["state"] == WAITING else probe)
        key = member_key(row["kind"], row["target_id"])
        if v == "dead":
            if managed is not None and managed(row):
                continue              # 平台在管：收尾归巡视（R4），自检不越权收口
            _close_dead_unit(row, "周期自检：可证明失效")
            problems.append(f"自检收口可证死行: {key}")
        elif v == "unknown" and row["state"] != WAITING and row["kind"] != KIND_EXT:
            problems.append(f"行状态不明（仅告警）: {key}")
    problems += selfcheck(probe)                        # 纯报告项并入（含 I1 违约）
    return problems


PRUNE_FINISHED_KEEP_S = 86400   # wait_items 终态行回收默认保留窗（秒；R14 口径保守）


def prune_finished(keep_sec=PRUNE_FINISHED_KEEP_S):
    """回收 wait_items 终态行（P6，裁决 R14）：done/failed/cancelled 且
    ended_at 距今超 keep_sec 秒 → 删；活跃行不动。返回删除条数。

    量级小、口径保守（默认 86400s）；挂进 runner.start_unit_selfcheck 周期
    尾部（蹭既有线程，零新线程）。终态行只承载审计/排查看板，超窗删除不影响
    任何拾取/位次口径（读侧全部只认活跃行）。"""
    cutoff = time.strftime("%Y-%m-%d %H:%M:%S",
                           time.localtime(time.time() - keep_sec))
    with db.connect() as conn:
        cur = conn.execute(
            "DELETE FROM wait_items WHERE state IN ('done','failed','cancelled')"
            " AND ended_at IS NOT NULL AND ended_at <= ?", (cutoff,))
        return cur.rowcount


# ---------- 卡片等待项原子操作（P4 排队态单写：设计 §9「等待项核心模块内、事务包裹」） ----------
# 落点裁决（P4 计划 R6）：路线图「board.py enqueue_card」指调用面；跨表原子只能在
# 单连接单事务内做，故实现放本模块。board_cards 不在三表唯一写路径禁令内
# （禁令只锁 wait_items/chat_msgs 两表），本段是唯一允许写卡片占位的非 board 函数。

_CARD_QUEUE_TEXT = "排队等待：统一队列"   # 与 board._enter_doing 原文案逐字一致


def _active_card_row_locked(conn, target):
    """卡片的活跃 c: 行（无则 None；持连接调用——v3a 入队门禁共用读口）。"""
    return conn.execute(
        "SELECT id, state, seq FROM wait_items WHERE kind=? AND target_id=?"
        f" AND state IN ({_ACTIVE_IN})", (KIND_CARD, target)).fetchone()


def _project_card_queue_locked(conn, target, block_text):
    """卡片排队占位投影（条件写：已处 doing+queue 时不改写——保 answer 排队
    路径的空 block_text；否则置 doing+queue 并清 scheduled_at）。"""
    conn.execute(
        "UPDATE board_cards SET column_key='doing', block_kind='queue',"
        " block_text=?, scheduled_at=NULL, updated_at=?"
        " WHERE id=? AND NOT (block_kind='queue' AND column_key='doing')",
        (block_text, db.now_str(), target))


def _card_enqueue_locked(conn, target, project_id, seq_sql, seq_args,
                         extra="", from_column="", block_text=_CARD_QUEUE_TEXT):
    """卡片入队单事务体（enqueue_card / insert_card_after_prefix 共用；v3a 幂等门禁）。

    位次由调用方给定几何（seq_sql/seq_args）。返回等待项 id。
    已有活跃 c: 行 → **复用**（不插第二行，位次不动）：
      - waiting 行：维持现状语义（复用 + 占位投影照常）；
      - starting/running/finishing 行（v3a：起跑证实后跨轮存活的运行行）：
        只复用，**不回退行态、也不写「排队等待」占位**——卡在跑而非排队，
        写占位会让展示与事实相反（旧口径起跑即终态化，此处撞到的是「无活跃行」，
        该分支是 v3a 新形态）。
    无活跃行 → 插 waiting 行 + 占位投影（行+占位同事务，P4 单写原子红线）。
    并发安全：INSERT 优先、活跃唯一索引兜底（撞索引=并发下已有活跃行 → 重查复用，
    与 enqueue/insert_after_prefix 同 idiom）。"""
    row = _active_card_row_locked(conn, target)
    if row is None:
        try:
            cur = conn.execute(
                "INSERT INTO wait_items (project_id, kind, target_id, state, seq,"
                f" created_at, meta) VALUES (?,?,?,'waiting', {seq_sql},?,?)",
                (project_id, KIND_CARD, target, *seq_args, db.now_str(),
                 json.dumps({"extra": str(extra or ""),
                             "from_column": str(from_column or "")},
                            ensure_ascii=False)))
            item_id = cur.lastrowid
        except sqlite3.IntegrityError:
            row = _active_card_row_locked(conn, target)
            if row is None:
                raise               # 非活跃唯一索引冲突：上抛，交给调用方
            item_id = row["id"]
        else:
            _project_card_queue_locked(conn, target, block_text)
            return item_id
    item_id = row["id"]
    if row["state"] == WAITING:
        _project_card_queue_locked(conn, target, block_text)
    return item_id


def enqueue_card(card_id, project_id, extra="", from_column="",
                 block_text=_CARD_QUEUE_TEXT):
    """卡片入队（board 排队路径唯一写入口）：一个事务内写 card 等待项行 +
    board_cards 占位投影——「占位在、行不在 / 行在、占位不在」从结构上消失。

    幂等门禁（v3a，I5 同一卡至多一条活跃 c: 行）：同类同目标已有活跃行 → 复用
    （同 enqueue，位次不动）；其中 waiting 行照常落占位投影，starting/running/
    finishing 行（跨轮存活的运行行）只复用、不回退行态也不写排队占位（见
    `_card_enqueue_locked`）。meta={"extra": 打回意见, "from_column": 排队前列}
    ——打回意见随 meta 持久化（不再依赖内存暂存，重启不再丢），from_column 供
    起跑失败回列（P4 计划裁决 R7）。"""
    target = str(card_id)
    with db.connect() as conn:
        return _card_enqueue_locked(
            conn, target, project_id,
            "(SELECT COALESCE(MAX(seq),0)+1 FROM wait_items)", (),
            extra=extra, from_column=from_column, block_text=block_text)


def insert_card_after_prefix(card_id, project_id, extra="", from_column="",
                             block_text=_CARD_QUEUE_TEXT):
    """卡片入队「运行前缀后」（续跑/手动恢复专用写入口，v2b T2 裁决 R9）：
    一个事务内写 card 等待项行（位次=前缀后/等待区最前，与 insert_after_prefix
    同几何——_after_prefix_seq 唯一出处）+ board_cards 占位投影。

    v2a 子批终审契约（绑定）：续跑切换插入点前必须先落本原子变体——行与占位
    分两事务会留崩溃窗口「行在、占位不在」，合法行随后被「占位失效」摘除
    （P4 单写原子红线）。幂等（复用既有行、位次不动——重复按开始不提前）、
    占位条件写（保 answer 路径空 block_text）、meta 持久化（extra/from_column）
    语义与 enqueue_card 逐字一致（含 v3a 幂等门禁：已有运行行只复用不回退），
    仅位次不同。返回等待项 id。"""
    target = str(card_id)
    with db.connect() as conn:
        seq_sql = "?"
        seq_args = (_after_prefix_seq(conn, project_id),)
        return _card_enqueue_locked(
            conn, target, project_id, seq_sql, seq_args,
            extra=extra, from_column=from_column, block_text=block_text)


def insert_card_force_start(card_id, project_id, meta=None):
    """force 落表（v2b T4，裁决 R12）：一个事务内插「前缀尾」
    （_after_prefix_seq 几何=最后一个运行中条目之后）+ **直入 starting**
    （out-of-band 立即启动，不经 worker 拾取）——行从不以 waiting 形态出现，
    结构上消除「worker 路过见 waiting c: 行而占位失效摘除」的拾取竞态窗
    （force 卡无 doing+queue 占位，两段式 insert+claim 留该窗）。
    起跑证实由调用方 `enter_running`；会话结束由 card_finished 终态化（行即
    成员期间构成运行前缀、位次计入）。

    v3a 幂等门禁：已有活跃 c: 行 → **复用**（返回其 id/seq，行态与位次都不动）
    ——旧口径按编程错误上抛。force 前调用方已 cancel_card_wait 清残留，再撞=
    并发 force / 起跑证实后的跨轮存活行，此时重复插行会撞活跃唯一索引、把行打回
    starting 又会破坏「行即条目」语义。返回 (row_id, seq_new)。"""
    target = str(card_id)
    with db.connect() as conn:
        row = _active_card_row_locked(conn, target)
        if row is not None:
            return row["id"], row["seq"]
        seq_new = _after_prefix_seq(conn, project_id)
        try:
            cur = conn.execute(
                "INSERT INTO wait_items (project_id, kind, target_id, state, seq,"
                " created_at, claimed_at, claimed_by, meta)"
                " VALUES (?,?,?,'starting',?,?,?,'force',?)",
                (project_id, KIND_CARD, target, seq_new, db.now_str(),
                 db.now_str(), json.dumps(meta or {}, ensure_ascii=False)))
            return cur.lastrowid, seq_new
        except sqlite3.IntegrityError:
            row = _active_card_row_locked(conn, target)
            if row is None:
                raise               # 非活跃唯一索引冲突：上抛，交给调用方
            return row["id"], row["seq"]


def cancel_card_wait(card_id, reason=""):
    """卡片出队（board 取消路径唯一写入口）：一个事务内取消 card 等待项行 +
    清占位投影。双侧 rowcount 守卫：行已终态、或占位已被调用方改写（如 move_card
    先落了 manual 阻塞）则对应侧 no-op——不复活、不覆盖新状态。
    返回等待项是否命中取消（占位清除与否不影响返回值）。"""
    target = str(card_id)
    with db.connect() as conn:
        row = conn.execute(
            "SELECT id, meta FROM wait_items WHERE kind=? AND target_id=?"
            f" AND state IN ({_ACTIVE_IN})",
            (KIND_CARD, target)).fetchone()
        hit = False
        if row is not None:
            cur = conn.execute(
                "UPDATE wait_items SET state='cancelled', ended_at=?"
                f" WHERE id=? AND state IN ({_ACTIVE_IN})",
                (db.now_str(), row["id"]))
            if cur.rowcount == 1:
                hit = True
                if reason:
                    _merge_meta_locked(conn, row, {"cancel_reason": reason})
        conn.execute(
            "UPDATE board_cards SET block_kind=NULL, block_text=''"
            " WHERE id=? AND block_kind='queue'", (target,))
        return hit


def set_card_wait_placeholder(card_id, block_text=""):
    """仅写占位投影（answer 排队路径专用：等待单元是 answer 行，不建 card 行）。
    无条件置 doing+queue（与原作答排队分支语义等价；仅 done_at 不清这一不可达
    态差异——原分支同样不清，列归位由送达执行体兜底）。"""
    with db.connect() as conn:
        conn.execute(
            "UPDATE board_cards SET column_key='doing', block_kind='queue',"
            " block_text=?, updated_at=? WHERE id=?",
            (block_text, db.now_str(), str(card_id)))


# ---------- 外部条目 ext 行（v2d T4，裁决 R13；board 外部直跑会话唯一写入口） ----------

def insert_ext(project_id, card_id, sid=""):
    """外部条目落表：单事务插「运行前缀尾」（`_after_prefix_seq` 几何=最后一个
    运行中条目之后）+ **直入 running**——外部直跑会话不由平台启动，入场即视为
    在运行（行即成员构成运行前缀、位次计入「前面还有几个」；v2 §2.2【已定】）。

    target=看板卡 id、meta 带 sid；claimed_at 留空（无平台认领——selfcheck 的
    活跃态超龄无证据判据只覆盖被 claim 过的行，外部条目不算泄漏）。复数并存
    （多外部会话各自一行）；并发安全：INSERT 优先、活跃唯一索引兜底——撞活跃
    唯一索引说明并发下已有活跃行（`upsert_ext` 的 check-then-insert 窗口），
    重查复用其行（与 `enqueue`/`insert_after_prefix` 同 idiom）；其他冲突仍上抛。
    返回 (row_id, seq_new)。"""
    target = str(card_id)
    with db.connect() as conn:
        try:
            seq_new = _after_prefix_seq(conn, project_id)
            cur = conn.execute(
                "INSERT INTO wait_items (project_id, kind, target_id, state, seq,"
                " created_at, meta) VALUES (?,?,?,'running',?,?,?)",
                (project_id, KIND_EXT, target, seq_new, db.now_str(),
                 json.dumps({"sid": str(sid or "")}, ensure_ascii=False)))
            return cur.lastrowid, seq_new
        except sqlite3.IntegrityError:
            row = conn.execute(
                "SELECT id, seq FROM wait_items WHERE kind=? AND target_id=?"
                f" AND state IN ({_ACTIVE_IN})", (KIND_EXT, target)).fetchone()
            if row is None:
                raise               # 非活跃唯一索引冲突：上抛，交给调用方
            return row["id"], row["seq"]


# ---------- chat_msgs 读写（P3 消息持久化：msg 等待项的载荷与状态权威） ----------
# 会话消息的状态权威（chat 内存登记转正）；chat_msgs.state 用消息侧口径
# queued|running|done|error|cancelled，与 wait_items.state（waiting|starting|…）分属
# 两套状态机：等待项管「队列拾取互斥」，消息行管「用户可见生命周期」。

def msg_enqueue(msg_id, project_id, sid, message, task_id=None, card_id=None,
                inject=False, meta=None, queue=True):
    """会话消息入队（chat.submit 专用写入口）：一个事务内写 chat_msgs 行
    （state=queued，毫秒 epoch 时间戳）+ msg 等待项行（meta 携带执行体重建
    载荷——family/model 提交时快照与 comment_id，见 P3 计划裁决 R1）。

    queue=False（P5 R13）：跳过等待项行、只写 chat_msgs——runner 单例缺位的
    同步路径专用（消息不经队列、无拾取方，等待项只会成为无人认领的孤儿行）。

    msg_id 主键保证唯一（同 id 重复提交视为编程错误，IntegrityError 上抛）；
    「先写行后补内存键」纪律由调用方保证（chat.submit 先本函数再 inst.submit_msg）。

    位次（2026-09-25 对齐 v2 §2.2）：等待项落「最后一个运行中条目之后」且排在
    同项目已排队用户动作行（m:/a:）之后（_msg_insert_seq 几何）——不再是全局
    队尾 MAX(seq)+1；消息优先于等待区卡片/任务，同项目消息间保持到达序 FIFO。"""
    now_ms = int(time.time() * 1000)
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO chat_msgs (id, project_id, sid, task_id, card_id,"
            " message, state, error, inject, created_at)"
            " VALUES (?,?,?,?,?,?,'queued','',?,?)",
            (str(msg_id), project_id, sid, task_id, card_id, message,
             1 if inject else 0, now_ms))
        if not queue:
            return None
        seq_new = _msg_insert_seq(conn, project_id)
        cur = conn.execute(
            "INSERT INTO wait_items (project_id, kind, target_id, state, seq,"
            " created_at, meta) VALUES (?,?,?,'waiting',?,?,?)",
            (project_id, KIND_MSG, str(msg_id), seq_new, db.now_str(),
             json.dumps(meta or {}, ensure_ascii=False)))
        return cur.lastrowid


def msg_get(msg_id):
    """按 id 取消息行（无则 None；终态未回收也算——注入端点归属校验依赖）。"""
    if not msg_id:
        return None
    with db.connect() as conn:
        return conn.execute("SELECT * FROM chat_msgs WHERE id=?",
                            (str(msg_id),)).fetchone()


def msg_rows(sid=None, card_id=None, states=None):
    """消息行查询（chat 读侧专用）：sid/card_id/states 可选过滤，created_at 升序
    （idx_chat_msgs_sid 覆盖 sid 过滤）；states 传元组。"""
    sql = "SELECT * FROM chat_msgs WHERE 1=1"
    args = []
    if sid is not None:
        sql += " AND sid=?"
        args.append(sid)
    if card_id is not None:
        sql += " AND card_id=?"
        args.append(card_id)
    if states:
        sql += " AND state IN (%s)" % ",".join("?" * len(states))
        args.extend(states)
    sql += " ORDER BY created_at, id"   # 同毫秒按 id tie-break，P4 必带⑥
    with db.connect() as conn:
        return conn.execute(sql, args).fetchall()


def msg_queued_card_ids():
    """有排队中消息的卡片 id 集合（看板「排队中」徽标批量数据源）。"""
    with db.connect() as conn:
        return {r["card_id"] for r in conn.execute(
            "SELECT DISTINCT card_id FROM chat_msgs"
            " WHERE state='queued' AND card_id IS NOT NULL")}


def msg_claim(msg_id):
    """queued→running（原子守卫；started_at=毫秒）。worker 执行体与 inject_now
    的状态迁移点（队列级互斥另有等待项 claim，两层守卫互补）。"""
    with db.connect() as conn:
        cur = conn.execute(
            "UPDATE chat_msgs SET state='running', started_at=?"
            " WHERE id=? AND state='queued'",
            (int(time.time() * 1000), str(msg_id)))
        return cur.rowcount == 1


def msg_requeue(msg_id):
    """running→queued（inject_now 投递失败退回；started_at 清零，同原内存语义）。"""
    with db.connect() as conn:
        cur = conn.execute(
            "UPDATE chat_msgs SET state='queued', started_at=NULL"
            " WHERE id=? AND state='running'", (str(msg_id),))
        return cur.rowcount == 1


def msg_finish(msg_id, state, error=""):
    """running→done/error（执行体终态；ended_at=毫秒；error 截 300 字与原内存一致）。"""
    with db.connect() as conn:
        cur = conn.execute(
            "UPDATE chat_msgs SET state=?, error=?, ended_at=?"
            " WHERE id=? AND state='running'",
            (state, (error or "")[:300], int(time.time() * 1000), str(msg_id)))
        return cur.rowcount == 1


def msg_cancel(msg_id, error="已取消"):
    """queued→cancelled（用户取消；queued 守卫＝与 worker claim 的仲裁点）。"""
    with db.connect() as conn:
        cur = conn.execute(
            "UPDATE chat_msgs SET state='cancelled', error=?, ended_at=?"
            " WHERE id=? AND state='queued'",
            (error, int(time.time() * 1000), str(msg_id)))
        return cur.rowcount == 1


def msg_recover_fail(msg_id, error="服务重启中断"):
    """queued/running→error（recover 专用）：msg 重发非幂等，starting 不放回
    waiting 只记败（P3 计划裁决 R3；error 经 msgs_of_sid 下发前端）。"""
    with db.connect() as conn:
        cur = conn.execute(
            "UPDATE chat_msgs SET state='error', error=?, ended_at=?"
            " WHERE id=? AND state IN ('queued','running')",
            (error, int(time.time() * 1000), str(msg_id)))
        return cur.rowcount == 1


def msg_prune(keep_sec, max_rows):
    """回收终态消息行（chat 内存版等价迁移；chat.submit 调用）：
    ① 终态（done/error/cancelled/yielded）且 ended_at 距今超 keep_sec 秒 → 删；
    ② 总行数超 max_rows → 按终态时间从旧到新删多余（活跃行不删）。
    等待项终态行不在本函数范围，由 prune_finished 回收（P6，R14）。"""
    now_ms = int(time.time() * 1000)
    n = 0
    with db.connect() as conn:
        cur = conn.execute(
            "DELETE FROM chat_msgs WHERE state IN"
            " ('done','error','cancelled','yielded')"
            " AND ended_at IS NOT NULL AND ended_at <= ?",
            (now_ms - keep_sec * 1000,))
        n += cur.rowcount
        extra = conn.execute("SELECT COUNT(*) n FROM chat_msgs").fetchone()["n"] - max_rows
        if extra > 0:
            ids = [r["id"] for r in conn.execute(
                "SELECT id FROM chat_msgs WHERE state IN"
                " ('done','error','cancelled','yielded')"
                " ORDER BY ended_at LIMIT ?", (extra,))]
            conn.executemany("DELETE FROM chat_msgs WHERE id=?", [(i,) for i in ids])
            n += len(ids)
    return n
