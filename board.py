#!/usr/bin/env python3
"""Touchstone 看板（Board）：卡片管理 + 门禁仲裁 + agent 会话驱动 + 定时调度。

复刻 dsh-kanban（设计：doc_ai/20260831_0659_看板复刻设计.md）：
- 五列 todo/doing/blocked/review/done，一项目一看板，数据按 project_id 隔离；
- 移列统一走 move_card 服务端仲裁：父任务未完成拦截；serial 模式进 doing 落阻塞列
  排队（block_kind='queue'）入 runner 统一队列——与测试任务共享每项目串行 FIFO，
  队列拾起自动起跑（dequeue_start），会话结束释放占用自动补位（force 可跳过排队直起）；
- 开始开发 = 起项目绑定的 agent 会话（单族：dsh 插件会话在 dsh 宿主进程内，经
  dshdriver HTTP 驱动 + dshevents 事件中枢做项目串行调度：sid 立即可知、运行中可插话、
  abort 停止；退场族项目在起会话处返回明确错误），
  会话结束 → 卡片自动进待审核并释放占用补位；
- 定时开工由 start_scheduler 的守护线程每 30s 扫描（不依赖页面打开）。
"""

import base64
import glob
import json
import os
import platcompat
import signal
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import agents
import chat
import db
import dshevents
import dshdriver
import feishu
import lib
import runner
import sessparse
import waitq
import worktree

# 五列定义（顺序即前端列序）
COLUMNS = ("todo", "doing", "blocked", "review", "done")

# 会话实况三态（2026-09-19 运行判定收口·先行）：判定「会话是否在运行」的唯一读路径。
# running=在跑；idle=明确空闲；unknown=读不到（事件中枢未连接/无信号）——调度场景必须保守
# （不补位/保留旧值），展示场景由调用方适配为 False（见 web_session_busy）。
STATE_RUNNING = "running"
STATE_IDLE = "idle"
STATE_UNKNOWN = "unknown"

# 看板设置默认值（board_settings.json 缺省补齐）；sort=每列排序方案：
# manual=手动拖拽顺序（sort_order），entered_desc=进入已完成时间新→旧（仅 done 列）
SETTINGS_DEFAULT = {"mode": "serial", "sync_sessions": True,
                    "jira": {"url": "", "user": "", "token": ""},
                    "sort": {"todo": "manual", "doing": "manual", "blocked": "manual",
                             "review": "manual", "done": "entered_desc"}}

# 列排序方案合法值（server 设置端点逐列校验用）；entered_desc 仅 done 列可用
SORT_MODES = ("manual", "created_desc", "updated_desc", "title", "entered_desc")

# 并行模式合法值（2026-09-17 需求修订，两档）：serial=同时只跑一个任务（由统一队列
# 每项目串行承载）；parallel=不限制。原第三档 readonly-parallel（2026-08-31 看板复刻
# 的过渡档，行为恒等同 serial）已删除——存量行在 settings_of 读取层归一为 serial，
# server 设置端点按本常量白名单校验
MODE_VALUES = ("serial", "parallel")

# 门禁临界区锁：「父依赖判定 + 直起落列」原子化（防并发双进 doing）。排队占位
# 落列/入队统一走锁外 waitq.enqueue_card 单事务（P4 R6 单写）；落 doing 即占住
# 串行位；serial 上限改由 runner 统一队列承载（每项目串行 FIFO，与测试任务混排）；
# 起会话一律在锁外（dsh 建会话/投递为驱动 REST 往返，持锁会阻塞全平台门禁）。
# 锁顺序固定 _gate_lock → _runs_lock，持 _gate_lock 时不得再调会取 _gate_lock 的函数
_gate_lock = threading.Lock()


def _card_opt(row, key, default=""):
    """读卡片可选列（列缺失/值为 NULL 一律回落 default）。

    `board_cards.worktree` 是 kanban 一期遗留列（`db.py` 建表里有、`db.migrate()`
    2026-10-06 批次才补 ALTER），比一期更早的库可能没有该列——sqlite3.Row 缺列会
    抛 IndexError，故所有新列的读取一律经本函数，不直接下标访问。
    """
    try:
        v = row[key]
    except (IndexError, KeyError):
        return default
    return default if v is None else v


def card_workspace(project, card):
    """卡片会话的工作目录（本批新增，见 plan §3.3）：

    独立 worktree 卡（`board_cards.worktree` 非空）用其 worktree 路径，其余一律
    仍用 `project_dir`——这是「卡片级 cwd」的唯一读口，起会话/resume/首轮提示词/
    在管条目记账全部经它取值，避免同一语义散落多处。
    """
    wt = (_card_opt(card, "worktree") or "").strip()
    return wt or project["project_dir"]


def card_json(row, running=False, busy=False, msg_queued=False, queue_state=None):
    """卡片 Row -> 前端 dict。running=平台在管运行；busy=会话级运行
    （平台运行或外部 busy——用户在 dsh GUI 直跑的同步卡会话，前端徽标
    running||busy 都点亮）。answer_pending=已作答·待送达（答案排队，
    wait_items kind=answer 活跃行，2026-09-14；P2 起权威在表）——此时会话实况
    仍 busy（提问挂起中）但平台
    已收下答案、等空闲送达，前端按「排队中」展示且不点亮「会话运行中」。
    msg_queued=本卡有平台排队中的会话消息单元（chat.queued_card_ids 批量
    预计算，2026-09-14）——展示态同款：平台已收下消息、等空闲送达，前端按
    「排队中」展示且不点亮「会话运行中」。
    queue_state（P6 展示派生，最后一枚键）：五态+空闲单枚举（判定收口
    queue_state_of，前端只渲染）；缺省按四参现算（hidden sites 调用点零改动），
    board_payload 走批量预计算显式传入，此时 answer_pending 与之同源
    （queue_state_of 判定序最高级即 answer 在场 ⟺ answer_pending，免二次点查）。
    worktree（2026-10-06 批次）：独立 worktree 卡的落点绝对路径，空串=普通卡
    （前端据此渲染 🌿 徽标与详情行；只写不改口径见 plan D3）——经 `_card_opt`
    读取，兼容无该列的老库。"""
    if queue_state is None:
        answer = is_answer_pending(row["id"])
        queue_state = queue_state_of(row, running, busy, msg_queued, answer=answer)
    else:
        answer = queue_state == QS_ANSWER
    return {"id": row["id"], "project_id": row["project_id"], "title": row["title"],
            "description": row["description"], "column": row["column_key"],
            "sort_order": row["sort_order"], "session_id": row["session_id"],
            "sessions": json.loads(row["sessions"] or "[]"),
            "block_kind": row["block_kind"], "block_text": row["block_text"],
            "parent_card_id": row["parent_card_id"],
            "origin": row["origin"], "done_at": row["done_at"],
            "trashed": bool(row["trashed"]), "trashed_at": row["trashed_at"],
            "scheduled_at": row["scheduled_at"], "jira_key": row["jira_key"],
            "last_error": row["last_error"], "last_error_at": row["last_error_at"],
            "worktree": _card_opt(row, "worktree"),
            "created_at": row["created_at"], "updated_at": row["updated_at"],
            # 状态有更新·用户未打开（2026-10-07 批次）：卡面打「有更新」标记的依据，
            # 置位/清除全在 db 层派生维护，读侧只透传布尔值。
            "unread": bool(_card_opt(row, "unread") or 0),
            "running": running, "busy": busy,
            "answer_pending": answer,
            "msg_queued": msg_queued,
            "queue_state": queue_state}


def comment_json(row):
    """评论 Row -> 前端 dict。"""
    return {"id": row["id"], "card_id": row["card_id"], "text": row["text"],
            "sent": bool(row["sent"]), "session_id": row["session_id"],
            "sent_text": row["sent_text"], "created_at": row["created_at"]}


def settings_of(project_id):
    """看板设置（缺省补 SETTINGS_DEFAULT；jira 与 sort 逐字段深合并，
    存量行缺字段时落默认值）。mode 读取层归一：已删档的 readonly-parallel
    （2026-09-17）与任何未知值一律按 serial 处理，存量行无需迁移脚本。"""
    s = dict(SETTINGS_DEFAULT)
    saved = db.get_board_settings(project_id)
    s.update({k: v for k, v in saved.items() if k in s})
    if s["mode"] not in MODE_VALUES:
        s["mode"] = "serial"
    jira = dict(SETTINGS_DEFAULT["jira"])
    jira.update(saved.get("jira") or {})
    s["jira"] = jira
    sort = dict(SETTINGS_DEFAULT["sort"])
    sort.update({k: v for k, v in (saved.get("sort") or {}).items() if k in sort})
    s["sort"] = sort
    return s


def _doing_queue_order(project_id):
    """doing 列展示序=队序的排序键映射（v2c T2，裁决 R11 小口径；v2d T4 加 ext 行）：
    {card_id: (rank, seq)}——c:/ext: 行非 waiting（starting/running/finishing）=
    运行位区 rank0 按 seq（ext 行 target=卡 id：外部条目的运行位次由此接管，
    原「无活跃行落 sort_order 兜底」自然退场）；c: 行 waiting=等待区 rank2 按
    seq；无 c: 行的 answer 占位卡以 a: 行 seq 落等待区 rank2（答案单元占用该队位）。
    无活跃行的卡（idle 同步卡）不在映射内——调用方落 rank1 按 sort_order 相对序。"""
    order, answers = {}, []
    for r in waitq.active_items(project_id):
        try:
            tid = int(r["target_id"])
        except (TypeError, ValueError):
            continue
        if r["kind"] in (waitq.KIND_CARD, waitq.KIND_EXT):
            order[tid] = (0 if r["state"] != waitq.WAITING else 2, r["seq"])
        elif r["kind"] == waitq.KIND_ANSWER:
            answers.append((tid, r["seq"]))
    for tid, seq in answers:
        order.setdefault(tid, (2, seq))         # c:/ext: 行优先于 a: 行（同卡双行时）
    return order


# 任务状态 → 看板列映射（v2c T4，裁决 R16；v2 §2.1【已定】）：进行中→doing、
# 失败/中断/停止→review、完成→done；映射外状态不上板（防御未知新态）
_TASK_BOARD_COLUMN = {"queued": "doing", "running": "doing",
                      "failed": "review", "interrupted": "review",
                      "stopped": "review", "done": "done"}


def board_payload(project_id, running_map=None):
    """看板全量：cards + comments + settings + active_tasks。running_map: card_id -> bool。
    卡片 busy=会话级运行（平台在管或 web 族外部 busy，web_busy_map 批量预计算；
    非 web 族恒 False）。active_tasks=任务条目三列上映（v2c T4，裁决 R16：
    queued/running→doing、failed/interrupted/stopped→review、done→done；
    doing 序=运行中在前+创建先后，review/done 序=结束时间新→旧；前端按条目
    column 字段分列只读渲染，列统计口径=看板卡片不含任务）；
    2026-09-06 起测试任务也上板（最初仅 doing 列只读展示，与卡片共用统一队列）。
    卡片 msg_queued=本卡有平台排队中的会话消息单元（chat.queued_card_ids 一次
    批量取集合，2026-09-14——前端据此显示「排队中」徽标）。
    卡片 queue_state（P6 展示派生）：queue_states 一次批量算出（answer 活跃行/
    msg 排队集合/外部条目行各一次查询，消除逐卡点查的 N+1 形态）。
    doing 列卡片按 wait_items seq 下发（v2c T2，裁决 R11 小口径：展示序=队序——
    运行位区按 seq、无行卡落运行位区尾、等待区按 seq）；其余列维持
    list_board_cards 原序（sort_order 展示序，非队列容器）。"""
    running_map = running_map or {}
    proj = db.get_project(project_id)
    busy_map = web_busy_map(proj, running_map) if proj is not None else {}
    queued_cards = chat.queued_card_ids()
    rows = db.list_board_cards(project_id)
    states = queue_states(proj, rows, running_map, busy_map, queued_cards)
    cards = [card_json(r, bool(running_map.get(r["id"])),
                       bool(running_map.get(r["id"]))
                       or bool(busy_map.get(r["session_id"])),
                       r["id"] in queued_cards,
                       states.get(r["id"]))
             for r in rows]
    # doing 列原位重排为队序（稳定：仅 doing 内部相对序变化，他列原序不动）
    doing_order = _doing_queue_order(project_id)
    doing_cards = sorted(
        (c for c in cards if c["column"] == "doing"),
        key=lambda c: doing_order.get(c["id"], (1, c["sort_order"] or 0, c["id"])))
    it = iter(doing_cards)
    cards = [next(it) if c["column"] == "doing" else c for c in cards]
    comments = [comment_json(r) for r in db.list_board_comments(project_id)]
    doing_t, term_t = [], []
    for r in db.list_tasks(project_id):
        col = _TASK_BOARD_COLUMN.get(r["status"])
        if col is None:
            continue                            # 映射外状态不上板（防御未知新态）
        entry = {"id": r["id"], "project_id": r["project_id"],
                 "name": r["name"],
                 "task_type": r["task_type"] or "normal",
                 "status": r["status"], "current_round": r["current_round"],
                 "session_id": r["session_id"], "error": r["error"],
                 "created_at": r["created_at"], "started_at": r["started_at"],
                 "ended_at": r["ended_at"], "column": col}
        (doing_t if col == "doing" else term_t).append(entry)
    # doing 列保持现状序（运行中在前，排队按创建先后≈统一队列 FIFO 顺序）；
    # review/done 列按结束时间新→旧（与 done 列 entered_desc 默认同向）
    doing_t.sort(key=lambda t: (t["status"] != "running", t["created_at"] or ""))
    term_t.sort(key=lambda t: t["ended_at"] or "", reverse=True)
    return {"cards": cards, "comments": comments, "settings": settings_of(project_id),
            "active_tasks": doing_t + term_t}


def _descendant_ids(project_id, card_id):
    """card_id 的全部后代 id 集合（沿 parent_card_id 链向下，防循环依赖用）。"""
    children = {}
    for r in db.list_board_cards(project_id):
        if r["parent_card_id"]:
            children.setdefault(r["parent_card_id"], []).append(r["id"])
    out, stack = set(), [card_id]
    while stack:
        cur = stack.pop()
        for cid in children.get(cur, []):
            if cid not in out:
                out.add(cid)
                stack.append(cid)
    return out


def set_parent(project_id, card_id, parent_id):
    """设置父任务依赖。parent_id 为自身/后代/非法值/跨项目返回 'cycle'，否则落库返回 None。"""
    if parent_id:
        try:
            parent_id = int(parent_id)
        except (TypeError, ValueError):
            return "cycle"  # 非数字输入按非法依赖处理，避免抛异常打穿 API 层
        if parent_id == card_id or parent_id in _descendant_ids(project_id, card_id):
            return "cycle"
        parent = db.get_board_card(parent_id)
        if parent is None or parent["project_id"] != project_id:
            return "cycle"  # 父卡不存在或属他人/他项目，按非法依赖处理
        if parent["trashed"]:
            return "cycle"  # 父卡已在回收站（列表/依赖树均不可见），按非法依赖处理
    db.update_board_card(card_id, parent_card_id=parent_id or None)
    return None


def move_card(project, card_id, target, block_text="", before_id=None,
              merge_ack=False):
    """移列总入口（服务端仲裁）。返回 (card_dict, None) 或 (None, err_dict)。

    err_dict 三种：{"error": "..."}（硬错误，列未变——含进 doing 起会话失败回滚原列）；
    {"blocked": "parent-not-done"}（父任务拦截，列未变，前端弹确认）；
    {"merge_pending": {...}}（独立 worktree 卡进「已完成」且有提交没回流主分支，
    列未变，前端弹「是否交给 agent 合并」，2026-10-07 批次）。
    queue 拦截不算错误：卡片落「正在开发」列排队占位（block_kind='queue'）入统一队列，正常返回。
    规则：doing 不可直接拖回 todo；离开 todo 清定时；doing→doing 同列拖放走
    手势映射（v2c T1，裁决 R10——before_id 不再丢弃、不再直接返回，force/停止/
    调序/no-op 四分支见 _doing_gesture）；其余同列早退不变；跨列移卡默认落目标
    列尾（=目标列 MAX+1，与建卡同语义）；目标列排序为 manual 且传入 before_id 时
    整列重写 sort_order 把卡插到 before_id 之前（before_id=None=列尾；before_id 不在
    目标列 400——跨列拖拽支持插入任意位置，与列内拖排 reorder 同语义）；非 manual
    目标列忽略 before_id（显示顺序由排序方案决定，插入无意义）；离开 doing 即出队
    （v3b 容器语义：容器迁移 = 出队，统一原语 `_leave_doing` 先停运行中会话再行
    收口，统一队列自动补位；2026-09-13 起平台不做任何提交，改动提交由外部 hook
    扩展负责）；非 doing 列卡移列防御性停会话
    （防评论投递等 headless 续接残留）；手动进 blocked 记 block_kind='manual' +
    block_text；进其他列清除阻塞标记；进 doing 委托 _enter_doing（门禁/排队/起
    会话统一语义）；任何移列（目标非 doing）放弃该卡待送达的答案（权威取消
    wait_items 行，2026-09-17——卡已移走，迟到送达会唤醒已停会话、与拖拽意图相悖）；
    进/出「已完成」先做 dsh 归档/取消归档（2026-10-05 双向同步：任一会话归档失败
    即整体放弃本次移列并 400 报错，见 `_archive_card_sessions`）。
    2026-10-07 起本路径落列一律 `mark_unread=False`：拖列/按钮移列都是用户本人
    在看板上发起的操作，不是「用户没看见的状态更新」，不该由平台反过来提醒用户。
    独立 worktree 卡进「已完成」的额外闸（2026-10-07 批次）：卡在独立工作树里开发
    ⇒ 改动在 `ts/card-<id>` 分支上、主分支一无所知；`merge_ack=False`（默认）时先
    查有没有待合并提交，有则返回 `{"merge_pending": ...}` **不动列**，由用户决定
    「交给 agent 合并」还是「仅通过」（后者由前端带 `merge_ack=true` 再来一次）。
    """
    card = db.get_board_card(card_id)
    if card is None:
        return None, {"error": "card not found"}
    if target not in COLUMNS:
        return None, {"error": "bad column"}
    src = card["column_key"]
    if src == target:
        if target != "doing":
            return card_json(card), None
        # doing→doing 同列拖放：手势映射（v2c T1，裁决 R10；此前直接返回、
        # before_id 被丢弃）。force/停止/调序/no-op 四分支见 _doing_gesture
        return _doing_gesture(project, card, before_id)
    if src == "doing" and target == "todo":
        return None, {"error": "doing 不可直接拖回 todo"}
    # 待合并提交闸（2026-10-07 批次）：独立 worktree 卡进「已完成」前先问一句——
    # 放在归档同步**之前**，因为这条分支要「列不动」地返回（先归档再问会把
    # 会话归档了却没过卡，留下不一致状态）。
    if target == "done" and src != "done" and not merge_ack:
        pend = merge_pending(project, card)
        if pend:
            return None, {"merge_pending": pend}
    # 归档同步（2026-10-05）：进/出「已完成」先做归档面，失败即整体放弃本次移列
    # （硬失败 400 报前端，卡片列不变）。**归档先行**的理由：先落列再归档的话，
    # 失败回滚要连「已停会话/已出队/已改排序」一起退，代价与风险都大；先行失败
    # 则一个字节都没动。拖入 doing 的取消归档在 `_enter_doing` 里做（start 端点
    # 同经该入口，保持单一写点）。
    if target == "done" and src != "done":
        err = _archive_card_sessions(card, True, "进入已完成")
        if err:
            return None, {"error": err}
    if src == "done" and target not in ("done", "doing"):
        err = _archive_card_sessions(card, False, "离开已完成")
        if err:
            return None, {"error": err}
    if target == "doing":
        return _enter_doing(project, card)
    fields = {"column_key": target}
    if target == "blocked":
        fields["block_kind"] = "manual"
        fields["block_text"] = block_text or ""
    else:
        fields["block_kind"] = None
        fields["block_text"] = ""
    if src == "todo":
        fields["scheduled_at"] = None  # 离开待开发清定时
    if before_id is not None and settings_of(card["project_id"])["sort"].get(target) == "manual":
        # 跨列插入指定位置（manual 列）：整列重写 sort_order，把卡插到 before 前
        # （与 reorder_card 同语义；被移动卡自身序号由 plan 决定，下方统一落库）。
        # 先校验 before_id 在该列，否则 400（防误插他列/凭空卡）
        col_cards = [r for r in db.list_board_cards(card["project_id"])
                     if r["column_key"] == target]
        try:
            plan = move_into_plan(col_cards, card_id, before_id)
        except ValueError as e:
            return None, {"error": str(e)}
        with db.connect() as conn:
            conn.executemany("UPDATE board_cards SET sort_order=? WHERE id=?",
                             [(s, c) for c, s in plan])
    else:
        # 跨列移卡落目标列尾（manual 列拖入即列尾；与建卡 MAX+1 同语义）
        with db.connect() as conn:
            fields["sort_order"] = conn.execute(
                "SELECT COALESCE(MAX(sort_order),0)+1 FROM board_cards"
                " WHERE project_id=? AND column_key=?",
                (card["project_id"], target)).fetchone()[0]
    db.update_board_card(card_id, mark_unread=False, **fields)
    if is_answer_pending(card_id):
        # 拖离当前列 = 放弃该卡已作答·待送达的答案（2026-09-17，见 docstring）。
        # 覆盖 doing/queue 直接落手动阻塞等不走 stop_card 的路径；停止/删除
        # 路径的清理在 stop_card。P2 起权威取消 + 摘除内存队列键。
        waitq.cancel(waitq.KIND_ANSWER, card_id, "停止/移列放弃")
        inst = runner.INSTANCE
        if inst is not None:
            inst.remove_answer(card_id)
    if card["block_kind"] == "queue":
        # 排队占位拖离：显式出队（拾取判定兜底摘除）。P4 单写：行+占位原子取消，
        # 行已终态/占位已被上方落列写改写则守卫 no-op——runner.INSTANCE 缺位也照清
        waitq.cancel_card_wait(card_id, "卡片出队")
    if src == "doing" and target == "blocked":
        if card["block_kind"] == "queue":
            pass  # 排队占位卡无会话无工作区改动（行已在上方显式出队），直接落手动阻塞
        else:
            # 拖入阻塞=离开开发容器 ⇒ 出队（v3b 统一原语：停会话 + 行收口）
            _leave_doing(db.get_board_card(card_id), reason="出队-拖入阻塞")
    elif src == "doing":
        # 离开开发列即出队（用户约定：非 doing 卡不得有活会话）——拖入
        # review/done 时先停会话再行收口；_finish_run 见列非 doing 自动跳过
        # review 流转。主动停（SIGTERM/REST abort）不记 last_error
        _leave_doing(db.get_board_card(card_id), reason="移列释放")
    elif target != "doing":
        # 防御：非 doing 列的卡也不应留活会话（如评论投递在 review 卡拉起的 headless 续接）
        stop_card(card_id)
    return card_json(db.get_board_card(card_id)), None


# ---------- doing 列内拖放手势（v2c T1，裁决 R10；v2 §2.4 三手势 + 运行位互拖 no-op） ----------

# 运行位分区判据（与 queue_state 派生同源——行即成员：starting/running ∈ 运行
# 前缀；finishing 为收尾瞬态，按运行位处理——停止手势对其无害、调序无意义）。
# 运行位判据并入口径见 `_gesture_run_position`（行态 ∪ 在管条目；v3a 起 c: 行
# 跨轮 running 存活，行态单看已能认出运行位）。
_GESTURE_RUN_STATES = (waitq.STARTING, waitq.RUNNING, waitq.FINISHING)


def _gesture_run_position(card_id):
    """手势「运行位」判据（收口轮 C1；= 平台持有该卡单元 ∧ 非 answer 占位）。

    复用 `_platform_holds`（本卡有活跃 c: 行 ∨ 在管条目 `_RUNS`）：
    运行位的卡可能正处于两种表征之一——跨轮 c: 行（v3a 起行 running 存活，
    行即持有者）、在管会话（`_RUNS`，起跑/收尾窗口）；单看行态在起跑/收尾毫秒
    窗口会漏判，手势随即静默失效（前端按 `card.running` 照弹确认框，服务端 200
    无副作用=确认框说谎，实障根因）——在管条目分支为该形态兜底。
    排除面与前端 `isRunGesture` 逐点对齐：answer 占位卡（a: 活跃行在场）不参与
    手势（T3 fix round 2 口径）；外部 busy 卡（sync/外部直跑，无平台持有者）
    三者皆无 → 仍按非队列卡 no-op，不误开手势。
    """
    return not is_answer_pending(card_id) and _platform_holds(card_id)


def _drop_prev_seq(project_id, next_seq, exclude_row_id):
    """落点上界 seq：项目活跃行中 seq < next_seq（None=列尾取全体）且非被拖行
    的最大 seq；无则 None（区首）。手势落点 reposition 的 prev 界计算。"""
    prev = None
    for r in waitq.active_items(project_id):
        if r["id"] == exclude_row_id:
            continue
        if next_seq is not None and r["seq"] >= next_seq:
            continue
        if prev is None or r["seq"] > prev:
            prev = r["seq"]
    return prev


def _waiting_cards_above(project_id, next_seq):
    """落点上方（seq < next_seq；None=列尾）的等待区卡数（c: waiting 行）。
    停止手势严格判定用：运行卡拖到等待卡「后面」才算停止——落点上方须确有
    等待卡；落在等待区最前（before 首等待卡）=仍在运行位尾，no-op。"""
    n = 0
    for r in waitq.active_items(project_id):
        if r["kind"] != waitq.KIND_CARD or r["state"] != waitq.WAITING:
            continue
        if next_seq is not None and r["seq"] >= next_seq:
            continue
        n += 1
    return n


def _doing_gesture(project, card, before_id):
    """doing→doing 同列拖放的手势映射（v2c T1，裁决 R10；v2 §2.4）。

    分区判据=卡片持有面（活跃 c: 行 ∪ 在管条目；`_gesture_run_position`）：
    starting/running/finishing 行 ∈ 运行位（运行前缀成员），waiting 行 ∈ 等待区；
    **运行位的卡由跨轮 running 的 c: 行直接表征，在管条目分支为起跑/收尾窗口兜底**
    ——行态单看漏判时手势静默 no-op 而前端照弹确认框；
    无成员面的卡（sync 外部卡永不拾取、idle/answer 占位卡）不参与手势，原样返回
    200。落点分区=before_id 指向卡的成员面；before_id=None=列尾按等待区区尾处理；
    before_id 卡须同项目同列且在队列内，否则 400/无手势。
    四分支：

    - 等待卡落运行位（before 运行卡）=force 手势（v2 §2.4① 跨过运行位往上
      拖=强制运行，「落哪算哪」例外）：_enter_doing(force=True) 立即起跑
      （v2b T4 落表机制：插入前缀尾+直入 starting，起跑证实置行 running），
      再把起跑行 reposition 到落点区间（at=落点 seq，best-effort——起跑已
      成功，挪序失败不翻转手势结果；落点卡无活跃行时无 seq 可参照，跳过挪序）；
    - 运行卡落等待区深处（before 等待卡且其上方另有等待卡 / 列尾且有等待
      卡）=停止手势（v2 §2.4② 拖到等待卡后面=停止当前任务）：递归走既有
      「离开 doing 先停后释放」路径落待审核——确认框是前端（T3）的事，
      服务端幂等执行；
    - 等待卡落等待区=调序：waitq.reposition 把 c: 行挪到落点（仅 UPDATE
      seq，行 id 稳定；拾取/展示单轨接线在 T2，本批只改队序）；
    - 运行卡落运行位=no-op（200，位次/状态零变化；v2 §2.4「允许、无实际
      效果」）。
    """
    drag_row = waitq.get_active(waitq.KIND_CARD, card["id"])
    drag_run = (_gesture_run_position(card["id"]) if drag_row is None
                else drag_row["state"] in _GESTURE_RUN_STATES)
    if drag_row is None and not drag_run:
        # 非队列卡（sync/idle/answer 占位）：无手势语义，原样返回
        return card_json(card), None
    if before_id is not None:
        try:
            before_id = int(before_id)
        except (TypeError, ValueError):
            return None, {"error": "目标位置卡不在该列"}
        if before_id == card["id"]:
            return card_json(card), None        # 自己压自己=no-op（防御）
        before_card = db.get_board_card(before_id)
        if before_card is None or before_card["trashed"] \
                or before_card["project_id"] != card["project_id"] \
                or before_card["column_key"] != "doing":
            return None, {"error": "目标位置卡不在该列"}
        before_row = waitq.get_active(waitq.KIND_CARD, before_id)
        if before_row is None:
            if not _gesture_run_position(before_id):
                # 落点卡非队列成员（sync/idle/answer 占位）：无手势语义
                return card_json(card), None
            # 落点卡无活跃行但在管（起跑/收尾窗口，_RUNS 承载运行位）：按运行位
            # 处理；无行即无落点 seq（force 挪序跳过，best-effort 语义不变）
            before_seq = None
            before_run = True
        else:
            before_seq = before_row["seq"]
            before_run = before_row["state"] in _GESTURE_RUN_STATES
    else:
        before_row = before_seq = None
        before_run = False                      # 列尾=等待区区尾
    pid = card["project_id"]
    if drag_run:
        if before_run:
            # 运行位互拖：no-op（位次/状态零变化，v2 §2.4「允许、无实际效果」）
            return card_json(card), None
        if _waiting_cards_above(pid, before_seq) == 0:
            # 落等待区最前=运行位尾：no-op（防同位拖放误停运行中会话）
            return card_json(card), None
        # 停止手势：复用既有「离开 doing 先停后释放」路径落待审核（递归一层；
        # 停止/释放/列写全部幂等，竞态下重复执行无害）
        return move_card(project, card["id"], "review")
    if before_run:
        # force 手势：跨过运行位往上拖=强制运行（落哪算哪，v2 §2.2 例外）
        new_card, err = _enter_doing(project, db.get_board_card(card["id"]),
                                     force=True)
        if err is not None:
            return None, err
        # at=落点 seq 区间：把起跑行挪到目标运行行之前（best-effort；落点卡无活跃
        # 行＝无 seq 参照，跳过）
        row = waitq.get_active(waitq.KIND_CARD, card["id"])
        if row is not None and before_seq is not None:
            try:
                waitq.reposition(row["id"],
                                 _drop_prev_seq(pid, before_seq, row["id"]),
                                 before_seq)
            except ValueError:
                pass
        return new_card, None
    # 调序手势：等待区内部（before 等待卡 / 列尾）
    prev_seq = _drop_prev_seq(pid, before_seq, drag_row["id"])
    if prev_seq is None and before_seq is None:
        return card_json(card), None            # 队列仅自身：无位可挪
    try:
        waitq.reposition(drag_row["id"], prev_seq, before_seq)
    except ValueError:
        return None, {"error": "调序落点非法"}
    return card_json(db.get_board_card(card["id"])), None


# ---------- 列内手动拖排（manual 模式限定，sort_order 整列重写） ----------


def reorder_plan(cards, card_id, before_id):
    """列内重排纯函数（单测覆盖）：cards=该列当前有序卡片 row 列表。

    返回 [(card_id, sort_order)] 全列重写清单（1..n）；把 card_id 插到
    before_id 之前（before_id=None 列尾）。card_id/before_id 不在列内抛
    ValueError（调用方转 400）。"""
    ids = [c["id"] for c in cards]
    if card_id not in ids:
        raise ValueError("卡片不在目标列")
    if before_id is not None and before_id not in ids:
        raise ValueError("目标位置卡不在该列")
    if before_id == card_id:
        before_id = None  # 自己压自己按列尾处理（防御，正常流程不会发）
    moving = next(c for c in cards if c["id"] == card_id)
    rest = [c for c in cards if c["id"] != card_id]
    out, placed = [], False
    for c in rest:
        if not placed and before_id is not None and c["id"] == before_id:
            out.append(moving)
            placed = True
        out.append(c)
    if not placed:
        out.append(moving)
    return [(c["id"], i + 1) for i, c in enumerate(out)]


def move_into_plan(col_cards, card_id, before_id):
    """跨列插入纯函数（单测覆盖）：col_cards=目标列当前有序卡片 row 列表
    （不含被移动卡），把 card_id 插到 before_id 之前（before_id=None 列尾）。

    返回 [(card_id, sort_order)] 整列重写清单（1..n）——被移动卡自身序号含在内，
    调用方统一落库（与 reorder_plan 返回语义一致）。before_id 不在列内抛
    ValueError（调用方转 400）。"""
    if before_id is not None and before_id not in [c["id"] for c in col_cards]:
        raise ValueError("目标位置卡不在该列")
    out, placed = [], False
    for c in col_cards:
        if not placed and before_id is not None and c["id"] == before_id:
            out.append(card_id)
            placed = True
        out.append(c["id"])
    if not placed:
        out.append(card_id)
    return [(cid, i + 1) for i, cid in enumerate(out)]


def reorder_card(project_id, card_id, before_id):
    """列内拖排入口（v2c T2，裁决 R11 双轨并单轨）。

    doing 列：调序落点=wait_items 位次（`_reorder_doing_card`——waiting 行间
    重排，仅 UPDATE seq，sort_order 不动；manual 限定解除，队序即展示序）。
    其余列：仅 manual 模式可用（其余模式 400），sort_order 用直接 SQL 整列
    重写（不走 update_board_card，避免拖排把全列 updated_at 刷掉、干扰
    updated_desc 排序）——非队列容器，现行语义不变。返回 None=成功，
    str=错误（server 转 400）。"""
    card = db.get_board_card(card_id)
    if card is None or card["project_id"] != project_id:
        return "卡片不存在"
    col = card["column_key"]
    if col == "doing":
        return _reorder_doing_card(project_id, card, before_id)
    if settings_of(project_id)["sort"].get(col) != "manual":
        return "当前列排序方案非手动，不可拖排"
    cards = [r for r in db.list_board_cards(project_id) if r["column_key"] == col]
    try:
        plan = reorder_plan(cards, card_id, before_id)
    except ValueError as e:
        return str(e)
    with db.connect() as conn:
        # plan 元组为 (card_id, sort_order)，SQL 占位符顺序为 (sort_order, id)，
        # 此处换位绑定（brief 原文直绑会把两列互换导致整列错序/空写）
        conn.executemany("UPDATE board_cards SET sort_order=? WHERE id=?",
                         [(s, c) for c, s in plan])
    return None


def _reorder_doing_card(project_id, card, before_id):
    """doing 列调序（v2c T2，裁决 R11）：改写 wait_items 队序（waiting 行间
    重排，waitq.reposition 仅 UPDATE seq、行 id 稳定；sort_order 不动）。

    运行位行（starting/running/finishing）与非队列卡（sync 外部卡/idle/
    answer 占位）不参与：no-op 返回成功——force/停止手势归 move_card 的
    _doing_gesture（T1），本路径只做等待区调序；现行前端 manual 拖排对运行
    卡同样只发 reorder，no-op 后展示层随 payload 队序回正、不刷错误。
    before_id=None=等待区区尾；before_id 指向运行位卡/非队列卡时收拢到
    等待区最前（「排到最前」语义）；before_id 卡须同项目同列非回收站，
    否则错误（server 转 400，文案与 reorder_plan 一致）。"""
    if before_id is not None:
        try:
            before_id = int(before_id)
        except (TypeError, ValueError):
            return "目标位置卡不在该列"
        if before_id == card["id"]:
            return None                     # 自己压自己=no-op（与手势同口径防御）
        before_card = db.get_board_card(before_id)
        if before_card is None or before_card["trashed"] \
                or before_card["project_id"] != project_id \
                or before_card["column_key"] != "doing":
            return "目标位置卡不在该列"
        before_row = waitq.get_active(waitq.KIND_CARD, before_id)
    else:
        before_row = None
    drag_row = waitq.get_active(waitq.KIND_CARD, card["id"])
    if drag_row is None or drag_row["state"] != waitq.WAITING:
        return None                         # 运行位行/非队列卡不参与调序：no-op
    if before_row is not None and before_row["state"] == waitq.WAITING:
        next_seq = before_row["seq"]        # 落点=该等待卡之前
    elif before_id is None:
        next_seq = None                     # 列尾=等待区区尾
    else:
        # 落点收拢等待区最前：before 运行位/非队列卡 → 排到等待区首
        next_seq = None
        for r in waitq.active_items(project_id):
            if r["kind"] == waitq.KIND_CARD and r["state"] == waitq.WAITING \
                    and r["id"] != drag_row["id"]:
                next_seq = r["seq"]         # active_items seq 升序：首行即区首
                break
        if next_seq is None:
            return None                     # 等待区仅自身：无位可挪
    prev_seq = _drop_prev_seq(project_id, next_seq, drag_row["id"])
    if prev_seq is None and next_seq is None:
        return None                         # 队列仅自身（防御，同手势口径）
    try:
        waitq.reposition(drag_row["id"], prev_seq, next_seq)
    except ValueError:
        return "调序落点非法"
    return None


# ---------- 外部条目 ext 行（外部直跑会话的队列成员，v2d T4，裁决 R13/R15） ----------
# 用户在 dsh GUI 直接开始（或接管）的会话不受平台控制（无法
# stop/排队），但平台起的任务/卡片是可控的：外部会话在跑时，统一队列的拾起判据
# 须把它视作占着项目运行位（方向②「外部在跑时平台单元排队等它结束」，2026-09-07
# 语义修订不变）。v2 模型（设计 §2.2/§2.5.2-5）：外部会话以 **wait_items
# kind=ext 行**入场——target=卡 id、meta 带 sid、入场即 running（不由平台启动）
# 入运行前缀（复数并存，位次计入），结束/消失经唯一收尾点 `finish("ext:<卡 id>")`
# 落终态并触发补位（时机③）。原 `_SYNC_BUSY` 内存集合（「有 doing+sync 卡实况
# busy 的项目」）随行即成员退场；v3d（R8）起**探针口径亦退役**（无注册面、无
# runner 锁内回调），语义以行判据保留：
#   ① 调度侧 `_pick_locked` **项目外部条目闸**：该项目存在活跃 `ext:` 行 ⇒
#      本项目本轮不补位（与窗口 N 无关，parallel 亦留队）——判据直接来自行；
#   ② `unit_busy` 同口径（窗口已满 ∨ 存在活跃 ext 行）——提交时「会不会排队」
#      与调度结论一致；
#   ③ `_pick_locked` 对 `a:` 单元折抵 ext: 键（P2 R1 逐字保留；行口径等价承接）。
# 探测对象=项目活跃会话集合（设计 §2.5.2-5）：单族化后只有 dsh_plugin——读
# `dshevents` 的进程内快照（**零请求**，见 `_ext_candidates`）。退场族无精确
# busy 信号不建 ext 行；挂起（interaction）
# 的会话不算占位（挂起即出队，队列继续执行下一个）。
# 建行对象=「无平台持有者（活跃 c: 行/在管条目）的实况 busy 会话卡」——sync 卡
# 天然无持有者，平台卡被用户 dsh GUI 接管（v2d T2 裸 busy
# 收尾后的窗口，I1 硬移交）同样成占位源：项目不再看着空闲、队列不在同项目并发
# 起单元；平台持有者在场则不建行（同一卡的前缀 ext:/c: 键双计结构性消除）。
# 残留窗口（旧探针同源，v3d 明示、设计已接受）：外部会话刚起、调和器节拍
# 尚未建 ext 行时，补位器可能放进一个平台单元与外部会话并发——dsh 侧调和器
# 已事件化（`_iw_once` 由状态帧唤醒、60s 兜底对账），窗口收窄到事件延迟级
# （spec/board《看板增强》）。
# （`_ext_refresh` 的入队/恢复前同步刷新把这一窗口再收窄到外部会话已知的路径）。


def ext_active(project_id):
    """项目是否有活跃 ext 行（=外部会话在跑，行读口）：展示派生（queue_state 的
    foreign_busy 判定）与 `runner.unit_busy` 的 ext 分量共用；调度侧的项目外部
    条目闸在 `runner._pick_locked` 内直接读行集（同一判据的批量化）。"""
    return waitq.active_ext(project_id)


def _platform_holds(card_id):
    """平台是否持有该卡单元（本卡有活跃 c: 行或在管条目）——ext 行与平台单元
    互斥判据：同一卡不得既被平台启动（活跃 c: 行占位）又有外部直跑行（前缀会
    双计「c:<id>」与「ext:<id>」两个键；外部条目不建 c: 行，只能由本闸互斥）。
    第二消费面：手势运行位判据 `_gesture_run_position`（收口轮 C1）复用本函数
    ——正常起跑稳态卡的持有面即「活跃 c: 行 ∨ 在管条目」（`_card_unit_active`
    即既有行判据，不另造第二份；判据读失败按未持有，不阻断建行自愈）。"""
    if _has_active_run(card_id):
        return True
    return _card_unit_active(card_id)


def _ext_target(row):
    """ext 行 target（卡 id 字符串，`finish("ext:<target>")` 键同源）。"""
    return str(row["target_id"])


def upsert_ext(project, card_id, sid):
    """外部直跑会话 → ext 行（幂等；v2 §2.2 插入规则表「外部直跑」+ 裁决 R13）。

    入场即 running 落「运行前缀尾」（insert_after_prefix 几何）、复数并存；
    已有活跃行/Meta sid 缺失/平台持有者在场 → 不建行返回 False。
    返回是否新建（调用方据变化唤醒补位；外部条目插入后前缀多为已占=不启动，
    时机① 的检查照常）。"""
    if not sid or _platform_holds(card_id):
        return False
    if waitq.get_active(waitq.KIND_EXT, card_id) is not None:
        return False
    waitq.insert_ext(project["id"], card_id, sid)
    return True


def _ext_stale_finish(project_id, desired, hold):
    """项目活跃 ext 行对账：不在目标集（实况已不 busy/卡已非占位源）且非探测
    不明（hold 保行）者经唯一收尾点 finish 收口。返回是否有行被收口。"""
    changed = False
    for row in waitq.active_ext_items(project_id):
        target = _ext_target(row)
        try:
            cid = int(target)
        except ValueError:
            cid = None                      # 脏 target（理论项）：不能建收尾键，跳过
        if cid is not None and (cid in desired or cid in hold):
            continue
        if finish(f"ext:{target}", "外部会话结束"):
            changed = True
    return changed


def _finish_all_ext(project_id, reason):
    """项目内全部活跃 ext 行收口（退场族/项目已删的防御清理，返回值同
    `_ext_stale_finish`）——退场族无 busy 信号、外部条目不可能有实况佐证，
    残留行留着会永久占前缀位次堵死项目。"""
    changed = False
    for row in waitq.active_ext_items(project_id):
        if finish(f"ext:{_ext_target(row)}", reason):
            changed = True
    return changed


def _session_card_map(cards):
    """{sid: 卡片 row} 反查（卡片 sessions 并集 + 主会话；绑定口径与
    sync_sessions 的 bound 映射一致——外部条目对账与建卡投影看到同一张卡）。"""
    bound = {}
    for c in cards:
        for s in json.loads(c["sessions"] or "[]"):
            bound[s] = c
        if c["session_id"]:
            bound[c["session_id"]] = c
    return bound


def _subagent_session(sid, origin=None):
    """该会话是否 dsh **子代理会话**（占用豁免判据，2026-10-07）。

    子代理是主会话的实现细节：它不构成项目外部占用（不建 ext 行、也不触发补投影）——
    否则「一次派 8 个子代理」＝项目被占满、排队单元永不补位（实障：卡 870 排队
    5 小时，成因即两条子代理会话的 ext 行）。

    `origin` 显式传入时用调用方手上的值（`_ext_candidates` 已在快照行里）；
    未传/为空＝未知（旧插件未上报）→ 回落 `sessparse.is_subagent` 的会话头读口
    （磁盘，按 stamp 缓存）。两处都判不了＝False（按主会话处理：占用判定宁可多等，
    不可误放行，与「断连=未知」同向）。
    """
    val = origin
    if val is None:
        try:
            val = (dshevents.get(sid) or {}).get("origin") or ""
        except Exception:
            val = ""
    if str(val or "") == "subagent":
        return True
    if str(val or ""):
        return False                     # 明确上报了别的 origin（主会话）
    try:
        return sessparse.is_subagent("dsh", sid)
    except Exception:
        return False


def _ext_candidates(project, cards):
    """项目活跃会话集合 → 占位目标/探测不明卡集（探测对象改造核，R15）。

    候选=有会话且非终态列（todo/done）、非挂起 interaction 的卡（与调和器探测
    面同域）；平台持有者在场剔除（不能既是平台单元又是外部条目）。返回
    (desired, hold, unbound, unknown)：
    - desired：{card_id: sid} 实况 busy（单族：读 `dshevents` 快照）；
    - hold：探测不明的卡——保留既有行（宁可多等不可误放行，调用方按「未知」
      保行；dsh 分支探测失败直接抛错，不产 hold）；
    - unbound：实况 busy 但尚无卡的 sid（调用方按需补一次 sync_sessions 投影）；
    - unknown：不可结论的 sid 集合（调用方判「本轮探测是否已查清」）。
    fam 为 None（退场族）返回空集——调用方按 `_finish_all_ext` 防御收口。
    探测域收窄（2026-09-27，kimi 逐 sid 探测时代的产物，dsh 一次快照即全量）：
    只探「绑候选卡 + 未绑卡」会话——绑在 todo/done/挂起 interaction 卡上的
    会话，busy 进不了 desired 也进不了 hold、又不在未绑卡判定面（bound 在册），
    探测结果不影响任何输出。终态列卡的存量 ext 行不再被「探不明」无限保留，
    `_ext_stale_finish` 可正常收口（终态列卡本就不在可建行域，行属残留）。
    """
    fam = _web_family(project)
    if fam is None:
        return {}, set(), set(), set()
    cards = [c for c in cards if c["session_id"]]
    bound = _session_card_map(cards)
    # 占用候选（可建行）域：非终态列、非挂起 interaction（挂起即出队，豁免面②）；
    # 会话→卡反查用全量卡（未绑卡判据不受候选域影响——绑在 todo/done 的会话
    # 不算「未建卡」，不触发投影）
    cand = {c["id"] for c in cards
            if c["column_key"] not in ("todo", "done")
            and not (c["column_key"] == "blocked"
                     and c["block_kind"] == "interaction")}
    desired, hold, unbound, unknown = {}, set(), set(), set()
    # 单族化后 fam 恒为 "dsh_plugin"（P7b：kimi/opencode 两族 web 驱动已退场）。
    # 路线 A P4（2026-10-03）：读 EventHub 快照（**零请求**）——原实现每轮一次
    # `/live`。P1 打通时这条分支是 dsh「外部直跑占用（ext 行）」的探测口
    # （此前掉进 opencode 分支必然失败，方案 §2.1 #16）；事件化后由
    # `agent/status`/`turn/*` 帧实时维护，调和器被事件唤醒时才读本地表。
    # 未连接 ⇒ 抛错，让调用方 `_ext_refresh` 按「探测不可用」返回 None（保既有
    # 行；宁可多等不可误放行）——绝不把未知当空闲。
    if not dshevents.connected():
        raise dshdriver.DshDriverError(-2, "状态事件中枢未连接（未知：保留既有行）")
    rows = list(dshevents.snapshot().values())
    pdir = os.path.abspath(project["project_dir"] or "")
    for r in rows:
        sid = str(r.get("session_id") or "")
        if not sid or r.get("status") != "running":
            continue                         # 空闲/未知不构成占用
        # 子代理会话不是外部占用（2026-10-07）：既不建行，也不进 unbound 触发投影
        # （它本就不该有卡；旧插件未上报 origin 时回落会话头判定，见 _subagent_session）
        if _subagent_session(sid, r.get("origin")):
            continue
        # 只认本项目工作目录下的会话：dsh 会话池是宿主全局的，跨项目的在跑
        # 会话不能算到本项目头上（ext 行按项目工作目录归属）
        if os.path.abspath(str(r.get("cwd") or "")) != pdir:
            continue
        c = bound.get(sid)
        if c is None:
            unbound.add(sid)                 # 在跑但平台无卡：调用方补投影后再反查
        elif c["id"] in cand and not _platform_holds(c["id"]):
            desired[c["id"]] = sid
    return desired, hold, unbound, unknown


def _ext_refresh(project):
    """入队/恢复前同步刷新 ext 行（裁决 R13/R15；闭合「外部会话刚起、调和器尚未
    巡到」的窗口——原 `_sync_busy_refresh` 的同步职责移交本路径）。

    按项目活跃会话集合精确对账：busy 会话建/保持行（在跑但尚无卡的会话先补一次
    sync_sessions 投影再落行）、实况空闲的行收口。返回 ext 行集合是否变化
    （True/False）；探测不可用（事件中枢未连接/会话枚举失败）返回 None=未改动
    （宁可多等不可误放行，旧口径逐字保留）。退场族无 busy 信号：不建行、
    在场残留行防御收口（豁免面③）。
    """
    fam = _web_family(project)
    if fam is None:
        return _finish_all_ext(project["id"], "退场族无外部占用信号")
    try:
        desired, hold, unbound, unknown = _ext_candidates(
            project, db.list_board_cards(project["id"]))
        if unbound:
            # 实况在跑但尚无卡的会话：补一次 30s 投影（sync_sessions 幂等）再反查，
            # 否则「会话已在跑、平台不知情」窗口照旧（R15 改探测对象的初衷）
            sync_sessions(project)
            desired, hold, unbound, unknown = _ext_candidates(
                project, db.list_board_cards(project["id"]))
    except Exception:
        return None
    if unknown and not desired:
        return None                         # 探测不明且无确证 busy：本轮不动（保旧值）
    changed = _ext_stale_finish(project["id"], desired, hold)
    for cid, sid in desired.items():
        if upsert_ext(project, cid, sid):
            changed = True
    return changed


def _recover_ext_rows(queued=()):
    """服务重启时的 ext 行映射（v2 §5 第 4 条；recover 尾部调用）：

    刷新面=**有活跃 ext 行的项目 ∪ 有排队卡的项目**（v2d 收口轮评审项 2：对齐
    旧 `_sync_busy_refresh` 的调用面——平台停机期间外部会话起跑时行尚未落表，
    只按「有行的项目」刷新会让排队卡所在项目在重启后照旧并发起单元）。
    逐项目按活跃会话集合重新精确对账（`_ext_refresh`）——实况仍在 → 行保持
    running（外部会话不受平台重启影响、占位不丢）；实况空闲 → finish 收口让出
    前缀位次；项目已删 → 全部行收口；探测不可用（None）→ 行保留（宁可多等）。
    queued：本机排队卡行清单（recover 已算出，复用免二次查询）。
    返回是否有行变化（调用方据变化唤醒补位）。"""
    changed = False
    pids = {row["project_id"] for row in waitq.active_ext_items()}
    pids |= {c["project_id"] for c in (queued or ())}
    for pid in pids:
        proj = db.get_project(pid)
        if proj is None:
            if _finish_all_ext(pid, "服务重启外部条目对账"):
                changed = True
            continue
        if _ext_refresh(proj):
            changed = True
    return changed


def refresh_ext_rows(reason="外部条目周期对账"):
    """按项目活跃 ext 行的实况对账刷新（周期自检 / 启动补跑共用入口）。

    对「有活跃 ext 行的项目」逐个跑 `_ext_refresh`（快照口径：中枢在线时以对齐过的
    注册表为准——不在场即收口；未连接时返回 None＝保行，绝不把未知当空闲）。有行
    变化即唤醒补位（前缀成员变化，时机③），无变化不空唤醒。返回是否有行变化。

    与 `_recover_ext_rows` 的分工（2026-10-07 实障修复）：那个是**重启恢复**专用
    （刷新面=有行项目 ∪ 有排队卡项目），执行点在 server 启动序里 `dshevents.start()`
    之前 ⇒ 探测必然不可用、一律保行；本函数是**运行期兜底与启动补跑**——调和器的
    逐卡探测（`_iw_once`）修好「在线但会话不在池」的口径后已能自动收口，本入口
    覆盖「调和器未跑到/被 hold 语义挡住」的漏网行，也用于中枢首连后的启动补跑。

    项目已删（行残留）走 `_finish_all_ext` 防御收口（同 recover 口径）。"""
    changed = False
    for pid in {row["project_id"] for row in waitq.active_ext_items()}:
        proj = db.get_project(pid)
        if proj is None:
            if _finish_all_ext(pid, reason):
                changed = True
            continue
        if _ext_refresh(proj):
            changed = True
    if changed and runner.INSTANCE is not None:
        runner.INSTANCE.notify_busy_change()   # 前缀成员变化：唤醒排队单元重新挑选
    return changed


# 启动补跑等中枢首连的上限（秒）：dsh 宿主同机，正常对齐是毫秒级；给足抖动余量
EXT_RECOVER_WAIT_SECONDS = 30.0


def start_ext_recover_after_connect(timeout=EXT_RECOVER_WAIT_SECONDS):
    """启动补跑线程：等中枢首连就绪后跑一次 ext 行对账（2026-10-07 实障修复）。

    `board.recover()` 尾部的 `_recover_ext_rows` 执行在 server 启动序里
    `dshevents.start()` **之前**（顺序硬约束不变）⇒ 那时探测必然「不可用」、按
    「宁可多等」一律保行——上一进程留下的僵尸 ext 行（会话早已结束、行仍
    running）会继续占位，**重启也救不回来**（实障：卡 870 排队 5 小时、项目 119
    积 10 条僵尸行堵死调度）。本函数由 server 在 `dshevents.start()` 之后调用：
    后台线程等首连（上限 timeout，不阻塞启动与端口绑定），就绪即跑一次
    `refresh_ext_rows`（快照口径收口僵尸行 + 唤醒补位）。

    未配置驱动（独立形态）/超时未就绪：直接结束——行保原样，等调和器与自检
    线程接手（它们的收口口径同样不把未知当空闲）。返回线程对象供测试 join。
    """
    def _run():
        try:
            if not dshevents.wait_connected(timeout):
                return                          # 未就绪：保行，交给运行期兜底
            refresh_ext_rows("启动补跑")
        except Exception as e:                  # noqa: BLE001 — 守护线程不 crash
            print(f"[board] 启动补跑 ext 行对账异常: {e}", flush=True)

    th = threading.Thread(target=_run, daemon=True, name="board-ext-recover")
    th.start()
    return th


def _enter_doing(project, card, extra="", force=False, worktree=False,
                 queue_worktree=False):
    """进 doing 统一入口（start 端点 / 拖入 doing / 定时开工共用）。

    force=true：跳过父依赖与排队直接起会话（用户自担风险），reason 标签按实参分
    「force 直起」/「serial 直起」；v2b T4 起 force 同时**落表**
    （裁决 R12；v2 §2.2 规则二：强制启动→开始运行→放到队列前面）——
    insert_card_force_start 单事务插前缀尾+直入 starting，起跑证实把行置 running
    （v3a：card_started→enter_running 统一入口）留队构成运行前缀（位次计入），
    终态化归 card_finished；
    起跑失败行 failed + 回 from_column（dequeue_start 同款收口）；
    runner 单例缺位：不入队直接起（脱离 server 调试退化）；
    其余一律入 runner 统一队列（v2b T2 起 parallel 空闲直起废除，裁决 R9/R5——
    serial/parallel 均走补位窗口 serial N=1 / parallel N=5）：父依赖拦截返回
    {"blocked": "parent-not-done"}（review 卡打回续改放行，现语义），否则入队——
    入队落点分流（R9）：from_column ∈ ("review","blocked")（续跑/手动恢复）经
    原子变体 waitq.insert_card_after_prefix 插「运行前缀后」=等待区最前；
    from_column == "todo"（新建首次起跑）经 waitq.enqueue_card 落等待区末尾
    （现行语义不变）。两入口均单事务写等待项+doing/queue 排队占位（v2a 终审
    契约原子红线）；extra/from_column 随 meta 持久化，dequeue_start 消费，
    重启不再丢。
    外部占用（外部条目 ext 行）不经入队判定参与——一律入队后由补位器按
    「前缀成员（ext 行即成员）+ 探针（项目活跃 ext 行在场）」在拾起侧留队；
    入队前的 `_ext_refresh` 同步刷新保留（闭合「外部会话刚起、调和器尚未巡到」
    竞态窗口，v2d T4 由原 `_sync_busy_refresh` 职责移交）。用户在 dsh GUI
    直接开始的外部会话（sync 卡）不受平台控制，不持队列占用；其会话实况 busy
    以 ext 行参与 runner 拾起判据（外部在跑时平台单元等它结束；挂起 interaction
    态除外——挂起即出队）。
    退场族防呆（P7b 单族化，B0 遗留项）：`_web_family` 为 None（kimi/opencode/
    claude/hermes/deepseek 旧 CLI 与旧 web 前缀项目）时**不落任何起会话路径**，
    直接返回 {"error": agents.RETIRED_MSG}（server 端点按既有硬错误分支透出
    400 JSON；起会话只有 dsh 插件一条路）。
    锁内只做判定与落列，起会话在锁外（dsh 建会话/投递为 REST 往返，持锁会
    阻塞全平台门禁）。返回 (card_dict, None) | (None, err_dict)。

    独立 worktree 模式（2026-10-06 批次，plan D1/D3/D10）：`worktree=True` 或卡片
    已带 worktree 标记时**本条起跑路径整体转交 `_enter_doing_worktree`**——那条路
    不写 `wait_items` 行（不占项目运行位、不阻塞同项目其他单元），语义与失败收口
    见该函数 docstring；本函数其余分支保持原样（排队/force 直起一字未动）。

    例外（2026-10-07 批次）：`queue_worktree=True` 时**不转交**，worktree 卡照常走
    统一队列。唯一调用方是 `handoff_worktree_merge`（把合并任务交给 agent）——合并
    要动主仓库工作区，必须与项目内其他单元串行，免排队语义在这里有害。
    """
    if _web_family(project) is None:
        # 退场族防呆（见 docstring）：不建行、不入队、不动列——直接明确报错
        return None, {"error": agents.RETIRED_MSG}
    # 归档同步（2026-10-05）：从「已完成」起跑（拖入开发列 / start 端点同经本入口）
    # 先取消归档——dsh 的 ArchivedSessionGate 会拒绝已归档会话跑模型步，不先解开
    # 续跑起不来。失败即整体放弃（列不动）并 400 报错；本入口是「离开已完成→doing」
    # 的单一写点，move_card 对该目标不再重复调用（一次移列一次调用）。
    if card["column_key"] == "done":
        err = _archive_card_sessions(card, False, "离开已完成")
        if err:
            return None, {"error": err}
    # 独立 worktree 模式（2026-10-06 批次，见 plan D1/D3/D10）：用户在下拉里选
    # 「在新 worktree 中开始」（worktree=True），或该卡此前已被标记为 worktree 卡
    # （card.worktree 非空 ⇒ 打回续改/重试/再进开发列自动复用同一工作树）——
    # 一律交给 `_enter_doing_worktree`：起跑但不入统一队列（不写 wait_items 行）。
    # queue_worktree=True（合并回交，2026-10-07）是唯一例外：走下面的排队路径，
    # 合并要动主仓库工作区，必须与项目内其他单元串行。
    if not queue_worktree and (worktree or (_card_opt(card, "worktree") or "").strip()):
        return _enter_doing_worktree(project, card, extra, force=force,
                                     want=bool(worktree))
    if card["column_key"] == "doing" \
            and card["block_kind"] == "queue" and not force:
        # 幂等：已在队列（P4 单态：占位仅 doing+queue，存量 blocked+queue 由启动
        # 迁移归位）。防御性补一次入队（submit_card 自身幂等不重复；行已在则
        # enqueue_card 幂等复用），用户重按开始即可自愈
        if runner.INSTANCE is not None:
            runner.INSTANCE.submit_card(card["id"])
        return card_json(card), None
    # 在管单元预检（v2d T3，裁决 R6）：活跃 c: 行（starting/running）或在管会话
    # 条目在途 = 该卡单元已在跑/在起跑窗口——按「会话运行中」拦下。原口径由
    # start_card 的 `_rec_active` 承担（只在起跑调用时才拦，且运行中的卡会被
    # 先入队留下一枚排队占位残影）；starting 态显式承担后前移到入口。仅入口面
    # 检查：worker 拾取起跑（dequeue_start）与 force 落表不经过本函数此支。
    if _card_unit_active(card["id"]) or _session_in_flight(card["id"]):
        cur = db.get_board_card(card["id"])
        if cur is None:
            return None, {"error": "卡片不存在"}   # 并发删卡竞态守卫（v2d T4）
        return card_json(cur), {"error": "会话运行中，请等待完成或先停止"}
    # 排队判定（v2b T2 起一律入队，裁决 R9/R5）：serial/parallel 均入队走
    # 补位窗口（parallel 空闲直起废除）；外部占用不再经本判定参与（拾起侧
    # 补位器探针留队，v2d T4 切 ext 行口径）。runner 单例缺位=调试退化直起。
    want_queue = runner.INSTANCE is not None
    force_row_id = None   # force 落表行（v2b T4，R12；失败收口/成功证实用）
    with _gate_lock:
        if not force and card["column_key"] != "review":
            parent_id = card["parent_card_id"]
            if parent_id:
                parent = db.get_board_card(parent_id)
                if parent is not None and parent["column_key"] != "done":
                    return None, {"blocked": "parent-not-done"}
        if not force and want_queue:
            # 落列与入队统一走锁外 waitq.enqueue_card 单事务（R6）；锁内判定/
            # 父依赖门禁不变。排队占位落「正在开发」列（2026-09-06 设计：排队卡
            # 进开发列显示「排队中」徽标，轮到才真正起会话）
            queued = True
        else:
            # 直起（force / runner 缺位退化；v2b T2 起 parallel 直起废除）：先把
            # 可能残留的排队态清干净
            # 再落 doing——卡片可能正挂在 runner 统一队列里等拾起（serial 入队后用户
            # force，或 recover 重建入队），不清则 worker 随后拾起与本次直起对撞
            # （P4 单写：行+占位原子取消；无条件不 gate INSTANCE——表存在即须清，
            # 行不在/占位已改则守卫 no-op）
            waitq.cancel_card_wait(card["id"], "force 直起")
            if force and runner.INSTANCE is not None:
                # force 落表（v2b T4，裁决 R12；v2 §2.2 规则二：强制启动→开始
                # 运行→放到队列前面）：插入前缀尾（最后一个运行中条目之后）+
                # 直入 starting（单事务 out-of-band，不经 worker 拾取）——
                # 起跑证实转 running 留队构成运行前缀（位次计入），终态化归
                # card_finished（会话结束收口）；meta 带 extra/from_column
                # （与队列 c: 行同型，审计/收口线索）
                force_row_id, _ = waitq.insert_card_force_start(
                    card["id"], project["id"],
                    meta={"extra": str(extra or ""),
                          "from_column": card["column_key"]})
            fields = {"column_key": "doing", "block_kind": None, "block_text": "",
                      "last_error": ""}  # 落 doing 清陈旧错误（对齐旧 start_into_doing）
            if card["column_key"] == "todo":
                fields["scheduled_at"] = None  # 离开待开发清定时
            # 用户本人点「开始/强制」（或 runner 缺位退化直起）引起的落列：
            # 不置「有更新」标记（排队路径经 waitq 落列，同样不置）
            db.update_board_card(card["id"], mark_unread=False, **fields)
            queued = False
    if queued:
        # 入队前同步刷新一次外部条目探测（ext 行对账，worker 拾起经
        # _pick_locked 的「前缀成员 + 探针」两道读取）：闭合「外部会话刚起、
        # 调和器尚未巡到」的竞态窗口。探测不可用返回 None=未改动（宁可多等
        # 不可误放行）；有变化时唤醒补位（时机①）。
        res = _ext_refresh(project)
        if res and runner.INSTANCE is not None:
            runner.INSTANCE.notify_busy_change()
        # 入队落点分流（v2b T2，R9）：续跑/手动恢复（review/blocked）插
        # 「运行前缀后」=等待区最前；todo 首次起跑落等待区末尾。行+占位在
        # waitq 单事务内写（此刻卡片行未改列，from_column 取到排队前列——
        # 起跑失败回该列，R7）
        runner.INSTANCE.submit_card(
            card["id"], extra=extra,
            after_prefix=card["column_key"] in ("review", "blocked"))
        return card_json(db.get_board_card(card["id"])), None
    try:
        start_card(project, db.get_board_card(card["id"]), extra)
    except RuntimeError as e:
        # 与 runner 队列拾起（dequeue_start）对撞落败：对方已起跑成功（_RUNS 有活
        # 条目），放弃回滚、按当前态返回——否则会把对方落好的 doing 踩回原列
        # （胜者会话照跑，结束后 _finish_run 因列非 doing 跳过 review 流转，卡片滞留）
        rival_running = _session_in_flight(card["id"])
        if rival_running:
            if force_row_id is not None:
                # 对撞落败：force 落表行收口（对方已起跑，本行不再启动）
                waitq.mark_failed(force_row_id, "起跑对撞落败")
            return card_json(db.get_board_card(card["id"])), None
        # 起会话失败：回滚原列按硬错误返回（last_error 已由 start_card 记录；
        # runner 占用尚未登记，此路径不得调 finish 释放）
        if force_row_id is not None:
            # force 落表行同款收口（dequeue_start 起跑失败：行 failed + 回
            # from_column——上方回滚写即 from_column；不留 starting 泄漏行
            # 占前缀，用户重按开始/重 force 重新落行）
            waitq.mark_failed(force_row_id, str(e))
        # 回滚同样是用户这次「开始」的收场（错误串已由 400 回执给前端），不置标记
        db.update_board_card(card["id"], mark_unread=False,
                             column_key=card["column_key"],
                             block_kind=card["block_kind"],
                             block_text=card["block_text"] or "")
        return None, {"error": str(e)}
    # 直起路径（force / runner 缺位退化）落表占住运行位（v3d 去占用后无第二登记：
    # 行即占位），reason 按实参分标签：
    # force 真参 →「force 直起」，serial 非 force（缺位退化）→「serial 直起」。
    # v2b T2 起 parallel 一律入队（免登记直起段废除）；dequeue_start 队列拾起
    # 路径不受影响照常落行。
    if runner.INSTANCE is not None:
        ext = {"reason": "force 直起" if force else "serial 直起"}
        if force_row_id is not None:
            # CLI 判据（R11④，与 worker 起跑 _process_card 同款）：有 proc 补
            # pid 进行 evidence——force 落表行+行证据同证，重启对账才能裁活
            # （否则 force 起跑无证据判 unknown 残留占前缀）
            pid = run_pid(card["id"])
            if pid:
                ext["pid"] = pid
        # 六条起跑路径统一：card_started 内部把行置 running（force 落表行
        # 由 enter_running 幂等续持为 running，不再在此单独 mark_running——
        # 统一入口才能覆盖「无活跃行/终态行」的 force 与送达恢复形态）；
        # 行跨轮存活、终态化归 card_finished（会话结束收口，R12）
        runner.INSTANCE.card_started(card["id"], project["id"], ext=ext)
    return card_json(db.get_board_card(card["id"])), None


def start_into_doing(project, card, extra="", force=False, worktree=False,
                     queue_worktree=False):
    """start 端点专用：语义全部由 _enter_doing 承载（保留函数名，server 调用点不动）。

    worktree=True = 用户在下拉里选「🌿 在新 worktree 中开始」（2026-10-06 批次）。
    queue_worktree=True = worktree 卡也走统一队列（合并回交，2026-10-07 批次）。
    """
    return _enter_doing(project, card, extra, force, worktree, queue_worktree)


# ---------- 独立 worktree 卡起跑（2026-10-06 批次） ----------

# worktree 卡起跑窗口防重入集合（进程内）：这条路径的「worktree 创建 + 建会话」
# 合计可达数秒，其间既没有 c: 行（`_card_unit_active` 查不到）也还没登记 `_RUNS`
# （`_session_in_flight` 查不到），连点会起两个会话、第二个还会覆盖卡片 worktree
# 语义。集合只作起跑窗口互斥，卡 id 进入即登记、finally 必清；超限粗粒度清理
# （与 `_STOP_STAMP` 同款「重报无罪」策略，量小且短命）。
_WT_STARTING = set()
_WT_STARTING_LOCK = threading.Lock()


def _wt_start_begin(card_id):
    """登记 worktree 起跑窗口；已在窗口内返回 False（本次请求让位）。"""
    with _WT_STARTING_LOCK:
        if card_id in _WT_STARTING:
            return False
        if len(_WT_STARTING) > 256:
            _WT_STARTING.clear()
        _WT_STARTING.add(card_id)
        return True


def _wt_start_end(card_id):
    """释放 worktree 起跑窗口（finally 调用，幂等）。"""
    with _WT_STARTING_LOCK:
        _WT_STARTING.discard(card_id)


def _enter_doing_worktree(project, card, extra="", force=False, want=False):
    """独立 worktree 起跑（plan D1/D3/D10；**不经统一队列**）。

    与 `_enter_doing` 的队列/force 分支并列的第二条起跑路径：
    - `want=True`（用户点了「在新 worktree 中开始」）：要求卡片**尚无主会话**
      （D10——dsh 的 resume 不传 cwd，已有会话再按 worktree cwd 续接会造成
      「平台以为在 worktree、agent 实际仍在主仓库」的静默背离），先 `worktree.create`
      建/复用工作树，失败按硬错误 400 返回（卡片列不动）；
    - 卡片已带 `card.worktree` 标记（打回续改/重试/再进开发列）：直接复用原工作树，
      不重复创建——worktree 模式随卡片持久化（D3）。

    落列与起会话：`db.update_board_card(column_key='doing', block_kind=None,
    worktree=<路径>)`（**不写 wait_items 行、不调 submit_card/insert_card_force_start**）
    → 锁外 `start_card`（会话 cwd 经 `card_workspace` 取 worktree 路径）。
    「不落行」的可行性依据（plan §2.2 逐条复核）：`_platform_holds` 认 `_RUNS`
    条目 ⇒ 调和器不会给该卡建 ext 行（不会触发「ext 在场 ⇒ 项目不补位」）；
    `finish()` 无活跃行时跳过行收口、仍搬列 ⇒ 会话结束照常落「待审核」；
    `selfcheck()` ③ 只报反向形态（卡不在 doing 列却有活跃行）；补位器只遍历
    活跃行 ⇒ 该卡既不排队也不占运行位。副作用：该卡不出现在位次/占用明细读口
    （`project_holder_details`），与「不进队列」语义一致。

    父依赖门禁与 `_enter_doing` 同口径（worktree 不豁免依赖，只豁免排队）；
    force 语义沿用（跳过父依赖）。起会话失败：回原列 + `last_error`（既有语义），
    `card.worktree` 标记保留（路径已建，重按开始即复用，不留无主工作树）。
    返回 (card_dict, None) | (None, err_dict)，与 `_enter_doing` 一致。
    """
    card_id = card["id"]
    card_wt = (_card_opt(card, "worktree") or "").strip()
    if want and not card_wt and (card["session_id"] or "").strip():
        # D10：已有主会话（当初在 project_dir 起的）不允许切 worktree 模式
        return None, {"error": "该卡片已有主会话，无法切换到独立 worktree（请新建卡片）"}
    # 在管预检（同 `_enter_doing`）+ 起跑窗口互斥（本路径独有，见 _WT_STARTING 注释）
    if _card_unit_active(card_id) or _session_in_flight(card_id) \
            or not _wt_start_begin(card_id):
        cur = db.get_board_card(card_id)
        if cur is None:
            return None, {"error": "卡片不存在"}
        return card_json(cur), {"error": "会话运行中，请等待完成或先停止"}
    try:
        with _gate_lock:
            # 父依赖门禁：与排队路径同口径（worktree 只免排队，不免依赖）
            if not force and card["column_key"] != "review" and not card_wt:
                parent_id = card["parent_card_id"]
                if parent_id:
                    parent = db.get_board_card(parent_id)
                    if parent is not None and parent["column_key"] != "done":
                        return None, {"blocked": "parent-not-done"}
        # worktree 创建/复用是慢操作（git 子进程，可能数秒），必须在锁外做
        path, branch, err = worktree.create(project, card_id)
        if err:
            return None, {"error": err}
        with _gate_lock:
            # 锁外创建期间可能有并发起跑（普通入队被 worker 拾起 / force 直起）：
            # 复检一次，让位给已经在管的那条路，避免双会话
            if _session_in_flight(card_id):
                cur = db.get_board_card(card_id)
                if cur is None:
                    return None, {"error": "卡片不存在"}
                return card_json(cur), None
            # 清可能残留的排队态（用户先点了「开始（入队）」又选 worktree 开始；
            # 或 recover 重建时入过队）——行+占位单事务取消，防 worker 随后拾起对撞
            waitq.cancel_card_wait(card_id, "worktree 直起")
            fields = {"column_key": "doing", "block_kind": None, "block_text": "",
                      "last_error": "", "worktree": path}
            if card["column_key"] == "todo":
                fields["scheduled_at"] = None      # 离开待开发清定时（对齐排队路径）
            # 用户本人下拉点「在新 worktree 中开始」引起的落列：不置「有更新」标记
            db.update_board_card(card_id, mark_unread=False, **fields)
        try:
            log_path = start_card(project, db.get_board_card(card_id), extra)
        except RuntimeError as e:
            # 与并发起跑对撞落败：对方已起跑成功，不动列、直接按当前态返回
            if _session_in_flight(card_id):
                return card_json(db.get_board_card(card_id)), None
            # 起会话失败：回原列（worktree 标记保留，重按开始即复用）；本路径
            # 从未落行，无需行收口（finish 无行时幂等 no-op，此处不调）；
            # 列回退同样是用户这次操作的收场（错误串已由前端 toast 提示），不置标记
            db.update_board_card(card_id, mark_unread=False,
                                 column_key=card["column_key"],
                                 block_kind=card["block_kind"],
                                 block_text=card["block_text"] or "")
            return None, {"error": str(e)}
        # 起跑行落一份 worktree 证据（与 _start_web 的会话日志同文件，便于事后核对）
        runner.append_log(log_path, f"### worktree 直起 path={path} branch={branch}\n")
        cur = db.get_board_card(card_id)
        return card_json(cur, running=True), None
    finally:
        _wt_start_end(card_id)


def worktree_preview(project, card):
    """卡片「在新 worktree 中开始」入口的预览（server 端点用，**不落盘**）：

    返回 {supported, reason, path, branch, exists, merge}——supported=False 时 reason
    是给用户看的中文原因（项目不是 git 仓库 / 卡片已有主会话，D10）；前端据此把
    菜单项置灰并显示原因，避免用户点了必然失败的入口。
    `merge`（2026-10-07 批次）= 待合并提交判定（`merge_pending`，None=无待合并）：
    已经是 worktree 卡的卡片走本端点时前端据它决定「通过」要不要弹合并框。
    """
    branch = worktree.branch_for(card["id"])
    pend = merge_pending(project, card)
    if (_card_opt(card, "worktree") or "").strip():
        # 已是 worktree 卡：续跑自动复用，无需再选（前端一般不再显示该入口）
        return {"supported": False, "reason": "该卡片已在独立 worktree 中运行",
                "path": _card_opt(card, "worktree"), "branch": branch,
                "exists": os.path.isdir(_card_opt(card, "worktree")),
                "merge": pend}
    if (card["session_id"] or "").strip():
        return {"supported": False,
                "reason": "该卡片已有主会话，不能切换到独立 worktree（请新建卡片）",
                "path": "", "branch": branch, "exists": False, "merge": pend}
    pv = worktree.preview(project, card["id"])
    if not pv["ok"]:
        return {"supported": False, "reason": pv["error"], "path": "",
                "branch": branch, "exists": False, "merge": pend}
    return {"supported": True, "reason": "", "path": pv["path"],
            "branch": pv["branch"], "exists": pv["exists"], "merge": pend}


def cleanup_card_worktree(project, card):
    """清理卡片 worktree（server 端点用）。返回 (ok, err)。

    运行中的卡拒绝（409 语义由 server 落）：会话还在跑时删工作树=把 agent 的
    cwd 抽走，必须由用户先停卡。删除成功后**清空卡片 worktree 标记**（该卡回到
    普通模式；主会话若已是 worktree cwd，仍可续跑，但下次「开始」不再建树——
    这属用户显式选择，且 D10 只拦「已有会话切 worktree」，不拦反向）。
    """
    if _card_unit_active(card["id"]) or _session_in_flight(card["id"]):
        return False, "会话运行中，请先停止卡片再清理 worktree"
    ok, err = worktree.remove(project, card)
    if not ok:
        return False, err
    db.update_board_card(card["id"], worktree="")
    return True, ""


# ---------- worktree 改动回流主分支（「通过」时的待合并闸，2026-10-07 批次） ----------
#
# 需求（用户 2026-10-07）：独立 worktree 卡的改动在 `ts/card-<id>` 分支上，主分支
# 一无所知；点「通过」时应当先看有没有待合并提交——没有就直接完成，有就把合并
# 交给 agent（冲突只有 agent 能解），**平台自己不执行任何 git 合并命令**。
#
# 分工与边界：
# - 平台（本模块）：判定 `ahead`（见 `merge_pending`）+ 生成指令 + 把卡片连同指令
#   送回统一队列（`handoff_worktree_merge`）；不碰分支、不替用户决定合并结果。
# - agent：在卡片会话里执行同步主分支、解冲突、回流合并（指令原文
#   `build_merge_instruction`），干完这轮会话结束 ⇒ 卡片按既有流程自动回待审核；
#   用户再点「通过」时 `ahead` 已为 0，直接进「已完成」。
# - worktree 卡平时**免排队**（不占项目运行位，plan D1）；但合并要动主仓库工作区，
#   必须与项目内其他单元串行 ⇒ 这条路径显式走统一队列（`queue_worktree=True`），
#   卡片在开发列显示「排队中」，轮到才起会话。

# 合并任务指令的段落标记：投给卡片会话的指令以它开头，`build_start_prompt` 据此
# 走专用提示词（不套打回意见的「【修改意见】…请按修改意见继续完善」壳——那会让
# agent 以为要改代码，而不是合并分支）。生产者=`build_merge_instruction`。
MERGE_TASK_MARK = "【合并任务】"


def merge_pending(project, card):
    """「通过」前的待合并提交判定（只服务独立 worktree 卡）。返回 dict 或 None。

    None = 无需询问（非 worktree 卡 / 工作树读不到 / 没有待合并提交）——三种情形
    都按普通卡直接完成（用户 2026-10-07 约定：没有可合并的 commit 就直接进已完成；
    工作树被用户删掉等读不到的情形拦下来只会卡住「通过」，故一并放行）。
    有值 = 前端弹「是否交给 agent 合并」（列不动），字段：
    {branch, target, ahead, behind, dirty, dirty_count, path}。
    """
    if not (_card_opt(card, "worktree") or "").strip():
        return None
    st = worktree.merge_status(project, card)
    if not st["ok"] or st["ahead"] <= 0:
        return None
    return {"branch": st["branch"], "target": st["target"],
            "ahead": st["ahead"], "behind": st["behind"],
            "dirty": st["dirty"], "dirty_count": st["dirty_count"],
            "path": st["path"]}


def build_merge_instruction(project, card, st):
    """生成交给 agent 的合并指令（原文即 prompt，见 `MERGE_TASK_MARK`）。

    指令把两个路径都写死（工作树 / 主仓库）——agent 的 cwd 是工作树，回流的
    `git -C <主仓库> merge` 是跨目录操作，不写清楚它会去猜（plan D7 的教训）。
    合并口径按用户 2026-10-07 约定：**先同步主分支最新代码，再回流；尽量 ff，
    不能 ff 才普通 merge**；冲突由 agent 解，解不了必须 abort 回退，不留半合并态。
    """
    main = (project["project_dir"] or "").strip()
    branch, target, path = st["branch"], st["target"], st["path"]
    dirty = int(st.get("dirty_count") or 0)
    head = [f"{MERGE_TASK_MARK}把卡片 #{card['id']} 的独立 worktree 改动合并回主分支。",
            f"工作树：{path}（分支 {branch}，你的会话工作目录）",
            f"主仓库：{main}（主分支 {target}）",
            f"待合并提交：{st['ahead']} 个"]
    if dirty:
        head.append(f"工作树当前有 {dirty} 处未提交改动，第一步先提交它们。")
    steps = [
        "步骤：",
        f"1. 提交工作树里的未提交改动（有的话），提交信息带上卡片号 #{card['id']}。",
        f"2. 同步主分支最新代码：若项目有远端，先在主仓库执行"
        f" `git -C {main} fetch`（无远端会失败，忽略即可）；然后在工作树执行"
        f" `git -C {path} merge {target}`（主分支已合入过就跳过）。"
        f"冲突在工作树内解决，并跑相关测试确认。",
        f"3. 回流合并：在主仓库执行 `git -C {main} merge --ff-only {branch}`"
        f"（能快进就快进，主分支保持线性）；若因主分支又前进而无法快进，"
        f"改用 `git -C {main} merge {branch}` 生成合并提交，冲突自己解决。",
        f"4. 不要 push，不要 rebase/重置主分支，不要改动与本卡无关的文件。",
        f"5. 结束后用一两句话报告：合并是否成功、目标分支名、合并后的 HEAD 短 sha；"
        f"失败就说明卡在哪一步。",
        f"若第 2/3 步冲突无法解决：`git -C {path} merge --abort`（工作树侧）或"
        f" `git -C {main} merge --abort`（主仓库侧）回退，"
        f"绝不留半合并状态，并在报告里说明卡在哪里。",
    ]
    return "\n".join(head + [""] + steps)[:PROMPT_MAX]


def handoff_worktree_merge(project, card):
    """把「合并 worktree 改动回主分支」交给卡片会话（回统一队列排队）。

    返回 (card_dict, None) 或 (None, err_dict)。平台**只投递不执行**：判定有
    待合并提交后，把 `build_merge_instruction` 的指令当打回意见送进统一队列
    （`queue_worktree=True` 让 worktree 卡走排队路径而不是免排队直起）——轮到该卡
    时才起会话，agent 干完这轮卡片自动回待审核，用户再点「通过」即完成。
    前置校验：无待合并提交 / 无主会话（没会话就没上下文可投递）直接报错。
    """
    if not (card["session_id"] or "").strip():
        return None, {"error": "该卡片尚无主会话，无法交给 agent 合并"}
    st = worktree.merge_status(project, card)
    if not st["ok"]:
        return None, {"error": f"无法判定待合并提交：{st['error']}"}
    if st["ahead"] <= 0:
        return None, {"error": "该卡片没有待合并的提交（可直接通过）"}
    instruction = build_merge_instruction(project, card, st)
    return start_into_doing(project, card, instruction, queue_worktree=True)


def dequeue_start(project, card):
    """runner 拾到排队卡片后的起跑（队列已保证项目串行位）。

    落 doing + 锁外起会话；起会话失败：清占位 + 卡回 from_column 列（随
    enqueue_card meta 持久化；非法/缺失回落 blocked）返回 False——不再留
    「占位但已出队」滞留态（P4 明示变更③），last_error 已由 start_card 记录，
    等待项 failed 由 runner finally 直调负责，用户重按开始即可重新入队。
    与 force 直起对撞落败（对方已起跑成功）时放弃回滚返回 True（卡片确已起跑，
    行占位由 _process_card 随后的 card_started 幂等补上）。
    """
    row = waitq.get_active(waitq.KIND_CARD, card["id"])
    try:
        meta = json.loads((row["meta"] if row is not None else "") or "{}")
        if not isinstance(meta, dict):
            meta = {}
    except ValueError:
        meta = {}
    extra = str(meta.get("extra") or "")
    from_col = str(meta.get("from_column") or "")
    with _gate_lock:
        db.update_board_card(card["id"], column_key="doing",
                             block_kind=None, block_text="", last_error="")
    try:
        start_card(project, db.get_board_card(card["id"]), extra)
    except RuntimeError:
        # 与 force 直起对撞落败：对方已起跑成功（_RUNS 有活条目），放弃回滚——
        # 回滚会把对方落好的 doing 踩回原列（胜者会话照跑、结束后 _finish_run
        # 因列非 doing 跳过 review 流转，卡片滞留）
        if _session_in_flight(card["id"]):
            return True
        # 起跑失败收口（P4 明示变更③）：清占位 + 回 from_column 列——不再留
        # 「占位但已出队」滞留态；等待项终态归属：starting 行=worker finally
        # 直调（本路径落 failed）/ running,finishing 行=finish()→card_finished
        # 收口（v2b force 落表行，fix round 1 起门禁 (running,finishing)；
        # v2d T1 收尾归 finish() 唯一收尾点）；
        # last_error 已由 start_card 记录（update_board_card 白名单不触碰）。
        # 回滚补收口（列先归位，随后经唯一收尾点 finish 补位唤醒；行已由 runner
        # finally 直调落 failed/cancelled 时，finish 的收口子步幂等 no-op）
        back = from_col if from_col in COLUMNS and from_col != "doing" else "blocked"
        db.update_board_card(card["id"], column_key=back,
                             block_kind=None, block_text="")
        finish(f"c:{card['id']}", "起跑失败回滚")
        return False
    return True


# ---------- 会话驱动 ----------

# card_id -> 运行条目（单族：dsh 插件会话在宿主进程内，恒 proc=None）：
# {"proc": None, "sid", "family", "project_dir", "started_at", "seen_busy",
# "aborted", "turn_baseline", "log_path"}
# （服务重启后丢失，recover 按会话实况重建）
_RUNS = {}
_runs_lock = threading.Lock()

# 单卡片 prompt 长度上限（与 chat.MESSAGE_MAX 对齐）
PROMPT_MAX = 20000


def build_task_prompt(project, card, extra=""):
    """全量任务提示词：任务描述（卡片标题并入描述）+ 工作目录 + 附加段。

    2026-09-14 用户约定：向 agent 发任务不区分任务标题与任务描述——标题并入
    【任务描述】段（与描述空行分隔），不再单列【任务标题】；空标题与卡面展示
    占位「未命名」（前端详情保存空标题所落的字面量）不参与拼接。
    2026-09-23 用户约定：去掉【约定】段（提问/审批前先提交本次会话改动）——
    提交契约不再随首轮 prompt 注入 agent，提交由环境侧自行决定（原可选扩展
    kimi-hooks 的 session_autocommit hook 已随 kimi 族退场，见 spec/board §18）。
    2026-09-29 用户约定：去掉尾部「请完成上述开发任务。」（卡 624「这一句可以
    去掉」，该句无信息增量）——首轮提示词到【工作目录】行收尾，不再补收束句；
    打回意见段的「请按修改意见继续完善。」是另一句，照旧保留（spec/board §40）。
    2026-10-06 批次：独立 worktree 卡的【工作目录】改指其 worktree 路径（经
    `card_workspace`），并追加一行说明分支与主仓库位置——否则 agent 会去动主
    仓库（plan D7）；普通卡提示词一字未变。
    """
    title = (card["title"] or "").strip()
    if title == "未命名":
        title = ""   # 卡面空标题展示占位，不是任务信息
    desc = (card["description"] or "").strip()
    body = "\n\n".join(seg for seg in (title, desc) if seg) or "（无）"
    workspace = card_workspace(project, card)
    p = (f"【任务描述】{body}\n"
         f"【工作目录】{workspace}")
    wt = (_card_opt(card, "worktree") or "").strip()
    if wt:
        p += (f"\n（本任务运行在独立 git worktree 中：分支 {worktree.branch_for(card['id'])}，"
              f"主仓库 {project['project_dir']}）")
    if extra:
        p += f"\n【修改意见】{extra}\n请按修改意见继续完善。"
    return p[:PROMPT_MAX]


def build_continue_prompt(extra=""):
    """续跑提示词：卡片已有主会话、再次进「正在开发」时替代全量首轮提示词。

    用户约定（2026-09-11）：从阻塞/待审核/已完成再进「正在开发」（拖入、
    「重试」、「打回」均含）时不重发原任务——主会话里已带首轮任务上下文，
    重发会被 agent 当作新任务从头再走一遍；只发「继续」让它接着做。
    打回意见（extra）随行注入，否则用户的修改要求会丢。
    """
    p = "继续"
    if extra:
        p += f"\n【修改意见】{extra}\n请按修改意见继续完善。"
    return p[:PROMPT_MAX]


def build_start_prompt(project, card, extra="", sid=""):
    """起跑提示词选择：有可续接主会话（sid 非空）→ 续跑「继续」提示词，
    否则全量首轮提示词（build_task_prompt）。

    sid 由调用方按族判定：单族后只有 dsh_plugin——有可续接主会话（走驱动
    resume）传其 sid，否则传空串——无可续会话自动回落全量，避免给无上下文的
    新会话发「继续」。
    卡上标题/描述即便有编辑一并忽略（用户约定：有会话只发「继续」）。
    合并回交指令（extra 以 MERGE_TASK_MARK 开头，2026-10-07 批次）：**原文直发**，
    不套「【修改意见】…请按修改意见继续完善」壳——那是打回改代码的语义，合并
    任务要的是执行 git 步骤，混在一起会让 agent 跑偏。
    """
    if extra.startswith(MERGE_TASK_MARK):
        return extra[:PROMPT_MAX]
    if sid:
        return build_continue_prompt(extra)
    return build_task_prompt(project, card, extra)


# ---------- web 驱动助手（dsh_plugin：会话在 dsh 宿主进程内，经驱动 REST 实时交互） ----------

# starting 态超时阈值（秒）：c: 行「拾取→会话证实」窗口上限（v2d T3，v2 §2.5.2-5，
# 裁决 R6）。数值沿用原 WEB_TURN_START_TIMEOUT（90s）宽限补丁——补丁语义并入两处：
# ① 行级对账 _reconcile_starting_rows（超龄 starting 行三态复核，调和器 5s 节拍）；
# ② 会话级宽限 _watch_runs_once（web turn 未起，在管条目复核同用本阈值）。
_STARTING_TIMEOUT_S = 90

# unknown 分支告警节流（v2d T4 收口 T3 复审项③）：同卡窗内只报一行——5s 节拍
# 此前每拍一行刷屏；滞留卡仍周期性上报（可观测性不退）。
_STARTING_ALERT_S = 300
_starting_alert_at = {}          # card_id -> 上次告警时间戳（进程内；粗粒度回收）
_starting_alert_lock = threading.Lock()


def _starting_alert_due(card_id):
    """unknown 分支告警节流判据（见 `_STARTING_ALERT_S`）：本卡到窗返回 True。"""
    now = time.time()
    with _starting_alert_lock:
        if len(_starting_alert_at) > 256:
            _starting_alert_at.clear()      # 量小：粗粒度回收（重报无罪）
        if now - _starting_alert_at.get(card_id, 0) < _STARTING_ALERT_S:
            return False
        _starting_alert_at[card_id] = now
        return True


def _web_family(project):
    """项目 agent 属于 dsh 插件族时返回 "dsh_plugin"，否则 None（退场族）。

    单族化（P7b）：kimi/opencode 两族（含其 web 驱动模块）已退场——
    `agents.agent_family` 只回 "dsh_plugin" 或 `agents.RETIRED_FAMILY`
    （"retired"，含旧 kimi/opencode/claude/hermes/deepseek CLI 与旧 web 前缀
    项目），后者一律按 None 处置：调用方据 None 走退场族防呆（见 start_card /
    `_enter_doing`），不再落任何起会话路径。
    dsh_plugin（路线 A）按 web 处置：会话不在本地子进程里跑，而是 dsh 宿主
    进程内的常驻 agent，平台只能「先建会话拿 sid → 投递 → 等 turn 结束」。
    """
    family = agents.agent_family(project["agent_path"] or "")
    return family if family == "dsh_plugin" else None


def _session_state_family(family, project_dir, sid, wait=True):
    """三态核心（族参数版；唯一会话状态读路径）：单族化后只有 dsh_plugin——
    读 `dshevents` 的进程内注册表（**零请求**：状态由 dsh 的 agent/status 事件
    推来；未连接/未知会话 ⇒ unknown，绝不推断空闲）；退场族 / 无 sid 无精确
    信号 → unknown。project_dir / wait 为既有调用面参数（dsh 读口是内存表，
    不阻塞 REST、取值不影响结果）。不 ensure、不抛异常（一切异常收敛为
    unknown，由调用方按场景处置）。"""
    if family is None or not sid:
        return STATE_UNKNOWN
    try:
        if family != "dsh_plugin":
            return STATE_UNKNOWN
        # 路线 A P4（2026-10-03）：读口从「逐会话 /status」换成 EventHub 的
        # 进程内注册表——状态由 dsh 的 agent/status 事件推来，**零请求**。
        # 未连接/未知会话 ⇒ UNKNOWN（＝未知，绝不推断空闲；调用方保持现状）。
        st = dshevents.get(sid)
        if st is None:
            return STATE_UNKNOWN
        return STATE_RUNNING if st.get("status") == "running" else STATE_IDLE
    except Exception:
        return STATE_UNKNOWN


def session_state(proj, sid, wait=True):
    """项目会话三态判定：agent_path 归族 + project_dir 定位（见族版核心注释）。"""
    return _session_state_family(_web_family(proj), proj["project_dir"], sid,
                                 wait=wait)


def unit_liveness(row):
    """行判活探针（v3c 行口径，经 runner.set_liveness_probe 注册给
    reconcile_units/selfcheck_units；锁外慢探测合法；输入=活跃等待项行）：
    web 族卡按会话三态映射——running → alive；
    idle → dead（waitq 侧 R11a 降级不采信，跨轮间隙不误杀）；unknown →
    unknown（探测失败/状态不明只告警）。退场族卡（无精确 busy 信号）
    与其他 kind 返回 None——交 waitq 内建 DB 证据（任务/消息行状态、卡行
    存在性、行 evidence 的 pid 存活）裁活。"""
    if row["kind"] != waitq.KIND_CARD:
        return None
    try:
        cid = int(row["target_id"])
    except (ValueError, TypeError):
        return None
    card = db.get_board_card(cid)
    if card is None:
        return None                    # 卡行已删：内建证据即可证死，无需探针
    proj = db.get_project(card["project_id"])
    if proj is None:
        return None
    family = _web_family(proj)
    if family is None:
        return None                    # 退场族卡：无精确 busy 信号，交内建证据
    st = _session_state_family(family, proj["project_dir"],
                               (card["session_id"] or "").strip())
    if st == STATE_RUNNING:
        return "alive"
    if st == STATE_IDLE:
        return "dead"                  # R11a：waitq 侧降级 unknown，不擅动
    return "unknown"


def unit_managed(row):
    """行所属单元是否仍由平台在管（v3c 修复轮 Important-2；`waitq.selfcheck_units`
    的 `managed` 判据注入面）：看板卡有在管条目（`_RUNS`）⇒ 其收尾归巡视
    `_finish_run`（R4「`_RUNS`= 收尾归属与实况探测依据」），自检不越权收口其行。

    典型形态：dsh 会话刚结束而巡视尚未收尾——行证据已陈旧/近可证死（在
    `_unit_verdict` 里），但巡视的 30s 节拍（`_watch_once`）才是收口权威：`_finish_run`
    → `finish` → `card_finished` 把行收成 `done`。自检若抢先，`card_finished` 的
    门禁 (running, finishing) 见行已终态 → 一次成功会话的终态被写死成 `failed`
    （审计污染 + 瞬时「卡在 doing 却无活跃行」的 I1 自报）。
    `_RUNS` 无条目的卡死行不受本判据保护——自检是那种行的唯一恢复路径。
    t:/m:/a: 行不在本判据面（平台在管面=看板卡会话；其行态由执行体收口）。"""
    if row["kind"] != waitq.KIND_CARD:
        return False
    try:
        cid = int(row["target_id"])
    except (ValueError, TypeError):
        return False
    return _has_active_run(cid)


def _web_busy(family, project_dir, sid, wait=True):
    """web 会话 turn 是否进行中（bool 适配：三态非 running 一律 False；核心不抛异常，
    调用方既有异常兜底结果不变）。已知边界（m8）：busy 为会话级语义——同一 sid 被其他
    客户端（如 dsh GUI/TUI）使用/插话同样反映为 busy；仅注明，不改逻辑。
    wait=False（批量面）传透三态核心——dsh 读内存注册表，天然非阻塞。"""
    return _session_state_family(family, project_dir, sid,
                                 wait=wait) == STATE_RUNNING


def web_session_busy(proj, sid):
    """web 族单会话实况 busy（展示口径：unknown 按 False——不点亮动画不误报）。
    单族化后只有 dsh_plugin：读插件内存态（无需 ensure：会话活在 dsh 进程内，
    平台侧没有可拉起的服务）；退场族 / 无 sid / 异常一律 False。"""
    family = _web_family(proj)
    if family is None or not sid:
        return False
    try:
        return session_state(proj, sid) == STATE_RUNNING
    except Exception:
        return False


def web_busy_map(proj, running_map=None):
    """web 族项目会话 busy 批量预计算（board_payload 的卡片 busy 字段源，
    前端 5s 轮询一次、后端集中算，前端不增请求）。单族化后只有 dsh_plugin：
    读 EventHub 的进程内快照——**零请求**（原 kimi 逐 sid /status、
    opencode 项目级 /session/status 两条批量探测路径已随两族退场）。未连接 ⇒ {}
    （busy 全 False，与「无信号」的展示口径一致：看板据此不点亮，不误判），
    下一帧事件到达即自动纠正；退场族返回 {}。

    running_map 为既有调用面参数（dsh 分支不消费——探测域收窄是 kimi 逐 sid
    探测时代的成本优化，dsh 一次快照即全量卡）。"""
    fam = _web_family(proj)
    if fam is None:
        return {}
    # 路线 A P4（2026-10-03）：读 EventHub 的进程内快照——**零请求**。
    snap = dshevents.snapshot()
    sids = {c["session_id"] for c in db.list_board_cards(proj["id"])
            if c["session_id"]}
    return {sid: bool((snap.get(sid) or {}).get("status") == "running")
            for sid in sids}


def _web_abort(family, project_dir, sid):
    """中断 web 会话当前 turn（单族：dsh_plugin cancel——dsh 的 cancel 保留已
    流式交付的文本）。family / project_dir 为既有调用面参数（dsh 无本地服务，
    cancel 只需 sid）。"""
    dshdriver.cancel(sid)


def _web_send(family, project, sid, text, model="", inject=False):
    """向 web 会话发 prompt：单族化后只有 dsh_plugin——走进程内 drive 的 followup
    （busy 时排进 agent inbox，同为服务端排队语义；`inject=True` 改走 steer =
    注入当前 turn 的最近 step 边界），返回空串（dsh 无 prompt_id 概念，排队行以
    平台消息 id 表示）。model 为既有调用面参数（dsh 的模型在建会话时定格，续投
    不再带）。投递是**唯一出口**（`_deliver_now` / 起会话后续投都经这里）。"""
    chat.dsh_send(sid, text, inject=bool(inject))
    return ""


def _web_turn_baseline(family, project_dir, sid):
    """发 prompt 前的 turn 归属基线（M2）：dsh_plugin = (轮次结束原因, 会话事件
    seq)——seq 严格单调，比消息条数更可靠（事件流本身就是计数）。读取失败/
    未知返回 None（_web_turn_ran 按「跑过」容错，不误判负）。"""
    try:
        # P4：读 EventHub 注册表（turn 状态帧带会话事件 seq）——零请求。
        # 未知（未连接/不在表）返回 None，与读失败同口径（_web_turn_ran 容错）
        st = dshevents.get(sid)
        if st is None:
            return None
        return (st.get("last_turn_reason") or "", int(st.get("last_seq") or 0))
    except dshdriver.DshDriverError:
        return None


def _web_turn_ran(rec):
    """本卡 turn 是否真跑过（web 监视 90s 未见 busy 时的复核，M2 按归属判定）：
    与 _start_web 发 prompt 前记录的基线比较——dsh_plugin 看轮次原因变化或事件
    seq 增长。基线缺失或复核异常按「跑过」容错（不误判负）。"""
    baseline = rec.get("turn_baseline")
    if baseline is None:
        return True
    try:
        st = dshevents.get(rec["sid"])
        if st is None:
            return True                    # 未知：按「跑过」容错（不误判负）
        return (st.get("last_turn_reason") or "") != baseline[0] \
            or int(st.get("last_seq") or 0) > baseline[1]
    except dshdriver.DshDriverError:
        return True


def _web_turn_error(rec):
    """web 会话 turn 级错误上浮（_finish_run 用）：无错返回空串。

    dsh_plugin：驱动的 last_turn_reason（completed 正常；aborted 是用户主动中断
    不算错误；error/max-tokens/blocked 上浮为 turn 异常）。读口为 EventHub
    注册表，未知 ⇒ 无错（收尾路径不因此失败）。
    """
    sid = rec.get("sid") or ""
    if not sid:
        return ""
    try:
        # P4：读 EventHub（turn/end 的归一 reason）；未知 ⇒ 无错（收尾不因此失败）
        reason = str((dshevents.get(sid) or {}).get("last_turn_reason") or "")
        if reason in ("", "completed", "aborted"):
            return ""
        return f"turn 异常结束（{reason}）"
    except dshdriver.DshDriverError:
        return ""


def _session_in_flight(card_id):
    """卡片会话条目在途判定（原 `_rec_active` 判据面，v2d T3 退役改名）：单族化
    后条目恒为 dsh（proc=None），在巡视弹出前在途（起跑证实→收尾之间，宽限期内
    busy 未起同样在途——防重入起第二会话）；proc 分支保留为防御（历史残留条目）。

    只回答「在管条目是否还在跑」，卡片运行态判定面（起跑门禁的 starting 支）
    已由 `_card_unit_active` 显式承担（裁决 R6）。对撞落败两处（_enter_doing /
    dequeue_start 的 except 分支）用本判据：对方起跑已登记条目即不抢回滚。
    """
    with _runs_lock:
        rec = _RUNS.get(card_id)
    if rec is None:
        return False
    proc = rec.get("proc")
    return proc is None or proc.poll() is None


def _card_unit_active(card_id):
    """活跃 c: 行（starting/running/finishing）在场判定（v2d T3，裁决 R6）：
    starting 态显式承担原「条目存在即运行中」的防重入职责——行在=单元在管
    （拾取→会话证实窗口、force 落表行），起跑窗口内即便还没登记在管条目也能
    拦住第二次起跑；finishing（收尾瞬态，v2d T4 收口 T3 复审项⑤）同样在管——
    收尾窗口内重入会与 finish() 的行收口/搬列抢跑。

    读失败按不在场（不阻断开始路径；后续写操作自会报错）。只在入口面用
    （`_enter_doing` 预检）：worker 拾取起跑（`dequeue_start`）与 force 落表
    路径自持 starting 行，不查本判据。

    残余（明示，罕见）：异常残留的活跃行（如自愈后的 running 行失去在管
    条目）会让该卡的重启被拦到 recover/重启收口为止——拦下优于「入队复用活跃行
    却永不拾取」的幽灵态（recover docstring 同款）；超龄无证据由 30min 自检
    告警面暴露（`waitq.selfcheck` v2d T3 扩三态）。
    """
    try:
        row = waitq.get_active(waitq.KIND_CARD, card_id)
    except Exception:
        return False
    return row is not None and row["state"] in (waitq.STARTING, waitq.RUNNING,
                                                waitq.FINISHING)


def _save_card_sid(card_id, sid):
    """把 sid 并入卡片 session_id/sessions（仿 _finish_run 的归并写法）。
    卡片已删（起会话中途被删）返回 False，调用方据此放弃启动。"""
    card = db.get_board_card(card_id)
    if card is None:
        return False
    sessions = json.loads(card["sessions"] or "[]")
    if sid not in sessions:
        sessions.append(sid)
    db.update_board_card(card_id, session_id=sid,
                         sessions=json.dumps(sessions, ensure_ascii=False))
    return True


def _start_web(project, card, family, extra=""):
    """web 驱动起会话（单族：dsh_plugin——会话在 dsh 宿主进程内）：建会话（sid
    立即可知，**建完立即入库**，防后续步骤失败丢会话成孤儿）→ 设模型 → 记 turn
    归属基线 → 发 prompt → 登记 _RUNS（proc=None，靠事件中枢/巡视收尾，见
    _watch_once）。

    有主会话时续接原会话（走驱动 resume，同一 sid 上下文续接，打回续改不丢
    上下文）；续接与新建的提示词选择见 build_start_prompt（有可续接主会话只发
    「继续」）；失败记 last_error 并抛 RuntimeError；起会话中途卡片被删则记日志
    并放弃（m4）。
    """
    sid = (card["session_id"] or "").strip()
    prompt = build_start_prompt(project, card, extra, sid)
    lib.ensure_runtime_dirs(project["work_dir"])
    log_dir = lib.runtime_dir(project["work_dir"], runner.LOG_DIR_NAME)
    log_path = os.path.join(log_dir, f"board_{card['id']}_{int(time.time())}.log")
    model = (card["model"] or "").strip() or (project["model"] or "").strip()
    baseline = None
    # 卡片级工作目录（2026-10-06 批次）：独立 worktree 卡用其 worktree 路径，
    # 其余仍是 project_dir（`card_workspace` 唯一读口）。会话创建/resume 的 cwd、
    # 在管条目记账、后续取消都用它——保证「worktree 卡的会话从头到尾在该路径」，
    # 与 plan §2.6 的「resume 不校验 cwd」风险对齐（创建与续接同路径才不背离）。
    workspace = card_workspace(project, card)
    try:
        runner.append_log(log_path,
                          f"### PROMPT {json.dumps(prompt, ensure_ascii=False)}\n")
        if workspace != (project["project_dir"] or ""):
            runner.append_log(log_path, f"### WORKDIR {workspace}（独立 worktree）\n")
        # 路线 A：会话在 dsh 宿主进程内。新建用 dshdriver.create_session
        # （插件回执 sid）；续接走 resume（同一 sid，上下文续接，对齐
        # runner._run_round_dshplugin 的 ensure_session 语义）。
        # 模型值统一 `provider/id`（模型下拉口径）而宿主 `/session` 不拆前缀 ⇒ 先拆开
        m_provider, m_id = dshdriver.split_model(model)
        if not sid:
            sid = dshdriver.create_session(workspace,
                                           task=f"card-{card['id']}",
                                           model=m_id, provider=m_provider)
            if not _save_card_sid(card["id"], sid):  # 建完即入库
                runner.append_log(log_path, "### 卡片已被删除，会话启动放弃\n")
                raise RuntimeError("卡片已被删除，会话启动放弃")
        else:
            dshdriver.resume_session(sid, cwd=workspace,
                                     task=f"card-{card['id']}",
                                     model=m_id, provider=m_provider)
        # 项目级会话默认值（2026-10-04）：思考等级 + 权限档，best-effort 下发
        # （失败只记日志，不因一个配置项起不来会话——见 dshdriver.apply_session_defaults）。
        # 取值优先「会话实时态里已有的显式值」（用户在会话详情页改过的档位跨
        # 「开始/打回续改」存活），否则回落项目默认（新会话即走项目默认）。
        effort = dshevents.session_effort(sid) or \
            str(db.row_opt(project, "reasoning_effort") or "").strip()
        pmode = dshevents.session_permission_mode(sid) or \
            str(db.row_opt(project, "permission_mode") or "").strip()
        if effort or pmode:
            runner.append_log(log_path, f"### 会话默认值 effort={effort or '(默认)'} "
                                        f"permission={pmode or '(默认)'}\n")
            dshdriver.apply_session_defaults(
                sid, model=m_id, provider=m_provider,
                reasoning_effort=effort, permission_mode=pmode,
                log=lambda t: runner.append_log(log_path, t))
        baseline = _web_turn_baseline(family, workspace, sid)
        # 起会话首投直接走驱动（与既有 dsh 分支一致）：后续投递才经 _web_send
        # 统一出口（见 _deliver_now）
        chat.dsh_send(sid, prompt)
    except (dshdriver.DshDriverError, OSError) as e:
        db.update_board_card(card["id"], last_error=f"会话启动失败: {e}",
                             last_error_at=int(time.time() * 1000))
        raise RuntimeError(f"会话启动失败: {e}")
    # 续接路径 sid 本就在库（归并写法幂等）；此处兜建会话后卡片被删等边角（m4）
    if not _save_card_sid(card["id"], sid):
        runner.append_log(log_path, "### 卡片已被删除，会话启动放弃\n")
        raise RuntimeError("卡片已被删除，会话启动放弃")
    runner.append_log(log_path, f"### WEB {family} sid={sid} "
                                f"model={model or '(宿主默认)'}\n")
    with _runs_lock:
        old = _RUNS.get(card["id"])
        if old is not None:
            # 双保险（正常路径已被 start_card 的 _session_in_flight + 入口
            # _card_unit_active 拦下，此为并发
            # 竞态防御）：已有条目则中断本次启动，尽力 abort 刚建
            # 的会话回收之，防同卡双会话脱管
            try:
                _web_abort(family, workspace, sid)
            except dshdriver.DshDriverError:
                pass
            runner.append_log(log_path,
                              "### 拒绝登记：已有运行中会话，本次会话已 abort\n")
            raise RuntimeError("会话运行中，拒绝重复启动")
        _RUNS[card["id"]] = {"proc": None, "sid": sid, "family": family,
                             "project_dir": workspace,
                             "started_at": int(time.time() * 1000),
                             "seen_busy": False, "aborted": False,
                             "turn_baseline": baseline, "log_path": log_path}
    return log_path


def start_card(project, card, extra=""):
    """开始开发 / 打回续改：起 dsh 插件实时会话（见 _start_web）。

    提示词选择见 build_start_prompt：有可续接的主会话只发「继续」，
    否则（首跑 / 无可续会话）全量首轮提示词。

    会话条目在途（_session_in_flight：web 条目未弹出）：
    抛 RuntimeError（防重复起会话顶掉 _RUNS 在管条目）。
    **起跑窗口的 starting 态防重入**（原 `_rec_active`「条目存在即运行中」职责，
    v2d T3 裁决 R6）落在入口侧：`_enter_doing` 先过 `_card_unit_active`（活跃 c:
    行）再走本函数——本函数自身不能查该判据（worker 拾取起跑路径自持 starting 行）。
    退场族防呆（P7b 单族化，B0 遗留项）：`_web_family` 为 None（旧 CLI / 旧 web
    前缀项目）时抛 RuntimeError(agents.RETIRED_MSG)，不落任何起会话路径——
    调用方（_enter_doing / dequeue_start）按既有 RuntimeError 分支回滚并透出
    4xx JSON。
    启动失败：记 last_error 并抛 RuntimeError。
    """
    if _session_in_flight(card["id"]):
        raise RuntimeError("会话运行中，请等待完成或先停止")
    family = _web_family(project)
    if family is None:
        # 退场族防呆（见 docstring）：记 last_error 后抛（对齐启动失败约定）
        db.update_board_card(card["id"], last_error=agents.RETIRED_MSG,
                             last_error_at=int(time.time() * 1000))
        raise RuntimeError(agents.RETIRED_MSG)
    return _start_web(project, card, family, extra)


def deliver_comment(project, card, comment_row, inject=False, raw=False):
    """评论投递主会话（默认包装【看板评论】前缀；raw=True 直发原文——会话
    详情页发送路径专用，用户本就在会话中对话，无需任务上下文包装；卡片评论
    区「投递」维持前缀以区分消息来源。两条路径都照旧落评论记录 sent_text）。

    2026-09-10（统一队列消息单元）：不再立即投递——登记会话消息单元进 runner
    统一队列，项目忙（同项目有任务/卡片会话在跑）时按入队顺序等待，项目空闲才
    投递；投递执行期间单元持有项目占用，故卡片会话也不会与项目内任务并发改代码。
    单族化后只有 dsh_plugin：目标会话在跑时普通投递走 followup（忙时排进 agent
    inbox，等同服务端排队，不拒绝）；inject=True 的「立即注入」在执行体内走
    steer（见 chat.inject_now 与 _deliver_now）。
    """
    family = _web_family(project)
    sid = card["session_id"]
    if raw:
        wrapped = comment_row["text"]
    else:
        wrapped = f"【看板评论】任务「{card['title']}」: {comment_row['text']}"
    # 进队前的前置校验：拦住必然失败的投递（无会话 / 退场族无投递通道）
    if family is None:
        raise RuntimeError(agents.RETIRED_MSG)
    if not sid:
        raise RuntimeError("尚无会话，请先开始开发")
    inst = runner.INSTANCE
    if inst is None:
        # 无统一队列（单测/独立脚本）：保持既有立即投递行为
        _deliver_now(project, card, comment_row, wrapped, inject)
        return None
    # 排队中的消息可「立即注入」（见 chat.inject_now）：family/model/
    # comment_id 提交时定格进等待项 meta（chat_msgs 零加列，P3 裁决 R1），执行时
    # 由 chat 侧按行＋快照重建 _deliver_unit/_deliver_now
    return chat.submit(project["id"], sid, wrapped,
                       card_id=card["id"], comment_id=comment_row["id"],
                       inject=inject,
                       family=runner.agent_family(project["agent_path"] or ""),
                       model=(card["model"] or "").strip()
                             or (project["model"] or "").strip())


def _deliver_unit(project, card, comment_row, wrapped, inject):
    """统一队列消息单元执行体：投递评论并等该会话结束（执行期间持有项目占用）。

    返回即释放占用：dsh 会话的等轮次走 `chat.wait_turn` 分流口（外部会话订阅全局
    状态流、平台自持会话走既有按会话 SSE，规则见该函数）；返回
    chat.STATE_YIELDED = turn 挂起等作答、已让位（chat.run_unit 据此落终态）。
    尾部 proc 分支为 CLI 时代的防御残留（单族化后 _RUNS 条目恒为 dsh，proc=None）。
    """
    _deliver_now(project, card, comment_row, wrapped, inject)
    family = _web_family(project)
    if family is not None:
        return chat.wait_turn(project["project_dir"], card["session_id"],
                              family)
    with _runs_lock:
        rec = _RUNS.get(card["id"])
    proc = rec.get("proc") if rec is not None else None
    if proc is not None:
        proc.wait()


# 卡片会话已不在宿主时的投递文案（用户可见）：不暴露「驱动池 / sid」这类内部
# 链路词，只给「发生了什么 + 怎么办」。sync 卡与「接不回」两种情形共用一句
# ——两者对用户的可执行动作相同（点「开始」重新拉起会话）。
LOST_SESSION_MSG = ("会话已结束（宿主无活动 agent），消息未送达："
                    "请点「开始」重新拉起会话后再发送")


def _ensure_card_session(project, card, sid):
    """投递前确保宿主仍持有该卡会话（宿主已失去 ⇒ 按 resume 接回）；返回可否投递。

    报障现场（卡 934，2026-10-10）：插件热重载把宿主里所有会话 dispose 掉之后，
    卡片 `session_id` 仍在库、卡照旧在列，用户发评论 / 点「立即注入」时驱动回
    404「会话不在驱动池中」——前端只能把这条内部文案原样 toast 出来。

    判定阶梯（与调和器「会话确已结束」同源，见 `chat.host_session_lost`）：
      ① 宿主仍有该会话（注册表命中 / 中枢未对齐＝未知）⇒ 放行，**零请求**，
         既有路径一个字节不变；
      ② 确已失去 ∧ 平台自建卡（`origin` 非 `sync`）⇒ `chat.revive_host_session`
         按 `_start_web` 的续接语义 resume 回池（同一张卡、同一个 sid、同一上下文）；
      ③ 确已失去 ∧ sync 卡（`origin='sync'`＝用户在 dsh GUI 直跑的会话）⇒ **不接回**：
         C 批设计「只投递不接管」，平台不擅自把用户的会话收养进自己的池，直接报
         明确文案（用户点「开始」＝显式收养，那是既有路径）。
    接不回（会话文件缺失 / 驱动不可达）同样返回 False，由调用方报同一句文案。
    cwd 取 `card_workspace`（worktree 卡的会话必须接回它的工作树）。
    """
    if not chat.host_session_lost(sid):
        return True                        # 会话在场/未知：不动作（零请求）
    cid = _card_opt(card, "id")
    row = db.get_board_card(cid) if cid else None
    origin = str(_card_opt(row if row is not None else card, "origin") or "")
    if origin == "sync":
        return False                       # 外部会话卡：不接管（见上 ③）
    return chat.revive_host_session(sid, cwd=card_workspace(project, row or card),
                                    task=f"card-{cid}")


def _deliver_now(project, card, comment_row, wrapped, inject=False):
    """评论真正送达（立即路径与统一队列消息单元执行体共用；wrapped 为最终文本）。

    单族化后只有 dsh_plugin：followup 忙时排进 agent inbox（等同服务端排队
    语义，不拒绝）；inject=True 走 steer，注入当前 turn 的最近 step 边界
    （steer 失败不致命，评论仍在 inbox/队列）。退场族无投递通道，直接报错。
    送达前两道人造兜底（顺序固定，都在 `_web_send` 之前）：
      ① **会话存活**（2026-10-10，修卡 934）：宿主被插件热重载/重启清过之后，
         卡会话可能已不存在——`_ensure_card_session` 先接回再投递，接不回则报
         `LOST_SESSION_MSG`（可执行指引），不再把驱动 404 原文案抛给用户；
      ② 重声明看管（C 批终审 I2，2026-10-10）：本函数是评论**推送腿**的唯一出口，
         `_watch_prune` 的撤销判据只看活跃 `m:` 行（不看推送腿本身）。真实入口＝平台
         重启后 `_rebuild_run → _deliver_unit → _deliver_now` 直投：`_WATCHED` 随进程
         清空、驱动侧 `watched` 也可能随插件重载清空 ⇒ 不补声明就撞驱动「未看管」404、
         `m:` 行落 error。与 `_answer_deliver` 同源同判据（`_watch_before_delivery`
         内部只对 `owned:false` 的池外会话声明，命中缓存零请求；池内/未知路径一个
         字节不变）。
    """
    family = _web_family(project)
    sid = card["session_id"]
    if family is not None:
        try:
            # 会话存活兜底（见上 ①）：卡会话已被宿主丢掉时先 resume 接回再投递
            if not _ensure_card_session(project, card, sid):
                raise RuntimeError(LOST_SESSION_MSG)
            # 送达前重声明看管（C 批终审 I2）：外部会话的看管可能已被 `_watch_prune`
            # 撤掉（平台重启后记账为空、驱动侧重载后 watched 为空），漏声明则下面
            # 这条驱动调用撞「未看管」404（见上）
            _watch_before_delivery(sid)
            # dsh 的「立即注入」= steer（注入当前 turn 的最近 step 边界）；
            # 普通投递 = followup（忙时排进 inbox，等同服务端排队）；
            # 统一走 _web_send（单族投递唯一出口，测试打桩面也在此）
            _web_send(family, project, sid, wrapped, inject=bool(inject))
        except dshdriver.DshDriverError as e:
            raise RuntimeError(f"评论投递失败: {e}")
        db.update_board_comment(comment_row["id"], sent=1, session_id=sid,
                                sent_text=wrapped)
        return
    # 退场族无投递通道（单族化）：明确报错，不落已删除的 CLI 起子进程路径
    raise RuntimeError(agents.RETIRED_MSG)


# 卡片的「平台刚停过会话」时间戳（stop_card 登记）：拖入阻塞等路径会先停会话，
# web abort 生效前 busy 可能短暂仍为真——调和器在宽限期内不据 busy 做
# 「阻塞→开发」搬列，防拖入阻塞瞬间被回弹（见 _stop_recent）。
_STOP_STAMP = {}
_STOP_GRACE_S = 15


def _stop_recent(card_id):
    """卡片是否刚被平台停过会话（宽限期内，见 _STOP_STAMP 注释）。"""
    ts = _STOP_STAMP.get(card_id)
    return ts is not None and (time.time() - ts) < _STOP_GRACE_S


def stop_card(card_id):
    """停止卡片运行中的会话（单族：dsh 走驱动 REST cancel；防御分支仍认
    进程组 kill）。返回是否命中。

    先取消该卡片排队中的会话消息（2026-09-10：评论投递走统一队列，停止即放弃
    排队消息；已开始执行的投递随会话停止一并中断）。平台未在管（_RUNS 无记录）
    时的兜底：dsh 会话在 dsh 宿主进程内托管，按其 sid 仍可 REST cancel——覆盖
    外部同步卡（用户在 dsh GUI 直跑的会话自动建卡，不登记 _RUNS）与会话详情
    端点按实况 busy 点亮停止按钮的场景；无 sid 则无停止通道，返回 False。
    每次调用登记 _STOP_STAMP（调和器宽限期，见 _stop_recent）：abort 生效前
    busy 可能短暂残留，拖入阻塞的卡片不被调和器按残留 busy 回搬开发列。
    同时放弃该卡待送达的答案（权威取消，2026-09-17；P2 起走 waitq.cancel）：卡已停/被
    移列，迟到送达会唤醒已停会话、与用户意图相悖（同款「先取消排队消息」）。
    等待区卡（doing/queue 占位）停止即出队收口（v3b `_dequeue_card`：行取消 +
    归位待审核）；运行中卡的收口归会话真正结束后的 `_finish_run`（会话未收尾前
    不得放行串行位）。"""
    now = time.time()
    _STOP_STAMP[card_id] = now
    if len(_STOP_STAMP) > 256:  # 长期运行防累积：超限时清掉已过期项
        for cid in [c for c, t in _STOP_STAMP.items() if now - t > _STOP_GRACE_S]:
            _STOP_STAMP.pop(cid, None)
    chat.cancel_queued(card_id=card_id)
    if is_answer_pending(card_id):        # 放弃该卡待送达答案（见 docstring）
        waitq.cancel(waitq.KIND_ANSWER, card_id, "停止/移列放弃")
        inst = runner.INSTANCE
        if inst is not None:
            inst.remove_answer(card_id)
    with _runs_lock:
        rec = _RUNS.get(card_id)
    if rec is None:
        card = db.get_board_card(card_id)
        if card is None:
            return False
        if card["column_key"] == "doing" and card["block_kind"] == "queue":
            # 等待区卡停止（v2b T3，裁决 R9：任意队列中卡可停止→待审核；原
            # 「等待区卡无停止入口」废除）：从未起跑或续跑占位——无会话可停，
            # 统一走出队收口（v3b `_dequeue_card`：等待行取消/运行行终态化 +
            # 补位唤醒，to_column 一并归位待审核）；排队消息/待送达答案已在
            # 上方先行取消
            _dequeue_card(card_id, "用户停止", to_column="review", mark_unread=False)
            return True
        proj = db.get_project(card["project_id"])
        if proj is None:
            return False
        fam = _web_family(proj)
        if fam is None:
            return False
        sid = (card["session_id"] or "").strip()
        if not sid:
            return False
        try:
            # P7a 缺陷 A：dsh 会话活在 dsh 宿主进程内，平台侧**没有可拉起的
            # 本地服务**——直接走驱动 cancel（原 kimi/oc 的 ensure_started 段已
            # 随两族退场；原先漏判会落 opencode 兜底把 `dsh-plugin:<路径>` 当
            # opencode 可执行文件 spawn → FileNotFoundError 打穿 HTTP handler，
            # 卡片「通过」/拖到 done/review/blocked 全部表现为连接被掐）。
            _web_abort(fam, proj["project_dir"], sid)
            return True
        except (dshdriver.DshDriverError, OSError):
            # OSError：网络/驱动异常不再打穿请求处理器
            return False
    if rec.get("proc") is None:
        # web 驱动：先锁内标记 aborted（宽限期内 turn 未起即被 stop 时，
        # _watch_once 据此按正常停止收尾而不误判负，M3），再走 REST abort；
        # abort 后 busy 回落，由 _watch_once 正常收尾（不算错误停止）
        with _runs_lock:
            rec["aborted"] = True
        try:
            _web_abort(rec["family"], rec["project_dir"], rec["sid"])
            return True
        except dshdriver.DshDriverError:
            return False
    if rec["proc"].poll() is not None:
        return False
    try:
        platcompat.kill_tree(rec["proc"].pid, signal.SIGTERM)
        return True
    except (ProcessLookupError, PermissionError, OSError):
        return False


def running_map():
    """card_id -> 是否有运行中的会话（单族条目恒 proc=None = 存在即运行中——
    宽限期内 busy 未起也报 True，防误判空闲；v2d T3 `_rec_active` 退役后本函数
    自持该展示口径，调度判定面改走 `_session_in_flight` + `_card_unit_active`
    显式事实面；
    已 abort 的 web 条目即报 False，不等巡视弹出（停止按钮即时反馈，
    收尾仍由 _watch_once 完成）。"""
    with _runs_lock:
        entries = list(_RUNS.items())
    out = {}
    for cid, rec in entries:
        proc = rec.get("proc")
        if proc is not None:
            out[cid] = proc.poll() is None
        else:
            out[cid] = not rec.get("aborted")
    return out


def compact_session(project, card, sid):
    """对卡片关联会话执行 compact（压缩上下文）。

    单族化后只有 dsh_plugin：走驱动 `/compact`（插件侧执行宿主 `/compact`
    命令），触发即返回——压缩在 dsh 进程内异步进行（要过一次模型），失败落
    宿主日志（原 kimi CLI 子进程压缩与两族 web REST 压缩已随族退场）。

    **池外两跳（2026-10-10 修「卡片 945 无法 compact」）**：宿主侧插件重载/dsh web
    重启后，平台自建的卡会话在驱动里只剩**观察**（`/live` 的 `owned:false`，宿主里
    仍活着）——旧实现只认驱动池，compact 必 404「会话不在驱动池中」，前端原样 toast。
    这里按 `rename_card_session` 同款两跳：首跳 404（=池外）⇒ `_ensure_watch(sid)` 补
    看管声明（幂等、**只声明不接管**）后重试一次；驱动侧 `/compact` 的池外回落分支按
    「看管 + 宿主有活 agent」放行（node 半同批实现）。为什么不能「先接管再压缩」：
    外部会话的 agent 已在宿主 store 注册，`/session` resume 必撞
    `agent "…" is already registered` ⇒ 500（C 批 T1 实测）。

    sid 必须属于该卡片（sessions 清单或主 session_id），不支持的族抛
    RuntimeError（server 转 400）。
    """
    if sid not in json.loads(card["sessions"] or "[]") and sid != card["session_id"]:
        raise RuntimeError("会话不属于该卡片")
    family = runner.agent_family(project["agent_path"] or "")
    if family != "dsh_plugin":
        # 单族化：非 dsh 即退场族项目（migrate_p7b 改写后不再出现），
        # 给「改绑 dsh 插件」的明确提示（B0 防呆口径）
        raise RuntimeError(agents.RETIRED_MSG)
    # 路线 A P3（2026-10-03）：走驱动 `/compact`（插件侧执行宿主 `/compact`
    # 命令；`ctx.compaction` 服务在插件 ctx 不可注入，命令路径是 P0 探针的结论）。
    # 触发即返回——压缩在 dsh 进程内异步进行（要过一次模型），失败落宿主日志。
    last = ""
    for attempt in (1, 2):
        try:
            dshdriver.compact(sid)
            return
        except dshdriver.DshDriverError as e:
            last = str(e)
            pool_miss = getattr(e, "code", None) == 404
            # 只在首跳 404（池外）补一次看管声明；**force=True** 跳过平台侧陈旧记账
            # （驱动侧重载会清空 `watched` 表，`_WATCHED` 却仍写着「声明过」）。
            # 已看管但宿主无活 agent 的 404 重试同样失败，代价只是一次请求，换来判定
            # 不依赖文案匹配；且第二跳的文案更准确（「会话已结束（宿主无活动 agent）」
            # 取代含糊的「不在驱动池中」）。
            if attempt == 1 and pool_miss and _ensure_watch(sid, force=True):
                print(f"[board] 卡片 compact：池外会话补看管声明后重试 sid={sid}",
                      flush=True)
                continue
            break
    raise RuntimeError(f"compact 失败: {last}")


def fork_compact_session(project, card, sid):
    """对卡片关联会话执行「压缩并新建」（单族：dsh_plugin）：fork 出完整副本 →
    把**新会话**压缩（其上下文随即变轻），与「新会话上下文轻」的目标一致；
    差别是新会话日志里仍保留完整历史（窗口渲染更重），已在 spec 注明。

    sid 必须属于该卡片（sessions 清单或主 session_id）。返回 (新会话 sid, True)。
    """
    if sid not in json.loads(card["sessions"] or "[]") and sid != card["session_id"]:
        raise RuntimeError("会话不属于该卡片")
    family = runner.agent_family(project["agent_path"] or "")
    if family != "dsh_plugin":
        raise RuntimeError(agents.RETIRED_MSG)   # 退场族（见 compact_session）
    # 路线 A P3：dsh 没有「读压缩摘要再注入新会话」的等价物（原 kimi 族走其
    # 会话 wire 里的压缩摘要记录）。这里用**等价近似**：
    # fork 出完整副本 → 把**新会话**压缩（其上下文随即变轻），与「新会话上下文
    # 轻」目标一致；差别是新会话日志里仍保留完整历史（窗口渲染更重），已在 spec 注明。
    try:
        new_sid = str((dshdriver.fork(sid) or {}).get("new_session_id") or "")
        if not new_sid:
            raise RuntimeError("压缩新建失败: 驱动未返回新会话 id")
        dshdriver.ensure_session(new_sid, cwd=project["project_dir"],
                                 task=f"card-{card['id']}")
        dshdriver.compact(new_sid)
        title = (card["title"] or "").strip()
        if title:
            try:
                dshdriver.rename(new_sid, f"{title}（压缩续）")
            except dshdriver.DshDriverError:
                pass
    except dshdriver.DshDriverError as e:
        raise RuntimeError(f"压缩新建失败: {e}")
    return new_sid, True


def fork_session(project, card, sid):
    """fork 卡片关联会话（单族：dsh_plugin）：经驱动完整复制源会话
    （历史/上下文全量保留，同 workspace/cwd），新会话标题「<卡标题>（fork）」。

    与 fork_compact_session（压缩并新建）的区别：fork 是原样复制、不压缩，
    适合想从当前完整上下文开分支探索的场景；压缩新建只带摘要、上下文更轻。

    sid 必须属于该卡片（sessions 清单或主 session_id）。返回新会话 sid。
    调用方（server 端点）负责把新 sid 绑定进卡片会话列表（bind_session 语义：
    仅追加列表，不抢占主会话）。
    """
    if sid not in json.loads(card["sessions"] or "[]") and sid != card["session_id"]:
        raise RuntimeError("会话不属于该卡片")
    family = runner.agent_family(project["agent_path"] or "")
    if family != "dsh_plugin":
        raise RuntimeError(agents.RETIRED_MSG)   # 退场族（见 compact_session）
    # 路线 A P3（2026-10-03）：宿主 sessionController.fork 完整复制（同 cwd/历史）。
    # fork 出的新会话不在驱动池里——平台这里补一次 ensure_session 把它 resume
    # 进池，之后（改名/缩轮/投递）都按普通会话走；返回新 sid 交调用方绑卡。
    try:
        new_sid = str((dshdriver.fork(sid) or {}).get("new_session_id") or "")
        if not new_sid:
            raise RuntimeError("fork 失败: 驱动未返回新会话 id")
        dshdriver.ensure_session(new_sid, cwd=project["project_dir"],
                                 task=f"card-{card['id']}")
        title = (card["title"] or "").strip()
        if title:
            try:
                dshdriver.rename(new_sid, f"{title}（fork）")
            except dshdriver.DshDriverError:
                pass                      # 标题失败不影响 fork 主流程
    except dshdriver.DshDriverError as e:
        raise RuntimeError(f"fork 失败: {e}")
    return new_sid


def finish(unit_key, reason, *, to_column=None, mark_unread=True):
    """所有「条目结束」的唯一收口（v2 §2.5.2-4，裁决 R14；v2d T1）。

    步骤：finishing 重入门禁（幂等）→ waitq.mark_finishing（running→finishing
    ——finishing 态唯一生产路径，收尾瞬态仍计入位次前缀）→ runner.card_finished
    （行终态门禁 (running,finishing)→done；notify_all =补位时机②）→ 搬列
    （to_column 给定且列不同才写：column_key+清阻塞标记，
    与各 review 归位同款）。各族探测（进程退出 / SSE / 轮询回落 / 调和器）
    只负责触发 finish，不再各自收尾；卡片生命周期各释放点（_finish_run 正常尾
    /卡已删、_iw_apply to_review 出队归位、_leave_doing 容器迁移、move_card
    移列、delete_card_cleanup、dequeue_start 起跑失败回滚、runner worker finally
    c: 分支）逐处改调本函数（v3b 起经 `_dequeue_card` 统一行收口）。

    mark_unread（2026-10-07 批次）：搬列时是否给卡片置「状态有更新·用户未打开」
    标记，透传给 `db.update_board_card`。缺省 True=平台/agent 自己搬的列要标记
    （会话结束→待审核、归档同步→已完成最典型）；`mark_unread=False` 只给「用户
    本人在看板上操作」的收尾路径（`stop_card` 的停止→待审核），用户不需要自己
    给自己发提醒。

    行态口径（v2b fix round 1 逐字保留 + v2b 终审记录①）：running/finishing
    行=本收尾点收口；starting 行不收（起跑失败行终态归 worker finally
    failed「起会话失败」，本函数不得抢先标 done）；waiting 行不收（取消路径
    职责——cancel_card_wait / 作答排队防御 waiting-only）。runner 缺位跳过
    行收口（原 _release_card 同型 no-op）仍搬列。
    幂等：行 finishing 重入直接返回（并发/中断保护；中断残留由 recover/自检
    收口）；行终态后重入各子步幂等——终态行态守卫、搬列列差守卫。
    占位/事实分离（v2 §2.5.2-1，v3d 收口）：收尾只看行态，无「先查持有」特判
    ——行即占位表征，行终态即出队。

    ext 单元（v2d T4，裁决 R13）：`ext:<卡 id>` = 外部条目收尾——外部会话不受
    平台控制、无平台收尾面，收尾=行终结（finishing→done）+
    唤醒补位（时机③），供调和器/入队刷新在「实况 busy 回落/会话消失/挂起出队/
    卡离开发列」时调用。只返回布尔（是否真实收尾一行，调用方判集合变化）；
    runner 缺位同样收行（不依赖单例）。

    reason 的落点（v3 终审修复）：**真实收口一行**即打一行确定性日志——`c:` 行
    `[board] 卡片收尾：c:<id>（<reason>）`、`ext:` 行
    `[board] 外部条目收尾：ext:<target>（<reason>）`（行未收口时——行不在
    (running,finishing)、finishing 重入、终态重入——不落日志）。v3d 删租约层前
    这行由 `waitq.release` 的「释放租约 c:N（reason）」承担，删除后各收尾标签
    在运行/收尾态行上失去可观测落点，本日志按唯一收尾点口径补回（spec/queue §3
    「收尾单点与 reason 全表」的「落点口径」段）。
    """
    if unit_key.startswith("ext:"):
        target = unit_key[4:]
        row = waitq.get_active(waitq.KIND_EXT, target)
        if row is None or row["state"] == waitq.FINISHING:
            return False                  # 无活跃行/finishing 重入：幂等 no-op
        waitq.mark_finishing(waitq.KIND_EXT, target)      # running→finishing
        if waitq.finish_by_target(waitq.KIND_EXT, target):    # → done
            print(f"[board] 外部条目收尾：ext:{target}（{reason}）", flush=True)
        if runner.INSTANCE is not None:
            runner.INSTANCE.notify_busy_change()          # 补位时机③
        return True
    if not unit_key.startswith("c:"):
        return                            # 卡片单元外无收尾语义（t:/m:/a: 原位单点）
    card_id = int(unit_key[2:])
    inst = runner.INSTANCE
    if inst is not None:
        row = waitq.get_active(waitq.KIND_CARD, card_id)
        if row is not None and row["state"] == waitq.FINISHING:
            return                        # finishing 重入幂等（见 docstring）
        if row is not None and row["state"] == waitq.RUNNING:
            waitq.mark_finishing(waitq.KIND_CARD, card_id)  # running→finishing
        if inst.card_finished(card_id, reason=reason):      # 行收口成功 → reason 落日志
            print(f"[board] 卡片收尾：c:{card_id}（{reason}）", flush=True)
    if to_column is not None:
        card = db.get_board_card(card_id)
        if card is not None and card["column_key"] != to_column:
            db.update_board_card(card_id, mark_unread=mark_unread,
                                 column_key=to_column,
                                 block_kind=None, block_text="")


def delete_card_cleanup(card_id):
    """删除卡片前的平台侧清理（server 删除端点在 stop_card 之后、删库行之前调用）。

    清平台侧残留：统一队列条目与运行行收口（v3b 起走 `_dequeue_card` 出队原语
    ——等待行取消 / 运行行终态化，行+占位投影一并清）——防「卡删了但
    项目运行位被残留行堵死」。全部操作幂等（无活跃行即 no-op；finish 无活跃行/
    无 runner 退化 no-op），任何状态的卡片均可安全调用。
    """
    _dequeue_card(card_id, "卡片删除")


def _finish_run(card_id, rec, reason="会话结束收尾"):
    """会话结束收尾：提取 session id 入库、doing/交互阻塞卡 → review
    （清交互阻塞标记）、记错误、释放 runner 占用。

    reason：收尾 reason 标签（落卡片日志/审计），默认「会话结束收尾」。
    dsh 驱动：sid 启动时已入库，跳过日志回捞；错误优先经 _web_turn_error 上浮
    turn 级真实错误（事件中枢的 last_turn_reason 非 completed/aborted 即异常），
    无则取 rec["error"]（turn 未开始超时兜底）；用户主动 abort 不算错误
    （对齐 SIGTERM 语义）。尾部 proc 分支为 CLI 时代的防御残留（单族化后
    _RUNS 条目恒为 dsh，proc=None）。
    """
    log_path = rec["log_path"]
    web_err = ""
    if rec.get("proc") is None:
        # dsh 驱动：sid 启动即知已入库；turn 级错误优先，超时错误兜底
        sid = rec.get("sid") or ""
        web_err = _web_turn_error(rec) or (rec.get("error") or "")
        if web_err:
            runner.append_log(log_path, f"### 会话异常结束: {web_err}\n")
    else:
        if rec.get("usage_path"):
            try:
                with open(rec["usage_path"], encoding="utf-8") as f:
                    usid = str(json.load(f).get("session_id") or "")
                if usid:
                    runner.append_log(log_path, json.dumps(
                        {"role": "meta", "type": "session.resume_hint",
                         "session_id": usid}, ensure_ascii=False) + "\n")
            except (OSError, ValueError):
                pass
        sid = runner.parse_session_hint(log_path)
        if not sid and rec.get("family") == "deepseek":
            sid = sessparse.dsh_latest_session(rec["project_dir"]) or ""
    card = db.get_board_card(card_id)
    if card is None:
        # 卡片已删：会话收尾无事可做，但 runner 项目占用必须释放，否则项目队列卡死
        finish(f"c:{card_id}", "会话结束-卡已删")
        return
    fields = {}
    if sid:
        sessions = json.loads(card["sessions"] or "[]")
        if sid not in sessions:
            sessions.append(sid)
        fields["session_id"] = sid
        fields["sessions"] = json.dumps(sessions, ensure_ascii=False)
    if rec.get("proc") is None:
        if web_err:
            fields["last_error"] = f"会话异常: {web_err}"
            fields["last_error_at"] = int(time.time() * 1000)
        else:
            fields["last_error"] = ""
    else:
        exit_code = rec["proc"].returncode
        # 用户主动 stop_card（SIGTERM，returncode=-15）属正常停止，不记错误
        if exit_code and exit_code != -15:
            fields["last_error"] = f"会话退出码 {exit_code}"
            fields["last_error_at"] = int(time.time() * 1000)
        else:
            fields["last_error"] = ""
    # 仅仍在 doing 的卡片自动流转；交互阻塞卡（block_kind='interaction'）在
    # turn 结束时同样流转 review——等待态已随会话结束失效，滞留阻塞列会成死卡；
    # 手动阻塞恒为 block_kind='manual' 不受影响。用户手动拖走的卡两侧都不碰。
    # 搬列（column_key/清阻塞标记）交唯一收尾点的 `to_column` 参数落（v2d 收口轮：
    # finish 的 to_column 由此接上生产调用面，收尾点内「行终态→notify→搬列」
    # 一次表达；finish 内部各子步幂等，顺序差异无副作用）。
    to_review = card["column_key"] == "doing" or (
        card["column_key"] == "blocked" and card["block_kind"] == "interaction")
    if to_review:
        # 交互等待已随会话结束失效：清 watcher 缓存，防 stale pending 卡片
        # 在会话窗持续显示「等待回答」（watch 5s 窗口先于 30s tick 即可能残留）
        _iw_clear(card["session_id"] or "")
    if fields:
        db.update_board_card(card_id, **fields)
    if to_review:
        try:
            feishu.card_review(card["project_id"], card)  # 待审核推送（默认事件关，旁路）
        except Exception:
            pass
    # 收尾：行终态化（唯一收尾点）；to_column 给定且列不同才写（列差守卫）
    finish(f"c:{card_id}", reason, to_column="review" if to_review else None)


def _watch_runs_once():
    """在管会话收尾巡视段（_watch_once 的前半拆分；30s 全量对账节拍）：
    结束会话收尾。

    单族化后条目恒为 dsh（proc=None，会话在 dsh 宿主进程内）：按事件中枢三态
    读实况——running 记 seen_busy；idle 按收尾判据处理；unknown（中枢断连/
    无信号）本轮跳过，下轮再看。
    _STARTING_TIMEOUT_S 内从未见 busy 时：已被 stop（aborted 标记）按正常
    停止收尾，否则经 _web_turn_ran 按 turn 归属基线复核——真跑过（短 turn
    漏观测）按正常收尾，没跑过按「turn 未开始」失败收尾（本阈值即原 90s 宽限
    补丁数值，v2d T3 起与行级 starting 超时对账同源为 _STARTING_TIMEOUT_S）。

    **dsh_plugin（事件源族，P7a 缺陷 D）**：hub 已知时按注册表实况直接判——
    running 记 seen_busy；idle 且（已 aborted 或 turn 基线已推进）立即收尾，
    不必等「某拍观测到 busy」。这样短于巡视节拍的轮次、以及起跑窗口内的停止
    都不用空等 90s 宽限（原先串行位白占 ~71s）。hub 断连（None＝未知）时保持
    现状，绝不把「读不到」推断成「已结束」。

    收尾归属：只有本线程真正从 _RUNS 弹出的条目才收尾——被新会话顶替的旧条目
    不收（其卡片归新条目管）。
    """
    with _runs_lock:
        entries = list(_RUNS.items())
    done = []
    now_ms = int(time.time() * 1000)
    for cid, rec in entries:
        proc = rec.get("proc")
        if proc is not None:
            if proc.poll() is not None:
                done.append((cid, rec))
            continue
        # dsh 条目：读 EventHub 三态（unknown＝断连/无信号，本轮跳过，下轮再看）
        st = _session_state_family(rec["family"], rec["project_dir"], rec["sid"])
        if st == STATE_UNKNOWN:
            continue
        busy = st == STATE_RUNNING
        if busy:
            rec["seen_busy"] = True
            continue
        # 事件源族（dsh_plugin）：hub 是权威实况，**不必等「某拍观测到 busy」**——
        # 短轮（短于 30s 巡视节拍）与「停止于起跑窗口」两种情形都在这里按结论
        # 收尾，否则要空等 _STARTING_TIMEOUT_S=90s 宽限、串行位白占（P7a 缺陷 D）。
        # 只在 hub 已知（非 None＝断连未知）时启用：未知必须保持现状，不推断结束。
        if rec["family"] == "dsh_plugin":
            hub = dshevents.get(rec["sid"])
            if hub is not None:
                if str(hub.get("status") or "") == "running":
                    rec["seen_busy"] = True
                    continue
                if rec.get("aborted"):
                    done.append((cid, rec))
                    continue
                # 基线缺失（起跑时 hub 未连接）时不启用快路径：宁可等宽限，不用
                # 「读不到」推断「已结束」（dshevents 不变量：断连=未知）
                if rec.get("turn_baseline") is not None and _web_turn_ran(rec):
                    done.append((cid, rec))
                    continue
        if rec.get("seen_busy"):
            done.append((cid, rec))
            continue
        if now_ms - rec["started_at"] <= _STARTING_TIMEOUT_S * 1000:
            continue  # turn 启动宽限期内（starting 窗口，行级对账同阈值）
        if rec.get("aborted"):
            # 宽限期内被 stop（turn 未起即 abort，M3）：按正常停止收尾，不判负
            done.append((cid, rec))
            continue
        if not _web_turn_ran(rec):
            rec["error"] = f"turn 未开始（{_STARTING_TIMEOUT_S}s 未见 busy）"
        done.append((cid, rec))
    with _runs_lock:
        popped = []
        for cid, rec in done:
            if _RUNS.get(cid) is rec:  # 防巡视期间条目被新会话顶替
                _RUNS.pop(cid, None)
                popped.append((cid, rec))
    # 只收本线程真正弹出的条目：被新会话顶替的旧条目不重复 _finish_run
    # （见 docstring「收尾归属」）
    for cid, rec in popped:
        _finish_run(cid, rec)


# ---------- starting 超时 + 对账兜底（v2d T3；v2 §2.5.2-5，裁决 R6） ----------

def _unit_evidence_pid(card_id):
    """卡行 evidence 的 pid 读取（R11④ 进程证据读取口；
    无活跃行/无 pid/坏 JSON → None）。"""
    return waitq.evidence_pid(waitq.get_active(waitq.KIND_CARD, card_id))


def _starting_evidence(card):
    """超龄 starting 行的会话证据三态（alive / dead / unknown）+ 判定时读到的
    在管条目（rec，无则 None——dead 处置的身份守卫弹出用）。

    判据链（可证才动、宁多等不误杀——与 unit_liveness / 行对账同哲学）：
    ① 在管条目在场（_RUNS）：
       - dsh（web）：会话 running → alive；会话 idle 且 turn 归属基线未动
         （_web_turn_ran=False，短 turn 漏观测面已排除）→ dead；其余
         （unknown / 短 turn 已跑 / 无基线）→ unknown；
       - CLI（原族，分支保留为防御）：子进程存活 → alive；子进程已退 → unknown
         （会话确曾起过且已结束，错误/会话 id 归因归巡视 _finish_run，本函数不
         预判，防抢走收尾）。
    ② 无在管条目（起跑路径异常残留）：
       - dsh（web）：会话 running → alive（实况在跑——行自愈，收尾仍归巡视）；
         其余（idle/unknown）→ unknown（无基线反证不了「本次未起」，只告警）；
       - CLI（原族，防御）：无存活 pid 证据（行 evidence.pid 缺席或已退）→ dead
         （进程面无在跑：平台已不持有会话，起跑窗口不可能仍在推进）。残余面：
         原 CLI 起进程到登记 `_RUNS` 之间的毫秒级间隙孤儿进程不在本判据覆盖内
         （`_spawn` 已随单族化删除；evidence.pid 由起跑证实写入）——窗口极小，
         且随平台退出/recover 回收。
    """
    cid = card["id"]
    with _runs_lock:
        rec = _RUNS.get(cid)
    if rec is not None:
        proc = rec.get("proc")
        if proc is not None:
            return ("alive" if proc.poll() is None else "unknown"), rec
        st = _session_state_family(rec.get("family"), rec.get("project_dir"),
                                   rec.get("sid") or "")
        if st == STATE_RUNNING:
            return "alive", rec
        if st == STATE_IDLE and not _web_turn_ran(rec):
            return "dead", rec
        return "unknown", rec
    proj = db.get_project(card["project_id"])
    family = _web_family(proj) if proj is not None else None
    if family is None:
        pid = _unit_evidence_pid(cid)             # 进程证据读行 evidence.pid
        if pid is not None and platcompat.pid_alive(pid):
            return "alive", None                  # 进程面确活（orphan 在跑，行自愈）
        return "dead", None                       # 无在管条目 + 无存活进程 = 可证未起
    st = _session_state_family(family, proj["project_dir"],
                               (card["session_id"] or "").strip())
    return ("alive" if st == STATE_RUNNING else "unknown"), None


def _reconcile_starting_rows():
    """starting 行超时对账（v2d T3；调和器 _iw_once 5s 节拍调用）。

    背景（v2 §2.5.2-5，裁决 R6）：c: 行 state=starting = 「拾取→会话证实」窗口
    （claim 后会话尚未证实运行，行即成员占着一个前缀位次）；窗口内的崩溃/异常
    若把行永久钉在 starting，补位器会永远少一个位次。本函数对超龄
    （> _STARTING_TIMEOUT_S=90s，原 WEB_TURN_START_TIMEOUT 数值）行按
    _starting_evidence 复核三态处置：
      alive → waitq.mark_running 自愈（行转 running 留队构成运行前缀，不处置——
              卡列/在管条目全不动）；
      dead  → 行 failed（error="starting 超时"）+ 卡回 meta.from_column（仅当卡
              仍在 doing=起跑窗口未被他路归位）+ finish（唯一收尾点：行收口 +
              补位 notify）+ 告警日志；在管条目随处置弹出（本单元既已判未起，
              放弃其收尾权——否则巡视侧随后按「turn 未开始」再收一遍，把卡列
              改写回 review）；
      unknown → 只告警不处置（「未知 ≠ 结束」，REST 失败/基线缺失）。
    仅 c: 参与：t:/m:/a: 的 starting 是执行全程常态（拾取即持行），其崩溃残留
    归 recover 映射与队列自检（R11 边界沿用）。

    两处 T3 复审收口（v2d T4 顺手）：
    - aborted 条目（用户 stop_card 中断在跑会话）按 unknown 处置：卡死期用户停卡
      的语义是「正常停止」，交巡视侧 `_finish_run` 收尾（rec["aborted"] 已记），
      本函数不得抢先判「starting 超时」失败（否则卡片错误被覆写成超时）；
    - unknown 告警按卡节流（`_STARTING_ALERT_S`，5s 节拍此前每拍一行）——
      滞留卡仍能周期上报，日志不被刷屏。
    """
    cutoff = time.strftime("%Y-%m-%d %H:%M:%S",
                           time.localtime(time.time() - _STARTING_TIMEOUT_S))
    now_ms = int(time.time() * 1000)
    for row in waitq.active_items():
        if row["kind"] != waitq.KIND_CARD or row["state"] != waitq.STARTING:
            continue
        claimed = row["claimed_at"] or ""
        if not claimed or claimed >= cutoff:
            continue                    # 未超龄（口径同为 YYYY-MM-DD HH:MM:SS 字符串）
        try:
            cid = int(row["target_id"])
        except ValueError:
            continue
        card = db.get_board_card(cid)
        if card is None:
            continue                    # 卡行已删：行收口归删除路径/recover（防御）
        try:
            verdict, rec = _starting_evidence(card)
        except Exception:
            verdict, rec = "unknown", None   # 探测异常=状态不明：只告警（R11 口径）
        if verdict == "dead" and rec is not None and rec.get("aborted"):
            verdict = "unknown"             # 用户停卡：交巡视按正常停止收尾（见 docstring）
        if verdict == "alive":
            if waitq.mark_running(waitq.KIND_CARD, cid):
                print(f"[board] starting 超时复核：卡 {cid} 实况在跑 → "
                      f"mark_running 自愈（claimed_at={claimed}）", flush=True)
            continue
        if verdict == "unknown":
            if _starting_alert_due(cid):
                print(f"[board] starting 超时告警（不可证未起，不处置）：卡 {cid}"
                      f" claimed_at={claimed}", flush=True)
            continue
        # dead：可证未起——行 failed + 卡回 from_column + 唯一收尾点 + 告警
        with _runs_lock:
            if rec is not None and _RUNS.get(cid) is rec:
                _RUNS.pop(cid, None)    # 身份守卫同巡视：只弹判定时那条条目
        waitq.finish_by_target(waitq.KIND_CARD, cid,
                               waitq.STATE_FAILED, "starting 超时")
        try:
            meta = json.loads((row["meta"] or "") or "{}")
            if not isinstance(meta, dict):
                meta = {}
        except ValueError:
            meta = {}
        fields = {"last_error": f"starting 超时（{_STARTING_TIMEOUT_S}s 未证实启动）",
                  "last_error_at": now_ms}
        back = str(meta.get("from_column") or "")
        if back not in COLUMNS or back == "doing":
            # force 落表行（from_column=doing，v2b T4）起跑未证实 → 回「待审核」
            # 更准（无外部输入等待语义，v2d 收口轮）；缺失/非法仍沿用旧默认 blocked
            back = "review" if back == "doing" else "blocked"
        if card["column_key"] == "doing":
            # 仅起跑窗口（仍在 doing）回列；卡已被他路归位则只记错误不抢列
            fields.update(column_key=back, block_kind=None, block_text="")
        db.update_board_card(cid, **fields)
        finish(f"c:{cid}", "starting 超时")     # 唯一收尾点：行收口 + notify 补位
        print(f"[board] starting 超时：卡 {cid} 超 {_STARTING_TIMEOUT_S}s 未证实启动 → "
              f"行 failed、卡回 {fields.get('column_key') or card['column_key']}"
              f"（claimed_at={claimed}）", flush=True)


def _heal_queue_placeholders():
    """排队占位缺等待项行自愈（30s 全量对账节拍；2026-10-10 实障卡 936）。

    背景：卡片停在「正在开发」+`block_kind='queue'`（前端「排队中」徽标的**唯一**
    来源，见 `queue_state_of`），但 wait_items 里没有对应的活跃 c: 行。调度权威是
    行——`runner._pick_locked` 只遍历等待项行，行不在场 ⇒ 补位器永远拾不到该卡，
    卡片永久僵在排队态（除用户重按「开始」的幂等补建或服务重启 `board.recover`
    尾段补建外**无任何自愈出口**），项目看着空闲而队列不动。本函数把 `recover`
    尾段那条「占位卡缺等待项行就补建」的对账规则**周期化**：逐张排队占位卡核对，
    行缺失即经 `runner.submit_card` 补建（幂等：行仍在则 `enqueue_card` 复用既有
    行、位次不动；补建落等待区末尾，与 recover 同几何——原排队位次已不可考）。

    跳过四类（都不是「行丢了」，补行反而有害）：
    - 已答待送达（活跃 a: 行在场）：等待单元是 answer 行，本就不建 c: 行
      （`_queue_answer_unit` 单写口径），补 c: 行会让未送达答案与新一轮起跑打架；
    - 独立 worktree 卡：起跑不入队、不落行（spec §47），`block_kind='queue'`
      对它是残留投影，补行等于把它塞回统一队列；
    - 平台在管（`_has_active_run`）：会话在跑、运行行缺失归收尾/调和器兜底，
      此处补行会与在跑会话并发起第二轮；
    - **会话实况在跑**（卡有 sid 且 `dshevents` 注册表报 `running`）：占位卡也可能是
      「会话被外部直跑/重启后行丢失」形态（恢复运行的行未重建），补行会让补位器起跑
      同一会话再投一轮 prompt——行缺失交调和器/收尾路径处理，本函数只补「确实没人在
      跑」的卡（单族化后状态读口零请求、本地注册表；断连/未知不在此列，照常补建）。

    检测到的异常形态各落一行诊断（`[board] 排队占位缺等待项行（占位在、行不在）…`）；
    异常逐卡吞（补建失败也只留一行诊断），不影响其他卡；返回本次补建条数。
    `runner` 单例缺位（调试退化）时只报告不自愈——日志仍如实留痕。"""
    inst = runner.INSTANCE
    try:
        queued = db.list_queued_board_cards()
    except Exception as e:                                  # noqa: BLE001
        print(f"[board] 排队占位自愈扫描失败: {e}", flush=True)
        return 0
    healed = 0
    for card in queued:
        try:
            cid = int(card["id"])
        except (TypeError, ValueError):
            continue                                        # 脏 id：理论项，跳过
        try:
            if (_card_opt(card, "worktree") or "").strip():
                continue                                    # worktree 卡不入队（§47）
            if waitq.get_active(waitq.KIND_CARD, cid) is not None:
                continue                                    # 行在场：正常排队，不动
            if waitq.get_active(waitq.KIND_ANSWER, cid) is not None:
                continue                                    # 已答待送达：单元是答案行
            if _has_active_run(cid):
                continue                                    # 会话在跑：行归收尾路径
            sid = (card["session_id"] or "").strip()
            if sid:
                try:
                    st = dshevents.get(sid) or {}
                except Exception:                           # noqa: BLE001 — 读口异常按未知
                    st = {}
                if st.get("status") == "running":
                    continue                                # 实况在跑：补行会重复投递
            # 占位在、行不在：`enqueue_card` 单事务红线（行+占位原子）声称此形态
            # 「从结构上消失」，出现即异常——先落一行异常报告，再补建
            print(f"[board] 排队占位缺等待项行（占位在、行不在）：c:{cid}"
                  f"（项目 {card['project_id']}）", flush=True)
            if inst is None:
                continue                                    # runner 缺位：只报告
            inst.submit_card(cid)
            healed += 1
        except Exception as e:                              # noqa: BLE001
            print(f"[board] 排队占位补建失败：c:{cid}: {e}", flush=True)
    return healed


def _watch_once():
    """一轮巡视：结束会话收尾（_watch_runs_once）+ 定时到点开工（被门禁拦则
    清定时记错误；起会话失败则把卡置回 todo，避免僵在 doing 无进程）+
    排队占位缺行自愈（`_heal_queue_placeholders`，实障卡 936）。"""
    _watch_runs_once()
    # 排队占位缺行自愈（30s 节拍）：占位在、行不在 ⇒ 补位器永远拾不到，卡片
    # 僵在「排队中」而项目看着空闲。补建规则与 recover 尾段同源（幂等）。
    try:
        _heal_queue_placeholders()
    except Exception:                                       # noqa: BLE001
        pass                                    # 巡视不因自愈失败中断（下一拍再来）
    # 定时扫描：todo 列到点卡片经统一入口进 doing（整库扫描，量小；一律入队
    # （v2b T2 起 parallel 直起废除），门禁语义与手动开始一致）
    now_ms = int(time.time() * 1000)
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT * FROM board_cards WHERE column_key='todo'"
            " AND scheduled_at IS NOT NULL AND scheduled_at<=?", (now_ms,)).fetchall()
    for r in rows:
        proj = db.get_project(r["project_id"])
        if proj is None or proj["archived"]:  # 归档项目不自动开工
            continue
        _, err = _enter_doing(proj, r)
        if err is not None and "blocked" in err:
            # 父任务未 done：清定时记错误（不再每 30s 重试点燃）
            db.update_board_card(r["id"], scheduled_at=None,
                                 last_error=f"定时到点但被门禁拦截（{err['blocked']}）",
                                 last_error_at=now_ms)
        # 起会话失败无需再处理：_enter_doing 已置回 todo（last_error 已由 start_card
        # 记录；scheduled_at 已清不再补），与旧「置回 todo」行为一致
    # session 自动同步：逐项目归类外部 agent 会话（单项目异常不影响其他项目）
    for proj in db.list_projects_all():  # db.py:439 全项目列表（含他用户项目：sync 只读
        # 会话存储+建卡，归属由 project_id 隔离保证）
        if proj["archived"]:  # 归档项目不自动同步
            continue
        try:
            sync_sessions(proj)
        except Exception:
            pass


_SCHED_STARTED = False


def start_scheduler():
    """启动看板调度守护线程（幂等）。30s 全量对账节拍（_watch_once：运行巡视
    + 定时开工 + 会话同步，现状扫尾不变）；节拍间 5s 唤醒一次（原 opencode
    SSE 断流的 5s 轮询兜底已随两族退场删除——单族 dsh 的状态实况由交互调和器
    线程消费事件中枢，本线程只做 30s 全量对账）。"""
    global _SCHED_STARTED
    if _SCHED_STARTED:
        return
    _SCHED_STARTED = True

    def _loop():
        beat = 0
        while True:
            try:
                if beat % 6 == 0:
                    _watch_once()            # 30s 全量对账节拍（现状扫尾不变）
            except Exception:  # 守护线程不 crash 主服务
                pass
            beat += 1
            time.sleep(5)

    threading.Thread(target=_loop, daemon=True, name="board-scheduler").start()


def _recover_web_card(proj, card):
    """web 驱动项目的 doing 卡重启恢复：会话在 dsh 宿主进程内（平台重启不影响），
    按事件中枢实况判定——running 重建 _RUNS 条目（seen_busy=True，proc=None）
    继续 watch，否则归位 review。免日志回捞/杀进程。
    无 session_id 或中枢未连接（读不到）一律归位 review（用户可重新开工）。

    外部直跑卡（origin=sync，v2d T4）：busy 时**不收养为平台单元**——外部会话
    不由平台启动（R13），其占位与收尾归外部条目 ext 行：recover 尾部的
    `_recover_ext_rows` 按项目活跃会话集合重新对账（实况在→ext 行保持 running
    入前缀、占位不丢），空闲时由调和器列映射回 review（≤5s，与收养路径同归）。
    收养行为（建 _RUNS 条目）会把不可控会话伪装成平台
    在管单元——ext 行被 `_platform_holds` 抑制。

    就绪闸（2026-10-08 批次 C，bug_report/20261008_1935）：本函数在启动序里必然
    早于 `dshevents.start()`（server.py 里 board.recover 先于 dshevents.start），
    此刻读任何会话都是「未知」；插件热重载后还会叠加「驱动实例重建、/live 空」
    ——旧口径把「未知」当「空闲」，于是**正在运行的卡**被搬去待审核，且此后
    调和器读不到该会话、自愈无门（实测卡 915）。现在：有 sid 而中枢不可信
    （`dshevents.aligned()` 为 False）⇒ **不搬列**（也不建 _RUNS），保留原列等
    中枢对齐后由调和器按实况归位（`_iw_once`：在场按忙/闲、缺席按「已结束」，
    列写的时机从「未知时」挪到「已知时」）。"""
    family = _web_family(proj)
    sid = (card["session_id"] or "").strip()
    if sid and not dshevents.aligned():
        return                       # 未知 ≠ 空闲：不搬列，交调和器在可信后收口
    busy = False
    if sid:
        try:
            busy = _web_busy(family, proj["project_dir"], sid)  # 插件内存态，零 ensure
        except dshdriver.DshDriverError:
            busy = False
    if not busy:
        # 重启恢复的列回落不置「有更新」标记：这是平台自己重建视图（会话实况已不在
        # ⇒ 卡不该留在开发列），不是「你不在时卡片发生了什么」；否则每次重启都会给
        # 整列 doing 卡（本机实测十余张 sync 卡）一次性打满标记 = 噪音
        db.update_board_card(card["id"], column_key="review", mark_unread=False)
        return
    if (card["origin"] or "") == "sync":
        return                    # 外部直跑：不建 _RUNS（见 docstring）
    log_dir = lib.runtime_dir(proj["work_dir"], runner.LOG_DIR_NAME)
    log_path = os.path.join(log_dir, f"board_{card['id']}_{int(time.time())}.log")
    try:
        runner.append_log(log_path, f"### 服务重启恢复：web 会话 {sid} 仍在运行，继续监视\n")
    except OSError:
        pass  # 日志写不进去不阻断恢复（watch 只依赖 sid）
    with _runs_lock:
        _RUNS[card["id"]] = {"proc": None, "sid": sid, "family": family,
                             # 卡片级工作目录（独立 worktree 卡=其工作树路径，
                             # 与 `_start_web` 记账同口径；普通卡仍是 project_dir）
                             "project_dir": card_workspace(proj, card),
                             "started_at": int(time.time() * 1000),
                             "seen_busy": True, "aborted": False,
                             "turn_baseline": None, "log_path": log_path}


def recover():
    """服务重启恢复：对每张 doing 卡按族归位，最后重建 runner 统一队列。

    dsh 族：走 _recover_web_card（实况 running 重建 watch 条目，否则归位 review）。
    退场族（原 CLI 路径，保留为防御）：回收 sid、杀残留进程组、归位 review。
    逐卡处理：
    1. 在项目 <work_dir>/.web/ 找最新 board_<cid>_*.log（按 mtime）；
    2. parse_session_hint 回收 sid，非空则并入 sessions/session_id 落库；
    3. 按日志里 ### PID 标记 killpg SIGTERM 杀残留进程组（进程可能已死，异常豁免）；
    4. 最后置 review。项目已删的卡直接置 review，跳过 1-3。
    统一队列重建：仍在运行的卡片（实况重建的 _RUNS 条目）重建运行态——
    `card_started`：`enter_running` 置行 running（行即条目，R11「live
    卡重建」）+ 证据落行（desc/reason/pid）；排队占位卡（doing/blocked + queue）
    按 updated_at,id 顺序重新入队。
    c: 等待项非 waiting 行在重建段按 v2a T1 映射收口（裁决 R3：占位/无实况
    starting→cancelled 并对账补建、无实况 running/finishing→failed、实况
    busy→mark_running 证实后由 card_started 保持 running；
    v3a：起跑证实后行 running 跨轮存活，card_started 不再把行标 done）。
    """
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT * FROM board_cards WHERE column_key='doing'").fetchall()
    for r in rows:
        if r["block_kind"] == "queue":
            continue   # 排队占位卡：无运行可恢复，留在开发列（统一队列重建会重新入队）
        proj = db.get_project(r["project_id"])
        if proj is not None and _web_family(proj) is not None:
            _recover_web_card(proj, r)
            continue
        if proj is not None:
            log_dir = lib.runtime_dir(proj["work_dir"], runner.LOG_DIR_NAME)
            logs = glob.glob(os.path.join(log_dir, "board_%d_*.log" % r["id"]))
            if logs:
                log_path = max(logs, key=os.path.getmtime)
                sid = runner.parse_session_hint(log_path)
                if sid:
                    sessions = json.loads(r["sessions"] or "[]")
                    if sid not in sessions:
                        sessions.append(sid)
                    db.update_board_card(r["id"], session_id=sid,
                                         sessions=json.dumps(sessions, ensure_ascii=False))
                # PID 标记写在日志头（原 CLI 起进程后立即落；`_spawn` 已删除），
                # 读头部窗口足够
                try:
                    with open(log_path, encoding="utf-8", errors="replace") as f:
                        head = f.read(65536)
                    m = runner.PID_MARK_RE.search(head)
                except OSError:
                    m = None
                if m:
                    try:
                        platcompat.kill_tree(int(m.group(1)), signal.SIGTERM)
                    except (ProcessLookupError, PermissionError, OSError):
                        pass  # 进程可能已随重启消失
        # 同 `_recover_web_card`：重启恢复的列回落是平台重建视图，不置「有更新」标记
        db.update_board_card(r["id"], column_key="review", mark_unread=False)
    # 统一队列重建：运行中的卡片补回运行行（有 proc 在手补 evidence.pid——CLI
    # 判据，供自检 R11④ 进程存活裁活；P5 R10）；排队卡片按序重新入队
    if runner.INSTANCE is not None:
        with _runs_lock:
            live = list(_RUNS)
        live_set = set(live)
        # —— c: 等待项行重启映射（v2a T1，裁决 R3；先于下方 card_started 重建段
        # 定行态——重建段的 enter_running 只负责「行置 running/建行」，行态裁决
        # 归本段）。waiting 行不动（存活）；实况 busy（web 会话在跑，_RUNS 已
        # 重建）的 starting 行 mark_running 证实（running/finishing 保持；v3a 起
        # running 行即跨轮存活的运行成员，重启后继续在队）；无实况
        # starting→cancelled（占位卡由下方对账补建重新入队=卡归位，已起跑卡已在
        # 上方归位 review）；无实况 running/finishing→failed（卡已归 review）——
        for r in rows:
            wrow = waitq.get_active(waitq.KIND_CARD, r["id"])
            if wrow is None or wrow["state"] == waitq.STATE_WAITING:
                continue
            if r["id"] in live_set:
                if wrow["state"] == waitq.STATE_STARTING:
                    waitq.mark_running(waitq.KIND_CARD, r["id"])
            elif wrow["state"] == waitq.STATE_STARTING:
                waitq.cancel(waitq.KIND_CARD, r["id"], "服务重启中断")
            else:
                waitq.finish_by_target(waitq.KIND_CARD, r["id"],
                                       waitq.STATE_FAILED, "服务重启中断")
        # —— c: 行全表兜底扫描（v2a T1 minor 收口，v2d T1）：上方循环只覆盖
        # doing 卡；非 doing 卡的活跃 c: 行（结构性不可达——doing+queue 单态，
        # 防御纵深）按同口径收口。非 doing 卡必不在 live_set（_RUNS 重建只对
        # doing 卡），即恒无实况：starting→cancelled、running/finishing→failed
        # 「服务重启中断」；waiting 行不动（重启存活语义）；兜底不搬列（列归位
        # 归上方 doing 卡主循环）。
        covered = {r["id"] for r in rows}
        for wrow in waitq.active_items():
            if wrow["kind"] != waitq.KIND_CARD \
                    or wrow["state"] == waitq.STATE_WAITING:
                continue
            try:
                wcid = int(wrow["target_id"])
            except ValueError:
                wcid = None
            if wcid is not None and wcid in covered:
                continue
            if wrow["state"] == waitq.STATE_STARTING:
                waitq.cancel(waitq.KIND_CARD, wrow["target_id"], "服务重启中断")
            else:
                waitq.finish_by_target(waitq.KIND_CARD, wrow["target_id"],
                                       waitq.STATE_FAILED, "服务重启中断")
        for cid in live:
            c = db.get_board_card(cid)
            if c is not None:
                if (_card_opt(c, "worktree") or "").strip():
                    # 独立 worktree 卡（2026-10-06 批次）：起跑即**不落队列行**，
                    # 这里不能补建——card_started→waitq.enter_running 会「行缺失则
                    # 建行」，重启后凭空多出一条占项目运行位的 c: 行，等于把免排队
                    # 的卡重新塞回队列（plan §2.2 唯一需要补守卫处）。运行事实由
                    # `_recover_web_card` 重建的 `_RUNS` 条目承担，收尾照常走
                    # `_finish_run`→`finish`（无行幂等）。
                    continue
                ext = {"reason": "recover 重建"}
                with _runs_lock:
                    rec = _RUNS.get(cid)
                if rec is not None and rec.get("proc") is not None:
                    ext["pid"] = rec["proc"].pid
                # card_started 经 enter_running 确保行 running（上方行映射段
                # 已把实况 busy 的 starting 行标 running；行缺失/终态时在此补齐
                # 建行）——不再把行标 done（旧口径把跨轮状态另立表征）。
                # 同一入口把 desc/reason/pid 证据写入行 evidence（判活读行）
                runner.INSTANCE.card_started(cid, c["project_id"], ext=ext)
        queued = db.list_queued_board_cards()
        # 重建入队前刷新外部条目（ext 行重启映射，v2d T4；v2 §5 第 4 条）：
        # 先于 submit_card 的 notify——否则重启后首个调和 tick（≤5s）前外部会话
        # 在跑也会被立即拾起，竞态窗口照旧。刷新面=有 ext 行的项目 ∪ 有排队卡的
        # 项目（v2d 收口轮评审项 2：停机期间起跑的外部会话行尚未落表，只按「有行
        # 的项目」刷新会漏）；逐项目按活跃会话集合精确对账：实况仍在 → 行保持
        # running（外部会话不受平台重启影响，占位不丢）；实况空闲/不可查（CLI 族）
        # → finish 收口让出前缀位次（补位时机③）。
        if _recover_ext_rows(queued) and runner.INSTANCE is not None:
            runner.INSTANCE.notify_busy_change()
        for c in queued:
            if waitq.get_active(waitq.KIND_CARD, c["id"]) is None:
                # P4 对账：waiting 行存活的卡不动（位次以表 seq 为准，不再按
                # updated_at,id 重排——变更②）；仅行缺失才补建
                runner.INSTANCE.submit_card(c["id"])


# ---------- Jira 导入（服务端 urllib 代理，避免浏览器 CORS；凭据不落地浏览器） ----------

JIRA_TIMEOUT = 10  # 秒


def _jira_get(cfg, path):
    """Jira GET（Basic Auth）。返回 (status, json_or_text)；网络异常返回 (0, 错误串)。"""
    url = cfg["url"].rstrip("/") + path
    token = base64.b64encode(f"{cfg['user']}:{cfg['token']}".encode()).decode()
    req = urllib.request.Request(url, headers={
        "Authorization": f"Basic {token}", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=JIRA_TIMEOUT) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")[:500]
    except (urllib.error.URLError, OSError, ValueError) as e:
        return 0, str(e)


def jira_myself(cfg):
    """测试连接：GET /rest/api/3/myself。返回 {"ok", "name"|"error"}。"""
    if not (cfg.get("url") and cfg.get("user") and cfg.get("token")):
        return {"ok": False, "error": "请填全 Jira 地址 / 用户名 / token"}
    status, data = _jira_get(cfg, "/rest/api/3/myself")
    if status == 200 and isinstance(data, dict):
        return {"ok": True, "name": data.get("displayName") or data.get("name") or ""}
    return {"ok": False, "error": f"HTTP {status}: {data if isinstance(data, str) else json.dumps(data)[:200]}"}


def jira_import(project_id):
    """导入当前用户未解决的 Jira 工单为看板卡片（jira_key 去重，最多 50 条）。"""
    cfg = settings_of(project_id)["jira"]
    if not (cfg.get("url") and cfg.get("user") and cfg.get("token")):
        return {"ok": False, "error": "请先在设置中配置 Jira"}
    jql = urllib.parse.quote(
        "assignee=currentUser() AND resolution=Unresolved ORDER BY updated DESC")
    status, data = _jira_get(cfg, f"/rest/api/3/search?jql={jql}&maxResults=50")
    if status != 200 or not isinstance(data, dict):
        return {"ok": False, "error": f"HTTP {status}: {str(data)[:200]}"}
    existing = {r["jira_key"] for r in db.list_board_cards(project_id) if r["jira_key"]}
    added = skipped = 0
    for issue in data.get("issues") or []:
        key = issue.get("key") or ""
        if not key:
            continue
        if key in existing:
            skipped += 1
            continue
        fields = issue.get("fields") or {}
        summary = (fields.get("summary") or key)[:200]
        desc = f"Jira: {cfg['url'].rstrip('/')}/browse/{key}"
        db.insert_board_card(project_id, f"[{key}] {summary}", desc, jira_key=key)
        added += 1
    return {"ok": True, "added": added, "skipped": skipped}


# ---------- 容器迁移 = 出队（卡离开「正在开发」容器即行收口；v3b 让行退场） ----------

def _dequeue_card(card_id, reason="", to_column=None, mark_unread=True):
    """出队收口（v3b 行收口唯一实现）：卡离开「正在开发」容器即出队。

    容器语义（设计 §2.1 I1）：只有「正在开发」是调度队列；卡迁移到阻塞 / 待审核 /
    已完成 / 删除时行随之收口——不再有独立的「释放占用」动作与触发判据。等待区行
    （含无活跃行时的占位投影）经 waitq.cancel_card_wait 取消（行 + 占位单事务），
    运行行经唯一收尾点 `finish(f"c:<id>")` 终态化（finishing→done +
    补位唤醒）；to_column 给定则一并归位（列差守卫，与 finish 的搬列同语义）。
    无活跃行时各子步幂等 no-op；finish 在 runner 缺位时只归位不收行（退化路径，
    同唯一收尾点）。

    `starting` 行处置（v3 终审修复补记，行为不变）：本原语**既不取消也不收口
    starting 行**——起点行的终态归属「拾取方」：worker finally 的 `c:` 分支
    （起跑失败 → failed「起会话失败」/ 状态不符 → cancelled「卡片状态不符」）与
    starting 超时对账 `_reconcile_starting_rows`（可证未起才 failed + 卡回列）；
    本原语对它的作用只剩「finish 的搬列/补位子步」。不顺手 cancel 的理由：起点
    行可能正被 worker 起会话，抢标会与拾取方抢同一行的终态标签（v2b fix round 1
    口径，`card_finished` 门禁同源）；起跑失败终态化后路径仍经 `finish` 收口占位
    （`dequeue_start`/worker finally 双调幂等）。

    mark_unread 透传给 finish 的搬列（2026-10-07 批次）：用户本人操作导致的出队
    （`stop_card` 停止→待审核）传 False，不给自己置「有更新」标记。
    """
    row = waitq.get_active(waitq.KIND_CARD, card_id)
    if row is None or row["state"] == waitq.WAITING:
        # 等待区行取消（行 + 占位投影单事务）；无活跃行时只剩占位投影清理（原
        # delete_card_cleanup「无条件清占位」语义保留；投影不在场/no 行时 no-op）
        waitq.cancel_card_wait(card_id, reason)
    finish(f"c:{card_id}", reason, to_column=to_column, mark_unread=mark_unread)


def _leave_doing(card, stop=True, reason=""):
    """卡离开「正在开发」容器（v3b 统一原语，替代原让行动作 `_blocked_yield`）。

    stop=True（手动拖入阻塞 / 拖离开发列 / 删除等路径）：先停会话——stop_card
    内含取消本卡排队消息 / 放弃待送达答案，「非 doing 列不得有活会话」。
    stop=False（交互挂起自动落阻塞路径）：只收行——abort 会清掉等待用户答复的
    pending 提问，且该会话在用户作答后照常续跑，不属「停止」语义。
    随后经 `_dequeue_card` 出队收口（行终态化 + 补位唤醒），
    统一队列立刻可补位下一个单元。
    2026-09-13 起平台不做任何提交（工作区改动由外部 hook 扩展在提问/回合结束
    时机提交，原 kimi-hooks 扩展已随 kimi 族退场，平台不介入）。
    """
    if stop:
        stop_card(card["id"])
    _dequeue_card(card["id"], reason)


# ---------- 会话归档同步（看板「已完成」⇄ dsh 归档集，2026-10-05） ----------
#
# 语义（用户口径）：卡片在「已完成」⟺ 卡片**主会话**在 dsh 归档集里；卡片在
# 「已完成」时其**全部**绑定会话都应归档，离开「已完成」时全部取消归档。
# 两个写者：① 平台拖拽/起跑（`move_card` / `_enter_doing`，归档先行）；
# ② 用户在 dsh GUI 里归档/取消归档（调和器按 `dshevents` 归档集快照反向搬列）。
# 失败口径（用户确认）：用户动作路径**硬失败**——归档不成则本次移列整体放弃
# （本次已改动的 sid 补偿回滚），server 端点按 400 报给前端；「会话不存在」
# （宿主 410）属无同步对象，跳过该 sid 放行、卡片记一行 last_error 提示。
# 调和器路径（dsh 侧已改，回滚不了）best-effort + 内存退避重试。

ARCHIVE_SYNC_ENV = "TS_ARCHIVE_SYNC"   # "0" 关闭归档同步（应急开关，默认开）
_ARCHIVE_TIMEOUT_S = 10                # 单次归档调用超时（驱动是宿主进程内调用，够用）
_ARCHIVE_RETRY = {}                    # sid -> [尝试次数, 下次时间, 目标态]
_ARCHIVE_RETRY_LOCK = threading.Lock()
_ARCHIVE_RETRY_MAX = 5                 # 重试次数上限（退避 5s→10s→20s→40s→80s）
_ARCHIVE_RETRY_BASE_S = 5.0
_ARCHIVE_RETRY_TICK_MAX = 8            # 每轮调和最多重试几个（防单轮打爆）
# 外部取消归档的**边沿**检测（sid -> 上次观测到的归档态）：只在 True→False 且卡片
# 在 done 时动作——归档失败/断连（未知）不会把卡片踢出「已完成」（电平语义会抖动）。
_ARCH_SEEN = {}
_ARCH_SEEN_MAX = 4096                  # 超限时按本轮在场集合清理（内存有界）


def archive_sync_enabled():
    """归档同步总开关（`TS_ARCHIVE_SYNC=0` 关闭；默认开）。"""
    return os.environ.get(ARCHIVE_SYNC_ENV, "1") not in ("0", "false", "False")


def _card_sids(card):
    """卡片全部绑定会话 id（主会话在前、去重去空）。"""
    out = []
    main = (card["session_id"] or "").strip()
    if main:
        out.append(main)
    try:
        sids = json.loads(card["sessions"] or "[]")
    except ValueError:
        sids = []
    if isinstance(sids, list):
        for sid in sids:
            s = str(sid or "").strip()
            if s and s not in out:
                out.append(s)
    return out


def _archive_call(sid, archived):
    """单会话归档/取消归档：返回 `"ok"` / `"unknown"` / 错误串。

    `"unknown"` = 宿主明确回报「会话不存在」（`ARCHIVE_UNKNOWN_SESSION`）——
    调用方跳过该 sid（无同步对象），不算失败。
    """
    try:
        dshdriver.archive(sid, archived=archived, timeout=_ARCHIVE_TIMEOUT_S)
        return "ok"
    except dshdriver.DshDriverError as e:
        if e.code == dshdriver.ARCHIVE_UNKNOWN_SESSION:
            return "unknown"
        return str(e)
    except Exception as e:               # noqa: BLE001 — 归档面任何异常都不许打穿移列
        return str(e)


def _record_card_error(card_id, text):
    """给卡片记一行 last_error（归档同步的跳过/失败提示；写失败绝不上抛）。"""
    try:
        db.update_board_card(card_id, last_error=str(text)[:200],
                             last_error_at=int(time.time() * 1000))
    except Exception:
        pass


def _archive_card_sessions(card, archived, reason="", strict=True):
    """把卡片全部绑定会话置为归档（True）/取消归档（False）。

    返回 None=到位（含卡片无绑定会话、开关关闭、独立形态无 dsh 宿主）；
    strict=True 时返回错误串=调用方须放弃本次移列（server 端点 400 报前端），
    且本次已改动的 sid 已**补偿回滚**到改动前状态。
    strict=False（调和器级联：dsh 侧已改、回滚不了）只记日志 + 退避重试。

    会话不存在 → 跳过并记 last_error 提示（历史遗留 sid / 会话存储已删）。
    补偿只回滚「本次确实改动过、且改动前状态已知为相反值」的 sid——中枢未连接
    （归档集未知）时不猜，宁可留一次告警也不误改用户既有的归档。
    """
    if not archive_sync_enabled() or not dshdriver.configured():
        return None                      # 关闭 / 独立形态：没有 dsh 宿主可同步
    sids = _card_sids(card)
    if not sids:
        return None
    prior = dshevents.archived_set()     # None=未知（补偿判据见 docstring）
    changed = []                         # 本次确认改动的 sid
    skipped = []                         # 会话不存在（无同步对象）
    failed = []                          # [(sid, err)]；传输类失败通常连带，取首个即可
    for sid in sids:
        if prior is not None and (sid in prior) == bool(archived):
            # 已知已到位：归档集快照说它已是目标态 ⇒ 不必再打驱动（级联归档时主会话
            # 通常已在集合里，省一次幂等调用；快照陈旧也不影响正确性）
            continue
        res = _archive_call(sid, archived)
        if res == "ok":
            changed.append(sid)
        elif res == "unknown":
            skipped.append(sid)
        else:
            failed.append((sid, res))
            if strict:
                break                    # 用户路径：首次失败即回滚收口（不再打后续 sid）
    verb = "归档" if archived else "取消归档"
    if failed and strict:
        for sid in reversed(changed):
            was = None if prior is None else (sid in prior)
            if was is (not archived):    # 原本状态与目标相反 ⇒ 本次真改过
                _archive_call(sid, not archived)
        sid, err = failed[0]
        msg = f"会话{verb}失败：{sid}（{err}）"
        _record_card_error(card["id"], msg)
        return msg
    if failed:
        for sid, err in failed:
            _archive_retry_add(sid, archived, err)
        print(f"[board] 归档同步未到位（{reason or '调和'}）：{len(failed)} 个会话待重试",
              flush=True)
    if skipped:
        _record_card_error(card["id"], f"归档跳过（会话不存在）: {skipped[0]}")
    return None


def archive_bound_session(card, sid, reason="新绑定会话"):
    """卡片在「已完成」时把新绑定的会话也归档（I2 维护；best-effort + 退避重试）。

    调用点：server 改卡端点的 `bind_session`（含 fork / 压缩新建后的绑定）——绑卡
    动作本身已生效，这里失败**不回滚绑定**（回滚会话列表代价更大），只记 last_error
    + 进退避重试；卡片不在 done / 开关关闭 / 独立形态一律 no-op。
    """
    if card is None or not sid:
        return
    if card["column_key"] != "done":
        return
    if not archive_sync_enabled() or not dshdriver.configured():
        return
    res = _archive_call(sid, True)
    if res == "unknown":
        _record_card_error(card["id"], f"归档跳过（会话不存在）: {sid}")
    elif res != "ok":
        _archive_retry_add(sid, True, res)
        _record_card_error(card["id"], f"会话归档失败（待重试）：{sid}")


def _archive_retry_add(sid, archived, reason=""):
    """登记一个待重试的归档/取消归档 sid（指数退避；次数用尽告警一次并放弃）。"""
    now = time.time()
    with _ARCHIVE_RETRY_LOCK:
        item = _ARCHIVE_RETRY.get(sid)
        attempts = (item[0] if item else 0) + 1
        if attempts > _ARCHIVE_RETRY_MAX:
            _ARCHIVE_RETRY.pop(sid, None)
            print(f"[board] 归档重试放弃：{sid}（{reason}）", flush=True)
            return
        delay = min(_ARCHIVE_RETRY_BASE_S * (2 ** (attempts - 1)), 300.0)
        _ARCHIVE_RETRY[sid] = [attempts, now + delay, bool(archived)]


def _archive_retry_tick():
    """调和器节拍里的归档重试（每轮最多 `_ARCHIVE_RETRY_TICK_MAX` 个）。

    只服务调和器级联（strict=False）留下的未到位项；用户动作路径失败即回滚，
    不留待重试状态。
    """
    if not archive_sync_enabled() or not dshdriver.configured():
        return
    now = time.time()
    with _ARCHIVE_RETRY_LOCK:
        due = [(sid, int(v[2])) for sid, v in _ARCHIVE_RETRY.items() if v[1] <= now]
        due = due[:_ARCHIVE_RETRY_TICK_MAX]
        for sid, _want in due:
            _ARCHIVE_RETRY.pop(sid, None)     # 取出即摘（失败会重新登记、次数累计）
    for sid, want in due:
        res = _archive_call(sid, bool(want))
        if res not in ("ok", "unknown"):
            _archive_retry_add(sid, bool(want), res)


def _archive_unarchive_edge(card):
    """观测到「dsh 取消归档」边沿（True→False）且卡片在「已完成」→ 归位「待审核」。

    用户口径（2026-10-05②）：任一方改状态另一方同步——dsh 侧取消归档，卡片离开
    「已完成」；按 I2 顺带把其余绑定会话也取消归档（best-effort + 重试）。
    read-verify-write：写前重读卡片与归档态，状态已变/未知即跳过（防旧判定覆盖）。
    搬列经统一出队原语（`to_column` 落列 + 行收口），与 `_iw_apply` 同款。
    """
    cur = db.get_board_card(card["id"])
    if cur is None or cur["column_key"] != "done":
        return
    if dshevents.archived(cur["session_id"] or "") is not False:
        return                            # 已变/未知：不动作
    _dequeue_card(cur["id"], "dsh 取消归档同步", to_column="review")
    _archive_card_sessions(cur, False, "取消归档级联", strict=False)


# ---------- session 自动同步（外部 agent 会话 → 看板卡片归类） ----------

# 退场族 busy 近似（原 CLI 族，保留为防御）：会话文件 mtime 距今小于该秒数
# 视为运行中（mtime 语义随族而异，如 hermes 是 started_at=会话开始时间而非
# 最后活动，近似语义为「刚开始不久」）
SYNC_BUSY_MTIME_S = 120

# sync 卡标题/描述口径（2026-10-10 改）：标题 = DSH **当前**会话标题（末枚
# `session/title` 事件，与 dsh GUI 侧栏 last-wins 一致——DSH 侧 LLM 自动标题 /
# 用户改名后，同步节拍跟着改卡标题）、描述 = 主会话第一次用户提问**全文**。
# 旧口径（2026-10-07~10-10：「首问首行进标题、其余行进描述」）已退场，存量卡由
# `_sync_card_follow` 在首个同步拍回填（详见 board spec §48）。
SYNC_TITLE_MAX = 200   # 标题上限（沿用建卡既有截断：insert_board_card 调用处 [:200]）
SYNC_DESC_MAX = 2000   # 描述上限（防一次长提问把看板负载撑大）

# 已跑过「存量子代理卡软删收口」的项目 id（`sync_sessions` 尾巴，2026-10-07）。
# 枚举侧过滤后不会再产生子代理卡，故每项目一轮足够；也保证用户从回收站还原后
# 不被反复软删（进程重启后重建空集，重跑一轮幂等）。
_SYNC_SUBAGENT_SWEPT = set()

# 已跑过「存量误建卡软删收口」的项目 id（`sync_sessions` 尾巴，2026-10-09）：
# 历史版本建出的两类卡——**平台自己持有会话的卡**（B 类：任务 / 飞书会话被当成
# 外部会话重复投影）与**空会话占位卡**（A 类：会话一个字都还没有就投影出
# `session-xxxx`）——新版一律不再产生，存量按同款「每项目一轮 + 软删可还原」
# 口径收口（理由与边界见 `sync_sessions` 尾巴注释）。
_SYNC_MISBUILT_SWEPT = set()


def _split_first_prompt(text):
    """首问原文 → (首行, 其余行)：仅服务**回落标题**与**旧口径描述识别**。

    - 首行超 SYNC_TITLE_MAX 的溢出部分并入其余行开头（截断不丢内容）；
    - 其余行超 SYNC_DESC_MAX 截断并补省略号；
    - 原文为空 → ('', '')（调用方自行兜底标题）。

    新口径下卡标题取 DSH 当前标题、描述取首问全文，本函数不再直接产生卡面字段；
    保留是因为两处仍要「旧口径形态」的字符串：无标题事件时以首问首行回落成标题
    （`_sync_card_fields`），以及判定卡描述是否仍是旧口径自动写入（`_sync_card_follow`）。
    """
    text = (text or "").strip()
    if not text:
        return "", ""
    lines = text.split("\n")
    first = lines[0].strip()
    rest = "\n".join(lines[1:]).strip()
    if len(first) > SYNC_TITLE_MAX:
        overflow = first[SYNC_TITLE_MAX:].strip()
        rest = "\n".join(x for x in (overflow, rest) if x)
        first = first[:SYNC_TITLE_MAX]
    if len(rest) > SYNC_DESC_MAX:
        rest = rest[:SYNC_DESC_MAX] + "…"
    return first, rest


def _full_first_prompt(text):
    """首问原文 → 卡描述：首问**全文**（去首尾空白；超 SYNC_DESC_MAX 截断补省略号）。

    与 `_split_first_prompt` 的「其余行」不同——不再丢掉首行（标题已由 DSH 会话
    标题承担，描述要的是完整提问）。
    """
    raw = (text or "").strip()
    if not raw:
        return ""
    return raw[:SYNC_DESC_MAX] + "…" if len(raw) > SYNC_DESC_MAX else raw


def _is_empty_session(item):
    """空会话判定（A 类闸，2026-10-09）：会话已存在但**还没有任何内容**。

    「有内容」= 有首问（`first_prompt`）或有会话标题事件（`title`）——两者都空
    的会话就是用户刚在 dsh 侧建出来、一句话还没说的空壳。历史版本会给它建一张
    `session-xxxx` 占位卡（等首问落盘再补齐标题），对用户表现为「看板上凭空
    冒出一张没标题的卡」；新口径改为**不投影**，等首问/标题落盘后的下一个
    30s 节拍再建卡（届时标题口径直接正确，不再需要兜底与补齐两步）。

    item 缺失（会话已不在本次枚举里，如存储被删）返回 False——那种情况交既有
    「存储被删→done」规则处理，本闸不表态。
    """
    if not item:
        return False
    return not str(item.get("first_prompt") or "").strip() \
        and not str(item.get("title") or "").strip()


def _is_placeholder_card(card, sids):
    """卡面是否仍是「自动写入的占位形态」——存量收口的**前置硬闸**（2026-10-09 二版）。

    占位形态 = 标题为空，或等于主会话 sid 短码（`sid[:12]`，即 `_sync_card_fields`
    的兜底名、`_sync_card_follow` 认的自动写入形态之一）。建卡时首问未落盘才会
    长这样；一旦有首问/任务提示词写进来，标题就成了真实内容。

    为什么要有这道闸：存量收口的另两条判据（会话枚举是否为空 / sid 是否在
    tasks·飞书登记里）都依赖**易变的一次性输入**——首版上线真机首跑就因这种输入
    异常误删 13 张有真实标题的卡（918、697、709 等，事后复算判据全不成立）。
    卡面标题是卡自身的证据，不随会话解析成败摇摆；**真实标题的卡一律不自动收口**
    （宁漏不误删，漏下的交用户自己删）。
    """
    title = (card["title"] or "").strip()
    if not title:
        return True
    # 标题 == 某个绑定会话的 sid 短码（`sids` 是集合，故用 any 而非取首元素）
    return any(title == str(s or "").strip()[:12] for s in sids if s)


def _platform_owned_sids(project_id):
    """本项目「平台自己持有会话位」的 sid 集合（B 类闸，2026-10-09）。

    sync 卡的定位是**外部直跑会话**（用户在 dsh GUI 里直接跑、平台只是把它
    投影到看板）。平台自己建/持有的会话在平台侧已有入口，再投影一张卡就是
    重复，故建卡前剔除。两个来源：

      - `tasks.session_id`：任务主会话（任务详情 / 日志里已有入口）；
      - `feishu_bindings.cur_sid`：飞书通用对话当前绑定的会话（飞书侧有入口）。

    看板卡自己的会话不用列——`sync_sessions` 的 bound 映射（卡片 sessions 并集）
    已经覆盖。站点会话窗发过消息的会话（`chat_msgs`）**不纳入**：那些会话常常
    正是 dsh GUI 建出来的外部会话（用户从会话窗投一句话而已），纳入会让它们
    永远建不出卡（含「建卡 30s 窗口内先投了消息」的竞态）。

    一次查库、单轮复用；表缺失/结构演进按空集（归因失败绝不影响建卡）。
    """
    sids = set()
    try:
        with db.connect() as conn:
            for sql, args in (
                ("SELECT session_id AS sid FROM tasks"
                 " WHERE project_id=? AND session_id<>''", (project_id,)),
                ("SELECT cur_sid AS sid FROM feishu_bindings"
                 " WHERE cur_project_id=? AND cur_sid<>''", (project_id,)),
            ):
                try:
                    sids.update(str(r["sid"]) for r in conn.execute(sql, args))
                except Exception:
                    continue     # 单表不可用只丢该项，不影响另一项与建卡
    except Exception:
        return set()
    return {s for s in sids if s}


def _sync_card_fields(item, sid):
    """sync 卡平台自动写入形态的 (标题, 描述) 目标值。

    标题 = **DSH 当前会话标题**（`item["title"]` = 末枚 `session/title` 事件，与
    dsh GUI 侧栏一致；无标题事件时回落首问首行、再回落 sid 短码）；描述 = 首问
    **全文**。建卡与 `_sync_card_follow` 补齐共用同一口径（幂等）。

    本函数只被**已通过空会话闸**的调用方调用——首问/标题两者皆空的会话根本不建卡
    （见 `_is_empty_session`）；建卡后 DSH 侧标题自动更新（LLM 标题、用户改名）与
    首问落盘，都由 `_sync_card_follow` 在下一个同步节拍里跟上。
    """
    title = (item.get("title") or "").strip()
    if not title:
        title = _split_first_prompt(item.get("first_prompt") or "")[0]
    if not title:
        title = sid[:12]
    return title[:SYNC_TITLE_MAX], _full_first_prompt(item.get("first_prompt") or "")


def _auto_title_forms(item, sid):
    """平台**可能自动写入过**的卡标题集合（判「卡面标题是否仍属自动写入形态」）。

    含：空、sid 短码、DSH 当前标题、**全部历史标题事件**、旧口径写入的首问首行。
    历史标题事件一项是为「建卡时只有兜底标题、LLM 标题后到」的窗口准备的——那时
    平台写进卡面的兜底标题已不是当前标题，只存在于会话的标题事件历史里；用户手工
    改过的标题不在此集合 ⇒ 整卡不再自动覆盖（尊重用户在卡面的改名）。
    """
    forms = {"", sid[:12]}
    forms.add(((item.get("title") or ""))[:SYNC_TITLE_MAX])
    forms.update(str(t or "")[:SYNC_TITLE_MAX] for t in (item.get("titles") or []))
    forms.add(_split_first_prompt(item.get("first_prompt") or "")[0])
    return forms


def _sync_card_follow(card, item, sid):
    """存量 sync 卡按「DSH 当前标题 + 首问全文」补齐的字段 dict（无变化返回 {}）。

    只认「主会话」：遍历到的会话不是卡的主会话（多会话并集里的子会话）时不动。
    只在卡仍由平台自动写入时动（卡标题 ∈ `_auto_title_forms`：空 / sid 短码 / 任一枚
    会话标题事件 / 旧口径的首问首行）——用户在卡面行内改过标题就整张卡不再自动覆盖
    （描述也不动）。描述仅在为空、或仍是**旧口径自动写入**（首问除首行）时改成首问
    全文；用户写过的描述不覆盖。
    """
    if (card["session_id"] or sid) != sid:
        return {}
    cur_title = (card["title"] or "").strip()
    if cur_title not in _auto_title_forms(item, sid):
        return {}
    title, desc = _sync_card_fields(item, sid)
    out = {}
    if cur_title != title:
        out["title"] = title
    cur_desc = (card["description"] or "").strip()
    legacy_desc = _split_first_prompt(item.get("first_prompt") or "")[1]
    if desc and cur_desc != desc and cur_desc in ("", legacy_desc):
        out["description"] = desc
    return out


def sync_sessions(project):
    """自动同步项目 agent 会话到看板。返回新建卡 id 列表。

    **建卡闸（2026-10-09 两处收窄，用户诉求「看板别再莫名冒卡」）**：
    - A 类 空会话不投影：会话已存在但一句话都还没有（首问/标题皆空）时不建卡，
      等首问或标题落盘后的下一个节拍再建（见 `_is_empty_session`）；
    - B 类 平台自持会话不重复投影：`tasks.session_id` / `feishu_bindings.cur_sid`
      的会话平台侧已有入口，不再当成"外部直跑会话"投影成卡（见
      `_platform_owned_sids`）。

    新建卡（origin='sync'）：标题 = DSH 当前会话标题（无标题事件时回落首问首行、
    再回落 sid 短码）、描述 = 首问全文，绑定主会话，busy→doing / 空闲→review；
    存量 sync 卡：按 DSH 当前标题 + 首问全文补齐（DSH 侧标题自动更新/改名后跟着改；
    用户改过名的不动）+ dsh 族列映射移交调和器（事件驱动），此处仅归档→done（人工拖到
    todo/blocked/done 后不再自动搬）；会话存储被删的 sync 卡自动进 done；绑子代理
    会话的存量 sync 卡收口进回收站（每项目一轮）；上述两类误建卡的存量也按同款
    口径收口（每项目一轮，见函数尾注释）。
    sync 卡不占 runner 项目占用（外部会话平台控制不了，防堵死统一队列）。
    """
    if not settings_of(project["id"]).get("sync_sessions", True):
        return []
    raw_family = runner.agent_family(project["agent_path"])
    # 归族 → 解析族：单族化后只有 dsh_plugin，会话存储解析归 sessparse 的
    # "dsh" 族（与 server._sess_family 的 dsh_plugin→dsh 同口径）；
    # 退场族不在解析白名单内，直接返回空（不建卡不搬列）。
    family = "dsh" if raw_family == "dsh_plugin" else raw_family
    if family not in sessparse.FAMILIES:
        return []
    items = sessparse.list_sessions(family, project["project_dir"])
    cards = db.list_board_cards(project["id"])
    bound = {}  # sid -> 卡片 row（sessions 并集反查）
    for c in cards:
        for s in json.loads(c["sessions"] or "[]"):
            bound[s] = c
        if c["session_id"]:
            bound[c["session_id"]] = c
    # B 类闸的 sid 集合（每轮一次查库，见 `_platform_owned_sids`）
    owned = _platform_owned_sids(project["id"])
    created = []
    for it in items:
        sid = it["sid"]
        archived = bool(it.get("archived"))
        c = bound.get(sid)
        # busy 按需判定（2026-09-27）：只有新卡分支消费 busy；存量 sync 卡只用
        # archived（列映射归调和器），不再为每个会话无条件探测。
        busy = False
        if c is None and not _is_empty_session(it) and sid not in owned:
            busy = _sync_session_busy(project, raw_family, sid, it["mtime"])
        if c is None:
            # A 类闸：空会话不投影（建卡竞态由"等首问"取代旧的"先落 sid 短码
            # 兜底再补齐"——用户在板上看到的将只会有内容的会话）
            if _is_empty_session(it):
                continue
            # B 类闸：平台自持会话（任务/飞书）已有入口，不重复投影成卡
            if sid in owned:
                continue
            title, desc = _sync_card_fields(it, sid)
            cid = db.insert_board_card(project["id"], title, desc)
            # 归档会话：不参与 busy 判定，直接落「已完成」
            col = "done" if archived else ("doing" if busy else "review")
            db.update_board_card(cid, session_id=sid, sessions=json.dumps([sid]),
                                 column_key=col, origin="sync")
            created.append(cid)
        elif c["origin"] == "sync":
            # 首问补齐（2026-10-07）：标题/描述仍是平台自动写入形态时按首问覆盖
            # （覆盖「建卡时提问还没到」的竞态与旧口径的存量卡；用户改过名不动）
            fields = _sync_card_follow(c, it, sid)
            if fields:
                db.update_board_card(c["id"], **fields)
            if c["column_key"] in ("doing", "review") and not _has_active_run(c["id"]):
                # dsh 的 busy/空闲 列映射已移交调和器（事件驱动，异常不搬列）；
                # 此处保留归档→done（archived 来源=list_sessions 的宿主归档集文件读，
                # 与调和器读驱动帧是两条独立通道：文件读不依赖驱动链路，重启/断连时
                # 也能把归档会话归类，故不删——两者同向、幂等）
                want = "done" if archived else None
                if want and c["column_key"] != want:
                    db.update_board_card(c["id"], column_key=want)
    # —— 存量子代理卡收口（2026-10-07 实障修复）——
    # 新口径下 `sessparse.list_sessions` 已过滤子代理会话（不再建新卡），但历史版本按
    # 子代理会话建出的卡还留在板面上（实测全机 72 张、70 张永留「待审核」——子代理
    # 不会被归档、存储也不会被删，归档同步与下面「存储被删→done」两条规则都够不着）。
    # 这里**软删进回收站**（可还原；不删会话文件、不动会话与依赖）。两条边界：
    #   ① 只认 origin='sync' 自动卡——用户自建卡即便绑了子代理会话也是用户的东西，不碰；
    #   ② 每项目只跑一轮——A 之后不会再产生这类卡，一轮足够；用户从回收站**还原**后
    #      同一进程内不会被反复软删（尊重显式操作），进程重启后重跑一轮（幂等）。
    if project["id"] not in _SYNC_SUBAGENT_SWEPT:
        dropped = 0
        for c in cards:
            sids = set(_card_sids(c))
            if c["origin"] != "sync" or not sids or _has_active_run(c["id"]):
                continue
            if any(sessparse.is_subagent(family, s) for s in sids):
                db.trash_board_card(c["id"])
                dropped += 1
        _SYNC_SUBAGENT_SWEPT.add(project["id"])
        if dropped:
            print(f"[board-sync] 子代理会话卡收口: 软删 {dropped} 张"
                  f"（项目 {project['id']}，见 spec/queue/排队与占用.md）")
    # —— 存量误建卡收口（2026-10-09；二版：「卡面占位形态」为前置硬闸）——
    # A/B 两闸只挡新建，历史版本已经建出的两类卡还留在板面上（实测：任务会话卡
    # 12 张、空会话占位卡 10 张，跨 4 个项目）。这里**软删进回收站**（可还原；
    # 不删会话文件、不动会话与依赖、不碰任务的任何记录）。判据与新建闸同源：
    #   ① B 类：卡绑的 sid 是平台自持会话（tasks/飞书）——重复投影，收回；
    #   ② A 类：卡绑的会话**全部**是空会话（首问/标题皆空）——没有任何内容可看；
    #      任一 sid 不在本轮枚举里（存储被删等）即不判空，交「存储被删→done」规则。
    # **首版实障（2026-10-09 当天）**：上述两条都依赖「易变的一次性输入」（会话
    # 枚举的解析结果 / tasks·飞书登记），真机首跑即在三个项目误删 13 张**有真实
    # 标题**的卡（918「现在TS作为DSH的插件…」、697/709 等；事后在库副本上复算，
    # 它们连判据中间值都不成立 ⇒ 属判据输入的一次性异常）。故补**前置硬闸**
    # `_is_placeholder_card`：只收口「卡面标题仍是自动写入占位形态（空 / 主会话
    # sid 短码）」的卡——卡面标题是卡自身的证据，不随会话解析成败摇摆；真实标题
    # （用户提问首行 / 任务提示词首行）一律不自动收口。代价＝标题已补齐的误建卡
    # （任务会话卡）会漏删，交用户自行处理（**宁漏不误删**）。
    # 三条边界与子代理卡收口一致：只认 origin='sync' 自动卡（用户自建卡一字节
    # 不动）、平台在管的运行中卡跳过（`_has_active_run`）、每项目只跑一轮
    # （用户从回收站还原后同一进程内不再被反复软删；重启后重跑一轮，幂等）。
    if project["id"] not in _SYNC_MISBUILT_SWEPT:
        by_sid = {it["sid"]: it for it in items}
        dropped = 0
        for c in cards:
            if c["origin"] != "sync" or _has_active_run(c["id"]):
                continue
            sids = set(_card_sids(c))
            if not sids or not _is_placeholder_card(c, sids):
                continue          # 卡面已有真实标题 ⇒ 非自动占位卡，绝不自动收口
            if any(s in owned for s in sids) or \
                    all(_is_empty_session(by_sid.get(s)) for s in sids):
                db.trash_board_card(c["id"])
                dropped += 1
        _SYNC_MISBUILT_SWEPT.add(project["id"])
        if dropped:
            print(f"[board-sync] 误建卡收口: 软删 {dropped} 张"
                  f"（项目 {project['id']}：平台自持会话卡 / 空会话占位卡，"
                  f"见 board spec §48）")
    # 存储被删 → done（list 只回 50 条，不能用「不在列表」判定删除，必须逐卡查存在性）
    for c in cards:
        if c["origin"] != "sync" or c["column_key"] == "done" or _has_active_run(c["id"]):
            continue
        sids = set(_card_sids(c))
        if sids and not any(sessparse.session_exists(family, s) for s in sids):
            db.update_board_card(c["id"], column_key="done")
    return created


def _sync_session_busy(project, raw_family, sid, mtime):
    """busy 判定：单族化后只有 dsh_plugin——读插件内存态（复用 _web_busy，
    wait=False 传透；EventHub 注册表天然非阻塞）。mtime 近似为 CLI 时代的防御
    残留（退场族走不到本函数：sync_sessions 已按解析族白名单提前返回）。
    异常视为空闲。"""
    if raw_family == "dsh_plugin":
        try:
            return _web_busy(raw_family, project["project_dir"], sid,
                             wait=False)
        except Exception:
            return False
    return (time.time() - mtime) < SYNC_BUSY_MTIME_S


def _has_active_run(card_id):
    """卡片是否有平台在管的运行中会话（_RUNS 条目存在即运行中，同 _watch_once 判定）。"""
    with _runs_lock:
        return card_id in _RUNS


def _wt_in_flight(card_id):
    """worktree 直起窗口在场判定（`_WT_STARTING`，见 `_enter_doing_worktree`）。

    worktree 卡不落 c: 行（「不进统一队列」语义），起跑窗口只能靠这个进程内
    登记集表征：`_wt_start_begin` 在入口登记、`finally` 在 `start_card`（内部
    登记 `_RUNS`）之后才 `_wt_start_end` 释放 ⇒ 在场区间恰好覆盖起跑窗口。"""
    with _WT_STARTING_LOCK:
        return card_id in _WT_STARTING


def _starting_window(card_id, starting_ids=None):
    """卡片是否处于「起跑窗口」：占位保护已解除，但会话尚未证实起跑。

    窗口的成因（2026-10-07 卡 902/903 实障）：`dequeue_start` / `_enter_doing_worktree`
    先落 `doing` + 清 `block_kind='queue'` 占位，**之后**才起会话；而 `_RUNS`
    在 `_start_web` 末尾（create_session → 会话默认值 → turn 基线 → `dsh_send`
    全跑完）才登记。这段 1～2 秒里 dsh 侧读到的 busy=False 是「turn 还没开始」，
    不是「会话已结束」——调和器若据此按忙/闲搬列，正在起跑的卡会被搬去
    「待审核」（用户约定：运行中的卡都在「正在开发」列），且随后 `has_run`
    早退不再自愈，卡片整轮滞留错列。

    三条起跑路径各自的窗口表征：
      - 统一队列路径（含 force 落表行）：c: 行 `state=starting`（拾取 →
        `card_started` 置 running）；
      - worktree 直起路径（无 c: 行）：`_WT_STARTING` 在场（见 `_wt_in_flight`）；
      - 已登记在管条目（`_RUNS`）＝已证实起跑，**一律不算窗口**——正常忙/闲
        映射（含「送达恢复」那种 running 行而无在管条目的形态：会话结束要能
        落回待审核，这条口径不能被本判据吞掉）。
    `starting_ids` 为调用方的批量读口预取值（`waitq.starting_card_ids()`，
    调和器一轮一次），缺省自行单查（`_iw_apply` 写前复核用）。"""
    if _has_active_run(card_id):
        return False
    ids = waitq.starting_card_ids() if starting_ids is None else starting_ids
    return card_id in ids or _wt_in_flight(card_id)


def run_pid(card_id):
    """在管卡会话子进程 pid（无运行条目/web 族无 proc → None；R11④ 进程存活
    裁活的写入侧数据源，落行 evidence.pid）。"""
    with _runs_lock:
        rec = _RUNS.get(card_id)
    if rec is not None and rec.get("proc") is not None:
        return rec["proc"].pid
    return None


def _orphan_hold(card_id):
    """本卡是否持有「无平台在管条目背书」的活跃 `c:` 行（**孤儿运行行**，缺陷 B 判据）。

    生产上唯一的产生面＝作答/立即送达**送达成功**时 `runner.card_started` 补回的
    「送达恢复」/「立即送达」行：那行由平台建，而目标会话是外部/接管会话（平台的
    `_RUNS` 里没有它）⇒ 行没有「在管条目」背书，收口只能靠调和器按实况判定
    （`_starting_window` 的 docstring 早已写明这类形态要能「落回待审核」）。

    为什么必须与 `has_run` 分开判（缺陷 B，T9b 真机 6 轮 5 轮命中）：调和状态机把
    `live_msg`（本卡有排队/执行中的 `m:` 行）算作「在跑」，而**孤儿行本身就在运行
    前缀里**——serial 项目里它把本卡自己的排队消息永久挡在队外
    （`runner._prefix_window_blocked`），状态机又因为那条消息「排队中」判本卡「在跑」
    ⇒ 互等：行不收口、消息永远排不到、该卡与项目后续投递全被挡住（周期自检只打
    `[waitq-selfcheck] 行状态不明（仅告警）`）。故孤儿行只认**实况 busy**。

    池内卡走不到这个形态：同一「送达恢复」动作发生在池内卡上时 `_RUNS` 条目在场
    （`has_run=True`），状态机在 `has_run` 分支早退、行由巡视线程 `_finish_run` 在
    会话空闲时收口（见 `_reconcile_action_for` 的不干预规则）。"""
    return _card_unit_active(card_id) and not _has_active_run(card_id)


# ---------- 交互等待检测（InteractionWatcher，方案 A） ----------
# 单族化后等待态只有 dsh 一个来源：`dshevents` 注册表的 interaction 字段——
# 提问来自 `user-questions/request` waterfall、审批来自 `approval/asked`
# 会话事件（都是 dsh 宿主**推**出来的实况，零请求）。
# → 看板卡片自动移阻塞列（block_kind='interaction'），等待消失自动回「正在开发」。
# 复用看板既有 block_kind/block_text 展示通道，不改表结构。
_IW_LOCK = threading.Lock()
_IW_CACHE = {}          # sid -> {"pending": bool, "text": str, "ts": int}
_IW_STARTED = False


def _dsh_option(raw):
    """dsh 提问选项 → 前端选项对象（{id, label, description}）。

    2026-10-04（修 #791）起插件下发**对象**形态 `{label, description}`
    （dsh `AskUserQuestionOption` 的语义：label 主行 + description 次行，kimi web
    时代同形）；此处对纯字符串形态保持兼容（旧插件/测试替身仍可能给 str）。
    平台侧选项 id 与 label 同值：dsh 的回答只认**选项标签**（selected=[label]），
    平台白名单校验与 `_dsh_answers` 都按该口径（见 `_dsh_answers` docstring）。"""
    if isinstance(raw, dict):
        label = str(raw.get("label") or raw.get("value") or "")
        desc = str(raw.get("description") or "")
    else:
        label, desc = str(raw if raw is not None else ""), ""
    return {"id": label, "label": label, "description": desc}


def _iw_interaction(family, proj, sid, busy_hint=None):
    """读 web 会话实况（等待态 + busy）：返回
    {"pending": bool, "busy": bool, "kind": "question"|"approval"|"",
     "qid": str|None, "question": str|None, "options": list|None,
     "answerable": bool, "text": str}；
    提问另带 questions（**逐题全量**：id/文本/header/body/options/multi_select/
    allow_other/other_label/other_description，1-4 题）与首题平面字段（header/body/
    multi_select/allow_other/other_label/other_description/wire）——供前端渲染
    交互卡片（选项+描述+自定义输入 / 批准-拒绝）。
    options 逐项 = `_dsh_option` 归一后的 `{id, label, description}`（2026-10-04
    起带选项描述，修 #791）；qid 取自插件的提问标识（认领中的提问非空 ⇒
    answerable=True ⇒ 会话窗渲染单选/多选框 + 「提交」）。2026-10-06 修 #837 起
    dsh Web GUI 同时弹同一个提问框（插件的原生作答通道）：两侧都能答、先答者胜，
    GUI 先答时平台迟到作答拿 accepted=false（上层按 40405 收口）。
    异常/无 sid 返回 None（该轮跳过，不误移不报错）。
    单族化后只有 dsh_plugin：读 `dshevents` 注册表（busy 来自 agent/status
    事件，挂起来自 `user-questions/request` waterfall 与 `approval/asked`
    会话事件，都是 dsh 宿主**推**出来的实况）——零请求；未连接/未知 ⇒ None
    （本轮跳过，不误移不报错）。busy_hint 为既有调用面参数（原 opencode
    项目级 busy map 预查值；dsh 分支不消费——实况随注册表一次取全）。"""
    if not sid:
        return None
    try:
        if family != "dsh_plugin":
            return None
        # 路线 A P4：读 EventHub 注册表（原为逐会话 `/status`）——busy 来自
        # dsh 的 agent/status 事件，挂起来自 `user-questions/request`
        # waterfall 与 `approval/asked` 会话事件，都是**推**出来的实况。
        # 未连接/未知 ⇒ None（本轮跳过，不误移不报错）。
        st = dshevents.get(sid)
        if st is None:
            return None
        busy = st.get("status") == "running"
        mark = st.get("interaction") or {}
        # T9 真机取证待办（2026-10-10）：外部会话（owned:false）挂起等作答期间，宿主
        # `status` 是否为 `running` **尚未取证**——本批先按既有口径交付，判据保持不动。
        # 若实测为 `idle`，mark 非空的挂起会被本行判成 pending=False（answerable 随之
        # 丢失、站点上不可答），届时由控制者另派小修复把判据拆开：`mark` 为空 ⇒
        # pending False；`mark` 非空且 `call_id` 非空 ⇒ pending True（`busy` 照实回传，
        # 防陈旧 mark 复活卡片），并补一条对应的反例用例。
        if not busy or not mark:
            return {"pending": False, "busy": busy, "qid": None,
                    "question": None, "options": None,
                    "answerable": True, "text": ""}
        if mark.get("kind") == "approval":
            # 审批：平台**认领**时（`/permission` 接管会话 → 插件在
            # waterfall 里挂起并写 answerable=true）可代答；未认领则由 dsh GUI
            # 作答，平台只展示（answerable=False，按钮置灰）。
            tool = str(mark.get("tool") or "")
            text = f"请求审批：{tool or '工具调用'}"
            return {"pending": True, "busy": True, "kind": "approval",
                    "qid": None, "approval_id": str(mark.get("id") or ""),
                    "tool": tool, "action": tool, "input": "",
                    "question": text, "options": None,
                    "answerable": bool(mark.get("answerable")), "text": text[:80]}
        qs = []
        for idx, q in enumerate(mark.get("questions") or []):
            q = q or {}
            qs.append({
                "id": str(q.get("id") or f"q_{idx}"),
                "question": q.get("question") or "",
                "header": q.get("header") or "",
                "body": q.get("detail") or "",
                "options": [_dsh_option(o) for o in (q.get("options") or [])],
                "multi_select": bool(q.get("multi")),
                "allow_other": True,      # dsh 作答支持自由文本（custom 字段）
                "other_label": "其他",
                "other_description": "",
            })
        q0 = qs[0] if qs else {}
        question = q0.get("question") or "agent 正在等待你的回答"
        # qid 走插件给的 tool call id（= dsh userQuestions.answer 的 callId）：
        # 平台作答链路（answer_interaction → _answer_deliver）原样复用
        call_id = str(mark.get("call_id") or "")
        return {"pending": True, "busy": True, "kind": "question",
                "qid": call_id, "questions": qs,
                "wire": q0.get("id") or "q_0",
                "question": question,
                "header": q0.get("header") or "",
                "body": q0.get("body") or "",
                "options": q0.get("options") or None,
                "multi_select": q0.get("multi_select"),
                "allow_other": True,
                "other_label": "其他",
                "other_description": "",
                "answerable": bool(call_id),
                "text": question[:80]}
    except Exception:
        return None          # 读注册表异常：本轮跳过


# ---------- 外部会话看管声明（C 批 T5，2026-10-10） ----------
#
# 背景：用户在 dsh GUI 里直跑/接管的会话（`/live` 里 `owned:false`）不在驱动池，
# 投递必然 404。驱动侧因此加了 `POST /watch` 显式看管闸（见 dshdriver.watch_session）；
# 平台侧把「声明范围」限定为**平台确实要投递的会话**：有卡的会话（宿主里与 Touchstone
# 无关的会话一律不碰）**加上**宿主上报为外部态（owned:false）的任务侧会话——后者由
# 消息前置闸与作答送达前的 `_watch_before_delivery` 按需补声明（T7 评审 2026-10-10）。
#
# 声明点三处，互为兜底：
#   ① `_iw_once` 逐卡循环内（调和器扫描，覆盖常态）；
#   ② `chat._external_preflight` 投递前置闸内（覆盖「卡刚建、扫描节拍还没跑到」的窗口）；
#   ③ `_watch_before_delivery` 作答/审批送达前（覆盖无卡的**任务侧**外部会话）。
# 撤销：`_watch_prune`（卡删除/换绑会话后回收，防集合无界增长）。
# 失效：`_watch_generation_sync`（中枢重连边沿清空记账后重放，设计 §5.1）。
# 语义：`_WATCHED` 是**进程内缓存**（「已声明过」的记账，避免每轮重复 POST）；
# 驱动侧 `watched` 才是权威。故集合清了只会多打一次幂等的 `/watch`，不会漏声明。
_WATCHED: set[str] = set()
_watch_lock = threading.Lock()
# 看管代次：上次见到的中枢连接代次（`dshevents.stats()["reconnects"]`）。
# None = 本进程尚未对过账（首次读只记基准，不清空——启动时集合本就为空）。
_WATCH_GEN = None
# 扫卡节流窗口（秒，C 批终审 I3，2026-10-10）：`_iw_once` 由**每个状态帧**唤醒
# （仅 IW_MIN_INTERVAL 限速），节拍尾部每轮都调 `_watch_prune()`；而扫卡 =
# `list_projects_all()` 一次连接 + **每项目一次** `list_board_cards()`，只要有任何
# 一个外部会话被看管，全量扫卡就跟着状态帧跑。节流到与调和器兜底拍
# （`IW_SAFETY_SECONDS`=60s，见文件尾）同量级：被节流的只是「扫卡 + 撤销」，
# **只影响回收的及时性**（多留一会儿看管是安全方向）；代次检查是正确性路径，
# 照旧每次进入都做（见 `_watch_prune`）。
WATCH_PRUNE_INTERVAL = 60.0
# 上次真正扫卡的时刻（`time.monotonic()`；0.0 = 本拍该扫）。就地读写都在 `_watch_lock` 内。
_WATCH_PRUNE_AT = 0.0


def _watch_generation_sync():
    """中枢重连边沿 ⇒ 清空 `_WATCHED`；返回是否发生了清空（设计 §5.1 的失效通道）。

    依据：`dshevents.stats()["reconnects"]`——中枢（`dshevents.EventHub`）每次
    「未连接 → 已连接」边沿加一，读口是**纯本地** `with self._cond`（零 HTTP 请求），
    故每次声明前读一次也不打驱动。为什么必须清：驱动侧 `watched` 是插件进程内的
    易失状态（`dispose()` / 插件重新 apply、宿主重载即清空），而平台记账仍写着
    「已声明过」——不清就会一直命中陈旧缓存、不再 POST `/watch`，投递撞驱动 404 落
    error，且卡还在时 `_watch_prune` 不撤 ⇒ 不自愈（bug_report/20261008_1935 记录的
    宿主侧重载场景）。清空只让下一次 `_ensure_watch` 重新声明一次（幂等 POST），
    不会漏声明。
    """
    global _WATCH_GEN
    try:
        gen = dshevents.stats().get("reconnects")
    except Exception:                      # noqa: BLE001 — 读口异常不阻断，下轮再来
        return False
    if gen is None:
        return False
    with _watch_lock:
        prev, _WATCH_GEN = _WATCH_GEN, gen
        if prev is None or prev == gen:
            return False
        _WATCHED.clear()
    return True


def _ensure_watch(sid, force=False):
    """声明「平台看管该会话」（幂等，成功才入缓存）；失败留痕返回 False，不重试。

    先过**代次对账**（中枢重连 ⇒ 陈旧记账作废，见 `_watch_generation_sync`），
    再查缓存：已在 `_WATCHED` 内直接 True（零请求）；否则
    `dshdriver.watch_session(sid)`，驱动确认 `watched=true` 才记进缓存。任何失败
    （旧插件无 `/watch` ⇒ 404、驱动不可达、令牌错）都只打印一行诊断并返回 False
    ——**不重试**：调用方（`chat._external_preflight`）据此拒投并给明确文案，比反复
    打驱动更有用；下一轮调和器扫描会自然重试一次（缓存里没有它）。

    `force=True` 跳过缓存命中、**强制重发一次声明**（成功后照常入缓存）。唯一调用方是
    `rename_card_session` 的 404 重试：那里的 404 恰恰说明「驱动侧认为没看管」，而
    `_WATCHED` 是**平台侧进程内记账**、可能与驱动侧脱节（实测 2026-10-10：带外
    `POST /watch {on:false}`、以及驱动在 `session/disposed` 时自清看管表，
    都会让缓存变陈旧）——缓存命中就不能让它挡住这次重试。
    """
    sid = str(sid or "")
    if not sid:
        return False
    _watch_generation_sync()
    if not force:
        with _watch_lock:
            if sid in _WATCHED:
                return True
    try:
        ok = bool(dshdriver.watch_session(sid))
    except Exception as exc:                       # noqa: BLE001 — 失败降级为拒投
        hint = "（插件过旧：无 /watch 端点，请重装插件并重启 dsh web）" \
            if getattr(exc, "code", None) == dshdriver.WATCH_UNSUPPORTED else ""
        print(f"[board] 看管声明失败 sid={sid}: {exc}{hint}", flush=True)
        return False
    if not ok:
        print(f"[board] 看管声明失败 sid={sid}: 驱动未确认看管（watched=false）",
              flush=True)
        return False
    with _watch_lock:
        _WATCHED.add(sid)
    return True


# 卡面改名的驱动调用超时（秒）：best-effort 的同步链路，快失败比让 HTTP worker 挂满
# 默认 120s 有用（2026-10-10 需求「TS 卡面改名 → DSH 会话名同步」）。
RENAME_TIMEOUT = 10


def rename_card_session(sid, title):
    """卡面改名 → 同步改 DSH 会话标题（best-effort）。返回 `(ok, error, accepted)`。

    两跳（2026-10-10 用户需求，B 档）：
      ① `dshdriver.rename`：覆盖**池内**会话（平台建/恢复过的：任务会话、平台起过的卡、
         会话窗发过消息被 resume 的）；
      ② 首跳 404（池外）⇒ `_ensure_watch(sid)` 声明看管（幂等、**只声明不接管**）后
         重试一次：覆盖用户在 dsh GUI 直跑、驱动只观察的会话——驱动侧 `/rename` 的
         池外回落分支按「看管 + 宿主有活 agent」放行（node 半同批实现）。
    失败**不抛**：卡面是用户的编辑，必须先生效；调用方（server 端点）把原因回给前端。
    `accepted` = 驱动回执里宿主**接受**的标题（可能被 dsh 规范化/按字节预算截断），
    成功时非空——调用方据此回写卡面，保证两侧逐字一致。
    """
    sid = str(sid or "")
    title = str(title or "").strip()
    if not sid or not title:
        return False, "缺少会话或标题，未同步 DSH 会话名", ""
    last = ""
    for attempt in (1, 2):
        try:
            r = dshdriver.rename(sid, title, timeout=RENAME_TIMEOUT) or {}
            return True, "", str(r.get("title") or title)
        except Exception as exc:                   # noqa: BLE001 — 统一降级为原因串
            last = str(exc)
            pool_miss = getattr(exc, "code", None) == 404
            # 只在「池外」这一跳补一次看管声明（已看管无活 agent 的 404 重试同样失败，
            # 但代价只是一次请求，换来判定逻辑不依赖文案匹配）。**force=True**：这一跳的
            # 404 正说明驱动侧认为没看管，平台侧 `_WATCHED` 缓存可能陈旧（带外撤销、
            # 驱动在 session/disposed 时自清），不能被它挡住重发。
            if attempt == 1 and pool_miss and _ensure_watch(sid, force=True):
                print(f"[board] 卡面改名：池外会话补看管声明后重试 sid={sid}",
                      flush=True)
                continue
            break
    return False, last, ""


def _watch_card_refs():
    """看管引用集：全部卡片的 `session_id ∪ sessions`。

    含归档项目（归档 ≠ 删卡，归档项目的在跑会话照旧需要投递通道）。坏 JSON 按
    「无附加会话」防御（与卡片读侧同口径）。
    """
    refs = set()
    for proj in db.list_projects_all():
        for card in db.list_board_cards(proj["id"]):
            sid = str(card["session_id"] or "")
            if sid:
                refs.add(sid)
            try:
                refs.update(str(s) for s in json.loads(card["sessions"] or "[]") if s)
            except ValueError:
                pass                               # 坏 JSON 按无附加会话（防御）
    return refs


def _watch_msg_inflight(sid):
    """该 sid 是否仍有在途消息（活跃 `m:` 行）——看管撤销判据的第二条。

    读口用 `chat.live_of_sid`（内部即既有 waitq 读口
    `waitq.msg_rows(sid=…, states=("queued", "running"))`，不另写 SQL）。
    读不到按「有在途」保守处理：宁可少撤（下轮再试），不可误撤（在途消息送达
    撞驱动 404，正是本任务要消灭的「放行后静默失败」）。
    """
    try:
        return bool(chat.live_of_sid(sid))
    except Exception:                          # noqa: BLE001 — 读不到按「有在途」保守
        return True


def _watch_prune():
    """撤掉**确无需要**的看管声明（`POST /watch {on:false}`），返回撤销条数。

    判据（两条都成立才撤）：
      ① 无卡引用——引用集 = 全部卡片的 `session_id ∪ sessions`，见 `_watch_card_refs`；
      ② 无在途消息——该 sid 已无活跃 `m:` 行，见 `_watch_msg_inflight`。前置闸会为
         **无卡**外部会话放行（飞书绑定会话、任务会话重载后变外部态等 `card_id/
         task_id` 皆空的 submit 路径），此时「无卡引用」≠「无人需要看管」：还在
         `m:` 行里排队的消息一旦被撤看管，送达时 `/prompt` 就撞驱动 404。

    竞态（与前置闸的 TOCTOU）：撤销判据在**同一临界区**内复核，不信任扫描快照
    ——① `_WATCHED` 成员资格在锁内重查（快照之后并发的前置闸可能刚重新声明入集合）；
    ② 在途消息在锁内重查（快照之后可能刚落 `m:` 行）。撤销成功后**再复核一次**：
    窗口内若又冒出新声明/新在途消息（`on:false` 可能压掉了并发的 `on:true`），立即
    补偿重声明——宁可多打一次幂等 `/watch`，不可留「缓存无、驱动无」而在途消息撞
    404。驱动 I/O 全程在锁外（锁纪律：`_watch_lock` 只保护记账集合，绝不跨网络调用）。
    撤销失败的 sid 放回集合等下一轮重试。

    节流（C 批终审 I3，2026-10-10）：本函数由 `_iw_once` **每个状态帧**调用一次，
    而「扫卡」是 O(项目数 × 每项目卡数) 的 DB 读、`_watch_msg_inflight` 还在
    `_watch_lock` 内做 SQLite 查询。故「扫卡 + 撤销」节流到
    `WATCH_PRUNE_INTERVAL`(60s，与调和器兜底拍同量级)：窗口内只剩两件零成本的事
    —— `_watch_generation_sync()`（本地代次读口）与「集合空则返回」。
    **代次检查不参与节流**（它是正确性路径：中枢重连边沿必须立刻作废旧记账，否则
    陈旧缓存永不自愈）；被节流影响的**只有回收的及时性**（最多晚一拍撤销看管——
    多留一会儿看管是安全方向，且在途消息送达不受影响）。
    开销：`_WATCHED` 为空（常态）时零 DB 访问（早于节流判定，也不会消耗窗口——
    新声明入集合后本拍即扫）。
    """
    global _WATCH_PRUNE_AT
    _watch_generation_sync()                   # 中枢重连过：陈旧记账先作废（撤销无意义）
    with _watch_lock:
        if not _WATCHED:
            return 0                           # 常态：零 DB 访问（不消耗节流窗口）
        now = time.monotonic()
        if now - _WATCH_PRUNE_AT < WATCH_PRUNE_INTERVAL:
            return 0                           # 本窗口已扫过：只推迟回收，不影响正确性
        _WATCH_PRUNE_AT = now                  # 开窗（含扫描异常：下一拍再试）
    refs = _watch_card_refs()
    with _watch_lock:
        candidates = sorted(_WATCHED - refs)   # 粗筛快照；最终判据见下面的锁内复核
    n = 0
    for sid in candidates:
        with _watch_lock:
            # —— 撤销前锁内复核（唯一信任点）——
            if sid not in _WATCHED or sid in refs or _watch_msg_inflight(sid):
                continue
            _WATCHED.discard(sid)              # 先出缓存：并发 _ensure_watch 转为重新声明
        try:
            dshdriver.watch_session(sid, on=False)
        except Exception as exc:               # noqa: BLE001 — 留痕，下轮重试
            with _watch_lock:
                _WATCHED.add(sid)              # 撤销失败：放回，下轮再试
            print(f"[board] 看管撤销失败 sid={sid}: {exc}", flush=True)
            continue
        # —— 撤销后复核：窗口内并发落下的新声明 / 新在途消息 ⇒ 补偿重声明 ——
        with _watch_lock:
            redeclared = sid in _WATCHED
            if redeclared:
                _WATCHED.discard(sid)          # 清掉再声明：强制真发一次 POST
        if redeclared or _watch_msg_inflight(sid):
            _ensure_watch(sid)
            continue
        n += 1
    return n


def _watch_before_delivery(sid):
    """送达前对**非池内**（外部）会话重新声明一次看管（C 批 T7 控制器裁定，2026-10-10）。

    为什么必须补（T5 与 T4 两处评审叠加出的真实洞）：`_watch_prune` 的撤销判据是
    「无卡引用 ∧ 无在途 `m:` 行」——**不含活跃 `a:`（作答）行**；驱动的
    `/watch {on:false}` 也不会主动收口在途认领（要等 abort/disposed/dispose）。
    两者叠加：答案已入队未送达、或会话正挂起等作答（用户刚点作答）时点，prune 可能
    已把该 sid 的看管撤掉 ⇒ 送达 `/answer`·`/approval` 撞驱动「未看管」404 ⇒
    `a:` 行落 error，正是本批要消灭的失败类。故作答/审批的**唯一送达出口**
    （`_answer_deliver`，worker 补位与「立即送达」共用）在真正调驱动前补一次声明。

    幂等且廉价：`_ensure_watch` 命中 `_WATCHED` 缓存时是**纯本地判断、零请求**，
    只有缓存/驱动侧确已被撤（prune 撤销、中枢重连失效）才真发一次 `POST /watch`。

    判据用既有读口 `dshevents.get(sid)` 的 `owned`（不新增全局状态、不猜）：
    `owned is False` ⇒ 外部会话（需要显式看管）；`owned is True`（平台自持）与
    `None`（注册表未知/断连——未知 ≠ 外部）一律不声明，与 `chat._external_preflight`
    及 `_iw_once` 逐卡挂钩同一判定阶梯：池内与未知路径行为一个字节不变。
    本函数**不改** `_watch_prune` 判据（「未看管不认领」是驱动侧红线，驱动行为正确），
    只把「撤销窗口里到达的送达」自愈回来。

    失败不阻断（`_ensure_watch` 自带留痕、不重试）：声明失败时驱动同样回 404，由
    调用方既有的重试/放弃语义处置，错误口径与此前一致。

    边界：本钩子**缩小但不关闭** `_watch_prune` 与「在途送达」之间的交错窗口——钩子
    返回后到驱动真正收到 `/answer`·`/approval` 之间仍可能被一次并发 prune 撤掉看管；
    该残留窗口的兜底在**送达重试**（`a:` 行的 3 次退避重试；每次重试都再走一遍本钩子
    重新声明），不为此引入锁或全局状态。
    """
    sid = str(sid or "")
    if not sid:
        return
    st = dshevents.get(sid)
    if st is None or st.get("owned"):
        return                          # 未知（断连/没见过）与平台自持：不碰
    _ensure_watch(sid)


_RECONCILE_FIELDS = {
    # 动作 -> 落库字段（block 的 block_text 由调用方按检测摘录补）
    "recover": {"column_key": "doing", "block_kind": None, "block_text": ""},
    "to_doing": {"column_key": "doing", "block_kind": None, "block_text": ""},
    "to_review": {"column_key": "review", "block_kind": None, "block_text": ""},
    # to_done 生产路径走 `_dequeue_card(to_column="done")`（行收口 + 搬列一体）；
    # 本项为兜底字段表，保持「动作 -> 字段」表完整（勿直写：会漏行收口）
    "to_done": {"column_key": "done", "block_kind": None, "block_text": ""},
}


def _reconcile_action_for(family, card, r, has_run=False, live_msg=False,
                          stop_recent=False, archived=None, starting=False,
                          orphan_hold=False):
    """调和状态机（纯函数，单测覆盖）：按会话实况 r（pending/busy）、归档态
    archived 与当前卡状态得出动作，action ∈
    {'block'（进阻塞+interaction）,
     'recover'（交互阻塞解除回 doing——2026-09-09 起在管运行卡按项目占用
       决定排队/直回（_iw_apply._recover_to_doing），收尾归 _finish_run）,
     'to_doing'（运行中→正在开发）, 'to_review'（空闲→待审核）,
     'to_done'（主会话已被 dsh 归档→已完成，2026-10-05）, None（不动）}。
    `archived`（None=未知/False=未归档/True=已归档）由调用方读 `dshevents.archived`
    （本地注册表，零请求）传入：**True 时优先于一切忙闲判定**直接落 to_done——
    dsh 归档即该会话的终态意图，此时再按 busy/idle 搬列会与归档同步打架；未知
    （None，中枢断连）一律不动作（不变量「断连=未知」）。
    映射规则（无平台在管运行时，设计 §2.4）：提问→blocked(interaction)；
    运行中→doing；空闲→review；阻塞解除按运行态回 doing/review。
    运行判定 running = busy or (live_msg ∧ ¬orphan_hold)（2026-09-11 立，2026-10-10
    加孤儿行例外）：live_msg=本卡会话有排队/执行中的平台消息单元（chat.live_of_sid）
    ——消息排队尚未执行时会话并不 busy，仅凭 busy 会漏判；阻塞列卡片在消息投递后
    即应回开发列（用户约定：所有正在运行的卡片都在「正在开发」列）。
    `orphan_hold`（`_orphan_hold`：本卡有活跃 `c:` 行但无 `_RUNS` 背书，生产上＝
    作答/立即送达补回的「送达恢复」行）**只认实况 busy**：那条行本身就在运行前缀里，
    serial 项目里它把本卡自己的排队消息挡在队外，再把 live_msg 当「在跑」就是互等
    （缺陷 B：行不收口 ⇒ 消息永远排不到 ⇒ 行永远收不了；真机 6 轮 5 轮命中，该卡与
    项目后续投递被永久挡住）。会话可信空闲（busy=False）时这类行必须收口让队列继续
    ——与「送达恢复行按实况落回待审核」的既有口径（`_starting_window`）同源。
    不干预规则：退场族不动（调用方已过滤，此处兜底保纯函数安全）；
    todo/done 终态不动；平台在管运行（has_run=True）的卡只做交互 block/recover、
    busy/空闲流转归 _finish_run 拥有（防与轮收尾抢写）——**唯一例外**是卡片在
    「待审核」而会话确实在跑（起跑窗口误判的遗留形态）→ 归位 doing，见
    `starting` 段与 2026-10-07 批次说明。
    `starting`（起跑窗口，判据见 `_starting_window`）：占位已清、会话尚未证实
    起跑——此窗口内 busy=False 是「turn 还没开始」而非「已结束」，**不做忙/闲
    列映射**，只防御性放行 block（2026-10-07 修卡 902/903：此前正在起跑的
    doing 卡被误判空闲搬去「待审核」，`_RUNS` 登记后早退不再自愈，卡片整轮
    滞留错列——用户约定：运行中的卡都在「正在开发」列）。
    queue 排队占位卡只放行 block（2026-09-10 修复）：占位不等于会话已停——
    运行中卡交互阻塞解除后落 doing/queue 排队等串行位（_recover_to_doing），
    dsh 会话照跑、稍后仍可能再提问；此前 queue 卡被一律跳过，这类提问
    永不被发现，卡片停在「正在开发/排队中」而进不了阻塞列。busy/空闲一律
    不搬列（等串行位的卡不能被 busy 映射回 doing、更不能被空闲映射去待审核，
    列流转与行占位归统一队列拾取与 _finish_run 拥有）。
    manual 手动阻塞卡（2026-09-11 修复）：默认不干预（用户停车位），但会话
    确实在运行时必须回「正在开发」——用户在会话详情页发消息（消息单元驱动
    会话）、外部直跑等都会让手动阻塞卡的会话转起来，此前这类卡片滞留阻塞列
    （真实故障：卡 210）。仅等待用户回答（pending）时维持阻塞态，不升级
    manual 标记；stop_recent=True（卡片刚被平台停过会话，拖入阻塞等）时
    busy 可能是 abort 生效前的残留，不据此回搬（live_msg 不受此限——消息
    驱动是强信号，用户主动发的消息照常回开发列）。
    blocked 且无阻塞标记（2026-09-17 归位）：历史残留态（作答落列写入失败 /
    送达只清标记，卡 388 实障滞留阻塞列两天），运行中（或平台在管）→ to_doing、
    空闲 → to_review；有等待时上面 pending 分支先手，升格 interaction 阻塞。"""
    # 路线 A 打通（2026-10-03 P1）：dsh_plugin 是唯一在族（会话常驻 dsh 宿主），
    # 交互/忙闲实况由 `_iw_interaction` 的 dsh 分支（插件内存态）给出。此前这里
    # 把 dsh 挡在门外，导致 dsh 卡片**永远不进 blocked、也不会自动回列**
    # （对齐缺口，见方案 §2.1 #15）。
    if family != "dsh_plugin":
        return None
    if archived is True:
        # 归档电平优先（2026-10-05）：主会话已归档 ⇒ 卡片归「已完成」，含 todo 卡；
        # 已在 done 即无动作（幂等收敛点，不参与下面的忙闲映射）。
        return None if card["column_key"] == "done" else "to_done"
    if card["column_key"] in ("todo", "done"):
        return None
    pending = bool(r and r.get("pending"))
    busy = bool(r and r.get("busy"))
    # 孤儿运行行只认实况 busy（缺陷 B，见 `_orphan_hold` 与 docstring）：
    # live_msg 不能再把它按「在跑」保住——行恰恰是那条消息起不来的原因
    running = busy or (bool(live_msg) and not orphan_hold)
    if card["block_kind"] == "manual":
        if pending:
            return None                      # 等待用户回答：维持阻塞态
        if stop_recent:
            return "to_doing" if live_msg else None
        return "to_doing" if running else None
    if card["block_kind"] == "queue":
        return "block" if pending else None
    if starting:
        # 起跑窗口（`_starting_window`）：占位已清、会话尚未证实起跑——此时的
        # busy=False 是「turn 还没开始」而非「已结束」，**不做忙/闲列映射**
        # （否则 doing 卡被判空闲搬去待审核；2026-10-07 卡 902/903 实障）。
        # 窗口内提问不可能出现（prompt 还没下发），仅作防御性放行。
        return "block" if pending else None
    if pending:
        if card["column_key"] == "blocked" and card["block_kind"] == "interaction":
            return None                      # 已在交互阻塞，等待作答
        return "block"                       # doing / review → 阻塞
    # 无等待
    if card["column_key"] == "blocked" and card["block_kind"] == "interaction":
        if has_run:
            return "recover"
        return "to_doing" if running else "to_review"
    # blocked 且无阻塞标记（2026-09-17 归位，见 docstring）：历史残留态——作答
    # 落列写入失败 / 送达只清标记（卡 388 实障滞留阻塞列两天）。按会话实况归位：
    # 运行中（或平台在管）→ 回「正在开发」；空闲 → 回「待审核」。
    if card["column_key"] == "blocked" and not card["block_kind"]:
        return "to_doing" if (running or has_run) else "to_review"
    if has_run:
        # 在管运行：列流转归 _finish_run（防与轮收尾抢写）。唯一例外——卡片在
        # 「待审核」而会话确实在跑：只可能来自起跑窗口内的误判（本批次修复前的
        # 遗留形态：窗口内被搬去待审核、`_RUNS` 登记后早退不再自愈），按用户
        # 约定「运行中的卡都在正在开发列」归位。stop_recent 宽限内不搬：刚被
        # 平台停过会话（停止/拖离开发列）的卡，busy 可能是 abort 生效前的残留。
        if card["column_key"] == "review" and running and not stop_recent:
            return "to_doing"
        return None                          # 在管运行：列流转归 _finish_run
    if card["column_key"] == "doing":
        return None if running else "to_review"
    if card["column_key"] == "review":
        return "to_doing" if running else None
    return None


def _iw_apply(family, card, action, r):
    """执行调和动作（read-verify-write）。写库前用 get_board_card 重读当前行，
    并重评 has_run/live_msg/stop_recent/起跑窗口（`_starting_window`）、重跑状态机：
    仅当动作仍成立才写库；
    否则跳过——保护用户手动拖卡/其他写者不被调和窗口内的旧判定覆盖
    （事件快照到落库之间卡状态可能已变/已删；live_msg 实时重取
    ——消息单元刚结束/被取消时状态机结论可能翻转为不动；stop_recent 实时
    重取——窗口内用户刚把卡拖入阻塞时，旧判定不得把它回搬开发列）。
    已答待送达（wait_items 有活跃 answer 等待项）的卡一律跳过：其列归属由作答/送达路径独占
    （作答落 doing/queue、送达执行体归位），此处堵写回竞态——tick 先
    按旧快照（卡在 doing、会话提问中）算出 block，用户随后作答把卡落
    doing/queue，写前复核在 doing/queue + dsh 侧仍 pending 下重评同为 block，
    会把卡写回 blocked/interaction，待送达窗口内卡片漂出「正在开发」列
    （2026-09-17 复现修复；实障卡 389）。"""
    cur = db.get_board_card(card["id"])
    if cur is None:
        return                    # 卡片已删：跳过
    if is_answer_pending(card["id"]):
        return                    # 已答待送达：调和动作一律跳过（见 docstring）
    has_run = _has_active_run(card["id"])
    live_msg = chat.live_of_sid((cur["session_id"] or "").strip())
    # 写前复核同样重取「孤儿运行行」（缺陷 B，短路口径同 `_iw_once`）
    orphan = bool(live_msg) and _orphan_hold(cur["id"])
    if _reconcile_action_for(family, cur, r, has_run, live_msg,
                             _stop_recent(cur["id"]),
                             dshevents.archived(cur["session_id"] or ""),
                             _starting_window(cur["id"]),
                             orphan) != action:
        return                    # 状态已变：跳过，不写库
    if action == "to_done":
        # dsh 侧归档 → 卡片进「已完成」（2026-10-05 反向规则）：走容器迁移原语收口
        # ——会话已由宿主归档并停工作（归档自带 stopActivity 语义），stop=False 不再
        # 发 cancel；行终态化 + 搬列由 finish 的 to_column 一次表达（列差守卫 +
        # done_at 派生），比直写列安全（不会留下活跃 c: 行占着项目运行位）。
        # 随后级联归档其余绑定会话：dsh 侧已改、回滚不了，故 best-effort + 退避
        # 重试（strict=False）。
        _dequeue_card(card["id"], "dsh 归档同步", to_column="done")
        _archive_card_sessions(db.get_board_card(card["id"]) or cur, True,
                               "归档级联", strict=False)
        return
    if action == "block":
        if cur["block_kind"] == "queue":
            # 落阻塞 eager 丢排队（v2b T3，裁决 R9；v2 §2.1 阻塞独立容器不占
            # 队列位）：c: 等待行即取消（行+占位原子），取代补位器「占位非
            # doing+queue」惰性 cancel——行不再留队等到拾取
            waitq.cancel_card_wait(card["id"], "落阻塞丢排队")
        db.update_board_card(card["id"], column_key="blocked",
                             block_kind="interaction",
                             block_text=(r.get("text") or "")[:80])
        try:
            feishu.card_blocked(cur["project_id"], cur, r)  # 旁路推送：任何异常不影响调和
        except Exception as e:
            # 吞掉但留痕：推送链路静默失联只能靠这行发现（2026-09-28 实障：
            # sqlite3.Row.get 崩在这里被吞，四次提问零推送、零日志无从排查）
            print(f"[board] 交互阻塞飞书推送失败: {e!r}", flush=True)
        # 卡离开「正在开发」容器 ⇒ 出队（v3b：**无条件**行收口——落阻塞容器就
        # 一定出队，不再看 origin / _has_active_run：容器迁移本身即出队，运行行
        # 在此终态化，统一队列继续执行下一个）。不停止会话
        # （stop=False：abort 会清掉等待用户答复的 pending 提问，作答后会话照常
        # 续跑）；不提交任何改动（2026-09-13 退场：平台不再自动提交，改动提交由
        # 外部 hook 扩展负责）。
        try:
            _leave_doing(cur, stop=False, reason="出队-交互阻塞")
        except Exception:
            pass  # 出队失败不阻断调和
        return
    if action == "recover":
        # 平台在管运行期交互阻塞解除：直回 doing + 行补回（见 _recover_to_doing）
        _recover_to_doing(cur)
        return
    # to_doing（无在管运行卡回开发列）**不再落排队占位**（2026-09-13 修订，
    # 原 2026-09-09 语义「平台卡项目忙 → 落 doing/queue 排队占位入统一队列」废止）：
    # 状态机上 to_doing 蕴含 running=True（会话实况 busy 或本卡消息单元在跑/排队
    # ——live_msg 已于 2026-09-11 例外直写），即卡正在跑、占位者即其自身；落排队
    # 占位会在 turn 结束后被统一队列拾起、重复发「继续」起一轮（卡片单元拾取判定
    # 撞不上 _RUNS），且「排队中」徽标与「会话运行中」矛盾同显（真实故障：卡 300）。
    # sync 卡（外部会话强制并行）本就走直写，此处统一。收尾（会话结束→待审核）
    # 归调和器下一轮判定。
    if action == "to_review":
        # 卡归位「待审核」容器 ⇒ 出队行收口（v3b：「to_review 兜底释放」作为独立
        # 释放概念退场——I1：不在正在开发容器即无活跃 c: 行）。送达恢复的会话不在
        # _RUNS（_finish_run 不会收尾），行若仍活跃必须在此收口，否则项目
        # 运行位泄漏——统一队列拒绝拾起该项目任何新单元、后续待送达答案永久等待
        # （2026-09-16 实障：卡 388 送达后占住项目 9 一天，卡 389 答案未送达）。
        # to_review 蕴含会话已空闲，无需停会话；经唯一收尾点 finish 幂等收口
        # （无活跃行时各子步 no-op），无需先查持有（v2d T1 裁决 R14：
        # 占位/事实分离——行即表征）。
        _leave_doing(cur, stop=False, reason="出队-归位待审核")
    db.update_board_card(card["id"], **_RECONCILE_FIELDS[action])


def _recover_to_doing(card):
    """平台在管运行卡的交互阻塞解除（2026-09-13 修订）：一律直回 doing——
    调用方 recover 蕴含平台在管运行（_RUNS 条目存在），本卡会话仍在跑，
    「等串行位再起会话」的排队前置不存在，「新进入者不越过运行位」直接由
    行占位保证：

    - 本卡已有活跃行（运行位在场）→ 直回 doing，行不动（补回幂等，等价）；
      否则补回运行行（防恢复运行的会话与后续入队单元并发；收尾仍归 _finish_run）。
      runner 缺位（退化为直起路径）直写 doing。

    2026-09-09 原语义「项目被其他单元占用（或运行中同步卡占用）→ 落
    doing/queue 排队占位入统一队列等位」于 2026-09-13 废止。真实故障（卡 300，
    session_53736c1e）：作答恢复后落 doing/queue 等位（项目被卡 303 占用），
    会话 turn 未停照跑，前端「排队中」与「会话运行中」徽标矛盾同显。排队占位
    的语义是「等串行位再起会话」，而本卡会话已在跑、它本身就是占位者；且原
    路径轮到拾起时也只走 dequeue_start 撞自身 _RUNS 的竞争分支（仅补回行、
    不重复发 prompt），本修订把这一步前移为直接补回——语义等价且不产生假排队态
    （也消除「会话结束但收尾未跑，队列拾起重复起一轮」的窄窗口）。
    """
    pid = card["project_id"]
    inst = runner.INSTANCE
    db.update_board_card(card["id"], **_RECONCILE_FIELDS["recover"])
    if inst is not None and not _card_unit_active(card["id"]):
        # 行口径判据（`_card_unit_active`，行即持有者，不另造第二判据）：落阻塞
        # 等出队路径 c: 行已出队终态化，本路径按「复用终态行/建行」补回 running 行
        # ——卡回开发容器即有活跃行（I1 不变量），会话在跑期间占着项目运行位
        ext = {"reason": "阻塞解除恢复"}
        with _runs_lock:
            rec = _RUNS.get(card["id"])
        if rec is not None and rec.get("proc") is not None:
            ext["pid"] = rec["proc"].pid   # CLI 判据（R11④ 进程存活裁活）
        inst.card_started(card["id"], pid, ext=ext)


def _iw_once():
    """一轮调和扫描（统一调和器，事件驱动 + 60s 兜底）：未归档项目的 dsh 族
    卡片 → 守卫跳过 → 读会话实况（等待态+busy）+ 本卡消息单元实况（live_msg）→
    调和状态机 → 写缓存/落库；
    同轮维护外部条目 ext 行（v2d T4，裁决 R13/R15）：实况 busy 且无平台持有者
    的会话卡建/保 ext 行（入场即入运行前缀）、实况空闲/挂起/卡离开发列的行
    收口（finish → 补位时机③）；行集合变化 notify runner 唤醒排队单元重新挑选。
    实况读口=事件中枢注册表（`_iw_interaction`，零请求）——单族化后无逐卡 REST
    探测（原 kimi 逐 sid status 成本与 review 静止卡长节流均随两族退场）；
    退场族无 busy 信号不建行（在场残留行防御收口）。
    守卫（设计 §2.4，2026-09-11 修订）：todo、done 终态 / 无会话 sid 的卡不碰；
    **归档同步例外（2026-10-05）**：归档判定先于该守卫——主会话已归档的卡
    （不管在哪列，含 todo）落 to_done；外部取消归档的边沿把 done 卡送回待审核。
    manual 手动阻塞卡照常探测（状态机只在会话运行/消息驱动时回开发列，空闲
    维持不干预；刚被平台停过会话的宽限期内 busy 不作数，由状态机 stop_recent
    参数处理——abort 生效前 busy 可能短暂残留，防拖入阻塞瞬间被回弹）；
    queue 排队占位卡照常探测（有 sid 才探——2026-09-10 修复：交互阻塞解除回
    排队等串行位期间会话仍在跑、仍可能提问；状态机对 queue 卡只放行 block，
    故 busy/空闲不会误搬列）；blocked+无阻塞标记的残留态卡照常探测（2026-09-17：
    作答落列写入失败 / 送达只清标记的历史孤儿，状态机按会话实况归位，
    此前整类跳过致卡 388 滞留阻塞列两天）；平台在管运行的卡只做交互检测
    （列流转归 _finish_run）。
    异常语义：读不到实况（中枢未连接/未知）该卡本轮跳过（不搬列，防把运行中卡
    误判完成搬去待审核；取代 sync_sessions 旧「异常视为空闲」；ext 行侧保留既有
    行=保留上一轮占用，宁可多等不可误放行——逐卡 `r is None` 走 `ext_hold`）。
    看管声明（C 批 T5）：逐卡对 `owned:false`（用户直跑的）会话调 `_ensure_watch`
    ——声明范围=有卡会话；卡删除后的回收在节拍尾部 `_watch_prune`。
    单卡异常不外抛（不影响其他卡/项目）。节拍尾部另跑 starting 超时对账
    （_reconcile_starting_rows，v2d T3，裁决 R6）。"""
    now = int(time.time() * 1000)
    ext_changed = False
    seen_sids = set()      # 本轮在场的归档判定 sid（_ARCH_SEEN 有界清理用）
    # 起跑窗口批量读口（一轮一次；逐卡点查会成 N+1，见 `_starting_window`）
    starting_ids = waitq.starting_card_ids()
    for proj in db.list_projects_all():
        if proj["archived"]:
            continue
        fam = _web_family(proj)
        if fam is None:
            # 退场族无 busy 信号：不构成占用（在场残留行防御收口，防跨族历史堵死项目）
            if _finish_all_ext(proj["id"], "退场族无外部占用信号"):
                ext_changed = True
            continue
        ext_busy = {}                      # 本轮占位目标：{card_id: sid}（实况 busy）
        ext_hold = set()                   # 探测不明的占用候选卡（保留既有行）
        for card in db.list_board_cards(proj["id"]):
            try:
                # —— 归档同步（2026-10-05）：读本地归档集快照（零请求），两条规则 ——
                # ①电平：主会话已归档 ⇒ 卡片归「已完成」（含 todo 卡；已 done 无动作）；
                # ②边沿：外部「取消归档」（True→False）且卡片在 done ⇒ 回「待审核」。
                # 归档态未知（None，中枢断连/未对齐）一律不动作（不变量「断连=未知」）。
                sid = card["session_id"] or ""
                arch = dshevents.archived(sid) if sid else None
                if sid and arch is not None:
                    seen_sids.add(sid)
                    prev = _ARCH_SEEN.get(sid)
                    _ARCH_SEEN[sid] = arch
                    if prev is True and arch is False and card["column_key"] == "done":
                        _archive_unarchive_edge(card)
                        continue
                if arch is True and card["column_key"] != "done":
                    _iw_apply(fam, card, "to_done", None)
                    continue
                if card["column_key"] in ("todo", "done"):
                    continue
                if (card["column_key"] == "blocked"
                        and card["block_kind"] not in ("interaction", "queue",
                                                       "manual", None)):
                    continue               # 其他 blocked 类型（防御）；无标记残留态
                    # （blocked+None）例外放行——状态机按会话实况归位（2026-09-17）
                if not sid:
                    continue               # 无会话（从未起跑的真排队卡等）无可探测
                r = _iw_interaction(fam, proj, sid)
                # —— 看管声明（C 批 T5）：外部会话（用户直跑/接管，`owned:false`）
                # 的投递/作答通道以平台显式 `POST /watch` 为闸，声明范围=有卡会话
                # （本循环即「有卡」的天然边界；撤销见 `_watch_prune`）。幂等：
                # 只有新 sid 首见（或中枢重连后记账刚被清空，见
                # `_watch_generation_sync`）才真发请求，失败留痕不重试。
                # 读注册表判 owned（而非另发请求）；未知（get 为 None）不声明。
                _st = dshevents.get(sid)
                if _st is not None and not _st.get("owned"):
                    _ensure_watch(sid)
                if r is None:
                    # 实况读不到：两种语义必须分开（2026-10-07 实障修复，卡 870）——
                    # ① 中枢**断连**＝真未知：保行（宁多等不可误放行，原口径）；
                    # ② 中枢**在线**而注册表无此 sid ＝ 该会话已不在 dsh 会话池
                    #    （`session/disposed` 摘条目，或重连对齐时被 `/live` 快照
                    #    覆盖掉）⇒ 外部会话已结束：不 hold，交本轮
                    #    `_ext_stale_finish` 按「不在目标集」收口。
                    # 旧口径把两者混为一谈，一律 hold 保行——子代理会话留下的 ext
                    # 行因此永久占位（项目常驻「有外部会话在跑」⇒ 永不补位，实障
                    # 里卡 870 排队 5 小时、项目 119 积 10 条僵尸行）。
                    if not dshevents.connected() and not _platform_holds(card["id"]) \
                            and not _subagent_session(sid):
                        ext_hold.add(card["id"])   # 占用未知：保留既有行（old 探针口径）
                    elif dshevents.aligned() and not _platform_holds(card["id"]):
                        # ③ 中枢可信（在线 ∧ 已对齐）却查不到该 sid ＝ 会话确已结束：
                        #    补上卡列这一格（2026-10-08 批次 D，bug_report/20261008_1935）
                        #    ——旧口径只收 ext 行、列不动，会话静默消失的 doing 卡永滞
                        #    开发列（卡 908/909/912/913 的原症状）；对齐前一律不动，
                        #    杜绝「热重载后注册表为空 ⇒ 把运行中的卡批量搬走」的误判。
                        #    写前复核全在 `_iw_apply`：queue 占位 / 起跑窗口 / 平台持有 /
                        #    已答待送达 / 归档（to_done）自动跳出（状态机重评）。
                        _iw_apply(fam, card, "to_review", None)
                    continue               # 实况读不到：该卡本轮跳过，不搬列
                # —— 外部条目占用候选（v2d T4）：busy 且非挂起、且平台不持有 ——
                # 挂起（pending）不算占用（豁免面②：挂起即出队，不建行）；平台
                # 持有者（活跃 c: 行/在管条目）自占前缀位，不建行（防 ext:/c: 双计）。
                if r.get("busy") and not r.get("pending") \
                        and not _platform_holds(card["id"]) \
                        and not _subagent_session(sid, r.get("origin")):
                    ext_busy[card["id"]] = sid
                if _has_active_run(card["id"]):
                    # 平台在管运行卡：行心跳 + 证据（v3c：证据迁行，直调；
                    # touch_unit 幂等且异常由本层 per-card try 兜底，无活跃行 no-op）。
                    # 证据串统一 `busy=1/0(poll)`（v2d T4）
                    waitq.touch_unit(waitq.KIND_CARD, card["id"],
                                     f"busy={1 if r.get('busy') else 0}(poll)")
                with _IW_LOCK:
                    c = _IW_CACHE.setdefault(sid, {})
                    c.update(r)            # pending/busy/qid/question/options/answerable/text
                    c["ts"] = now
                live_msg = chat.live_of_sid(sid)   # 本卡消息在跑/排队（消息驱动的会话）
                # 孤儿运行行（缺陷 B）只在「本卡确有排队/执行中的消息」时才影响判定
                # （无消息时 running 只看 busy，见 `_reconcile_action_for`）⇒ 短路
                # 掉那次行点查，平台在管卡的常规拍零额外 DB 访问。
                orphan = bool(live_msg) and _orphan_hold(card["id"])
                action = _reconcile_action_for(fam, card, r,
                                               _has_active_run(card["id"]), live_msg,
                                               _stop_recent(card["id"]), arch,
                                               _starting_window(card["id"],
                                                                starting_ids),
                                               orphan)
                if action:
                    _iw_apply(fam, card, action, r)
            except Exception:
                continue
        # —— ext 行对账（每项目一轮；行集合变化唤醒补位，时机①/③）——
        try:
            if _ext_stale_finish(proj["id"], ext_busy, ext_hold):
                ext_changed = True
            for cid, sid in ext_busy.items():
                if upsert_ext(proj, cid, sid):
                    ext_changed = True
        except Exception:
            continue
    if ext_changed and runner.INSTANCE is not None:
        runner.INSTANCE.notify_busy_change()   # 前缀成员变化：唤醒排队单元重新挑选
    # 归档同步尾巴（2026-10-05）：调和器级联失败留下的待重试项按退避重发；
    # 边沿表按在场集合做有界清理（只在超限时清，别丢边沿状态）。
    try:
        _archive_retry_tick()
    except Exception:
        pass                                     # 重试异常不影响本轮其他对账
    if len(_ARCH_SEEN) > _ARCH_SEEN_MAX:
        for sid in [s for s in _ARCH_SEEN if s not in seen_sids]:
            _ARCH_SEEN.pop(sid, None)
    # starting 超时对账（v2d T3，裁决 R6）：claim→会话证实窗口兜底——超龄
    # starting 行三态复核（alive 自愈 / 可证未起收尾 / 不可证只告警）。
    try:
        _reconcile_starting_rows()
    except Exception:
        pass                                     # 守护线程不 crash（同 _iw_once 口径）
    # 看管回收（C 批 T5）：卡删除/换绑会话后撤掉驱动的看管声明（`_WATCHED` 为空时
    # 零 DB 访问；异常不影响本轮回调和的其余部分）。
    try:
        _watch_prune()
    except Exception:
        pass                                     # 同上：回收失败下轮再来


def interaction_of_sid(sid):
    """watcher 缓存读取（会话端点 meta 用）：{pending, kind, qid, question,
    options, answerable, text, ts} 或 None（未检测/无等待）。"""
    if not sid:
        return None
    with _IW_LOCK:
        c = _IW_CACHE.get(sid)
        return dict(c) if c else None


def is_answer_pending(card_id):
    """该卡是否有已作答·待送达的答案（作答响应 queued 字段用；2026-09-13）。

    P2 起权威在 wait_items 表（kind=answer 活跃行 waiting/starting/running/
    finishing，v2a T1 七枚举口径）；
    原作答内存登记已退场。看板轮询频率下的单行索引读可接受；
    批量派生（P6 起）走 queue_states → waitq.answer_pending_card_ids 一次查询。"""
    return waitq.get_active(waitq.KIND_ANSWER, card_id) is not None


# ---------- 展示派生（P6：各语义服务端唯一判定，前端只渲染） ----------

# queue_state 枚举值（裁决 R2 五态+空闲；v2a T4 加 starting 七枚举，裁决 R6；
# 2026-09-25 加 interaction_pending 八枚举——提问挂起单列，#560）
QS_IDLE = "idle"                     # 无等待无运行
QS_QUEUED = "queued_serial"          # 等串行位（本项目排队位次）
QS_ANSWER = "answer_pending"         # 已收下待送达（answer 活跃行在场）
QS_INTERACTION = "interaction_pending"  # 提问挂起等作答（block_kind=interaction；
                                        # turn 虽在跑但等的是用户输入，不亮「会话运行中」）
QS_SERVER = "server_queued"          # 服务端排队（dsh 宿主 inbox 队列，仅会话级）
QS_FOREIGN = "foreign_busy"          # 等外部会话（项目被外部同步会话占用）
QS_STARTING = "starting"             # 启动中：板卡已交 runner、会话未证实运行
                                     # （c: 行 starting；90s 宽限窗口内，v2d T3 超时处置）
QS_RUNNING = "running"               # 运行中（平台在管 running 或会话实况 busy）


def card_starting(card_id):
    """本卡 c: 等待项是否 starting 态（已交 runner 拾起、会话未证实运行；
    queue_state `starting` 枚举判据，v2a T4——单行索引点查，批量路径走
    waitq.starting_card_ids 一次查询）。"""
    row = waitq.get_active(waitq.KIND_CARD, card_id)
    return row is not None and row["state"] == waitq.STARTING


def queue_state_of(row, running=False, busy=False, msg_queued=False,
                   foreign=False, answer=None, starting=None):
    """单卡 queue_state 纯判定（裁决 R10 优先级，互斥不变量在派生层保证）。

    判定序（高→低）：answer_pending > interaction_pending > running > starting
    > queued_serial/foreign_busy > idle（v2a T4 加 starting，裁决 R6：starting 行
    在场=已在启动，压排队态，与 running 的边界=是否证实运行；2026-09-25 加
    interaction_pending——提问挂起（block_kind=interaction）压 running：dsh
    turn 在等作答期间实况 busy=true，旧判定亮「会话运行中」与阻塞容器矛盾（#554））。
    「已收下待送达」与运行并存是唯一例外——本函数按优先级只回一枚枚举，
    卡片操作行（⚡ 送达）仍读 answer_pending 字段本体（契约不变）。
    foreign=True 仅当卡片处于排队占位且项目被外部会话占用时由调用方传入。
    answer/starting：批量预计算路径（queue_states）传入本卡 answer 活跃行 /
    c: 行 starting 在场与否，缺省分别按 is_answer_pending / card_starting
    点查（hidden sites 现算路径）。
    """
    if answer is None:
        answer = is_answer_pending(row["id"])
    if answer:
        return QS_ANSWER
    if row["block_kind"] == "interaction":   # 提问挂起：与 🤔 徽标同条件（列无关）
        return QS_INTERACTION
    if running or busy:
        return QS_RUNNING
    if starting is None:
        starting = card_starting(row["id"])
    if starting:
        return QS_STARTING
    if msg_queued or row["block_kind"] == "queue":
        return QS_FOREIGN if foreign else QS_QUEUED
    return QS_IDLE


def queue_states(proj, rows, running_map=None, busy_map=None, queued_cards=None):
    """批量派生 {card_id: queue_state}（board_payload 用，一次预计算避免 N+1：
    answer 活跃行、c: starting 行与 msg 排队集合各一次查询，外部占位一次行读）。

    proj 非 None 时做项目级外部占位判定（项目有活跃 ext 行=外部会话在跑，
    `ext_active` 行读口）；proj 为 None
    时按无项目上下文降级（foreign 恒 False，foreign_busy 不可能出现）。
    """
    running_map = running_map or {}
    busy_map = busy_map or {}
    queued_cards = queued_cards or set()
    foreign = proj is not None and ext_active(proj["id"])
    answers = waitq.answer_pending_card_ids()
    startings = waitq.starting_card_ids()
    out = {}
    for r in rows:
        running = bool(running_map.get(r["id"]))
        out[r["id"]] = queue_state_of(
            r, running,
            running or bool(busy_map.get(r["session_id"])),
            r["id"] in queued_cards, foreign, answer=r["id"] in answers,
            starting=r["id"] in startings)
    return out


_ANSWER_MAX_RETRIES = 3      # 送达失败重试上限（沿用原调和器口径）
_ANSWER_BACKOFF_S = 30.0     # 放回后的退避窗口（not_before；原 5s 轮询改退避，§4.1）
_QUESTION_GONE_CODE = 40405  # 提问不存在/已应答（沿用原 kimi envelope code；
                             # dsh 作答链路用同值抛出，msg 兜底防口径漂移）


def _answer_question_gone(err):
    """「问题已不存在」判定（重试无意义）：envelope code=40405 为主判，msg 含
    not found 为兜底（防驱动侧 code 口径漂移）。判据读 err.args[0]——
    DshDriverError 沿用 `(code, message)` 二元组约定。"""
    code = err.args[0] if err.args else None
    msg = str(err.args[1]) if len(err.args) > 1 else ""
    return code == _QUESTION_GONE_CODE or "not found" in msg.lower()


def _answer_retry_or_fail(card_id, row, err):
    """送达失败的统一处置：retries+1；未满上限放回 waiting（not_before 退避）
    并重入队；满上限 mark_failed + 清占位（watcher 重探 pending 后交互卡重现、
    用户可重答——自愈出口与原调和器一致）。"""
    retries = (row["retries"] or 0) + 1
    if retries < _ANSWER_MAX_RETRIES:
        waitq.return_to_waiting(row["id"],
                                not_before=time.time() + _ANSWER_BACKOFF_S,
                                bump_retry=True)
        inst = runner.INSTANCE
        if inst is not None:
            inst.submit_answer(card_id)
        print(f"[board] 答案送达失败（第 {retries} 次，将重试）"
              f" card={card_id}: {err}", flush=True)
        return
    waitq.mark_failed(row["id"], err)
    db.update_board_card(card_id, block_kind=None, block_text="")
    print(f"[board] 答案送达失败（重试 3 次放弃）card={card_id}: {err}", flush=True)


def _dsh_answers(out):
    """平台作答载荷（answer_interaction 的 out）→ dsh 原生 answer 载荷。

    平台形态：[{"wire", "kind", "option_id", "option_ids", "text"}]
    dsh 形态：[{"id", "selected": [选项标签], "custom": 自由文本}]
    平台侧选项 id 与 label 同值（dsh 的 AskUserQuestionOption 只有标签语义，
    见 agent-driver 的 interaction 帧），故 selected 直接取 id。
    """
    items = []
    for a in out or []:
        kind = str(a.get("kind") or "single")
        ids = [str(x) for x in (a.get("option_ids") or [])]
        one = str(a.get("option_id") or "")
        selected = ids if kind in ("multi", "multi_with_other") else ([one] if one else [])
        item = {"id": str(a.get("wire") or ""), "selected": selected}
        if kind in ("other", "multi_with_other"):
            item["custom"] = str(a.get("text") or "")
        items.append(item)
    return items


def _answer_deliver(proj, meta):
    """按权威行 meta 送达（worker 执行体与「立即送达」共用出口；v2b T1：
    审批作答同路入队后补位送达走同一执行体——meta 带 approval_id 走审批
    应答，否则走提问作答）。异常原样上抛，退避/重试/40405 分流由调用方
    处置。

    dsh_plugin（路线 A，单族）：meta 的 qid 是 dsh 的 tool callId，作答走插件
    `/answer` → 宿主 `ctx.userQuestions.answer`（与 Web GUI 同一条通道）；
    「问题已不存在」由 accepted=false 表达——抛 DshDriverError(40405)，上层
    `_answer_question_gone` 按 code 判定放弃（不空转重试）。

    dsh 审批（2026-10-03 P3 第二批）：平台认领了会话审批时（`/permission` 接管，
    插件在 waterfall 里挂起），meta 带 `outcome`（`allowed-once`/`rejected`）走
    插件 `/approval`；未认领（GUI 作答）时插件返回 409 → 这里转 40005 让上层按
    「再无待决」收口。

    外部（池外）会话（C 批 T7，2026-10-10）：真正调驱动前经 `_watch_before_delivery`
    幂等补声明看管——看管可能已被 `_watch_prune` 撤掉（其撤销判据不含活跃 `a:` 行），
    漏声明会让 `/answer`·`/approval` 撞「未看管」404、答案落 error。
    """
    if _web_family(proj) != "dsh_plugin":
        # 退场族无作答送达通道（单族化）：明确报错，不落已删除的 kimi 配送段
        raise RuntimeError(agents.RETIRED_MSG)
    # 送达前重声明看管（C 批 T7）：外部会话的看管可能已被 `_watch_prune` 撤掉
    # （其判据不含活跃 `a:` 行），漏声明则下面两条驱动调用撞「未看管」404（见上）
    _watch_before_delivery(meta.get("sid"))
    if meta.get("approval_id"):
        outcome = str(meta.get("outcome") or "")
        if not outcome:
            raise dshdriver.DshDriverError(40005, "dsh 审批缺少 outcome（不应发生）")
        try:
            dshdriver.answer_approval(str(meta.get("sid") or ""),
                                      str(meta.get("approval_id") or ""), outcome)
        except dshdriver.DshDriverError as e:
            if e.code in (404, 409):
                raise dshdriver.DshDriverError(
                    _QUESTION_GONE_CODE, "审批已不存在（可能已由 dsh GUI 作答）")
            raise
        return
    accepted = dshdriver.answer_question(
        str(meta.get("sid") or ""), str(meta.get("qid") or ""),
        _dsh_answers(meta.get("answers") or []))
    if not accepted:
        raise dshdriver.DshDriverError(_QUESTION_GONE_CODE, "提问不存在或已应答")


def _deliver_answer_unit(card_id):
    """答案单元执行体（runner worker 调用；P2 起答案投递的唯一路径）。

    前置：worker 拾取已 claim（runner._claim_unit 的 answer 直调分支）。
    本函数＝原 _deliver_pending_answers 成功路径的队列化（设计 §8）：
    载荷读自行 meta（重启后按表重建的答案同样送达）；项目空闲由 _pick_locked
    保证（busy + 自身占位例外，等价原调和器判据）；成功 mark_done → 卡归位
    → card_started（顺序统一 R4；会话空闲后的行收口归调和器 to_review 分支的
    出队收口「出队-归位待审核」——v3b 前该动作名「兜底释放」，语义同为出队；
    v3a：card_started 同时把 c: 行置 running——本路径原先无卡行（作答排队只写
    占位），enter_running 按「建行/复用终态行」补回运行成员）；「问题已不存在」
    （40405 类）直接 failed（清占位走自愈出口）；其余失败交
    _answer_retry_or_fail；行已不活跃/项目不存在：cancel 并返回。"""
    row = waitq.get_active(waitq.KIND_ANSWER, card_id)
    if row is None:
        return                      # 已取消/已终态：无事可做
    try:
        meta = json.loads(row["meta"] or "{}")
        if not isinstance(meta, dict):
            meta = {}
    except ValueError:
        meta = {}
    proj = db.get_project(row["project_id"])
    if proj is None:
        waitq.cancel(waitq.KIND_ANSWER, card_id, "项目不存在")
        return
    try:
        _answer_deliver(proj, meta)
    except dshdriver.DshDriverError as e:
        if _answer_question_gone(e):
            waitq.mark_failed(row["id"], str(e))
            db.update_board_card(card_id, block_kind=None, block_text="")
            print(f"[board] 答案送达放弃（问题已不存在）card={card_id}: {e}",
                  flush=True)
            return
        _answer_retry_or_fail(card_id, row, str(e))
        return
    except Exception as e:
        _answer_retry_or_fail(card_id, row, str(e))
        return
    # —— 送达成功：终态 → 列归位 → 行补回运行位（顺序统一，R4）——
    waitq.mark_done(row["id"])
    # 归位开发列：恢复的会话在跑=运行中卡在开发列；同时兜底落列失败滞留
    # blocked 的卡（2026-09-16 实障卡 388 场景，原自愈分支退场后由此兜底，R3）
    # 用户作答引发的回列（阻塞→开发）不置「有更新」标记：用户刚答完，答案送达
    # 与否由前端「排队中」徽标即时反映，再点一个未读是噪音
    db.update_board_card(card_id, column_key="doing", mark_unread=False,
                         block_kind=None, block_text="")
    inst = runner.INSTANCE
    if inst is not None:
        # 行补回（本路径原先无卡行——作答排队只写占位）：enter_running 建行/
        # 复用终态行，恢复的会话自此占着项目运行位（行即条目）
        inst.card_started(card_id, row["project_id"],
                          ext={"reason": "送达恢复"})   # 占住运行位
    print(f"[board] 答案送达成功：card={card_id}", flush=True)


def deliver_pending_answer_now(card_id):
    """「立即送达」：把已作答·待送达的答案立即交给等待中的会话（不等项目空闲）。

    用户按钮入口。P2 起 = claim + 直投（与消息 inject_now 同一抢占总模式）：
    先原子 claim 等待项（互斥点——与 worker 拾取竞争时只有一方成功），成功者
    直接送达（本卡已不在此等待项上排队）；claim 失败 = 已被送达/取消/worker
    执行中，按原
    口径拒绝。成功：mark_done → 卡归位 → card_started（顺序统一 R4）；失败：
    「问题已不存在」（40405 类，必带①）对齐执行体口径立即 mark_failed + 清占位
    （重试无意义）；其余 return_to_waiting 放回（不动 retries——手动失败不消耗
    重试额度）+ 重入队，错误交调用方提示。返回 (ok, error)。"""
    row = waitq.get_active(waitq.KIND_ANSWER, card_id)
    if row is None or row["state"] != waitq.STATE_WAITING:
        return False, "没有待送达的答案（可能已送达）"
    if not waitq.claim(row["id"], "deliver-now"):
        return False, "没有待送达的答案（可能已送达）"
    inst = runner.INSTANCE
    if inst is not None:
        inst.remove_answer(card_id)     # 出队：不再等统一队列
    try:
        meta = json.loads(row["meta"] or "{}")
        if not isinstance(meta, dict):
            meta = {}
    except ValueError:
        meta = {}
    proj = db.get_project(row["project_id"])
    if proj is None:
        waitq.cancel(waitq.KIND_ANSWER, card_id, "项目不存在")
        return False, "项目不存在"
    try:
        _answer_deliver(proj, meta)
    except Exception as e:
        if _answer_question_gone(e):
            # 「问题已不存在」对齐执行体口径（必带①）：立即放弃不空转重试 3 次
            waitq.mark_failed(row["id"], str(e))
            db.update_board_card(card_id, block_kind=None, block_text="")
            return False, f"回答失败：{e}"
        waitq.return_to_waiting(row["id"])
        if inst is not None:
            inst.submit_answer(card_id)
        return False, f"回答失败：{e}"
    waitq.mark_done(row["id"])
    # 「立即送达」同队列送达路径口径：用户作答引发的回列不置「有更新」标记
    db.update_board_card(card_id, column_key="doing", mark_unread=False,
                         block_kind=None, block_text="")
    if inst is not None:
        # 「立即送达」= 用户自担路径：行补回运行位（与队列送达路径同款：
        # 行即条目，enter_running 建行/复用终态行）
        inst.card_started(card_id, row["project_id"],
                          ext={"reason": "立即送达"})   # 占住运行位
    print(f"[board] 答案立即送达：card={card_id}", flush=True)
    return True, ""


_IW_PROBE_TTL = 5.0   # 任务会话按需探测的缓存时效（与 watcher 扫描同频）


def interaction_probe(family, proj, sid):
    """按需探测一个会话的等待态并写入 watcher 缓存（任务会话端点/SSE 用）。

    看板卡片由调和器统一维护（事件驱动 + 60s 兜底）；任务会话没有调和器，
    会话端点每 tick 调本函数：缓存新鲜（≤_IW_PROBE_TTL）直接复用，否则探测
    一次；探测失败（None）保留旧缓存不清态（读口抖动不误清展示与作答白名单）。返回
    interaction_of_sid 同款 dict 或 None。"""
    if not sid:
        return None
    now = int(time.time() * 1000)
    with _IW_LOCK:
        c = _IW_CACHE.get(sid)
        fresh = bool(c and now - int(c.get("ts") or 0) < _IW_PROBE_TTL * 1000)
    if not fresh:
        r = _iw_interaction(family, proj, sid)
        if r is not None:
            with _IW_LOCK:
                cc = _IW_CACHE.setdefault(sid, {})
                cc.update(r)
                cc["ts"] = now
    return interaction_of_sid(sid)


def _iw_clear(sid):
    """清理 watcher 缓存中该 sid 的条目（回答成功后调用）。已答/已流转的卡若
    残留 stale pending，interaction_of_sid 会长期返回旧 pending（Task 3
    复审 Minor 3），导致会话窗重复显示已答提问、阻塞徽标不消失。"""
    if not sid:
        return
    with _IW_LOCK:
        _IW_CACHE.pop(sid, None)


def _queue_answer_unit(proj, card_id, sid, meta):
    """作答/审批统一入队（v2b T1，裁决 R8 一律入队）：权威行插「运行中最后
    一个条目后面」（insert_after_prefix=前缀后/等待区最前；meta 携带完整
    送达载荷——重启存活的前提），落 doing/queue 排队占位（前端「排队中」
    徽标），补位启动时才由统一队列 worker 送达（执行体 _deliver_answer_unit，
    not_before 退避/3 次重试/40405 直 failed 分流不动）。

    重复作答替换（2026-09-19 口径保留）：enqueue 族 API 的幂等语义是「同类
    同目标已有活跃行 → 复用既有行、不合入新 meta」，再次直接入队会把改答
    静默吞掉、送达的仍是第一份。故先取消既有活跃行再全新插入；
    retries/not_before 随新答案重置是正确的（新作答取代旧尝试）。
    落列失败不自毁答案：等待项是权威事实源，worker 补位照常送达，列归位
    由送达执行体兜底（2026-09-16 实障卡 389 的「永久滞留」不可能复现）。
    """
    if waitq.get_active(waitq.KIND_ANSWER, card_id) is not None:
        waitq.cancel(waitq.KIND_ANSWER, card_id, "重复作答替换")
    waitq.insert_after_prefix(waitq.KIND_ANSWER, card_id, proj["id"], meta=meta)
    inst = runner.INSTANCE
    if inst is not None:
        inst.submit_answer(card_id)   # 内存键唤醒（补位时机①；可拾取性由 _pick_locked 判定）
    try:
        # 占位投影单写（P4 R6：等待单元是 answer 行不建 card 行，纯投影；
        # 列归位由送达执行体兜底）
        waitq.set_card_wait_placeholder(card_id, block_text="")
        # 防旧队列条目被拾起误发「继续」（不变量①；P4 R10：waitq.cancel
        # 一行防御——answer 与 card 同目标不同 kind、活跃唯一索引按 kind
        # 分离不冲突）。v2d T1 行态口径统一（v2b 终审记录①）：只收 waiting
        # 行（防御本义=队列条目不被拾起）——running/finishing 行（force 落表
        # 在跑）终态化归 finish() 唯一收尾点、starting 归 worker finally，
        # 不再被防御 cancel 命中。
        waitq.cancel(waitq.KIND_CARD, card_id, "作答排队防御",
                     states=(waitq.WAITING,))
        _iw_clear(sid)              # 清交互缓存：前端不再显示作答卡
    except Exception as e:
        print(f"[board] 作答排队落列失败（答案已收，列待送达时归位）"
              f" card={card_id}: {e}", flush=True)


def answer_interaction(proj, card, qid, answers):
    """作答卡片会话的待答提问（单族：dsh_plugin，**整批提交全部子题**）：先校验
    watcher 缓存确为 pending（防已答/过期 qid 重复提交），再校验每题的作答形态。
    看板卡路径（v2b T1，裁决 R8）**一律入队**（_queue_answer_unit：插前缀后/
    等待区最前 + doing/queue 占位，补位启动时 worker 才调驱动 `/answer` 一次
    提交送达——dsh 侧按 callId + 逐题 selected/custom 一次给全，缺项即未答）；
    任务侧伪卡（无 id）保持直送，但直送前经 `_watch_before_delivery` 补声明看管
    （任务会话被宿主上报为外部态后撞「未看管」404 的修复，T7 评审 2026-10-10）。
    成功后清理 watcher 缓存（下轮调和重新检测刷新）。

    answers = [{"wire": "q_0", "kind": "single|multi|other|multi_with_other",
                "option_id"/"option_ids"/"text": ...}, ...]（前端逐题收集；
    2026-09-11 前只支持首题单条作答，其余子题被静默忽略）。

    校验一律对缓存里的实况值取白名单：qid 走 st["qid"]（既堵 URL 拼接注入
    ——qid 原样进驱动 REST 路径，禁 / ? # 等字符混入，也防旧 qid 重放）；
    每题 wire id 必须命中 st["questions"][].id 且不得重复、不得漏题（漏了
    dsh 侧视为未答，等于把子题丢掉——本函数存在的理由）；选项 id 必须落在该题
    options 内；kind 与该题能力（multi_select / allow_other）对齐；自定义输入限长。
    返回 None=成功，str=错误信息（server 转 400 JSON {error}）。"""
    sid = card["session_id"] or ""
    st = interaction_of_sid(sid) if sid else None
    if not st or not st.get("pending"):
        return "当前没有等待中的提问"
    if st.get("kind") != "question":
        return "当前等待的不是提问"
    if not qid or str(qid) != str(st.get("qid") or ""):
        return "提问不存在或已过期"
    if not isinstance(answers, list) or not answers:
        return "作答载荷非法"
    qs = [q for q in (st.get("questions") or []) if q]
    if not qs:
        # 兜底：旧缓存条目只有首题平面字段
        qs = [{"id": str(st.get("wire") or "q_0"),
               "options": st.get("options") or [],
               "multi_select": bool(st.get("multi_select")),
               "allow_other": bool(st.get("allow_other"))}]
    by_id = {str(q.get("id") or ""): q for q in qs}
    given = {}
    for a in answers:
        if not isinstance(a, dict):
            return "作答载荷非法"
        wid = str(a.get("wire") or "")
        if wid not in by_id:
            return "题目不存在或已过期"
        if wid in given:
            return "题目作答重复"
        given[wid] = a
    if len(given) != len(by_id):
        return "请回答全部问题"
    out = []
    for q in qs:                       # 按题目顺序组装（与前端展示序一致）
        wid = str(q.get("id") or "")
        a = given[wid]
        kind = str(a.get("kind") or "single")
        text = str(a.get("text") or "").strip()
        if kind not in ("single", "multi", "other", "multi_with_other"):
            return "作答形态非法"
        if kind in ("multi", "multi_with_other") and not q.get("multi_select"):
            return "该问题不支持多选"
        if kind in ("other", "multi_with_other") and not q.get("allow_other"):
            return "该问题不支持自定义输入"
        opts = q.get("options") or []
        valid_ids = {str(o.get("id") or "") for o in opts}
        ids = [str(x) for x in (a.get("option_ids") or [])]
        if kind in ("multi", "multi_with_other"):
            if kind == "multi" and not ids:
                return "未选择任何选项"
            if any(i not in valid_ids for i in ids):
                return "选项不存在或已过期"
        elif kind == "single" and opts and str(a.get("option_id") or "") not in valid_ids:
            # 单选：无 options 的问题不设白名单（兼容无选项提问），有则必须命中
            # （other 形态不带选项 id，不参与该白名单）
            return "选项不存在或已过期"
        if kind in ("other", "multi_with_other"):
            if not text:
                return "请输入内容"
            if len(text) > 2000:
                return "输入内容过长"
        out.append({"wire": wid, "kind": kind,
                    "option_id": str(a.get("option_id") or ""),
                    "option_ids": ids, "text": text})
    # 作答一律入队（v2b T1，裁决 R8）：不再判项目忙/闲——闲时直送分支与
    # _own_occupancy 直送旁路已删除（自身占位豁免移入补位器，runner
    # ._answer_exempt_keys_locked，R5⑥），一律插「运行中最后一个条目后面」
    # （前缀后/等待区最前），卡落 doing/queue 排队占位，补位启动时才送达。
    # 仅看板卡（有卡 id）参与；任务侧会话没有卡片列语义，保持直送
    # （specQ §5 边界不变；直送前经 `_watch_before_delivery` 补声明看管，见下）。
    try:
        card_id = card["id"]
    except (KeyError, IndexError, TypeError):
        card_id = None
    if card_id is None:
        if _web_family(proj) != "dsh_plugin":
            # 退场族无作答通道（单族化）：不落已删除的 kimi 配送段
            return f"回答失败：{agents.RETIRED_MSG}"
        # 送达前重声明看管（T7 评审 Important，控制器裁定 2026-10-10）：任务会话
        # 宿主重载后会被驱动以 owned:false 上报（= 池外），而本直送分支不经
        # `_answer_deliver`；不补声明就撞「未看管」404，用户看到「回答失败：…」。
        # 判据同 `_answer_deliver`：owned:false 才声明，池内/未知零请求。
        _watch_before_delivery(sid)
        try:
            # 路线 A：任务侧会话直送（卡片侧走作答排队，见 _answer_deliver）；
            # 驱动调用失败（网络/序列化/提问已失效等）均须落到前端
            if not dshdriver.answer_question(sid, qid, _dsh_answers(out)):
                return "回答失败：提问不存在或已过期"
        except Exception as e:
            return f"回答失败：{e}"
        _iw_clear(sid)
        return None
    _queue_answer_unit(proj, card_id, sid,
                       {"sid": sid, "qid": qid, "answers": out})
    return None


def answer_approval(proj, card, approval_id, decision, scope=""):
    """应答卡片会话的待审批请求（单族：dsh_plugin，manual 逐条确认档挂起的工具调用）。

    与 answer_interaction 同款白名单校验：approval_id 必须是缓存里的实况值
    （防伪造/旧 id 重放）；decision ∈ approved/rejected（平台两态），
    scope="session" 为「本会话内批准」——dsh 无该语义，显式拒绝（见下）。
    看板卡路径（v2b T1）一律入队、补位启动时才送达；任务侧保持直送，直送前同样经
    `_watch_before_delivery` 补声明看管（与提问腿同源，T7 评审 2026-10-10）。
    成功后清 watcher 缓存（下轮调和重新检测刷新）。
    返回 None=成功，str=错误信息（server 转 400 JSON {error}）。"""
    sid = card["session_id"] or ""
    st = interaction_of_sid(sid) if sid else None
    if not st or not st.get("pending"):
        return "当前没有等待中的审批"
    if st.get("kind") != "approval":
        return "当前等待的不是审批"
    if not approval_id or str(approval_id) != str(st.get("approval_id") or ""):
        return "审批不存在或已过期"
    decision = str(decision or "")
    if decision not in ("approved", "rejected"):
        return "审批决定非法"
    scope = str(scope or "")
    if scope not in ("", "session"):
        return "审批范围非法"
    # dsh（2026-10-03 P3 第二批）：把平台三态映射成宿主 ApprovalOutcome。
    # dsh 没有「本会话内批准」语义（outcome 只有 allowed-once/rejected/cancelled），
    # 故 scope=session 明确拒绝而不是静默降级。
    fam = runner.agent_family(proj["agent_path"] or "")
    if fam != "dsh_plugin":
        return f"审批失败：{agents.RETIRED_MSG}"
    if scope == "session":
        return "dsh 不支持「本会话内批准」（宿主无 session 级放行语义）"
    dsh_outcome = {"approved": "allowed-once", "rejected": "rejected"}[decision]
    # 审批作答同路入队（v2b T1，删恒直送）：与提问作答同一插入规则——补位
    # 启动时由执行体按 meta 分发 answer_approval 送达。仅看板卡（有卡 id）
    # 参与；任务侧会话保持直送（specQ §5 边界不变；直送前同样补声明看管，见下）。
    try:
        card_id = card["id"]
    except (KeyError, IndexError, TypeError):
        card_id = None
    if card_id is None:
        # 送达前重声明看管（T7 评审 Important，控制器裁定 2026-10-10）：同上
        # （提问腿）——任务会话池外化后，本直送分支同样需要先补声明再调 `/approval`。
        _watch_before_delivery(sid)
        try:
            dshdriver.answer_approval(sid, approval_id, dsh_outcome)
        except Exception as e:                      # noqa: BLE001
            return f"审批失败：{e}"
        _iw_clear(sid)
        return None
    meta = {"sid": sid, "approval_id": str(approval_id),
            "decision": decision, "scope": scope,
            "outcome": dsh_outcome}                # 送达时直接用宿主 outcome
    _queue_answer_unit(proj, card_id, sid, meta)
    return None


# 调和器节拍（P4 事件化，2026-10-03）：
# - 单族化（P7b）后只有 dsh 一族，**轮询退场**：只等 EventHub 事件，SAFETY 才
#   兜底对账一次（节点掉线/丢帧的最后防线，不是状态轮询——醒后读的是本地注册表）。
IW_SAFETY_SECONDS = 60.0
IW_DEBOUNCE_SECONDS = 0.15     # 事件风暴合并：同批帧只跑一轮调和
IW_MIN_INTERVAL = 0.5          # 两轮调和最小间隔（把 dsh 事件速率对 CPU 的影响封顶）


def start_interaction_watcher():
    """启动交互检测常驻线程（幂等；daemon 不阻塞主服务退出）。

    P4（2026-10-03）：由「每 5s 固定轮询」改为**事件驱动 + 兜底**——
    等 `dshevents.wait(timeout)`：dsh 侧任一状态帧到达即醒（立即调和），
    超时（单族部署 60s 兜底）只作为对账兜底。
    """
    global _IW_STARTED
    if _IW_STARTED:
        return
    _IW_STARTED = True

    def _loop():
        last = 0.0
        while True:
            try:
                changed = dshevents.wait(IW_SAFETY_SECONDS)
                if changed:
                    time.sleep(IW_DEBOUNCE_SECONDS)     # 合并同批事件
                now = time.monotonic()
                if now - last < IW_MIN_INTERVAL:        # 事件密集时限速
                    time.sleep(IW_MIN_INTERVAL - (now - last))
                last = time.monotonic()
                _iw_once()
            except Exception:      # 守护线程不 crash
                pass

    threading.Thread(target=_loop, daemon=True, name="board-interaction").start()
