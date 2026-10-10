#!/usr/bin/env python3
"""飞书通用对话（会话对话层）：默认项目下的会话绑定、自由文本投递、答复回流、
项目总览卡与会话列表卡。设计见 doc_ai/plan/202610/20261008_2215_飞书通用对话…设计.md。

依赖方向（硬约束）：本模块可模块级 import db/sessparse/dshdriver/dshevents/agents/waitq；
chat 与 feishu 一律**函数内懒 import**（feishu → runner → chat 已成环，见 chat.py:166 先例）。
"""
import json
import os
import sys
import time

import agents
import db
import dshevents
import dshdriver
import sessparse
import waitq

CONV_ENV = "TS_FEISHU_CONV"     # "0" 关闭（回到「未识别文本回帮助」）
CARD_MAX_BYTES = 8000           # 卡片 JSON 体积预算
PROJECTS_MAX = 20               # 总览卡最多列的项目数
PROJECTS_FALLBACK = 10          # 超预算时第二轮降级的项目数（brief Step 3：再截到 10）
PROJECT_NAME_MAX = 200          # 卡片里项目名的展示上限（异常超长名的体积兜底）
SESSIONS_MAX = 10               # 列表卡最多列的会话数
LIST_TTL = 1800                 # 「绑定会话 <序号>」列表记忆有效期（秒）
REPLY_MAX_CHARS = 3000          # 答复回流截断长度
_LAST_LIST = {}                 # open_id -> (ts, [sid, ...])

# 固定文案（测试与 spec 逐字引用，改动需同步三处）
DRIVER_NEEDED = "飞书通用对话需要 dsh 插件形态（独立形态的站点没有进程内 agent 驱动）"
NO_DEFAULT_GUIDE = "请先设置默认项目（回复「默认项目 <项目名>」，或发「项目」在卡片上点选）"
NO_PROJECTS_GUIDE = "你还没有项目，请先到站点创建"
STALE_NOTE = "（此前绑定的会话已不存在，已解除绑定）"
UNBIND_NOTE = "已解除此前绑定的会话（下次发消息将在新项目自动新建）"
PROJECTS_MORE_FMT = "另有 %d 个项目，回复「默认项目 <项目名>」精确设置"
PROJECTS_TEXT_HINT = "在卡片可用前，可用『默认项目 <项目名>』设置"    # 卡片发不出时的文本兜底
SESSIONS_TEXT_HINT = "可用『绑定会话 <序号|标题关键字|会话id前缀>』绑定"
TITLE_FMT = "飞书对话 %m-%d %H:%M"     # 新建会话的缺省标题（本地时间）
SESSION_GONE = "该会话已不存在（可能被删除或归档清理），发「会话」刷新列表"
SESSION_EMPTY = ("该默认项目下还没有会话——直接发一句话就会自动新建，"
                 "或回复「新建会话 <标题>」")
SESSION_STALE = "列表记忆已过期或序号越界，先发「会话」刷新最近 10 条，再回复「绑定会话 <序号>」"
SESSION_MISS_FMT = "没找到匹配「%s」的会话，发「会话」看最近 10 条"
SESSION_MULTI_FMT = "「%s」匹配到多个会话，回复更精确的关键字：\n%s"
# bind_session 的失败回执（`t=ss` 回调据此选 toast 类型；文案与文本兜底逐字共用）
SESSION_FAIL_TEXTS = (NO_DEFAULT_GUIDE, SESSION_GONE)
SESSION_NAME_MAX = 60           # 会话名在卡片里的展示上限（异常超长标题的体积兜底）
MESSAGE_TOO_LONG = ("消息过长（单条上限 %d 字）：请把长内容作为附件/文件发送，"
                    "或拆成几条短消息再发")


def enabled():
    """通用对话总开关（默认开；TS_FEISHU_CONV=0 关闭）。"""
    return (os.environ.get(CONV_ENV) or "").strip() != "0"


def current_text(binding):
    """「当前」回执：默认项目 + 当前会话（标题 / sid 前 12 位 / 绑定时间 / 所属项目）；
    未绑定会话时明说「未绑定会话，发消息将自动新建」。"""
    project = _default_project(binding)
    lines = [f"默认项目：{project['name'] if project else '未设置'}"]
    sid = (binding["cur_sid"] or "").strip()
    if not sid:
        lines.append("当前会话：未绑定会话，发消息将自动新建")
        return "\n".join(lines)
    title = (binding["cur_title"] or "").strip() or sid[:12]
    lines.append(f"当前会话：{title}（{sid[:12]}）")
    bound_at = (binding["cur_bound_at"] or "").strip()
    if bound_at:
        lines.append(f"绑定时间：{bound_at}")
    owner = _project_by_id(binding, binding["cur_project_id"])
    lines.append(f"所属项目：{owner['name'] if owner else '（项目已不在你的列表）'}")
    return "\n".join(lines)


def new_session(binding, title=""):
    """「新建会话 [标题]」：默认项目下新建 dsh 会话并绑定，回执写明项目与看板副作用
    （新会话落在项目 project_dir，看板 sync_sessions 会自动建一张 sync 卡，不占运行位）。"""
    project, err = _locate_project(binding)
    if project is None:
        return err
    title = (title or "").strip() or _new_title()
    sid, err = _create_in_project(binding, project, title)
    if err:
        return err
    return (f"已新建并绑定「{title}」（项目：{project['name']}），接下来发消息都进这个会话；"
            f"它也会出现在看板（sync 卡，不占运行位）")


def route_text(binding, text, cfg=None):
    """单聊自由文本路由（四分支）：有会话直投 → 无会话按默认项目自动新建 → 投递 → 引导。

    0. 长度闸：超 `chat.MESSAGE_MAX`（与站点 `POST …/messages` 同一常量）⇒ 直接回
       中文回执并给两条出路（改发文件/附件、或拆成几条），**什么都不提交**；
    1. 有 `cur_sid` 且项目仍归本人、会话仍存在 ⇒ 直接投递；
       失效（会话被删/归档清理/项目易主）⇒ 自动解绑 + 留痕提示，再按「无会话」处理；
    2. 无会话 ⇒ 默认项目（回落到用户唯一项目）下自动新建并绑定，再投递；
    3. 投递走 `chat.submit`（统一队列 `m:` 行，与站点会话消息同路、不做注入插队），
       `extra_meta` 带 `baseline` 供答复回流只取本轮新增；
    4. 无默认项目（多项目未指定 / 无项目）⇒ 回引导文案 + **项目总览卡**（点选即设默认）。
    """
    import chat       # 函数内懒 import：feishu → runner → chat 已成环（chat.py:166 先例）
    if len(text or "") > chat.MESSAGE_MAX:
        return MESSAGE_TOO_LONG % chat.MESSAGE_MAX
    open_id = binding["open_id"]
    note = ""
    sid = (binding["cur_sid"] or "").strip()
    title = (binding["cur_title"] or "").strip()
    project = None
    if sid:
        project = _project_by_id(binding, binding["cur_project_id"])
        if project is None or not sessparse.session_exists("dsh", sid):
            db.clear_feishu_cur_session(open_id)
            sid, title, project = "", "", None
            note = STALE_NOTE
    if not sid:
        project, _err = _locate_project(binding)
        if project is None:
            # 设计 §3.4 分支 4：引导文案 + 项目总览卡（无项目时 projects_card 为 None，
            # 只回文案，绝不给一张空卡）；卡片发送走凭据闸，缺凭据只留痕
            card = projects_card(binding)
            if card is not None:
                send_card(open_id, card, cfg)
            return NO_DEFAULT_GUIDE + (("\n" + note) if note else "")
        title = _new_title()
        sid, err = _create_in_project(binding, project, title)
        if err:
            return err + (("\n" + note) if note else "")
        # 创建路径内已写绑定；这里重申一次（幂等）：路由侧不依赖创建函数的副作用
        # ——「这条消息投到哪个会话」必须与库里的绑定指针一致
        db.set_feishu_cur_session(open_id, project["id"], sid, title)
    if not title:
        title = sid[:12]
    baseline = _baseline_of(sid)
    try:
        res = chat.submit(project["id"], sid, text,
                          family=agents.agent_family(project["agent_path"]),
                          extra_meta={"feishu": {"open_id": open_id,
                                                 "user_id": binding["user_id"],
                                                 "project_id": project["id"],
                                                 "baseline": baseline,
                                                 "title": title}})
    except Exception as e:
        _trace(f"投递失败 sid={sid}: {e!r}")
        return f"投递失败：{e}" + (("\n" + note) if note else "")
    state = "排队中" if res.get("queued") else "执行中"
    return f"已投递到「{title}」（{state}），跑完把答复发回这里" + note


def conv_intent(binding, action, groups, sender_open_id, cfg=None):
    """六条新指令的执行器（feishu.execute_intent 分派进来）。

    `current` / `new` / `use` / `leave` 回文本；`projects` / `sessions` 发对应卡片
    （卡片即回执，返回空串 ⇒ 调用方不另发文本）；未知动作兜底回帮助（不静默、不留白）。
    """
    g = groups or []
    if action == "current":
        return current_text(binding)
    if action == "projects":
        # 项目总览卡：卡片自带点选控件（t=dp 回调设默认项目）；无项目才回文本
        card = projects_card(binding)
        if card is None:
            return NO_PROJECTS_GUIDE
        if not send_card(binding["open_id"], card, cfg):
            return _projects_text(binding)      # 卡片没被受理 ⇒ 文本兜底，绝不静默
        return ""      # 卡片即回执，不另发文本（execute_intent 见空串不发）
    if action == "sessions":
        # 会话列表卡（t=ss 回调绑定）：无默认项目回文本引导（卡片无处可列）
        card = sessions_card(binding)
        if card is None:
            return NO_DEFAULT_GUIDE
        if not send_card(binding["open_id"], card, cfg):
            return _sessions_text(binding)      # 卡片没被受理 ⇒ 文本兜底，绝不静默
        return ""      # 同上：卡片即回执
    if action == "new":
        return new_session(binding, ((g or [None])[0] or "").strip())
    if action == "use":
        # 文本兜底绑定：序号（上一张列表卡的顺序）/ 标题包含 / sid 前缀
        return use_by_token(binding, g[0] if g else "")
    if action == "leave":
        return leave_session(binding)
    import feishu     # 函数内懒 import（同 route_text）：未知动作兜底回帮助
    return feishu.HELP_TEXT


# ---------- 项目总览卡与 t=dp 回调（Task 4） ----------
#
# 卡片形态（设计 §3.6）：每项目一块 markdown（名称 + 标记 + 计数行）+ **唯一**根级
# `select_static`（option.value = 项目 id），点选即回调 `t=dp` 设默认项目。飞书规定
# 多选/表单类组件才需 form 容器，单选下拉放根级最省体积也最好用（无 form 元素）。


class _Card(dict):
    """卡片对象（dict 子类）：元素按飞书 schema 2.0 放在 `body.elements`
    （与 `feishu._build_interaction_card` 同构，`rest_send_card` 直接 `json.dumps`
    发出）；另把 `card["elements"]` 作**只读别名**指向同一列表，便于调用方/用例
    按元素遍历。别名只在读口生效：`json.dumps` 走真实键，发出去的 JSON 里没有
    顶层 elements（既不多占体积预算，也不会因未知字段被飞书拒收）。
    """

    def __getitem__(self, key):
        if key == "elements" and not dict.__contains__(self, key):
            return dict.__getitem__(self, "body")["elements"]
        return dict.__getitem__(self, key)


def _card(header, elements):
    """构造卡片 dict（见 `_Card`）：header=卡片头，elements=根级元素列表。"""
    return _Card({"schema": "2.0", "header": header, "body": {"elements": elements}})


def _card_bytes(card):
    """卡片实际发出的体积（字节）：与 `rest_send_card` 同一序列化口径
    （`json.dumps(..., ensure_ascii=False)` 的 UTF-8 字节数）。"""
    return len(json.dumps(card, ensure_ascii=False).encode("utf-8"))


def projects_card(binding):
    """项目总览卡（`项目` 指令）：用户没有任何项目时返回 None（调用方回文本引导）。

    排序：默认项目置顶，其余按 id 升序（下拉选项同序）。体积三道闸（飞书对超限
    卡片整条拒收，宁可少列也不能发不出去）：
    ① 最多列 PROJECTS_MAX 个项目，其余折成一行文本引导（点选仍可设默认）；
    ② 仍超 CARD_MAX_BYTES ⇒ 删计数行（保留名称 + 标记）；
    ③ 仍超 ⇒ 项目数降到 PROJECTS_FALLBACK 再逐次折半（至少留 1 个）。
    """
    projects = _projects_of(binding)
    if not projects:
        return None
    default = _default_project(binding)
    default_id = int(default["id"]) if default else 0
    cur_pid = int(_binding_value(binding, "cur_project_id", 0) or 0)
    if not str(_binding_value(binding, "cur_sid", "") or "").strip():
        cur_pid = 0        # 会话指针为空时 cur_project_id 无意义（不标 💬）
    ordered = sorted(projects,
                     key=lambda p: (0 if int(p["id"]) == default_id else 1, int(p["id"])))
    rows = [(int(p["id"]), _clip_name(p["name"]),
             [m for m, on in (("✅", int(p["id"]) == default_id),
                              ("💬", bool(cur_pid) and int(p["id"]) == cur_pid)) if on])
            for p in ordered]
    counts = [_counts_line(p) for p in ordered[:PROJECTS_MAX]]   # 只算会展示的前 N 个
    title = _clip_name(default["name"]) if default else "未设置"
    header = {"title": {"tag": "plain_text", "content": f"项目总览（默认：{title}）"},
              "template": "orange"}
    total = len(rows)
    shown = min(total, PROJECTS_MAX)
    card = _card(header, _projects_elements(binding, rows, counts, shown, True))
    if _card_bytes(card) > CARD_MAX_BYTES:                      # 降级 ②：删计数行
        card = _card(header, _projects_elements(binding, rows, counts, shown, False))
    limit = PROJECTS_FALLBACK                                   # 降级 ③：收缩项目数
    while _card_bytes(card) > CARD_MAX_BYTES and shown > 1:
        shown = min(shown, limit)
        card = _card(header, _projects_elements(binding, rows, counts, shown, False))
        limit = max(1, limit // 2)
    return card


def _projects_elements(binding, rows, counts, shown, with_counts):
    """总览卡根级元素：前 shown 个项目各一块 markdown（`**名称** ✅/💬` [+ 计数行]），
    有项目没列全时补一行文本引导，末尾是唯一的根级下拉控件（value=项目 id）。"""
    els = []
    for i, (_pid, name, marks) in enumerate(rows[:shown]):
        head = "**%s**" % name + ((" " + " ".join(marks)) if marks else "")
        els.append({"tag": "markdown",
                    "content": head + (("\n" + counts[i]) if with_counts else "")})
    extra = len(rows) - shown
    if extra > 0:
        els.append({"tag": "markdown", "content": PROJECTS_MORE_FMT % extra})
    els.append({"tag": "select_static", "name": "ts_projects",
                "placeholder": {"tag": "plain_text", "content": "选择项目设为默认"},
                "options": [{"text": {"tag": "plain_text", "content": name[:24]},
                             "value": str(pid)} for pid, name, _m in rows[:shown]],
                "behaviors": [{"type": "callback",
                               "value": {"t": "dp", "u": binding["user_id"]}}]})
    return els


def _projects_text(binding):
    """总览卡的**纯文本兜底**（卡片未被受理时）：项目清单 + 文本设置指引。

    排序与卡片一致（默认项目置顶，其余按 id 升序），默认项目打 ✅；项目名同样过
    `_clip_name`。文本没有卡片的 8000 字节预算问题，故不做体积降级、也不裁条数。
    """
    projects = _projects_of(binding)
    if not projects:
        return NO_PROJECTS_GUIDE
    default = _default_project(binding)
    default_id = int(default["id"]) if default else 0
    ordered = sorted(projects,
                     key=lambda p: (0 if int(p["id"]) == default_id else 1, int(p["id"])))
    lines = ["项目列表："]
    for p in ordered:
        mark = " ✅默认" if int(p["id"]) == default_id else ""
        lines.append(f"· {_clip_name(p['name'])}{mark}")
    lines.append(PROJECTS_TEXT_HINT)
    return "\n".join(lines)


def _counts_line(project):
    """单项目计数行：任务（运行中/排队）· 看板五列 · 队列四类活跃行。

    口径：任务取 `db.list_tasks` 的 status（与站点「运行中/排队」一致）；队列行取
    `waitq.active_items` 按 kind 分组（`task` 与任务状态同源，不重复计）。
    """
    pid = project["id"]
    running = queued = 0
    for t in db.list_tasks(pid):
        status = str(t["status"] or "")
        if status == "running":
            running += 1
        elif status == "queued":
            queued += 1
    board = _board_counts(pid)
    kinds = {k: 0 for k in (waitq.KIND_CARD, waitq.KIND_MSG,
                            waitq.KIND_ANSWER, waitq.KIND_EXT)}
    for it in waitq.active_items(pid):
        kind = str(it["kind"] or "")
        if kind in kinds:
            kinds[kind] += 1
    return (f"任务 运行 {running}/排队 {queued} · "
            f"看板 待开发 {board['todo']}/开发中 {board['doing']}"
            f"/阻塞 {board['blocked']}/待审核 {board['review']}/已完成 {board['done']} · "
            f"队列 卡 {kinds[waitq.KIND_CARD]}/消息 {kinds[waitq.KIND_MSG]}"
            f"/作答 {kinds[waitq.KIND_ANSWER]}/外部 {kinds[waitq.KIND_EXT]}")


def _board_counts(pid):
    """看板五列卡片数：doing/blocked/review 走 `db.board_counts_many` 批量口（brief
    指定口径），todo/done 该口**不返回**（实测只有三列，db.py:1027）⇒ 由
    `db.list_board_cards` 现算补齐；补齐值无条件覆盖，日后该口扩到五列也不会重复计。"""
    counts = {"todo": 0, "doing": 0, "blocked": 0, "review": 0, "done": 0}
    counts.update(dict(db.board_counts_many([pid]).get(pid) or {}))
    tail = {"todo": 0, "done": 0}
    for card in db.list_board_cards(pid):
        key = str(card["column_key"] or "")
        if key in tail:
            tail[key] += 1
    counts.update(tail)
    return counts


def set_default_project(binding, project):
    """设默认项目（卡片回调与文本指令共用同一段写路径）。返回回执文案。

    跨项目自动解绑（设计 §3.2）：当前已绑定会话且会话属于**另一个**项目时，
    一并清掉会话绑定——会话是项目目录下的实体，留着跨项目投递会打到错误的
    工作目录；同一项目则保留会话不动。

    换项目同时作废「会话列表卡」的序号记忆（`_LAST_LIST` 是**某个项目下**的顺序，
    留着会让「绑定会话 3」把旧项目的会话绑到新项目上）；同项目重复设置不动它。
    """
    open_id = binding["open_id"]
    changed = int(_binding_value(binding, "default_project_id", 0) or 0) != int(project["id"])
    db.set_feishu_default_project(open_id, project["id"])
    if changed:
        _LAST_LIST.pop(open_id, None)
    reply = f"默认项目已设为「{project['name']}」"
    sid = str(_binding_value(binding, "cur_sid", "") or "").strip()
    if sid and int(_binding_value(binding, "cur_project_id", 0) or 0) != int(project["id"]):
        db.clear_feishu_cur_session(open_id)
        reply += "\n" + UNBIND_NOTE
    return reply


def on_card_action(sender, binding, value, action, cfg):
    """通用对话卡片回调（`t=dp` 项目总览 / `t=ss` 会话列表）：返回 toast；未知 t 返回 None。

    写操作前两道归属复核（多用户隔离，仿 `feishu._on_slash_perm_action`）：卡片
    `value.u` == 点击者 user_id（防串号）且所选项目 ∈ `db.list_projects(user_id)`
    ——任一不满足即错误 toast 且**不改任何状态**。`t=ss` 的会话归属由
    `bind_session` 复验**本项目会话桶的成员资格**（`sessparse.list_sessions` 的
    结果集，不是跨 bucket 的 `session_exists`）兜住。`sender` 未用（open_id 从
    binding 取），保留以固定回调签名。
    """
    value = value or {}
    action = action or {}
    if str(value.get("u") or "") != str(binding["user_id"]):
        return {"toast": {"type": "error", "content": "这张卡片不属于当前账号"}}
    if str(value.get("t") or "") == "dp":
        project = _project_by_id(binding, _selected_project_id(action))
        if project is None:
            return {"toast": {"type": "error", "content": "项目不在你的列表里"}}
        reply = set_default_project(binding, project)
        _dm(binding["open_id"], reply, cfg)
        return {"toast": {"type": "success", "content": "已设为默认项目"}}
    if str(value.get("t") or "") == "ss":
        sid = _selected_session(action)
        if not sid:
            return {"toast": {"type": "error", "content": "没有取到要绑定的会话"}}
        reply = bind_session(binding, sid)
        _dm(binding["open_id"], reply, cfg)     # 完整回执走私聊（toast 只做轻提示）
        if reply == SESSION_GONE:
            return {"toast": {"type": "error", "content": "会话已不存在，发「会话」刷新列表"}}
        if reply in SESSION_FAIL_TEXTS:
            return {"toast": {"type": "error", "content": "绑定失败"}}
        return {"toast": {"type": "success", "content": "已绑定该会话"}}
    return None        # 未知 t：交给飞书卡片回调兜底（不更新卡片）


def _selected_project_id(action):
    """下拉回调里被选中的项目 id：`action.option`（str 或 list，取首个）→ 兜底
    `action.value.i`；非数字返回 0（0 不是合法项目 id，定位必然失败 ⇒ 错误 toast）。"""
    raw = (action or {}).get("option")
    if isinstance(raw, (list, tuple)):
        raw = raw[0] if raw else ""
    if raw in (None, ""):
        raw = ((action or {}).get("value") or {}).get("i")
    try:
        return int(str(raw).strip())
    except (TypeError, ValueError):
        return 0


def _selected_session(action):
    """下拉回调里被选中的会话 id：`action.option`（str 或 list，取首个）→ 兜底
    `action.value.i`；取不到返回 ""（回调据此回错误 toast，绝不无依据地绑定）。"""
    raw = (action or {}).get("option")
    if isinstance(raw, (list, tuple)):
        raw = raw[0] if raw else ""
    if raw in (None, ""):
        raw = ((action or {}).get("value") or {}).get("i")
    return str(raw or "").strip()


# ---------- 会话列表卡、绑定 / 解绑与文本兜底（Task 5） ----------
#
# 卡片形态（设计 §3.7）：默认项目下最近活跃的 SESSIONS_MAX(10) 个会话各一块 markdown
# （`**序号. 名称** · 相对时间 · 状态标`；序号供「绑定会话 <序号>」文本兜底）+ **唯一**
# 根级 `select_static`（option.value = 会话 id），点选即回调 `t=ss` 绑定。零会话时不发
# 控件、只发一块引导 markdown（空下拉点不出东西）。看卡**只读**：绑定态只由显式写口改。


def sessions_card(binding):
    """会话列表卡（`会话` 指令）：无默认项目返回 None（调用方回「先设默认项目」文本）；
    零会话返回**有卡片无控件**（一块引导 markdown）。

    数据源 `sessparse.list_sessions("dsh", project["project_dir"])`（已按 mtime 倒序），
    取前 SESSIONS_MAX 条；同时把本次顺序登记进 `_LAST_LIST[open_id]`（「绑定会话
    <序号>」兜底），登记条数与卡片实际列出的条数**始终一致**（体积降级后同步收缩，
    防序号错位）。体积策略同 `projects_card`：超 CARD_MAX_BYTES 逐次折半展示条数
    （至少留 1 条）——飞书对超限卡片整条拒收，宁可少列也不能发不出去。
    """
    project = _default_project(binding)
    if project is None:
        return None
    items = sessparse.list_sessions("dsh", project["project_dir"])[:SESSIONS_MAX]
    open_id = binding["open_id"]
    header = {"title": {"tag": "plain_text",
                        "content": f"会话列表（默认：{_clip_name(project['name'])}）"},
              "template": "blue"}
    if not items:
        _remember_list(open_id, [])                 # 空列表也登记（序号必然越界）
        return _card(header, [{"tag": "markdown", "content": SESSION_EMPTY}])
    cur_sid = str(_binding_value(binding, "cur_sid", "") or "").strip()
    # 行内容（含 🏃 运行标记）只算一次：体积降级只裁条数，不重复读会话状态
    # （标记读本地 dshevents 注册表，零请求；未知/未连接一律不标）
    rows = [_session_row(i, it, cur_sid) for i, it in enumerate(items, 1)]
    shown = len(items)
    card = _card(header, _sessions_elements(rows, items, shown, binding["user_id"]))
    limit = shown // 2
    while _card_bytes(card) > CARD_MAX_BYTES and shown > 1:
        shown = min(shown, limit)
        card = _card(header, _sessions_elements(rows, items, shown, binding["user_id"]))
        limit = max(1, limit // 2)
    _remember_list(open_id, [it["sid"] for it in items[:shown]])
    return card


def _sessions_elements(rows, items, shown, user_id):
    """列表卡根级元素：前 shown 条各一块 markdown（rows 已渲染好）+ 唯一的根级下拉
    （option.value = 会话 id，behaviors 带 `t=ss` 与点击者 user_id 供防串号复核）。"""
    els = list(rows[:shown])
    els.append({"tag": "select_static", "name": "ts_sessions",
                "placeholder": {"tag": "plain_text", "content": "选择要绑定的会话"},
                "options": [{"text": {"tag": "plain_text",
                                      "content": _session_name(it)[:24]},
                             "value": str(it["sid"])} for it in items[:shown]],
                "behaviors": [{"type": "callback",
                               "value": {"t": "ss", "u": user_id}}]})
    return els


def _session_row(index, item, cur_sid):
    """单行 markdown：`**序号. 名称** · 相对时间 · 状态标`。

    状态标：🏃 运行中（`_session_busy`）、📦 已归档（`item["archived"]`）、✅ 当前
    （sid == 已绑定的 cur_sid）。序号是「绑定会话 <序号>」的锚，必须与实际列出顺序一致。
    """
    marks = []
    if _session_busy(item["sid"]):
        marks.append("🏃 运行中")
    if item.get("archived"):
        marks.append("📦 已归档")
    if str(item["sid"]) == str(cur_sid or ""):
        marks.append("✅ 当前")
    return {"tag": "markdown",
            "content": "**%d. %s** · %s%s" % (index, _session_name(item),
                                              _rel_time(item.get("mtime")),
                                              (" · " + " ".join(marks)) if marks else "")}


def _session_name(item):
    """会话展示名（fallback 链：标题 → 首问首行 → sid 短码），按 SESSION_NAME_MAX 截断。"""
    name = str(item.get("title") or "").strip()
    if not name:
        prompt = str(item.get("first_prompt") or "").strip()
        name = prompt.splitlines()[0].strip() if prompt else ""
    if not name:
        name = str(item.get("sid") or "")[:12]
    return name[:SESSION_NAME_MAX]


def _sessions_text(binding):
    """列表卡的**纯文本兜底**（卡片未被受理时）：会话清单 + 文本绑定指引。

    序号取自 `_LAST_LIST[open_id]`（`sessions_card` 刚登记的那份：与卡片下拉严格同序，
    且已随体积降级同步收缩）——这样文本里的「1.」就是「绑定会话 1」能绑的那条，照文本
    发序号不会绑错。标题按 sid 从当前会话集回查；列表记忆缺失（理论不可达，
    `sessions_card` 两条分支都登记）才现取一份。零会话回 `SESSION_EMPTY`（它本身已给出
    「直接发一句话 / 新建会话」的出路）。
    """
    entry = _LAST_LIST.get(binding["open_id"])
    if entry:
        sids = [str(s) for s in entry[1]]
    else:
        sids = [str(it["sid"]) for it in _project_sessions(binding)[:SESSIONS_MAX]]
    if not sids:
        return SESSION_EMPTY
    by_sid = {str(it["sid"]): it for it in _project_sessions(binding)}
    project = _default_project(binding)
    lines = [(f"「{_clip_name(project['name'])}」最近会话：" if project else "最近会话：")]
    for i, sid in enumerate(sids, 1):
        item = by_sid.get(sid) or {"sid": sid}
        lines.append(f"{i}. {_session_name(item)}（{sid[:12]}）")
    lines.append(SESSIONS_TEXT_HINT)
    return "\n".join(lines)


def _remember_list(open_id, sids):
    """登记本次列表卡的会话顺序（`绑定会话 <序号>` 兜底用）；写前清理过期桶。"""
    now = time.time()
    for key in [k for k, v in list(_LAST_LIST.items()) if now - v[0] > LIST_TTL]:
        _LAST_LIST.pop(key, None)
    _LAST_LIST[open_id] = (now, [str(s) for s in sids])


def _session_busy(sid):
    """会话是否正在跑 turn（True ⇒ 列表卡显示 🏃；仅展示用）。

    读口＝`dshevents` 的进程内注册表（状态由 dsh 宿主 `agent/status` 事件**推**来，
    **零请求**）：列表卡在飞书入站线程里同步构建，若逐会话打驱动 `/status`
    （15s 超时 × 最多 SESSIONS_MAX 条）会把入站线程整条卡住。未连接中枢或未见过
    该会话时 `get` 返回 None ⇒ **不标**（未知 ≠ 空闲，不替宿主下忙/闲断言）；
    任何异常同样按「不标」处理——忙闲探测失败绝不能打断列表卡渲染。
    """
    try:
        st = dshevents.get(sid)
        return bool(st) and st.get("status") == "running"
    except Exception as e:
        _trace(f"会话忙闲探测失败 sid={str(sid)[:12]}: {e!r}")
        return False


def _rel_time(mtime):
    """相对活跃时间：刚刚 / N 分钟前 / N 小时前 / N 天前（脏值/未来/缺值一律「刚刚」）。"""
    try:
        ts = float(mtime)
    except (TypeError, ValueError):
        return "刚刚"
    if ts <= 0:
        return "刚刚"
    delta = time.time() - ts
    if delta < 60:
        return "刚刚"
    if delta < 3600:
        return "%d 分钟前" % int(delta // 60)
    if delta < 86400:
        return "%d 小时前" % int(delta // 3600)
    return "%d 天前" % int(delta // 86400)


def _session_project(binding):
    """会话绑定用到的项目：默认项目 → 当前会话所属项目（按 cur_project_id 还原）→ None。

    默认项目缺失（未设/项目被删）时按 `cur_project_id` 还原，是为了让「重新绑定当前
    会话所在项目里的另一个会话」在默认项目悬空时仍可用；两处都过 `_project_by_id`，
    非本人项目一律 None（多用户隔离）。
    """
    project = _default_project(binding)
    if project is None:
        project = _project_by_id(binding, _binding_value(binding, "cur_project_id", 0))
    return project


def _project_sessions(binding):
    """`_session_project` 下的会话列表（mtime 倒序，上限由 sessparse 定 50）；
    项目缺失 / 读不到返回 []（列表是增强能力，绝不抛异常）。同时是 `bind_session`
    的归属校验数据源：sid ∈ 该结果集才算「属于这个项目」（见 bind_session）。"""
    project = _session_project(binding)
    if project is None:
        return []
    return sessparse.list_sessions("dsh", project["project_dir"])


def bind_session(binding, sid, title=""):
    """绑定会话（`t=ss` 回调与「绑定会话 …」文本兜底共用）：返回回执文案。

    **所有「选中一个 sid 写绑定」的路径都必须走这里**（`on_card_action` 的 `t=ss`
    分支、`use_by_token` 的序号/标题/sid 前缀三路），写前做一次项目归属复验：
    sid 必须落在**该项目 `project_dir` 的会话桶**内，判据是 `sessparse.list_sessions`
    的结果集（**不拿 sid 直接开文件**——`session_exists` 是跨 bucket 的纯路径存在性，
    验不出「这个 sid 属不属于当前项目」）。`list_sessions` 一次枚举同时覆盖了
    「会话已被删除/归档清理」与「卡是别的项目的旧快照」两种失效（卡片下发后用户换过
    默认项目时，旧卡的 option value 仍指向旧项目的 sid）；复验不过**一个字都不写**
    ——否则会写出 `cur_sid` 与 `cur_project_id` 不一致的绑定态，让别项目的会话占用
    本项目的运行位、答复回流也归错项目。

    唯一不经此处的写路径是**新建**会话（`_create_in_project`）：sid 由驱动在
    `project_dir` 下现建，天然属于本项目，且刚建的会话未必已进入列表快照。
    `title` 缺省现取会话标题（取不到回落 sid 前 12 位展示）。返回文案命中
    `SESSION_FAIL_TEXTS` 即表示**没写绑定**（回调据此选 toast）。
    """
    sid = str(sid or "").strip()
    project = _session_project(binding)
    if project is None:
        return NO_DEFAULT_GUIDE
    if sid not in {str(it["sid"]) for it in _project_sessions(binding)}:
        return SESSION_GONE
    title = str(title or "").strip() or sessparse.session_title("dsh", sid)
    db.set_feishu_cur_session(binding["open_id"], project["id"], sid, title)
    return (f"已绑定「{title or sid[:12]}」（项目：{project['name']}），"
            f"接下来发消息都进这个会话")


def use_by_token(binding, token):
    """文本兜底绑定（「绑定会话 <序号|标题关键字|会话id前缀>」）：返回回执文案。

    三分支（设计 §3.7）：① 纯数字 ⇒ 上一张列表卡的序号（`_LAST_LIST`，TTL LIST_TTL；
    过期/越界只回引导，绝不瞎猜「第 1 条」）；② 标题包含**唯一**命中 ⇒ 绑定，多命中
    回候选列表（不猜）；③ sid 前缀唯一命中 ⇒ 绑定，多命中同样回候选。都不中 ⇒ 引导
    发「会话」看最近 10 条。
    """
    token = str(token or "").strip()
    if not token:
        return SESSION_STALE
    if token.isdigit():
        entry = _LAST_LIST.get(binding["open_id"])
        idx = int(token) - 1
        if not entry or (time.time() - entry[0]) > LIST_TTL or not 0 <= idx < len(entry[1]):
            return SESSION_STALE
        return bind_session(binding, entry[1][idx])
    items = _project_sessions(binding)
    hits = [it for it in items if token in str(it.get("title") or "")]
    if not hits:
        hits = [it for it in items if str(it.get("sid") or "").startswith(token)]
    if len(hits) == 1:
        return bind_session(binding, hits[0]["sid"], hits[0].get("title") or "")
    if len(hits) > 1:
        return SESSION_MULTI_FMT % (token, "\n".join(
            f"· {_session_name(it)}（{str(it['sid'])[:12]}）" for it in hits[:8]))
    return SESSION_MISS_FMT % token


def leave_session(binding):
    """「解绑会话」：只清当前会话绑定（默认项目原样保留）；未绑定时给明确回执。"""
    sid = str(_binding_value(binding, "cur_sid", "") or "").strip()
    if not sid:
        return "当前未绑定会话"
    project = _default_project(binding)
    name = project["name"] if project is not None else "未设置"
    db.clear_feishu_cur_session(binding["open_id"])
    return f"已解绑当前会话（默认项目保持为「{name}」），下次发消息将自动新建"


def send_card(open_id, card, cfg):
    """给绑定用户发交互卡片（`项目`/`会话` 指令用）：懒 import feishu 后走
    `rest_send_card`；凭据不全只留痕返回 False（与 `_dm` 同闸——绝不用空凭据去打
    真实接口），异常同样只留痕返回 False（卡片发不出不该让指令执行本身失败）。

    返回 True=飞书已受理。调用方（`conv_intent`）据此决定是否补发**文本兜底**：
    「卡片即回执」的成功路径不另发文本，可一旦卡片没被受理，那条路径就会变成
    「用户发了指令却一个字都收不到」——故发送结果必须回传（模块先例：
    `send_slash_perm_card` 返回 `(ok, err)`）。
    """
    import feishu     # 函数内懒 import（feishu → runner → chat 已成环）
    if not _has_creds(cfg):
        _trace(f"卡片跳过（应用凭据缺失）open_id={str(open_id)[:12]}")
        return False
    try:
        feishu.rest_send_card(open_id, card, cfg)
    except Exception as e:
        _trace(f"卡片发送失败: {e!r}")
        return False
    return True


def _dm(open_id, text, cfg=None, user_id=0):
    """给绑定用户发 DM 文本（卡片回执 / Task 6 答复回流共用）。

    **凭据前置闸**：`cfg` 缺 `app_id` 或 `app_secret` 时只留痕返回，绝不发网络
    请求——卡片回调与回流的单测都会走到这里（控制者裁决 F1：缺闸就会去打真实
    飞书接口）。
    """
    import feishu     # 函数内懒 import（同上）
    cfg = cfg or feishu.app_config(user_id or 0)
    if not _has_creds(cfg):
        _trace(f"DM 跳过（应用凭据缺失）open_id={str(open_id)[:12]}")
        return
    try:
        feishu.rest_send_text(open_id, text, cfg)
    except Exception as e:
        _trace(f"DM 发送失败: {e!r}")


def _has_creds(cfg):
    """应用凭据是否齐备（app_id + app_secret）：卡片发送与 DM 回执共用的前置闸。"""
    return bool(cfg) and bool(cfg.get("app_id")) and bool(cfg.get("app_secret"))


def _clip_name(name):
    """项目名展示截断（卡片体积兜底；正常项目名远短于此，仅在异常长名时生效）。"""
    return str(name or "")[:PROJECT_NAME_MAX]


def _binding_value(binding, key, default=""):
    """binding 字段容错读取：生产是 sqlite3.Row、用例里可能是普通 dict，少键一律按
    缺省值处理（直接下标遇少键会 KeyError，被上层 except 吞成「静默无回复」）。"""
    try:
        return binding[key]
    except (KeyError, IndexError, TypeError):
        return default


def _projects_of(binding):
    """该绑定用户的全部项目（多用户隔离：只查本人）。"""
    return db.list_projects(binding["user_id"])


def _project_by_id(binding, pid):
    """按 id 在本人的项目里定位（不存在/非本人项目一律 None，防越权）。"""
    try:
        pid = int(pid or 0)
    except (TypeError, ValueError):
        return None
    for p in _projects_of(binding):
        if p["id"] == pid:
            return p
    return None


def _default_project(binding):
    """单聊默认项目行（未设或项目已删返回 None）。"""
    return _project_by_id(binding, binding["default_project_id"])


def _locate_project(binding):
    """项目定位（口径同 feishu._resolve_project）：默认项目 → 用户唯一项目 →
    (None, 错误文案)；报错分支列出可选项目名。返回 (project, "") 或 (None, 文案)。"""
    project = _default_project(binding)
    if project is not None:
        return project, ""
    owned = _projects_of(binding)
    if len(owned) == 1:
        return owned[0], ""
    if not owned:
        return None, NO_PROJECTS_GUIDE
    return None, ("请指明项目（回复「默认项目 <项目名>」），可选：" +
                  "、".join(p["name"] for p in owned[:8]))


def _create_in_project(binding, project, title):
    """在项目目录下新建 dsh 会话并写「当前会话」绑定。返回 (sid, err)，err 非空=失败。

    步骤：驱动可用性闸（中文引导，绝不抛异常栈）→ `create_session` → 项目级会话
    默认值（模型 / 思考等级 / 权限档，**best-effort 只留痕不阻断**）→ `rename`
    （同上）→ `db.set_feishu_cur_session`。失败路径一律不写绑定。
    """
    if not dshdriver.configured():
        return "", DRIVER_NEEDED
    title = (title or "").strip() or _new_title()
    # 项目级模型必须在**建会话时**下传（口径同 board._start_web）：宿主 `/session`
    # 不拆 `provider/id` 前缀，故先 split_model 拆成 provider + 裸 id；
    # 只喂 apply_session_defaults 会漏——它仅在 reasoning_effort 非空时才调
    # set_model（dshdriver.py:420-429），只配模型的项目会静默跑在宿主默认模型上。
    model_provider, model_id = dshdriver.split_model(str(project["model"] or ""))
    try:
        sid = dshdriver.create_session(cwd=project["project_dir"], task=title,
                                       model=model_id, provider=model_provider)
    except Exception as e:
        _trace(f"新建会话失败 project={project['id']}: {e!r}")
        return "", f"新建会话失败：{e}"
    try:
        dshdriver.apply_session_defaults(
            sid, model=model_id, provider=model_provider,
            reasoning_effort=str(project["reasoning_effort"] or "").strip(),
            permission_mode=str(project["permission_mode"] or "").strip(),
            log=_trace)
    except Exception as e:
        _trace(f"会话默认值下发失败 sid={sid}: {e!r}")      # 只留痕，不阻断
    try:
        dshdriver.rename(sid, title)
    except Exception as e:
        _trace(f"会话改名失败 sid={sid}: {e!r}")            # 只留痕，不阻断
    db.set_feishu_cur_session(binding["open_id"], project["id"], sid, title)
    return sid, ""


def _baseline_of(sid):
    """投递前条目基线：回流按 `after=baseline` 只取本轮新增（异常回落 0）。"""
    try:
        return int(sessparse.load("dsh", sid, "main", after=0).get("total", 0) or 0)
    except Exception:
        return 0


# ---------- Task 6：答复回流（终态钩子 → 抽取新增 assistant 文本 → DM 推送） ----------
#
# 链路：chat.run_unit 收口 → chat._fire_msg_done(msg_id, state) → 本模块
# notify_msg_done → waitq.msg_meta 取提交时定格的 feishu 载荷（open_id/baseline）
# → sessparse.load(after=baseline) 抽本轮 assistant 文本 → _clip_reply 截断 → _dm。
# 载荷只在等待项行上（chat_msgs 无 meta 列），且要读**终态之后**的行 ⇒ 走
# waitq.msg_meta 的 state 无关口径。

def start():
    """注册消息终态钩子（feishu.start_notifier 调用；幂等）。

    钩子是**单一注册位**（chat.set_msg_done_hook 后注册覆盖先注册），重复调用
    等价于再注册一次同一个函数——无副作用、不叠加。
    """
    import chat                                  # 函数内 import 防环
    chat.set_msg_done_hook(notify_msg_done)


def notify_msg_done(msg_id, state):
    """消息单元终态 → 把本轮答复推回飞书（非飞书来源直接返回）。

    state 三态：yielded＝turn 挂起等作答，**不推**（作答链路自己会回卡/回执，
    再推一份答复只会与它重复且此刻根本没有新答复）；error＝推失败回执（带
    chat_msgs.error 摘要）；done＝抽 baseline 之后的新增 assistant 文本推出。
    任何异常都不外抛（钩子是旁路，队列收口不因推送失败受影响）。
    """
    import chat, waitq
    meta = (waitq.msg_meta(msg_id) or {}).get("feishu") or {}
    if not meta:
        return
    open_id = meta.get("open_id") or ""
    if not open_id:
        return
    if not _binding_current(open_id, meta.get("user_id")):
        _trace(f"答复跳过（绑定已变更）open_id={str(open_id)[:12]}")
        return
    if state == "yielded":
        print(f"[feishu_conv] 会话挂起等作答，不推答复：{msg_id}", flush=True)
        return
    if state == "error":
        row = waitq.msg_get(msg_id)
        err = ((row["error"] if row is not None else "") or "")[:200]
        _dm(open_id, f"本轮执行失败：{err or '未知原因'}（可在站点会话窗查看详情）",
            None, meta.get("user_id"))
        return
    row = waitq.msg_get(msg_id)
    sid = (row["sid"] if row is not None else "") or ""
    reply = _clip_reply(_reply_of(sid, int(meta.get("baseline") or 0)))
    if reply:
        _dm(open_id, reply, None, meta.get("user_id"))


def _binding_current(open_id, user_id):
    """推送前的绑定归属复核：open_id 当前仍有绑定行、且其 `user_id` 与载荷一致。

    载荷里的 `open_id` 是**提交那一刻**定格的；用户提交后可能在设置页解绑，或把同一
    个飞书号改绑给另一个 Touchstone 用户（`db.set_feishu_binding` 按 open_id UPSERT）。
    答复含会话正文，只能送给提交者本人——不一致就不推（否则会送到接手该飞书号的
    新持有人手里）。库读写异常一律按「复核不过」处理：宁可不推，绝不误推。
    """
    try:
        row = db.get_feishu_binding_by_open(open_id)
    except Exception as e:
        _trace(f"绑定复核失败 open_id={str(open_id)[:12]}: {e!r}")
        return False
    if row is None:
        return False
    return str(row["user_id"]) == str(user_id)


def _reply_of(sid, baseline):
    """取该会话 baseline 之后的新增 assistant 文本（think/tool_* 忽略；异常返回空串）。

    baseline 是投递**前**的条目总数（route_text 在 submit 前定格）：`after=baseline`
    的切片即本轮新增（含 user/think/tool_call/tool_result/assistant 五类），这里只
    拼 assistant（think 是模型的草稿、tool_* 是过程，都不是给用户的答复）。
    """
    try:
        data = sessparse.load("dsh", sid, "main", after=baseline)
    except Exception:
        return ""
    if not data.get("found"):
        return ""
    parts = [e.get("text") or "" for e in data.get("entries") or []
             if e.get("kind") == "assistant"]
    return "\n\n".join(p for p in parts if p.strip())


def _clip_reply(text):
    """答复截断：超 REPLY_MAX_CHARS 保留首段并附站点指引（飞书单条消息不宜过长）。"""
    text = (text or "").strip()
    if len(text) <= REPLY_MAX_CHARS:
        return text
    return text[:REPLY_MAX_CHARS - 200] + "\n……（内容过长已截断，完整内容见站点会话窗 / 看板）"


def _new_title():
    """新建会话的缺省标题（本地时间；与 dsh 侧栏 / 会话列表卡里可辨认）。"""
    return time.strftime(TITLE_FMT)


def _trace(text):
    """轻量留痕（本层没有会话日志文件可写；与 feishu.py 的 stderr 诊断同风格）。"""
    print(f"feishu_conv: {text}", file=sys.stderr, flush=True)
