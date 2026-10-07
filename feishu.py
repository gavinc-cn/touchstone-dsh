#!/usr/bin/env python3
"""飞书集成（M1 出站推送）：阻塞事件 → 飞书群自定义机器人 webhook。

2026-09-09 起飞书设置为用户级：每个用户配置自己的机器人（应用凭据 + 默认
webhook + 站点地址），入站长连接按用户各自拉起，推送回落项目所有者的配置。
设计：doc_ai/plan/202609/20260906_1307_飞书集成_阻塞推送与消息指令.md（§6）
- board/runner 在状态跃迁点旁路调用 push_event（永不抛出，不影响主流程）
- 投递走 feishu_outbox 表（daemon 线程 1s tick，失败退避 60s/300s/1800s ×3 后留痕）
- 凭据（webhook URL/secret）不落任何日志、不入通知文案
- 参考实现：同机另一飞书机器人项目（同机实证的签名/消息形态）
"""
import argparse
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.request

import db
import requests

FEISHU_EVENTS = ("blocked_interaction", "task_failed", "card_review")
RETRY_DELAYS = (60, 300, 1800)     # 重试退避（秒）：3 次后标 failed 留痕
SEND_TIMEOUT = 5                   # webhook POST 超时（秒）
_TICK = 1.0                        # 发送线程轮询间隔（秒）
_SENDER_STARTED = False

_EVENT_META = {
    # kind -> (通知标题, 是否附站点链接)
    "blocked_interaction": ("🤔 卡片等待回复", True),
    "task_failed": ("❌ 任务失败", True),
    "card_review": ("📋 卡片待审核", False),
}

# 多子题渲染截断（飞书卡片元素/文本都有长度上限，超长会整条被拒收）
_Q_TEXT_MAX = 500      # 单题题面
_Q_OPT_MAX = 100       # 单选项 label
_Q_DESC_MAX = 160      # 选项描述次行 / 题目补充说明

# 多选类「卡片点选」暂存态（2026-10-07 第三档）：用户每题各点一次下拉，答案先
# 落在本进程内存里，**答满整批**才走 board.answer_interaction 送达（dsh 的
# ask_user_question 一个 Promise 只兑现一次，见 doc_ai/spec/feishu/飞书集成.md）。
_MQ_TTL = 1800         # 暂存存活上限（秒）：超时即丢，用户重答即可
_MQ_MAX_BUCKETS = 64   # 暂存桶上限（卡×提问）：极端情况下防无界增长
_MQ_FORM_MAX_BYTES = 950   # 单题多选 mini 表单 JSON 预算（飞书 form 元素硬限 1000）


def user_config(user_id):
    """用户飞书配置（feishu_user_cfgs 表；enabled/base_url/默认 webhook/应用凭据）。
    2026-09-09 起飞书设置为用户级：每个用户配置自己的机器人，无全局配置。"""
    return db.get_feishu_user_cfg(user_id)


def hook_of(project_id):
    """项目推送目的地：绑定行（enabled 且有 url）优先；显式 enabled=0 硬关闭
    （不回落用户配置）；无绑定行或行内无 url 回落**项目所有者**的用户级配置
    （其 enabled 总开关 + 默认 webhook）。附 base_url（通知「详情」链接）与
    user_id（投递记录归属）。
    返回 {"target","secret","events","base_url","user_id"} 或 None（不推）。"""
    row = db.get_feishu_hook(project_id)
    proj = db.get_project(project_id)  # 所有者为 0 时（项目被删）回落 user_config(0)={}
    owner_id = proj["user_id"] if proj else 0
    base_url = (user_config(owner_id).get("base_url") or "").rstrip("/") if proj else ""
    if row is not None:
        if not row["enabled"]:
            return None
        if row["webhook_url"]:
            return {"target": row["webhook_url"],
                    "secret": row["webhook_secret"] or "",
                    "events": {e for e in FEISHU_EVENTS
                               if e in (row["events"] or "")},
                    "base_url": base_url, "user_id": owner_id}
    cfg = user_config(owner_id)
    if not cfg.get("enabled", True):
        return None
    if not cfg.get("default_webhook"):
        return None
    return {"target": cfg["default_webhook"], "secret": cfg.get("default_secret", ""),
            "events": set(FEISHU_EVENTS), "base_url": base_url,
            "user_id": owner_id}


def sign(secret, ts):
    """飞书自定义机器人签名：base64(hmac_sha256(key=f"{ts}\\n{secret}"))。"""
    string_to_sign = f"{ts}\n{secret}"
    return base64.b64encode(
        hmac.new(string_to_sign.encode("utf-8"), digestmod=hashlib.sha256).digest()
    ).decode("utf-8")


def _payload(text):
    """text 消息体（timestamp/sign 在发送时刻补，队列重试后旧签会过期）。"""
    return json.dumps({"msg_type": "text", "content": {"text": text}},
                      ensure_ascii=False)


def _render(kind, ctx, project_id, base_url=""):
    """事件 → 通知文案：首行标题 [项目名]，按 kind 拼 卡片/任务/提问/选项/
    错误/pipeline 跳过 行，末行可选站点链接（项目所有者的用户配置 base_url）；
    凭据永不入文案。blocked_interaction 按 ctx.kind 分形态给「可直接回复」的
    作答指引（提问=作答指令；审批=同意/拒绝指令；不可远程作答的等待仍
    引导站点）。"""
    head, with_link = _EVENT_META[kind]
    proj = db.get_project(project_id)
    lines = [f"{head} [{proj['name'] if proj else f'#{project_id}'}]"]
    if "card_id" in ctx:
        lines.append(f"卡片 #{ctx['card_id']} {(ctx.get('title') or '')[:60]}")
    if "task_id" in ctx:
        lines.append(f"任务 #{ctx['task_id']} {(ctx.get('name') or '')[:50]}"
                     f"（{ctx.get('type') or ''}）")
    cid = ctx.get("card_id")
    if ctx.get("kind") == "approval":
        # 审批等待：动作/工具/内容摘要 + 同意/拒绝指令（比通用「agent 提问」行更准确）
        lines.append(f"审批请求：{ctx.get('action') or ctx.get('tool') or '工具调用'}")
        if ctx.get("tool"):
            lines.append(f"工具：{ctx['tool']}")
        if ctx.get("input"):
            lines.append(f"内容：{str(ctx['input'])[:200]}")
        lines.append(f"飞书回复「同意 {cid}」批准，「拒绝 {cid}」拒绝；"
                     f"「同意 {cid} 会话」本会话内同类调用自动放行")
    else:
        qs = [q for q in (ctx.get("questions") or []) if q]
        if len(qs) > 1:
            # 多子题：逐题完整展示（旧实现只渲染首题 q0，其余子题在飞书上不可见）
            lines.append(f"agent 提问（共 {len(qs)} 题）：")
            lines.extend(_question_text_lines(_question_views(qs)))
        elif ctx.get("question"):
            lines.append(f"agent 提问：{ctx['question']}")
            for i, o in enumerate(ctx.get("options") or [], 1):
                lines.append(f"  {i}) {o}")
        if kind == "blocked_interaction":
            n_q = len(qs) or ctx.get("questions_count") or 0
            if not ctx.get("answerable"):
                # 不可远程作答的等待（answerable=false）：仍引导站点
                lines.append("请到站点会话窗口处理")
            elif n_q > 1:
                # 多子题：一条指令按题号逐题答全（表单卡超 form 体积硬限时同样走这条）
                lines.append(_multi_answer_help(cid, qs or [None] * int(n_q)))
            else:
                tips = [f"飞书回复「作答 {cid} <选项序号>」按选项作答"]
                if ctx.get("multi_select"):
                    tips.append(f"多选逗号分隔（作答 {cid} 1,3）")
                if ctx.get("allow_other"):
                    tips.append(f"「作答 {cid} <文字>」自定义回答")
                lines.append("；".join(tips))
    if ctx.get("error"):
        lines.append(f"错误：{str(ctx['error'])[:200]}")
    if ctx.get("skipped_n"):
        lines.append(f"pipeline 后段 {ctx['skipped_n']} 条已连带跳过")
    if with_link:
        base = (base_url or "").rstrip("/")
        if base:
            lines.append(f"详情：{base}")
    return "\n".join(lines)


def push_event(project_id, kind, ctx):
    """旁路事件入队（任何异常吞掉，绝不影响业务主流程）：
    hook 选择 → events 过滤 → 渲染 → 幂等入 outbox（记项目所有者 user_id）。"""
    try:
        h = hook_of(project_id)
        if h is None or kind not in h["events"]:
            return
        text = _render(kind, ctx, project_id, h.get("base_url") or "")
        dedup = ctx.get("dedup_key") or \
            f"{kind}:{project_id}:{ctx.get('card_id') or ctx.get('task_id') or ''}"
        db.feishu_outbox_push(h["target"], h["secret"], _payload(text), dedup,
                              user_id=h.get("user_id") or 0)
    except Exception:
        pass


# ---------- 业务侧语义函数（board / runner 钩子调用） ----------

def _clip_text(text, limit):
    """截断长文本（空值归一为空串；超限加省略号）——飞书卡片/文本都有长度上限。"""
    s = str(text or "").strip()
    return s if len(s) <= limit else s[:limit] + "…"


def _option_view(raw):
    """单个选项归一 → `{id, label, description}`：兼容 dsh
    `AskUserQuestionOption` 的 dict（label/description）与旧形态的纯字符串
    （测试替身/旧插件仍可能给 str，直接 `.get` 会炸穿推送——2026-09-28 同款事故）。"""
    if isinstance(raw, dict):
        label = raw.get("label") or raw.get("text") or raw.get("value") or ""
        return {"id": str(raw.get("id") or label), "label": str(label),
                "description": str(raw.get("description") or "")}
    return {"id": str(raw or ""), "label": str(raw or ""), "description": ""}


def _question_views(qs):
    """interaction.questions（1-4 题）→ 逐题渲染视图（飞书卡片与群文本共用）。

    多子题必须**逐题完整展示**：旧实现只渲染首题（q0），其余子题在飞书上完全
    不可见（2026-10-06 实障：agent 一次问 3 题，卡片上只见第 1 题）。视图：
      {no, header, question, body, options:[{no,label,description}],
       multi_select, allow_other, other_label}"""
    views = []
    for i, q in enumerate(qs, 1):
        q = q if isinstance(q, dict) else {}
        options = []
        for j, o in enumerate(q.get("options") or [], 1):
            ov = _option_view(o)
            options.append({"no": j,
                            "label": _clip_text(ov["label"], _Q_OPT_MAX),
                            "description": _clip_text(ov["description"], _Q_DESC_MAX)})
        views.append({
            "no": i,
            "header": _clip_text(q.get("header"), 60),
            "question": _clip_text(q.get("question"), _Q_TEXT_MAX),
            "body": _clip_text(q.get("body") or q.get("detail"), _Q_DESC_MAX),
            "options": options,
            "multi_select": bool(q.get("multi_select")),
            "allow_other": bool(q.get("allow_other")),
            "other_label": _clip_text(q.get("other_label") or "其他", 40),
        })
    return views


def _single_question_view(ctx):
    """单题提问 ctx → 单题视图（与 `_question_views` 同形态，供 mini 表单取选项）。

    `ctx["questions"]`（逐题全量视图，见 `card_blocked`）优先；旧调用面/测试替身
    只给平面字段（`question`/`options` 为 label 串、`multi_select`/`allow_other`）
    时按平面字段兜底，组不出视图不让卡片构建抛异常。"""
    qs = [q for q in (ctx.get("questions") or []) if q]
    if qs:
        return _question_views(qs)[0]
    opts = []
    for i, o in enumerate(ctx.get("options") or [], 1):
        ov = _option_view(o)
        opts.append({"no": i, "label": _clip_text(ov["label"], _Q_OPT_MAX),
                     "description": ""})
    return {"no": 1,
            "header": "",
            "question": _clip_text(ctx.get("question"), _Q_TEXT_MAX),
            "body": "",
            "options": opts,
            "multi_select": bool(ctx.get("multi_select")),
            "allow_other": bool(ctx.get("allow_other")),
            "other_label": _clip_text(ctx.get("other_label") or "其他", 40)}


def _single_multi_select_pick(cid, ctx):
    """单题**多选**且可远程作答 → `(mini 表单元素 or None, 指引文案)`。

    多选组件 `multi_select_static` 按飞书官方规定**只能内嵌表单容器**（`checker`
    只回 `checked` 布尔、表达不了「N 选 M」），故单题多选与多子题里的多选同款：
    卡片上给「单题 mini 表单 + 提交按钮」，回调 `t=mq/n=1` 走 `_answer_multi_click`
    （单题点满即整批送达，见 2026-10-07 第四档）。

    表单 JSON 超 `_MQ_FORM_MAX_BYTES`（飞书 form 元素 1000 字节硬限，超限必被
    `230099/11310` 拒收且整卡静默丢失）或该题没有选项时**不发控件**，只回文本
    作答指引——绝不发出必被拒的卡。"""
    q = _single_question_view(ctx)
    tail = f"；自定义文字回复「作答 {cid} <文字>」" if q["allow_other"] else ""
    if not q["options"]:
        return None, (f"请回复「作答 {cid} <文字>」作答" if q["allow_other"]
                      else "该提问没有可选选项，请到站点会话窗口处理")
    form = _multi_select_form(cid, q, btn_text="提交作答")
    if len(json.dumps(form, ensure_ascii=False)) > _MQ_FORM_MAX_BYTES:
        return None, (f"多选题：请回复「作答 {cid} 1,3」（逗号分隔序号）" + tail)
    return form, (f"多选题：勾选后点「提交作答」送达；"
                  f"也可回复「作答 {cid} 1,3」（逗号分隔序号）" + tail)


def _question_card_blocks(views):
    """多子题 → DM 卡片逐题 markdown 元素（**只读**展示；可点选时由
    `_multi_click_elements` 在同一份排版后追加下拉组件）。
    卡片无状态：不可远程作答时只展示题面，作答指引由调用方 hint 承担。"""
    return [_question_md_element(v, len(views)) for v in views]


def _question_text_lines(views):
    """多子题 → 群 webhook 文本行（msg_type=text 不渲染 markdown，按纯文本排版）。"""
    lines = []
    for v in views:
        title = v["header"] or f"第 {v['no']} 题"
        head = f"【{v['no']}/{len(views)} {title}】"
        lines.append(f"{head}{v['question']}" if v["question"] else head)
        if v["body"]:
            lines.append(f"  {v['body']}")
        for o in v["options"]:
            lines.append(f"  {o['no']}) {o['label']}")
            if o["description"]:
                lines.append(f"     {o['description']}")
        caps = []
        if v["multi_select"]:
            caps.append("多选")
        if v["allow_other"]:
            caps.append(f"可自定义：{v['other_label']}")
        if caps:
            lines.append("  （" + "；".join(caps) + "）")
    return lines


def _question_md_element(v, n):
    """单题 → markdown 元素（题号/题头/题面/补充说明/选项与描述/能力标注）。
    「只读展示」与「逐题点选卡」共用同一份排版（2026-10-07 抽公共，避免两处漂移）。"""
    title = v["header"] or v["question"] or f"第 {v['no']} 题"
    md = [f"**{v['no']}/{n} {title}**"]
    if v["header"] and v["question"]:
        md.append(v["question"])
    if v["body"]:
        md.append(v["body"])
    for o in v["options"]:
        md.append(f"{o['no']}) {o['label']}")
        if o["description"]:
            md.append(f"　　{o['description']}")     # 全角缩进：描述次行
    caps = []
    if v["multi_select"]:
        caps.append("多选")
    if v["allow_other"]:
        caps.append(f"可自定义：{v['other_label']}")
    if caps:
        md.append("（" + "；".join(caps) + "）")
    return {"tag": "markdown", "content": "\n".join(md)}


def _multi_click_elements(cid, views):
    """多子题 → 「逐题点选卡」元素：每题一块只读 markdown + 一个可点选控件，
    返回 `(elements, 只能文本作答的题号列表)`。

    **单选**题（`select_static`）可放**根级**：飞书官方《下拉选择-单选》明确
    「支持嵌套在分栏、表单容器、折叠面板、循环容器、交互容器中」，且 2026-10-07
    真机实测「选中即触发 `card.action.trigger`、`behaviors[].value` 原样带回」
    （T5 探针卡点选后收到 `tsprobe5sel` 回执）。

    **多选**题不能用根级组件：官方《下拉选择-多选》写明 `multi_select_static`
    **仅支持内嵌在表单容器中使用**，靠表单「提交」按钮回传 `form_value`；
    `checker`（勾选器）只回 `checked` 布尔、表达不了「N 选 M」，故只能包一层
    **单题 mini 表单**（组件 + 一个提交按钮）。注意这与旧「整张多题表单卡」
    完全不同：那时一张 form 装全部子题、生产构建 1086–3187 字节**必被
    `230099/11310` 拒收**（静默丢卡 bug）；单题 mini 表单只装一道题的组件，
    按 `_MQ_FORM_MAX_BYTES` 留预算，**超限就不发该组件**、该题退回文本补答
    （`只能文本作答的题号列表` 由调用方写进指引），不会发出必被拒的卡。

    选项 `value` 取 1 起序号：回调时按**当前**服务端白名单换回 option id（与文本
    指令/选项按钮同款校验，天然防过期卡片重放与伪造）。
    无选项的题不发组件，同样进「只能文本作答」列表。"""
    els, text_only = [], []
    n = len(views)
    for v in views:
        els.append(_question_md_element(v, n))
        if not v["options"]:
            text_only.append(v["no"])
            continue
        if v["multi_select"]:
            form = _multi_select_form(cid, v)
            if len(json.dumps(form, ensure_ascii=False)) <= _MQ_FORM_MAX_BYTES:
                els.append(form)
            else:
                text_only.append(v["no"])   # 组件装不进 form 硬限：退回文本作答
            continue
        els.append({
            "tag": "select_static",
            "name": f"mq{cid}_{v['no']}",
            "placeholder": {"tag": "plain_text", "content": "请选择"},
            "options": [{"text": {"tag": "plain_text", "content": o["label"]},
                         "value": str(o["no"])} for o in v["options"]],
            "behaviors": [{"type": "callback",
                           "value": {"t": "mq", "c": cid, "n": v["no"]}}]})
    return els, text_only


def _multi_select_form(cid, v, btn_text=""):
    """多选题 → **单题 mini 表单**（飞书规定 `multi_select_static` 只能内嵌表单容器，
    见 `_multi_click_elements`）。提交按钮与组件同带 `t=mq/c/n`：飞书表单提交帧走
    **按钮**的 behaviors.value，组件值在 `action.form_value[<组件 name>]`（数组）。
    `btn_text` 空则用「提交第 N 题」（多子题卡带题号更好认；单题卡传「提交作答」）。"""
    return {
        "tag": "form", "name": f"mqf{cid}_{v['no']}",
        "elements": [
            {"tag": "multi_select_static", "name": f"mq{cid}_{v['no']}",
             "placeholder": {"tag": "plain_text", "content": "请选择（可多选）"},
             "options": [{"text": {"tag": "plain_text", "content": o["label"]},
                          "value": str(o["no"])} for o in v["options"]],
             "behaviors": [{"type": "callback",
                            "value": {"t": "mq", "c": cid, "n": v["no"]}}]},
            {"tag": "button", "name": f"mqs{cid}_{v['no']}",
             "form_action_type": "submit", "type": "primary",
             "text": {"tag": "plain_text",
                      "content": btn_text or f"提交第 {v['no']} 题"},
             "behaviors": [{"type": "callback",
                            "value": {"t": "mq", "c": cid, "n": v["no"]}}]},
        ]}


def _multi_click_hint(cid, qs, text_only=(), multi_forms=()):
    """逐题点选卡末行指引：点满自动整批送达；要写自定义文字（或控件放不下的题）
    给文本补答语法（文本指令与已点选的答案**可混用**——已点选的题不必重复给，
    见 `_answer_by_token`）。`text_only` = 卡片上没有可点控件的题号；
    `multi_forms` = 卡片上发了多选 mini 表单的题号（多选是「勾选 + 点提交」两步，
    不点名容易被当成勾上就算答了）。"""
    extra = sorted(set(text_only)
                   | {i for i, q in enumerate(qs, 1) if (q or {}).get("allow_other")})
    lines = [f"逐题选择即可，答满 {len(qs)} 题自动送达 agent。"]
    forms = sorted(set(multi_forms))
    if forms:
        lines.append("；".join(f"第 {i} 题是多选：勾选后点「提交第 {i} 题」"
                               for i in forms))
    if extra:
        lines.append("第 " + "、".join(str(i) for i in extra)
                     + " 题请回复「作答 %s %s」作答"
                     % (cid, " ".join(f"{i}:<值>" for i in extra))
                     + "（自定义文字写 <文字>，可选项写序号，多选逗号分隔；"
                       "已点选的题不用重复给）")
    return "\n".join(lines)


def _build_interaction_card(ctx, project_name):
    """blocked_interaction ctx → schema 2.0 交互卡片 dict（DM 单聊推送用）。
    交互边界（卡片无状态动作 = 一次点击/一次提交即完成）：
    - 多子题提问（1-4 题）且**可远程作答**：发「逐题点选卡」——每题一块只读题面 +
      一个根级下拉（单选=select_static / 多选=multi_select_static），点选即回调把
      该题答案**暂存**（`_mq_put`），答满整批经 board.answer_interaction 一次送达；
      自定义文字用「作答 卡号 题号:文字」补答（两路可混用，见 `_answer_by_token`）。
      **2026-10-07 第三档：`form` 表单卡退场**——飞书对 form 元素有 1000 字节硬限，
      生产多题表单必被拒收且静默丢卡（见 `_multi_click_elements`）。
    - 多子题但不可远程作答（answerable=false，会话非平台自持）：**逐题只读展示**
      （题面/选项/描述）+ 站点引导——旧实现只渲染首题，其余子题不可见（2026-10-06 修）
    - 单题单选提问：每选项一个作答按钮
    - 审批：批准/会话内批准/拒绝三按钮（与站点审批面板一致）
    - 单题**多选**提问：卡片上给单题 mini 表单（`multi_select_static` + 「提交作答」
      按钮，飞书规定多选组件只能内嵌表单容器），回调 t=mq/n=1 单题点满即送达
      （2026-10-07 第四档，此前只给文字指引）；表单超预算/无选项则退回文字指引
    - 单题自由文本：文字指引（仍走「作答 卡号 …」指令）
    按钮 value 精简键：t=动作（a 作答单题 / mq 多选题点选 / p 批准 / s 会话内批准 /
    d 拒绝）、c=卡号、n=题号、i=选项序号——回调时重读 interaction_of_sid 取服务端
    选项白名单，天然防过期 qid 重放与伪造（board 侧还有整批白名单校验兜底）。"""
    kind = ctx.get("kind")
    cid = ctx.get("card_id")
    elements = []
    if kind == "approval":
        lines = [f"**审批请求**：{ctx.get('action') or ctx.get('tool') or '工具调用'}"]
        if ctx.get("tool"):
            lines.append(f"工具：{ctx['tool']}")
        if ctx.get("input"):
            lines.append(f"内容：{str(ctx['input'])[:200]}")
        elements.append({"tag": "markdown", "content": "\n".join(lines)})
        for label, t, style in (("✅ 批准", "p", "primary"),
                                ("🔁 会话内批准", "s", "default"),
                                ("⛔ 拒绝", "d", "danger")):
            elements.append({
                "tag": "button", "type": style,
                "text": {"tag": "plain_text", "content": label},
                "behaviors": [{"type": "callback", "value": {"t": t, "c": cid}}]})
    else:
        qs = [q for q in (ctx.get("questions") or []) if q]
        if len(qs) > 1:
            views = _question_views(qs)
            elements.append({"tag": "markdown", "content": "\n".join([
                f"**agent 提问（共 {len(qs)} 题）**",
                f"卡片 #{cid} {(ctx.get('title') or '')[:60]}"])})
            if ctx.get("answerable"):
                # 可远程作答：逐题点选（单选=根级下拉；多选=单题 mini 表单），
                # 点满自动整批送达；放不下控件的题由指引点名走文本补答
                click_els, text_only = _multi_click_elements(cid, views)
                elements.extend(click_els)
                forms = [v["no"] for v in views
                         if v["multi_select"] and v["no"] not in text_only]
                elements.append({"tag": "markdown",
                                 "content": _multi_click_hint(cid, qs, text_only,
                                                              forms)})
            else:
                # 不可远程作答（会话非平台自持）：逐题只读展示 + 站点引导。
                # 2026-10-06 前的实现落到下面的单题分支，只渲染首题（q0），其余
                # 子题在飞书上完全不可见（用户实障：agent 一次问 3 题只见第 1 题）。
                elements.extend(_question_card_blocks(views))
                elements.append({"tag": "markdown",
                                 "content": "该等待不支持远程作答，请到站点会话窗口处理"})
        else:
            md = [f"**agent 提问**：{ctx.get('question') or 'agent 正在等待你的回答'}",
                  f"卡片 #{cid} {(ctx.get('title') or '')[:60]}"]
            for i, o in enumerate(ctx.get("options") or [], 1):
                md.append(f"{i}) {o}")
            elements.append({"tag": "markdown", "content": "\n".join(md)})
            hint = None
            if not ctx.get("answerable"):
                hint = "该等待不支持远程作答，请到站点会话窗口处理"
            elif (ctx.get("questions_count") or len(qs) or 0) > 1:
                hint = (f"该提问含 {ctx.get('questions_count') or len(qs)} 道子题，"
                        "请到站点会话窗口逐题作答")
            elif ctx.get("multi_select"):
                # 单题多选：卡片上给单题 mini 表单（多选组件只能内嵌表单容器）；
                # 装不下/无选项时只给文本指引（见 _single_multi_select_pick）
                form, hint = _single_multi_select_pick(cid, ctx)
                if form is not None:
                    elements.append(form)
            if ctx.get("answerable") and not hint and kind == "question":
                for i, o in enumerate(ctx.get("options") or [], 1):
                    elements.append({
                        "tag": "button", "type": "primary" if i == 1 else "default",
                        "text": {"tag": "plain_text", "content": f"{i}) {o}"},
                        "behaviors": [{"type": "callback",
                                       "value": {"t": "a", "c": cid, "i": i}}]})
                if ctx.get("allow_other"):
                    hint = f"自定义回答请回复「作答 {cid} <文字>」"
            if hint:
                elements.append({"tag": "markdown", "content": hint})
    return {"schema": "2.0",
            "header": {"title": {"tag": "plain_text",
                                 "content": f"🤔 卡片等待回复 [{project_name}]"},
                       "template": "orange"},
            "body": {"elements": elements}}


def _dm_interaction_card(project_id, ctx):
    """旁路：向项目所有者的飞书单聊发交互卡片（绑定 + 应用凭据齐全才发）。
    卡片是即时交互载体，不走 outbox（过期提问的分钟级重试无意义）；失败仅
    留痕——群 webhook 文本推送（push_event）始终是主通道，不受影响。"""
    try:
        proj = db.get_project(project_id)
        owner = (proj["user_id"] if proj else 0) or 0
        binding = db.get_feishu_binding_by_user(owner)
        cfg = app_config(owner)
        if not binding or not cfg:
            return
        name = proj["name"] if proj else f"#{project_id}"
        rest_send_card(binding["open_id"],
                       _build_interaction_card(ctx, name), cfg)
    except Exception as e:
        print(f"feishu outbound: DM 交互卡片发送失败: {e!r}",
              file=sys.stderr, flush=True)


def card_blocked(project_id, card, interaction):
    """卡片交互等待（board._iw_apply block 分支调用；qid 进 dedup_key
    防同一提问在重试窗口内重复推送）。ctx 按 interaction.kind 分形态：
    提问带 questions_count/multi_select/allow_other（指引行拼作答指令用），
    审批带 tool/action/input（审批请求摘要与同意/拒绝指引用）。"""
    # board 传的是 db.get_board_card 的 sqlite3.Row（无 .get）——统一转 dict，
    # 否则 ctx 构建即 AttributeError 且被调和器吞掉，推送与 DM 每次静默丢失
    # （实障 2026-09-28：四次卡片提问零推送）
    card = dict(card) if not isinstance(card, dict) else card
    kind = str(interaction.get("kind") or "")
    qs = [q for q in (interaction.get("questions") or []) if q]
    q0 = qs[0] if qs else {}
    ctx = {
        "card_id": card["id"], "title": card.get("title") or "",
        "kind": kind,
        "question": interaction.get("question") or "",
        # 选项展示名取 label（交互归一后的字段，见 board._iw_interaction 的
        # dsh 分支；旧代码取不存在的 text 字段，推送里选项序号后恒空白）
        "options": [o.get("label") or o.get("text") or ""
                    for o in (interaction.get("options") or [])],
        "answerable": bool(interaction.get("answerable")),
        "dedup_key": f"card:{card['id']}:interaction:{interaction.get('qid') or ''}"}
    if kind == "approval":
        ctx.update({"tool": interaction.get("tool") or "",
                    "action": interaction.get("action") or "",
                    "input": interaction.get("input") or ""})
    else:
        ctx.update({"questions_count": len(qs),
                    "multi_select": bool(q0.get("multi_select",
                                                 interaction.get("multi_select"))),
                    "allow_other": bool(q0.get("allow_other",
                                               interaction.get("allow_other"))),
                    # 逐题视图透传：多子题表单卡按题能力取组件（id/题面/选项/
                    # 多选/自定义输入）；组不成表单时同一份数据供**逐题只读展示**
                    # （题面/选项/描述次行），缺了它多子题只能显示首题（2026-10-06 修）
                    "questions": [{"id": str(q.get("id") or ""),
                                   "question": q.get("question") or "",
                                   "header": q.get("header") or "",
                                   "body": q.get("body") or "",
                                   "options": [_option_view(o)
                                               for o in (q.get("options") or [])],
                                   "multi_select": bool(q.get("multi_select")),
                                   "allow_other": bool(q.get("allow_other")),
                                   "other_label": q.get("other_label") or ""}
                                  for q in qs]})
    push_event(project_id, "blocked_interaction", ctx)
    _dm_interaction_card(project_id, ctx)   # 旁路：所有者 DM 交互卡片（可点按钮）


def card_review(project_id, card):
    """卡片落 review 待审核（默认 events 不含此 kind，项目级开启才推）。"""
    card = dict(card) if not isinstance(card, dict) else card  # Row 无 .get（同 card_blocked）
    push_event(project_id, "card_review",
               {"card_id": card["id"], "title": card.get("title") or ""})


def task_failed(project_id, task_id, name, ttype, error, skipped_n=0):
    """任务 failed/interrupted（runner 各终态写点调用；
    skipped_n = pipeline 后段连带跳过条数）。"""
    push_event(project_id, "task_failed", {
        "task_id": task_id, "name": name, "type": ttype,
        "error": error, "skipped_n": skipped_n})


# ---------- M2 入站：REST 客户端（requests，token 自管；节律仿 feishu_client.py） ----------

class FeishuRestError(Exception):
    """飞书 REST 调用失败（token 获取/业务 code 非 0/网络异常）。
    code = 飞书业务码（99991640 缺权限、40000000 业务约束、40000031 图标非法……），
    供调用方做差异化中文引导；网络异常/非 JSON 响应等拿不到业务码的情形为 None。"""

    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


_TOKEN_CACHE = {}      # app_id -> {"token": str, "expire": epoch 秒}（过期前 5 分钟刷新）
_BOT_OPEN_ID = {}      # app_id -> 机器人自身 open_id（群聊 @ 判定用，缓存）


def app_config(user_id):
    """用户自建应用凭据（feishu_user_cfgs 的 app_id/app_secret）；任一缺失返回 None。
    入站长连接与 REST 均以用户自己的应用为主体，各用户互不影响。"""
    cfg = user_config(user_id)
    if cfg.get("app_id") and cfg.get("app_secret"):
        return cfg
    return None


def inbound_status(user_id):
    """用户入站长连接状态摘要（设置页展示用）：configured=凭据齐全；thread=连接
    线程是否存活。thread 为 True 仅代表线程在 client.start() 内（SDK 内置重连）；
    连接失败细节看 server.log。"""
    cfg = app_config(user_id)
    t = _WS_THREADS.get(user_id)
    return {"configured": cfg is not None,
            "thread": t is not None and t.is_alive()}


def _tenant_token(cfg):
    """tenant_access_token（按 app_id 分桶缓存，过期前 5 分钟刷新；与参考实现同节律）。"""
    app_id = cfg.get("app_id") or ""
    now = time.time()
    cached = _TOKEN_CACHE.get(app_id) or {}
    if cached.get("token") and now < cached.get("expire", 0):
        return cached["token"]
    try:
        r = requests.post(
            "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
            json={"app_id": app_id, "app_secret": cfg.get("app_secret", "")},
            timeout=10)
        out = r.json()
    except (OSError, ValueError) as e:
        raise FeishuRestError(f"token 请求失败: {e}") from e
    if out.get("code") != 0:
        raise FeishuRestError(f"token 获取失败 code={out.get('code')} {out.get('msg', '')}",
                              code=out.get("code"))
    _TOKEN_CACHE[app_id] = {"token": out["tenant_access_token"],
                            "expire": now + out.get("expire", 7200) - 300}
    return out["tenant_access_token"]


def _rest(method, path, *, params=None, json_body=None, cfg=None):
    """飞书 REST 统一调用（按用户应用 cfg 鉴权）：非 0 业务码抛 FeishuRestError。
    路径规范化：调用方带/不带 /open-apis 前缀均恰好拼出一层（曾因调用方自带前缀
    + 此处再拼一层，请求打到 /open-apis/open-apis/... 恒 404 纯文本，且异常被吞
    表现为「机器人毫无反应」）。
    另：网关偶发返回粘连/截断的非 JSON 响应——非 JSON/非对象响应留痕原始字节后
    自动重试，最多 3 次。"""
    if cfg is None:
        raise FeishuRestError("应用未配置（app_id/app_secret 缺失）")
    path = "/" + path.lstrip("/")
    if not path.startswith("/open-apis"):
        path = f"/open-apis{path}"
    url = f"https://open.feishu.cn{path}"
    err_hint = ""
    for attempt in (1, 2, 3):
        try:
            r = requests.request(
                method, url, params=params,
                json=json_body, timeout=10,
                headers={"Authorization": f"Bearer {_tenant_token(cfg)}",
                         "Content-Type": "application/json"})
        except (OSError, ValueError) as e:
            raise FeishuRestError(f"REST {method} {path} 失败: {e}") from e
        try:
            out = r.json()
        except ValueError:
            print(f"feishu rest: 非 JSON 响应({attempt}/3) {method} {path} "
                  f"status={r.status_code} raw={r.content[:200]!r}",
                  file=sys.stderr, flush=True)
            err_hint = f"响应非 JSON status={r.status_code}"
            continue
        if not isinstance(out, dict):
            print(f"feishu rest: 非 dict 响应({attempt}/3) {method} {path} "
                  f"raw={r.text[:200]!r}", file=sys.stderr, flush=True)
            err_hint = "响应非对象"
            continue
        if out.get("code") != 0:
            raise FeishuRestError(
                f"REST {path} code={out.get('code')} {out.get('msg', '')}",
                code=out.get("code"))
        return out
    raise FeishuRestError(f"REST {method} {path} {err_hint}（已重试 3 次）")


def rest_send_text(open_id, text, cfg):
    """主动发单聊文本（调用方应用维度；open_id 为消息接收方在该应用下的标识）。"""
    _rest("POST", "/open-apis/im/v1/messages",
          params={"receive_id_type": "open_id"},
          json_body={"receive_id": open_id, "msg_type": "text",
                     "content": json.dumps({"text": text}, ensure_ascii=False)},
          cfg=cfg)


def rest_send_card(open_id, card, cfg):
    """主动发单聊交互卡片（schema 2.0 dict）。新版卡片的按钮回调才支持经
    长连接接收（旧版卡片回传交互只能 HTTP 回调）。im API 实测（2026-09-27
    spike）：content 直接传卡片 JSON 串；{"data": …} 包裹会被 230099 拒绝。"""
    _rest("POST", "/open-apis/im/v1/messages",
          params={"receive_id_type": "open_id"},
          json_body={"receive_id": open_id, "msg_type": "interactive",
                     "content": json.dumps(card, ensure_ascii=False)},
          cfg=cfg)


def rest_reply(message_id, text, cfg):
    """回复触发消息（带线程上下文；按调用方应用凭据）。"""
    _rest("POST", f"/open-apis/im/v1/messages/{message_id}/reply",
          json_body={"msg_type": "text",
                     "content": json.dumps({"text": text}, ensure_ascii=False)},
          cfg=cfg)


def rest_patch_text(message_id, text, cfg):
    """原地补丁 bot 已发消息（慢操作回执「占位-补丁」用；按调用方应用凭据）。"""
    _rest("PUT", f"/open-apis/im/v1/messages/{message_id}",
          json_body={"msg_type": "text",
                     "content": json.dumps({"text": text}, ensure_ascii=False)},
          cfg=cfg)


def bot_open_id(cfg):
    """机器人自身 open_id（/bot/v3/info，按 app_id 缓存一次；群聊 @ 判定用）。"""
    app_id = cfg.get("app_id") or ""
    if _BOT_OPEN_ID.get(app_id):
        return _BOT_OPEN_ID[app_id]
    out = _rest("GET", "/open-apis/bot/v3/info", cfg=cfg)
    _BOT_OPEN_ID[app_id] = (out.get("bot") or {}).get("open_id")
    return _BOT_OPEN_ID[app_id]


# ---------- M4 快捷指令（Slash Command，application/v7/app_slash_commands） ----------
# 飞书客户端里输入「/」时，输入框上方弹出的指令面板内容由开放平台**按应用维度**下发：
# 应用用 OpenAPI 注册若干条指令（名称 + 说明 + 图标），用户在面板里选中即把
# 「/名称 [参数]」当普通文本消息发给机器人（走既有 im.message.receive_v1 长连接），
# 再由 parse_intent 的斜杠别名规则落到与中文指令同一套执行器——入站链路零分叉。
# 注册/更新约 5 分钟服务端生效 + 客户端约 3 分钟缓存；PC 飞书 7.70+、移动 7.71+。
# 文档：https://open.larkoffice.com/document/mcp_open_tools/agent-best-practices/agent-supports-slash-commands

SLASH_API = "/open-apis/application/v7/app_slash_commands"
# (指令名, 中文说明, icon_key)：指令名与 _INTENT_RULES 的 /别名 一一对应（顺序即面板顺序）；
# icon_key 取值见官方「Slash Command Icon Key 说明」，传错报 40000031
SLASH_COMMANDS = (
    ("help",    "查看可用指令", "skill_outlined"),
    ("bind",    "绑定站点账号：/bind 绑定码", "member_outlined"),
    ("unbind",  "解除站点账号绑定", "clear_outlined"),
    ("project", "设置默认项目：/project 项目名", "home_outlined"),
    ("status",  "查看任务与看板摘要：/status [项目名]", "database_outlined"),
    ("cards",   "查找卡片：/cards 关键字（id 前缀 / 标题包含）", "codeblock_outlined"),
    ("approve", "通过待审核卡片：/approve 卡片", "flag_outlined"),
    ("reject",  "驳回卡片继续开发：/reject 卡片 意见", "edit_outlined"),
    ("answer",  "回复 agent 提问：/answer 卡片 选项序号|文字", "chat_outlined"),
    ("agree",   "批准挂起的工具审批：/agree 卡片 [session]", "sent_outlined"),
    ("deny",    "拒绝挂起的工具审批：/deny 卡片", "ai-block_outlined"),
)
_SLASH_NAMES = tuple(c for c, _, _ in SLASH_COMMANDS)
# 缺权限/scope 类业务码（99991640 lacks permission；99991672/99991679 同为 scope 相关）
_SLASH_PERM_CODES = (99991640, 99991672, 99991679)
_SLASH_PERM_HINT = ("应用缺少「应用指令」权限：飞书开发者后台 → 权限管理，添加 "
                    "application:app_slash_command:read 与 write，创建并发布新版本后重试")


def _slash_description(desc):
    """指令说明载荷：default_value 兜底 + 中文 i18n。
    **图标不放这里**——2026-10-05 线上取证：官方创建示例把 icon 放 description 内可被接受
    但**被忽略**（回读恒为默认 skill_outlined）；放 item 级（GET 回包形态）POST/PATCH 均生效
    （实测：PATCH 后回读 database_outlined、POST 后回读 flag_outlined）。"""
    return {"default_value": desc, "i18n": {"zh_cn": desc}}


def _slash_remote_desc(item):
    """远端 item → 说明文本（GET 回包的 description 是 {default_value,i18n} 对象，
    兼容直接给字符串的形态）。"""
    d = (item or {}).get("description")
    if isinstance(d, str):
        return d
    if isinstance(d, dict):
        return d.get("default_value") or (d.get("i18n") or {}).get("zh_cn") or ""
    return ""


def _slash_remote_icon(item):
    """远端 item → icon_key（官方示例把 icon 放 description 内、回包示例放 item 级，
    两种形态都认；都取不到按缺省 skill_outlined，与创建时的默认一致）。"""
    candidates = [(item or {}).get("icon")]
    d = (item or {}).get("description")
    if isinstance(d, dict):
        candidates.append(d.get("icon"))
    for holder in candidates:
        if isinstance(holder, dict) and holder.get("icon_key"):
            return holder["icon_key"]
    return "skill_outlined"


def slash_error_hint(err):
    """飞书业务码 → 用户可操作的中文引导（设置页展示用，不抛异常）。"""
    code = getattr(err, "code", None)
    if code in _SLASH_PERM_CODES:
        return _SLASH_PERM_HINT
    if code == 40000031:
        return "指令图标 icon_key 不合法（取值见官方 Slash Command Icon Key 说明）"
    if code == 99992402:
        return "指令参数校验失败：指令名需为不含「/」的标识符，说明不可为空"
    return str(err)


def _need_scope(err):
    """该失败是否属「应用缺 scope」类——决定要不要向用户发飞书权限引导卡片。"""
    return getattr(err, "code", None) in _SLASH_PERM_CODES


def list_slash_commands(cfg):
    """已注册指令列表（GET；需要 application:app_slash_command:read）。"""
    out = _rest("GET", SLASH_API, cfg=cfg)
    items = (out.get("data") or {}).get("items") or []
    return [{"command_id": str(i.get("command_id") or ""),
             "command": i.get("command") or "",
             "description": _slash_remote_desc(i),
             "icon": _slash_remote_icon(i),
             "update_time": i.get("update_time") or ""}
            for i in items]


def create_slash_command(cfg, command, desc, icon_key="skill_outlined"):
    """注册一条指令，返回 command_id（重名报 40000000 command already exists）。
    icon 走 item 级（实测生效；放 description 内会被忽略，见 _slash_description）。"""
    out = _rest("POST", SLASH_API, cfg=cfg,
                json_body={"command": command,
                           "description": _slash_description(desc),
                           "icon": {"icon_key": icon_key or "skill_outlined"}})
    return str((out.get("data") or {}).get("command_id") or "")


def update_slash_command(cfg, command_id, desc, icon_key="skill_outlined"):
    """按 command_id 更新说明与图标（PATCH 幂等；指令名注册后不可改）。"""
    _rest("PATCH", f"{SLASH_API}/{command_id}", cfg=cfg,
          json_body={"description": _slash_description(desc),
                     "icon": {"icon_key": icon_key or "skill_outlined"}})


def delete_slash_command(cfg, command_id):
    """删除一条指令（已删除的再删返回 command_id not found，由调用方按幂等处理）。"""
    _rest("DELETE", f"{SLASH_API}/{command_id}", cfg=cfg)


def _slash_upsert(cfg, name, desc, icon, by_name):
    """单条幂等 upsert（同步循环内的最小执行单元）：返回 created/updated/kept。
    差异判定=说明**或图标**不一致即更新：图标现已证明可回读（item 级下发生效），
    故这条严格判定既幂等、又能自愈「历史上用 description 内 icon 注册、只落了默认图标」
    的存量指令（下一批同步自动补齐真图标）。
    创建撞名（40000000，多为差集竞态或用户手工建过）时重取列表按 command_id 转更新，
    使重复点击「注册/同步」必然收敛而不是报错。"""
    cur = by_name.get(name)
    if cur is not None:
        if cur["description"] == desc and cur["icon"] == icon:
            return "kept"
        update_slash_command(cfg, cur["command_id"], desc, icon)
        return "updated"
    try:
        create_slash_command(cfg, name, desc, icon)
        return "created"
    except FeishuRestError as e:
        if getattr(e, "code", None) != 40000000:
            raise
        fresh = {r["command"]: r for r in list_slash_commands(cfg)}
        cur = fresh.get(name)
        if cur is None:
            raise
        update_slash_command(cfg, cur["command_id"], desc, icon)
        return "updated"


def slash_status(user_id):
    """设置页读取口：TS 期望清单 + 飞书侧现状（含用户自己的其他指令）。
    凭据缺失/权限不足等一律走 error 字段返回，不抛异常（页面照常渲染并给引导）；
    need_scope=缺「应用指令」scope（页面据此提供「发飞书权限卡片」入口）。"""
    desired = [{"command": c, "description": d, "icon": i}
               for c, d, i in SLASH_COMMANDS]
    cfg = app_config(user_id)
    if cfg is None:
        return {"configured": False, "desired": desired, "remote": [], "extra": [],
                "need_scope": False,
                "error": "未配置应用凭据（App ID/App Secret），先在上方「飞书机器人配置」保存后重试"}
    try:
        remote = list_slash_commands(cfg)
    except FeishuRestError as e:
        return {"configured": True, "desired": desired, "remote": [], "extra": [],
                "need_scope": _need_scope(e), "error": slash_error_hint(e)}
    extra = sorted(r["command"] for r in remote if r["command"] not in _SLASH_NAMES)
    return {"configured": True, "desired": desired, "remote": remote, "extra": extra,
            "need_scope": False, "error": ""}


def sync_slash_commands(user_id):
    """把 TS 指令清单幂等同步到飞书：只增/改**自己的**指令，**绝不删**用户的其他指令。
    返回 {ok, created, updated, kept, extra, failed, need_scope, error} 供设置页展示
    （need_scope=True 时调用方应发权限引导卡片并等用户确认后重试）。"""
    cfg = app_config(user_id)
    if cfg is None:
        return {"ok": False, "need_scope": False,
                "error": "未配置应用凭据（App ID/App Secret）"}
    try:
        remote = list_slash_commands(cfg)
    except FeishuRestError as e:
        return {"ok": False, "need_scope": _need_scope(e), "error": slash_error_hint(e)}
    by_name = {r["command"]: r for r in remote}
    buckets = {"created": [], "updated": [], "kept": []}
    failed = []
    need_scope = False
    for name, desc, icon in SLASH_COMMANDS:
        try:
            buckets[_slash_upsert(cfg, name, desc, icon, by_name)].append(name)
        except FeishuRestError as e:
            need_scope = need_scope or _need_scope(e)
            failed.append(f"{name}: {slash_error_hint(e)}")
    return {"ok": not failed,
            "created": buckets["created"], "updated": buckets["updated"],
            "kept": buckets["kept"],
            "extra": sorted(n for n in by_name if n not in _SLASH_NAMES),
            "failed": failed, "need_scope": need_scope,
            "error": failed[0] if failed else ""}


def clear_slash_commands(user_id):
    """删除**TS 自己的**指令（名字命中 SLASH_COMMANDS 的远端项）；用户其他指令不动。"""
    cfg = app_config(user_id)
    if cfg is None:
        return {"ok": False, "need_scope": False,
                "error": "未配置应用凭据（App ID/App Secret）"}
    try:
        remote = list_slash_commands(cfg)
    except FeishuRestError as e:
        return {"ok": False, "need_scope": _need_scope(e), "error": slash_error_hint(e)}
    deleted, failed = [], []
    need_scope = False
    for r in remote:
        if r["command"] not in _SLASH_NAMES:
            continue
        try:
            delete_slash_command(cfg, r["command_id"])
            deleted.append(r["command"])
        except FeishuRestError as e:
            need_scope = need_scope or _need_scope(e)
            failed.append(f"{r['command']}: {slash_error_hint(e)}")
    return {"ok": not failed, "deleted": sorted(deleted),
            "extra": sorted(r["command"] for r in remote if r["command"] not in _SLASH_NAMES),
            "failed": failed, "need_scope": need_scope,
            "error": failed[0] if failed else ""}


def _slash_summary(out):
    """同步结果一句话摘要（DM 卡片回执与设置页提示共用）。"""
    s = (f"新增 {len(out.get('created') or [])}、更新 {len(out.get('updated') or [])}、"
         f"已是最新 {len(out.get('kept') or [])}")
    if out.get("failed"):
        s += f"、失败 {len(out['failed'])}"
    return s


def slash_perm_card(app_id, user_id):
    """权限引导卡片（schema 2.0，DM 单聊）：说明缺哪个 scope、三步怎么开通、
    开发者后台直达链接，底部「我已开通，重试注册」按钮——点它回调里重跑同步
    （卡片无状态，value 只带身份 u 与动作 t=sc，回调时按 open_id→binding 复核）。
    按钮形态与既有交互卡片完全一致（behaviors/callback），避免未验证的元素类型。
    链接只给「应用详情页」根 URL（官方文档只保证菜单路径「开发配置 → 权限管理 /
    应用发布 → 版本管理与发布」，深链路由未在文档中出现，不猜）。"""
    url = (f"https://open.feishu.cn/app/{app_id}"
           if app_id else "https://open.feishu.cn/app")
    content = (
        "**Touchstone 快捷指令**（机器人私聊输入框打「/」弹出的指令面板）需要你的飞书应用先开通权限：\n"
        "· `application:app_slash_command:read`\n"
        "· `application:app_slash_command:write`\n\n"
        "**开通三步**：\n"
        f"1. 打开 [开发者后台 · 本应用]({url})，左侧 **开发配置 → 权限管理**，点「开通权限」\n"
        "2. 搜索 `app_slash_command`，把读、写两个权限都勾上并确认开通\n"
        "3. 左侧 **应用发布 → 版本管理与发布** → 创建版本并发布"
        "（权限改动必须发版、过审后才生效）\n\n"
        "完成后点下面的按钮，我立刻重试注册；若刚发版，可等约 1 分钟再点一次。")
    payload = {"t": "sc", "a": "retry", "u": int(user_id)}
    return {"schema": "2.0",
            "header": {"title": {"tag": "plain_text",
                                 "content": "🔑 需要开通「应用指令」权限"},
                       "template": "orange"},
            "body": {"elements": [
                {"tag": "markdown", "content": content},
                {"tag": "button", "type": "primary",
                 "text": {"tag": "plain_text", "content": "我已开通，重试注册"},
                 "behaviors": [{"type": "callback", "value": payload}]},
            ]}}


def send_slash_perm_card(user_id):
    """向该用户的飞书单聊发权限引导卡片（需已绑定 + 应用凭据齐全）。
    返回 (ok, err)：未绑定/未配凭据属正常情形，调用方据此给站点侧提示，不抛异常。"""
    cfg = app_config(user_id)
    if cfg is None:
        return False, "未配置应用凭据（App ID/App Secret），先保存配置再发卡片"
    binding = db.get_feishu_binding_by_user(user_id)
    if not binding:
        return False, "尚未绑定飞书账号：设置页生成绑定码后在机器人单聊回复「绑定 <码>」"
    try:
        rest_send_card(binding["open_id"],
                       slash_perm_card(cfg.get("app_id", ""), user_id), cfg)
        return True, ""
    except FeishuRestError as e:
        return False, f"卡片发送失败：{e}"


def _on_slash_perm_action(sender, value, cfg):
    """权限引导卡片的按钮回调：复核身份（必须是该卡片指向的、已绑定的用户）→
    重跑 sync_slash_commands → DM 文本回执 + toast。返回 None 表示不更新卡片。"""
    binding = db.get_feishu_binding_by_open(sender)
    if binding is None:
        _dm_text(sender, "尚未绑定 Touchstone 账号：登录站点 → 侧栏「设置」→ "
                         "飞书设置，生成绑定码后在这里回复「绑定 <码>」完成绑定", cfg)
        return {"toast": {"type": "error", "content": "尚未绑定站点账号"}}
    uid = int(value.get("u") or 0)
    if uid and uid != int(binding["user_id"]):
        # 防串号：卡片只对它发给的那个人生效
        return {"toast": {"type": "error", "content": "该卡片不属于当前账号"}}
    out = sync_slash_commands(binding["user_id"])
    if out.get("ok"):
        _dm_text(sender, "✅ 快捷指令注册完成：" + _slash_summary(out)
                 + "\n约 5 分钟后在机器人私聊输入「/」即可看到（重启飞书客户端可加速）。", cfg)
        return {"toast": {"type": "success", "content": "注册完成"}}
    text = "❌ 仍未成功：" + (out.get("error") or "未知错误")
    if out.get("need_scope"):
        text += "\n看起来权限还没生效：确认已在权限管理里添加读+写并**创建版本发布**，稍等约 1 分钟再点一次卡片上的按钮。"
    _dm_text(sender, text, cfg)
    return {"toast": {"type": "error", "content": "仍未成功，看私聊回复"}}


# ---------- M2 入站：ws 长连接与消息主流程 ----------

HELP_TEXT = (
    "Touchstone 指令（单聊可用）：\n"
    "· 帮助 — 本说明\n"
    "· 绑定 <码> — 绑定站点账号（绑定码在站点侧栏「设置」→ 飞书设置 生成）\n"
    "· 解绑 — 解除绑定\n"
    "· 默认项目 <项目名> — 设置默认项目\n"
    "· 状态 [项目名] — 任务与看板摘要\n"
    "· 卡片 <关键字> — 找卡片（id 前缀/标题包含）\n"
    "· 通过 <卡片> — 待审核卡片完成审核\n"
    "· 驳回 <卡片> <意见> — 打回继续开发\n"
    "· 作答 <卡片> <选项序号|文字> — 回复 agent 提问"
    "（多选逗号分隔：作答 7 1,3；文字=自定义回答。单题多选卡上勾选后"
    "点「提交作答」即可，无需打字）\n"
    "· 作答 <卡片> <题号:值 …> — 多子题一次答全"
    "（如「作答 7 1:2 2:1 3:1,3」；多选写 1:2,3，自定义写 1:文字。"
    "多子题卡可直接在卡片上逐题点选，点满自动送达，已点选的题不必重复给）\n"
    "· 同意 <卡片> [会话] — 批准挂起的工具审批（「会话」=本会话内自动放行）\n"
    "· 拒绝 <卡片> — 拒绝挂起的工具审批\n"
    "· 快捷指令：输入框里打「/」可直接选 /status、/cards、/approve 等"
    "（参数用法与上面对应中文指令一致）"
)

_WS_THREADS = {}       # user_id -> 入站线程（已拉起且在 run 的；线程退出后残留引用）
_MSG_SEEN = []         # message_id LRU（list 尾=最新）
_MSG_SEEN_SET = set()
_MSG_SEEN_MAX = 512
_EVT_SEEN = []         # 卡片回调 event_id LRU（card.action.trigger 飞书会重推）
_EVT_SEEN_SET = set()
_EVT_SEEN_MAX = 512


def _seen_event(eid):
    """卡片回调 event_id 去重（LRU512）：返回 True=重复事件。"""
    if eid in _EVT_SEEN_SET:
        return True
    _EVT_SEEN.append(eid)
    _EVT_SEEN_SET.add(eid)
    if len(_EVT_SEEN) > _EVT_SEEN_MAX:
        _EVT_SEEN_SET.discard(_EVT_SEEN.pop(0))
    return False


def start_inbound_for(user_id):
    """幂等启动指定用户的入站长连接线程（首次配置保存时即时拉起/服务启动遍历）；
    应用凭据缺失或线程已在运行时不启动。返回是否启动了新线程。
    凭据变更后旧连接仍在跑（lark SDK 无干净停止）——变更提示需重启站点生效；
    线程随进程 daemon 退出。生命周期日志走 stderr（server.log 可查）。"""
    cur = _WS_THREADS.get(user_id)
    if cur is not None and cur.is_alive():
        return False
    cfg = app_config(user_id)
    if not cfg:
        print(f"feishu inbound: 用户 {user_id} 应用凭据缺失，长连接未启动",
              file=sys.stderr, flush=True)
        return False
    t = threading.Thread(target=_ws_run, args=(user_id, cfg), daemon=True,
                         name=f"feishu-inbound-{user_id}")
    _WS_THREADS[user_id] = t
    t.start()
    return True


def start_inbound_all():
    """服务启动时遍历全部用户配置，为应用凭据齐全者逐个拉起入站长连接。
    返回新启动的连接数。"""
    n = 0
    for user_id, cfg in db.list_feishu_user_cfgs():
        if cfg.get("app_id") and cfg.get("app_secret"):
            if start_inbound_for(user_id):
                n += 1
    return n


def _make_ws_client(cfg, event_handler, card_handler, log_level=None):
    """构造支持卡片回调分派的 ws 客户端。
    实测结论（2026-09-27）：长连接上卡片点击（card.action.trigger）以 **event 帧**
    投递，主路线是 EventDispatcherHandler.register_p2_card_action_trigger 注册
    processor（见 _ws_run）——不注册会「processor not found」→ 飞书侧 200671。
    协议层的 MessageType.CARD 帧本版网关并不使用，且 lark-oapi 1.7.3 的
    ws.Client 对其直接 return 丢弃（构造参数也无 card_handler）——本子类覆写
    帧分发把它接进 card_handler 仅为协议兜底，两路最终都汇到 _on_card_action。
    依赖 SDK 内部方法/常量形状（lark_oapi.ws.client 的 _get_by_key/HEADER_*/
    MessageType/Response/JSON 与父类 _combine/_write_message），升级 lark-oapi
    后须复核本覆写。"""
    from lark_oapi.ws import client as sdk
    import lark_oapi as lark

    class _CardAwareClient(lark.ws.Client):
        async def _handle_data_frame(self, frame):
            try:
                mt = sdk.MessageType(
                    sdk._get_by_key(frame.headers, sdk.HEADER_TYPE))
            except Exception:
                return          # 头缺失/未知帧类型：父层无法处理，直接丢弃
            if mt == sdk.MessageType.CARD:
                await self._handle_card_frame(frame)
                return
            await super()._handle_data_frame(frame)

        async def _handle_card_frame(self, frame):
            hs = frame.headers
            msg_id = sdk._get_by_key(hs, sdk.HEADER_MESSAGE_ID)
            sum_ = sdk._get_by_key(hs, sdk.HEADER_SUM)
            seq = sdk._get_by_key(hs, sdk.HEADER_SEQ)
            pl = frame.payload
            if int(sum_) > 1:   # 合包（与父类同款逻辑）
                pl = self._combine(msg_id, int(sum_), int(seq), pl)
                if pl is None:
                    return
            threading.Thread(target=self._run_card_handler, args=(pl,),
                             daemon=True, name="feishu-card-action").start()
            resp = sdk.Response(code=sdk.http.HTTPStatus.OK)
            header = hs.add()
            header.key = sdk.HEADER_BIZ_RT
            header.value = "0"
            frame.payload = sdk.JSON.marshal(resp).encode("utf-8")
            await self._write_message(frame.SerializeToString())

        def _run_card_handler(self, pl):
            try:
                data = json.loads(pl.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                return
            try:
                card_handler(data)
            except Exception as e:
                print(f"feishu inbound: 卡片回调处理异常: {e!r}",
                      file=sys.stderr, flush=True)

    if log_level is None:
        log_level = lark.LogLevel.ERROR
    return _CardAwareClient(cfg["app_id"], cfg["app_secret"],
                            event_handler=event_handler,
                            log_level=log_level)


def _ws_run(user_id, cfg):
    """ws 客户端线程主体（按用户应用）：start() 阻塞，SDK 内置自动重连
    （同机实证；断连窗口的入站消息不补推=已知限制）。随进程 daemon 退出，
    handler 内禁上抛。cfg 为进程级不可变更快照——凭据变更后旧连接持续到重启站点。"""
    try:
        import lark_oapi as lark
    except ImportError:
        print("feishu inbound: lark-oapi 未安装，入站禁用",
              file=sys.stderr, flush=True)
        return  # 依赖未装：入站禁用（M1 出站 webhook 不受影响）

    def _handler(data):
        _on_message_event(data, cfg)

    def _on_card_sdk(data):
        # 返回值（toast）由 ws 客户端序列化回响应帧——丢弃则点击反馈（toast）
        # 恒不生效（SDK 路径此前即如此）
        return _on_card_action(_card_sdk_to_dict(data), cfg)

    handler = (lark.EventDispatcherHandler.builder("", "")
               .register_p2_im_message_receive_v1(_handler)
               # 已读回执不注册会在 SDK 层报 ERROR「processor not found」（每次已读一条），空实现消音
               .register_p2_im_message_message_read_v1(lambda data: None)
               # 卡片点击回调（card.action.trigger）：长连接上以 event 帧投递，
               # 不注册会「processor not found」→ 飞书侧报 200671（2026-09-27 实测）
               .register_p2_card_action_trigger(_on_card_sdk)
               .build())
    # TS_FEISHU_WS_DEBUG=1: SDK 与 websockets 帧级 DEBUG 日志（排查事件是否到达网关层）
    ws_debug = bool(os.environ.get("TS_FEISHU_WS_DEBUG"))
    if ws_debug:
        logging.basicConfig(level=logging.DEBUG,
                            format="%(asctime)s %(name)s %(levelname)s %(message)s")
        logging.getLogger("websockets").setLevel(logging.INFO)
    client = _make_ws_client(cfg, handler, lambda data: _on_card_action(data, cfg),
                             log_level=lark.LogLevel.DEBUG if ws_debug
                             else lark.LogLevel.ERROR)
    print(f"feishu inbound: 用户 {user_id} 连接长连接网关（app_id={cfg['app_id']}）…",
          file=sys.stderr, flush=True)
    try:
        client.start()
    except Exception as e:  # 连接建立失败/网关拒绝等：留痕后线程退出（不再自动重试）
        print(f"feishu inbound: 用户 {user_id} 长连接异常退出: {e!r}（重启站点重试）",
              file=sys.stderr, flush=True)


def _on_message_event(data, cfg):
    """SDK 事件回调（P2ImMessageReceiveV1）→ 统一 dict → 主流程；异常全吞。
    cfg 为本连接所有者的应用凭据（后续 REST 回复/群聊判定均按此应用）。"""
    try:
        msg = data.event.message
        mentions = [{"key": m.key, "open_id": (m.id.open_id if m.id else None)}
                    for m in (msg.mentions or [])]
        handle_message_event({
            "message_id": msg.message_id, "message_type": msg.message_type,
            "content": msg.content, "chat_type": msg.chat_type,
            "mentions": mentions,
            "sender_open_id": data.event.sender.sender_id.open_id}, cfg)
    except Exception as e:
        print(f"feishu inbound: 事件解析异常: {e!r}", file=sys.stderr, flush=True)


def _seen_message(mid):
    """message_id LRU 去重（512 条）：返回 True=重复消息（飞书会重推）。"""
    if mid in _MSG_SEEN_SET:
        return True
    _MSG_SEEN.append(mid)
    _MSG_SEEN_SET.add(mid)
    if len(_MSG_SEEN) > _MSG_SEEN_MAX:
        _MSG_SEEN_SET.discard(_MSG_SEEN.pop(0))
    return False


def handle_message_event(evt, cfg=None):
    """入站消息主流程（M2 规则指令全为快路径，内联同步执行；M3 agent 解析需挪线程）：
    去重 → 群聊 @ 判定（未 @ 静默）→ 文本抽取（剥 @占位符）→ 绑定校验（未绑引导）
    → 意图解析（未识别回帮助）→ 执行 → reply。任何异常吞掉。
    cfg = 连接所有者（收到消息的应用）的凭据，供回复/群聊判定使用。"""
    try:
        mid = evt.get("message_id")
        if not mid or _seen_message(mid):
            return
        print(f"feishu inbound: 收到消息 chat_type={evt.get('chat_type')} "
              f"type={evt.get('message_type')} sender={(evt.get('sender_open_id') or '')[:12]}",
              file=sys.stderr, flush=True)
        if evt.get("chat_type") == "group":
            bo = bot_open_id(cfg)
            if not bo or not any((m or {}).get("open_id") == bo
                                 for m in evt.get("mentions") or []):
                return
        if evt.get("message_type") != "text":
            if evt.get("chat_type") != "group":
                rest_reply(mid, "暂不支持该消息类型，请发送文字指令", cfg)
            return
        try:
            content = json.loads(evt.get("content") or "{}")
        except ValueError:
            content = {}
        text = (content.get("text") or "").strip()
        for m in evt.get("mentions") or []:
            key = (m or {}).get("key")
            if key:
                text = text.replace(key, "").strip()
        if not text:
            return
        sender = evt.get("sender_open_id") or ""
        binding = db.get_feishu_binding_by_open(sender)
        intent = parse_intent(text)
        print(f"feishu inbound: 文本={text[:30]!r} intent={(intent or {}).get('action', '-')}",
              file=sys.stderr, flush=True)
        # 绑定指令先于绑定校验：未绑定者的合法指令只有「绑定」本身——若绑定校验
        # 前置，「绑定 <码>」也会被「尚未绑定」拦下，死锁（未绑定者永远无法绑定）
        if intent and intent["action"] == "bind":
            if binding is not None:
                rest_reply(mid, "当前账号已绑定，无需重复绑定（解绑后可重新绑定）", cfg)
                return
            err = bind_user(intent["groups"][0], sender)
            rest_reply(mid, "绑定成功，发「帮助」查看可用指令" if err is None else err, cfg)
            return
        if binding is None:
            rest_reply(mid, "尚未绑定 Touchstone 账号：登录站点 → 侧栏「设置」→ 飞书设置，"
                            "生成绑定码后在这里回复「绑定 <码>」完成绑定", cfg)
            return
        if intent is None:
            rest_reply(mid, HELP_TEXT, cfg)
            return
        reply = execute_intent(binding, intent, sender)
        if reply:
            rest_reply(mid, reply, cfg)
    except Exception as e:
        print(f"feishu inbound: 处理异常: {e!r}", file=sys.stderr, flush=True)


# ---------- DM 交互卡片点击回调（card.action.trigger，schema 2.0） ----------

def _toast_for(reply):
    """执行器回执文案 → 卡片回调 toast 载荷（reply=None 表示无需回执）。
    成功前缀与执行器约定对齐（已收下 / ✅）；完整结果走 DM 文本，toast 只做轻提示。"""
    if reply is None:
        return None
    ok = reply.startswith(("已收下", "✅"))
    return {"toast": {"type": "success" if ok else "error",
                      "content": "已收下，详情看机器人单聊" if ok
                      else "操作失败，详情看机器人单聊"}}


def _dm_text(open_id, text, cfg):
    """DM 文本旁路发送（回执/引导用）：失败留痕不外抛，不影响调用方返回。"""
    try:
        rest_send_text(open_id, text, cfg)
    except Exception as e:
        print(f"feishu inbound: DM 回执发送失败: {e!r}", file=sys.stderr, flush=True)


def _on_card_action(data, cfg):
    """卡片点击回调主流程：event_id 去重 → open_id 绑定校验（未绑 DM 引导）→
    动作分发（t=a 单题选项作答 / mq 多选类点选（多子题逐题点选、单题多选
    mini 表单）/ p 批准 / s 会话内批准 /
    d 拒绝 / sc 快捷指令权限卡片「我已开通，重试注册」）→ 与文本指令共用的
    _answer_by_token / _answer_multi_click / _decide_approval → DM 文本完整回执 + 返回 toast。
    value 精简键：t 动作（a 单题作答 / mq 多选类点选 / p 批准 / s 会话内批准 /
    d 拒绝）、c 卡号、n 题号（多题点选用）、i 选项序号（序号在执行器里重读服务端
    白名单，防过期重放/伪造）；多题点选另读 action.option / action.options
    （飞书回调带的**所选选项值**）。业务操作为本地 sqlite/内存（毫秒级），
    仅 DM 回执涉及网络——在卡片回调线程同步执行可接受。
    任何异常吞掉（返回 None=不更新卡片）。"""
    try:
        header = data.get("header") or {}
        event_id = str(header.get("event_id") or data.get("event_id") or "")
        if event_id and _seen_event(event_id):
            return None
        event = data.get("event") or {}
        sender = str((event.get("operator") or {}).get("open_id") or "")
        action = event.get("action") or {}
        value = dict(action.get("value") or {})
        t = str(value.get("t") or "")
        key = str(value.get("c") or "")
        # M4 权限引导卡片（t=sc）独立于卡片交互流：不带卡号，回调里重跑斜杠指令同步
        if t == "sc":
            return _on_slash_perm_action(sender, value, cfg)
        if t not in ("a", "mq", "p", "s", "d") or not key:
            return None
        binding = db.get_feishu_binding_by_open(sender)
        if binding is None:
            _dm_text(sender, "尚未绑定 Touchstone 账号：登录站点 → 侧栏「设置」→ "
                             "飞书设置，生成绑定码后在单聊回复「绑定 <码>」完成绑定", cfg)
            return {"toast": {"type": "error", "content": "尚未绑定站点账号"}}
        found, err = _find_user_card(binding["user_id"], key)
        if found is None:
            _dm_text(sender, err, cfg)
            return {"toast": {"type": "error", "content": "没找到对应卡片"}}
        p, c = found
        if t == "mq":
            # 多选类点选：每次点击自带 toast（含进度），答满那次才发 DM 文本
            reply, toast = _answer_multi_click(p, c, value, action)
            if reply:
                _dm_text(sender, reply, cfg)
            return toast
        if t == "a":
            reply = _answer_by_token(p, c, str(value.get("i") or ""))
        else:
            decision = "approved" if t in ("p", "s") else "rejected"
            reply = _decide_approval(p, c, decision,
                                     "session" if t == "s" else "")
        if reply:
            _dm_text(sender, reply, cfg)
        return _toast_for(reply)
    except Exception as e:
        print(f"feishu inbound: 卡片回调处理异常: {e!r}", file=sys.stderr, flush=True)
        return None


def _card_sdk_to_dict(data):
    """SDK P2CardActionTrigger 模型 → _on_card_action 的 dict 形态。
    卡片回调在长连接上以 event 帧投递（header.type=card.action.trigger），
    经 EventDispatcherHandler.register_p2_card_action_trigger 注册的 processor
    进来的是 SDK 模型对象；转成与协议层同构的 dict，回调主流程不感知来源。
    下拉点选作答的**所选选项值**（`option`/`options`）一并透传——缺了多题
    「逐题点选」取不到用户选的是哪一项（`_multi_click_index` 消费）。"""
    header = getattr(data, "header", None)
    event = getattr(data, "event", None)
    operator = getattr(event, "operator", None) if event else None
    action = getattr(event, "action", None) if event else None
    action_d = {"value": (getattr(action, "value", None) or {}) if action else {}}
    if action is not None:
        for k in ("tag", "name", "form_value", "input_value",
                  "option", "options", "checked"):
            v = getattr(action, k, None)
            if v is not None:
                action_d[k] = v
    return {
        "header": {"event_id": (getattr(header, "event_id", "") or "")
                   if header else ""},
        "event": {
            "operator": {"open_id": (getattr(operator, "open_id", "") or "")
                         if operator else ""},
            "action": action_d,
        },
    }


# 规则意图表（M3：未命中且 nl_parse=agent 时走 agent headless 兜底解析）
# 每条规则的「中文写法 | 斜杠别名」两分支共用同一组捕获组（组数必须一致，执行器按
# groups 取值）：斜杠别名对应 SLASH_COMMANDS 注册的指令名，用户从飞书指令面板选中后
# 投递过来的文本就是「/名称 [参数]」，与中文指令落到同一个 action。
_INTENT_RULES = (
    ("help",            r"^(?:帮助|help|/help)$"),
    ("bind",            r"^(?:绑定|/bind)\s*([A-Za-z0-9]{4,8})$"),
    ("unbind",          r"^(?:解绑|/unbind)$"),
    ("default_project", r"^(?:默认项目|/project)\s+(\S+)$"),
    ("status",          r"^(?:状态|/status)(?:\s+(.+))?$"),
    ("card",            r"^(?:卡片|/cards?)\s+(.+)$"),
    ("approve",         r"^(?:通过|/approve)\s+(\S+)$"),
    ("reject",          r"^(?:驳回|/reject)\s+(\S+)\s+(.+)$"),
    ("answer",          r"^(?:作答|/answer)\s+(\S+)\s+(.+)$"),
    ("agree",           r"^(?:同意|/agree)\s+(\S+)(?:\s+(会话|session))?$"),
    ("deny",            r"^(?:拒绝|/deny)\s+(\S+)$"),
)
_BIND_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"  # 去易混字符
_BIND_TTL = 600        # 绑定码有效期（秒）
_BIND_CODES = {}       # code -> (user_id, expires epoch)；内存态不入库


def parse_intent(text):
    """规则意图解析（本地正则先行；M3 未命中走 agent 兜底）。未识别返回 None。"""
    t = (text or "").strip()
    for action, pat in _INTENT_RULES:
        m = re.match(pat, t)
        if m:
            return {"action": action, "groups": list(m.groups())}
    return None


def make_bind_code(user_id):
    """生成 6 位绑定码（内存态 10 分钟有效；不入库）。"""
    code = "".join(secrets.choice(_BIND_ALPHABET) for _ in range(6))
    _BIND_CODES[code] = (user_id, time.time() + _BIND_TTL)
    return code


def bind_user(code, open_id):
    """校验绑定码并绑定（open_id 侧发起）。返回 None=成功，str=错误文案。"""
    item = _BIND_CODES.pop((code or "").strip().upper(), None)
    if item is None:
        return "绑定码无效或已被使用"
    user_id, expires = item
    if time.time() > expires:
        return "绑定码已过期，请到站点重新生成"
    db.set_feishu_binding(open_id, user_id)
    return None


def execute_intent(binding, intent, sender_open_id):
    """绑定用户身份执行意图；返回回复文案（空串=不回复）。项目/卡片访问一律先过
    归属（list_projects(user_id) 限用户项目），异常统一转友好文案。"""
    action, g = intent["action"], intent["groups"]
    try:
        if action == "help":
            return HELP_TEXT
        if action == "bind":
            return "当前账号已绑定，无需重复绑定"
        if action == "unbind":
            db.del_feishu_binding_by_open(sender_open_id)
            return "已解绑。重新绑定请到站点生成新的绑定码"
        if action == "default_project":
            return _set_default_project(binding, g[0] or "")
        return _execute_board_action(binding, intent, sender_open_id)
    except FeishuRestError:
        return "飞书接口调用失败，请稍后重试"
    except Exception:
        return "指令执行失败，请稍后重试"


def _set_default_project(binding, name):
    """设置单聊默认项目：精确名 → 唯一包含匹配；否则报项目不在列表。"""
    user_id = binding["user_id"]
    projects = db.list_projects(user_id)
    for p in projects:
        if p["name"] == name:
            db.set_feishu_default_project(binding["open_id"], p["id"])
            return f"默认项目已设为「{name}」"
    hits = [p for p in projects if name in p["name"]]
    if len(hits) == 1:
        db.set_feishu_default_project(binding["open_id"], hits[0]["id"])
        return f"默认项目已设为「{hits[0]['name']}」"
    return f"项目「{name}」不在你的项目列表"


def _find_user_card(user_id, key):
    """找卡并消歧（文本指令与 DM 卡片按钮回调共用）：纯数字按 id 前缀、否则标题
    包含，仅限用户自己的项目（多用户隔离）。返回 (project, card) 或 (None, 错误文案)。"""
    hits = _find_cards(user_id, key)
    if not hits:
        return None, f"没有找到匹配「{key}」的卡片（仅搜你自己的项目；支持 id 前缀/标题包含）"
    if len(hits) > 1:
        lines = ["匹配到多张卡，请用更精确的 id 或关键字："]
        for p, c in hits[:6]:
            lines.append(f"· #{c['id']} [{p['name']}] {(c['title'] or '')[:30]}")
        return None, "\n".join(lines)
    return hits[0], ""


# ---------- 多选类「卡片点选」暂存态（2026-10-07 第三/四档） ----------
#
# 为什么需要暂存：飞书卡片上每题各点一次下拉，每次点击是一次独立的
# `card.action.trigger` 回调；而送达 agent 的 `board.answer_interaction` 必须
# **一次给全所有子题**（dsh 的 ask_user_question 一个 Promise 只被 `/answer`
# 兑现一次，缺项即未答）。故点击先落暂存，答满才整批提交——单题多选（n=1）
# 点一次即答满，走的是同一条路（暂存只作一次中转），不必另开一条链路。
#
# 桶键 = (卡号, qid)：qid 变了（新提问/旧提问被作废）自然换桶，旧桶靠 TTL 回收；
# 桶值 `{n, vals:{题号:题值}, at}`，题值形态与文本指令一致（"2" / "1,3" / 自由文字），
# 于是送达可直接复用 `_multi_answers`。纯内存态：重启丢失时用户重点一次即可
# （不引 DB——暂存是中转态，落库反而要处理与 qid 的一致性）。
_MQ_LOCK = threading.Lock()
_MQ_STAGE = {}         # (card_id:int, qid:str) -> {"n":int, "vals":{no:val}, "at":float}


def _mq_prune_locked(now):
    """清过期/超量暂存桶（调用方必须已持 `_MQ_LOCK`）。"""
    for k in [k for k, b in _MQ_STAGE.items() if now - b["at"] > _MQ_TTL]:
        _MQ_STAGE.pop(k, None)
    while len(_MQ_STAGE) > _MQ_MAX_BUCKETS:
        oldest = min(_MQ_STAGE, key=lambda k: _MQ_STAGE[k]["at"])
        _MQ_STAGE.pop(oldest, None)


def _mq_put(cid, qid, n, no, val):
    """写入一题答案 → `(已答数, 总题数, 是否已答满)`。
    题数不符时重建桶（卡片可能已指向新提问，宁可重来不可串答）。"""
    now = time.time()
    key = (int(cid), str(qid or ""))
    with _MQ_LOCK:
        _mq_prune_locked(now)
        bucket = _MQ_STAGE.get(key)
        if bucket is None or bucket["n"] != int(n):
            bucket = {"n": int(n), "vals": {}, "at": now}
            _MQ_STAGE[key] = bucket
        bucket["vals"][int(no)] = str(val)
        bucket["at"] = now
        done = len(bucket["vals"])
        return done, int(n), done >= int(n)


def _mq_take(cid, qid, n):
    """取走并清空该提问的暂存 → `[(题号, 题值)]`（题号升序）。
    **送达前调用**：取走即认为这次点选已被消费，避免并发重复提交。"""
    key = (int(cid), str(qid or ""))
    with _MQ_LOCK:
        bucket = _MQ_STAGE.pop(key, None)
    if not bucket or bucket["n"] != int(n):
        return []
    return [(no, bucket["vals"][no]) for no in sorted(bucket["vals"])]


def _mq_peek(cid, qid):
    """读该提问已暂存的答案 `{题号: 题值}`（文本指令补答时合并用，不改动暂存）。"""
    with _MQ_LOCK:
        bucket = _MQ_STAGE.get((int(cid), str(qid or "")))
        return dict(bucket["vals"]) if bucket else {}


def _mq_drop(cid, qid):
    """丢弃该提问的暂存（提问已收口/送达完成/作答报错兜底）。"""
    with _MQ_LOCK:
        _MQ_STAGE.pop((int(cid), str(qid or "")), None)


def _multi_click_index(action, multi, name):
    """飞书回调 → 所选选项序号列表（1 起）；取不到返回 None。

    三条来源（按卡片构建形态一一对应，见 `_multi_click_elements`）：
      - 单选根级 `select_static` → `action.option`（官方《下拉选择-单选》回调示例：
        `"option": "1"` = 用户提交的选项回传数据，即 `options[].value`）；
      - 多选单题 mini 表单提交 → `action.form_value[<组件 name>]`（数组；官方
        《下拉选择-多选》回调示例：`form_value.multi_select_departments` 为数组）；
      - 兜底 `action.value.i`：万一某形态只回组件 value，也按序号解析。"""
    vals = None
    if multi:
        raw = (action.get("form_value") or {}).get(name)
        if isinstance(raw, list) and raw:
            vals = [str(x) for x in raw]
        elif isinstance(raw, str) and raw.strip():
            vals = [x for x in re.split(r"[\s,]+", raw.strip()) if x]
        if vals is None:                     # 兼容别种回传形态
            raw = action.get("options")
            if isinstance(raw, list) and raw:
                vals = [str(x) for x in raw]
    else:
        raw = action.get("option")
        if isinstance(raw, list) and raw:
            vals = [str(x) for x in raw]
        elif raw not in (None, ""):
            vals = [str(raw)]
    if vals is None:
        one = (action.get("value") or {}).get("i")
        if one not in (None, ""):
            vals = [str(one)]
    if not vals:
        return None
    out = []
    for v in vals:
        if not re.fullmatch(r"\d+", v):
            return None
        out.append(int(v))
    return out


def _toast(kind, content):
    """卡片回调 toast 载荷（kind ∈ success/error/info）。"""
    return {"toast": {"type": kind, "content": content}}


def _answer_multi_click(p, c, value, action):
    """多选类点选卡回调（多子题「逐题点选卡」与单题多选 mini 表单共用）：
    把该题答案写进暂存，**答满即整批送达**。返回 `(DM 回执文案 or "", toast 载荷)`。

    每次点击都回一个 toast（含进度），只有答满那次才发 DM 文本（减少消息噪音）。
    单题多选（n=1）点满即等于立即送达（暂存只是一次中转，见 `_single_multi_select_pick`）；
    单题单选没有 t=mq 控件（走 t=a 选项按钮），收到即视为卡片过期/伪造，明确纠正。
    校验一律读 `interaction_of_sid` 的**当前**服务端值（防过期卡片/旧 qid 重放），
    选项序号按当前白名单换 option id 的动作在 `_multi_answers` 里完成。"""
    import board
    st = board.interaction_of_sid(c["session_id"] or "")
    if not st or not st.get("pending"):
        return (f"卡片 #{c['id']} 当前没有等待中的提问", _toast("error", "提问已结束"))
    if st.get("kind") != "question":
        return (f"卡片 #{c['id']} 当前等待的不是提问，"
                f"请回复「同意 {c['id']}」或「拒绝 {c['id']}」",
                _toast("error", "该等待是审批"))
    if not st.get("answerable"):
        return ("该等待不支持远程作答，请到站点会话窗口处理",
                _toast("error", "不支持远程作答"))
    qs = [q for q in (st.get("questions") or []) if q]
    n = len(qs)
    if n < 1:
        return (f"卡片 #{c['id']} 当前没有等待中的提问", _toast("error", "提问已结束"))
    if n == 1 and not (qs[0] or {}).get("multi_select"):
        return (f"该提问是单选题，请用卡片上的选项按钮，或回复"
                f"「作答 {c['id']} <选项序号>」",
                _toast("error", "单题单选请用按钮"))
    try:
        no = int(value.get("n"))
    except (TypeError, ValueError):
        no = 0
    if no < 1 or no > n:
        return ("题号无效（卡片可能已过期），请重新作答",
                _toast("error", "题号无效"))
    q = qs[no - 1] or {}
    opts = q.get("options") or []
    if not opts:
        return (f"第 {no} 题没有选项，请回复「作答 {c['id']} {no}:<文字>」",
                _toast("error", "该题请写文字"))
    idxs = _multi_click_index(action, bool(q.get("multi_select")),
                              f"mq{c['id']}_{no}")
    if idxs is None:
        return (f"没收到你选的选项，请改用「作答 {c['id']} {no}:<选项序号>」",
                _toast("error", "未收到选项，请看单聊"))
    if any(i < 1 or i > len(opts) for i in idxs):
        return (f"第 {no} 题选项序号无效（共 {len(opts)} 个选项）",
                _toast("error", "选项无效"))
    if len(idxs) > 1 and not q.get("multi_select"):
        return (f"第 {no} 题为单选，请只选一项", _toast("error", "单选只能选一项"))
    val = ",".join(str(i) for i in sorted(set(idxs)))   # 与文本指令同一形态
    done, total, ready = _mq_put(c["id"], st.get("qid"), n, no, val)
    if not ready:
        return ("", _toast("success", f"已记下第 {no} 题（{done}/{total}）"))
    parts = _mq_take(c["id"], st.get("qid"), n)
    if len(parts) < n:
        # 极端竞态（取走前被 TTL 清掉/并发取走）：不提交半份，让用户重选
        return ("作答未提交（暂存已过期），请重新逐题选择",
                _toast("error", "暂存过期，请重选"))
    answers, err = _multi_answers(qs, parts)
    if err:
        return (f"作答未提交：{err}", _toast("error", "作答未提交"))
    err = board.answer_interaction(p, c, st.get("qid"), answers)
    if err:
        return (f"作答失败：{err}", _toast("error", "作答失败"))
    return (f"已收下：卡片 #{c['id']} {len(answers)} 道作答，排队送达中",
            _toast("success", f"{len(answers)} 题已答完，已送达"))


def _multi_answer_parts(token):
    """多题作答 token → `[(题号, 题值)]`；非多题形态返回 None。

    语法（2026-10-06 第二档：多子题在飞书作答）：`1:2 2:1 3:3`（题号:选项序号），
    题值内多选写逗号（`1:2,3`）、自定义文字直接写（`2:保留旧名`）。题值里可含
    空格——**不以 `<数字>:` 开头的 token 续接到上一题**，故 `2:用 sqlite 就行 3:保持`
    解析为两题。题号即卡片上 `1/N … N/N` 的序号、也是 interaction.questions 的下标
    （1 起），与「作答」指令一次给全的整批语义对齐（缺题不提交，见 `_multi_answers`）。"""
    if not re.match(r"\s*\d+\s*:", token or ""):
        return None
    parts, cur = [], None
    for tok in str(token).split():
        m = re.fullmatch(r"(\d+)\s*:\s*(.*)", tok)
        if m is not None:
            cur = [int(m.group(1)), m.group(2)]
            parts.append(cur)
        elif cur is not None:
            cur[1] = f"{cur[1]} {tok}".strip()      # 续接自由文本（含空格）
        else:
            return None
    return [(no, val) for no, val in parts] if parts else None


def _multi_answer_help(cid, qs):
    """多子题作答语法回执（缺题/格式不符时给用户看）。
    两条路都可：卡片上逐题点选（点满自动送达），或一条指令按题号一次给全；
    两者**可混用**——已点选的题不必在指令里重复给（见 `_answer_by_token`）。"""
    return (f"该提问含 {len(qs)} 道子题：可在卡片上逐题点选（点满自动送达），"
            f"或回复「作答 {cid} "
            + " ".join(f"{i}:<选项序号>" for i in range(1, len(qs) + 1))
            + "」一次答全；多选写「1:2,3」，自定义写「1:文字」")


def _multi_answers(qs, parts):
    """多题逐题值 → board.answer_interaction 的 answers 载荷。

    返回 `(answers, err)`：err 非空即 answers=None（**不提交**）。kind 规则对齐
    站点会话窗（SessionView.answerOf）：单选=single、多选=multi、自定义=other；
    序号按**当前**服务端白名单换回 option id，防过期卡片/提问已变。缺题直接回执
    所缺题号，不落地半份答案。文本指令与卡片点选暂存两路的题值都走这里。"""
    n = len(qs)
    seen = {}
    for no, val in parts:
        if no < 1 or no > n:
            return None, f"题号 {no} 无效（本提问共 {n} 题）"
        if no in seen:
            return None, f"第 {no} 题重复作答"
        seen[no] = str(val or "").strip()
    missing = [i for i in range(1, n + 1) if i not in seen]
    if missing:
        heads = "、".join(
            f"第 {i} 题（{(qs[i - 1] or {}).get('header') or '未命名'}）"
            for i in missing)
        return None, f"还差 {heads} 未作答，请一次答全 {n} 题"
    out = []
    for i, q in enumerate(qs, 1):
        q = q or {}
        val = seen[i]
        wire = str(q.get("id") or f"q_{i - 1}")
        opts = q.get("options") or []
        multi = bool(q.get("multi_select"))
        if re.fullmatch(r"\d+(?:\s*,\s*\d+)*", val):    # 序号形态（单个/逗号多选）
            if not opts:
                return None, f"第 {i} 题没有选项，请直接写回答文字"
            idxs = [int(x) for x in re.split(r"\s*,\s*", val)]
            if any(x < 1 or x > len(opts) for x in idxs):
                return None, (f"第 {i} 题选项序号无效（共 {len(opts)} 个选项）"
                              if len(opts) > 1 else f"第 {i} 题只有一个选项，序号填 1")
            if len(idxs) > 1 and not multi:
                return None, f"第 {i} 题为单选，请只给一个序号"
            ids = [str((opts[x - 1] or {}).get("id") or "") for x in idxs]
            if len(ids) > 1:
                out.append({"wire": wire, "kind": "multi", "option_ids": ids})
            else:
                out.append({"wire": wire, "kind": "single", "option_id": ids[0]})
            continue
        if not val:
            return None, f"第 {i} 题未作答"
        if len(val) > 2000:
            return None, f"第 {i} 题自定义输入过长（限 2000 字）"
        if not q.get("allow_other", True):
            return None, f"第 {i} 题不支持自定义输入，请给选项序号"
        out.append({"wire": wire, "kind": "other", "text": val})
    return out, ""


def _answer_by_token(p, c, token):
    """作答单题提问（文本指令「作答 卡号 …」与 DM 卡片选项按钮共用）：
    token = 选项序号 / 逗号分隔多序号（multi 形态）/ 自由文本（other 形态）。
    校验一律对 interaction_of_sid 缓存里的服务端值取白名单；返回回执文案。"""
    import board
    st = board.interaction_of_sid(c["session_id"] or "")
    if not st or not st.get("pending"):
        return f"卡片 #{c['id']} 当前没有等待中的提问"
    if st.get("kind") == "approval":
        # 审批等待收到「作答」：引导用同意/拒绝指令（answer_interaction 只收提问）
        return f"该等待是工具审批，请回复「同意 {c['id']}」或「拒绝 {c['id']}」"
    if not st.get("answerable"):
        return "该等待不支持远程作答，请到站点会话窗口处理"
    # 作答须一次给全全部子题（answers 逐题 record，漏项即未答）：多子题走
    # 「题号:值」逐题形态（2026-10-06 第二档），并与卡片点选暂存**合并**
    # （2026-10-07 第三档）——文本只需给没点过的题，缺题仍不提交
    qs = st.get("questions") or []
    if len(qs) > 1:
        parts = _multi_answer_parts(token)
        staged = _mq_peek(c["id"], st.get("qid"))
        if parts is None:
            if not staged:
                return _multi_answer_help(c["id"], qs)
            parts = sorted(staged.items())
        else:
            nos = [no for no, _ in parts]
            dup = next((x for x in nos if nos.count(x) > 1), None)
            if dup is not None:
                return f"第 {dup} 题重复作答"
            merged = dict(staged)
            merged.update({no: val for no, val in parts})
            parts = sorted(merged.items())
        answers, err = _multi_answers(qs, parts)
        if err:
            return err
        err = board.answer_interaction(p, c, st.get("qid"), answers)
        _mq_drop(c["id"], st.get("qid"))     # 提交后被消费（成功与否都清，防陈旧）
        if err:
            return f"作答失败：{err}"
        return f"已收下：卡片 #{c['id']} {len(answers)} 道作答，排队送达中"
    if _multi_answer_parts(token) is not None:
        # 单题提问收到「1:2」这类逐题语法：明确纠正，别把它当自由文本提交
        return (f"该提问只有一道题，请回复「作答 {c['id']} <选项序号>」"
                f"或「作答 {c['id']} <文字>」")
    q0 = qs[0] if qs else {}
    opts = q0.get("options") or st.get("options") or []
    wire = q0.get("id") or "q_0"
    opt_list = " / ".join(f"{i + 1}){(o or {}).get('label', '')}"
                          for i, o in enumerate(opts))
    if re.fullmatch(r"\d+(?:\s*,\s*\d+)*", token):
        # 序号形态：单序号→single（选项按 1 起序）；逗号多序号→multi（须允许多选）
        idxs = [int(x) for x in re.split(r"\s*,\s*", token)]
        if any(i < 1 or i > len(opts) for i in idxs):
            return f"选项序号无效，可回复：{opt_list}" if opts else "该提问没有可选选项"
        if len(idxs) == 1:
            opt = opts[idxs[0] - 1]
            err = board.answer_interaction(p, c, st.get("qid"),
                                           [{"wire": wire, "kind": "single",
                                             "option_id": (opt or {}).get("id")}])
            if err:
                return f"作答失败：{err}"
            return (f"已收下：卡片 #{c['id']} 选择「{(opt or {}).get('label', '')}」，"
                    "排队送达中")
        if not q0.get("multi_select"):
            return "该问题不支持多选，请回复单个选项序号"
        chosen = [opts[i - 1] for i in idxs]
        err = board.answer_interaction(p, c, st.get("qid"),
                                       [{"wire": wire, "kind": "multi",
                                         "option_ids": [(o or {}).get("id")
                                                        for o in chosen]}])
        if err:
            return f"作答失败：{err}"
        labels = "、".join((o or {}).get("label", "") for o in chosen)
        return f"已收下：卡片 #{c['id']} 多选「{labels}」，排队送达中"
    # 文本形态：自定义输入（须题目 allow_other；无选项提问同样按文本处理）
    if not q0.get("allow_other"):
        if opts:
            return f"该问题不支持自定义输入，可回复选项序号：{opt_list}"
        return "该提问无选项且不支持自定义输入，请到站点会话窗口处理"
    if len(token) > 2000:
        return "输入内容过长（限 2000 字）"
    err = board.answer_interaction(p, c, st.get("qid"),
                                   [{"wire": wire, "kind": "other",
                                     "text": token}])
    if err:
        return f"作答失败：{err}"
    return f"已收下：卡片 #{c['id']} 自定义回答，排队送达中"


def _decide_approval(p, c, decision, scope):
    """审批决定（文本指令「同意/拒绝 卡片」与 DM 卡片按钮共用）：decision ∈
    approved/rejected，scope="session" 本会话内自动放行；经 board.answer_approval
    入统一队列、补位启动时送达（其余校验由 board 白名单把关）。返回回执文案。"""
    import board
    st = board.interaction_of_sid(c["session_id"] or "")
    if not st or not st.get("pending") or st.get("kind") != "approval":
        return (f"卡片 #{c['id']} 当前没有等待中的审批"
                f"（提问类请回复「作答 {c['id']} <选项序号|文字>」）")
    aid = str(st.get("approval_id") or "")
    if not aid:
        return "审批不存在或已过期，请到站点会话窗口处理"
    err = board.answer_approval(p, c, aid, decision, scope)
    if err:
        return f"审批失败：{err}"
    verb = "已批准" if decision == "approved" else "已拒绝"
    tail = "（本会话内同类调用自动放行）" if scope == "session" else ""
    return f"✅ 卡片 #{c['id']} 审批{verb}{tail}，排队送达中"


def _execute_board_action(binding, intent, sender_open_id):
    """看板/任务类动作：状态/找卡/通过/驳回/作答/同意/拒绝。
    函数级 import board（board 模块级 import feishu，防循环；runner._process_card
    同款处理）。所有动作限定在绑定用户自己的项目内；作答/审批核心在
    _answer_by_token / _decide_approval（与卡片回调共用，防两路逻辑漂移）。"""
    import board
    action, g = intent["action"], intent["groups"]
    user_id = binding["user_id"]
    if action == "status":
        p, err = _resolve_project(binding, g[0])
        if p is None:
            return err
        return _board_summary(p)
    key = (g[0] if g else "").strip()
    found, err = _find_user_card(user_id, key)
    if found is None:
        return err
    p, c = found
    if action == "card":
        return _card_detail(p, c)
    if action == "approve":
        if c["column_key"] != "review":
            return f"卡片 #{c['id']} 不在「待审核」列（当前 {c['column_key']}），无法通过"
        _, err = board.move_card(p, c["id"], "done")
        if err:
            return "审核失败：" + str(err.get("error") or err.get("blocked") or "门禁拦截")
        return f"✅ 卡片 #{c['id']} {(c['title'] or '')[:30]} 已审核通过"
    if action == "reject":
        if c["column_key"] != "review":
            return f"卡片 #{c['id']} 不在「待审核」列（当前 {c['column_key']}），无法驳回"
        try:
            board.start_card(p, c, extra=g[1] or "")
        except RuntimeError as e:
            return f"打回失败：{e}"
        return f"↩️ 卡片 #{c['id']} 已打回继续开发，打回意见将注入 agent"
    if action == "answer":
        return _answer_by_token(p, c, (g[1] or "").strip())
    if action in ("agree", "deny"):
        decision = "approved" if action == "agree" else "rejected"
        scope = ("session" if (action == "agree"
                               and (g[1] if len(g) > 1 else "") == "会话") else "")
        return _decide_approval(p, c, decision, scope)
    return HELP_TEXT


def _resolve_project(binding, name):
    """项目定位（歧义消解）：显式项目名（精确→唯一包含）→ 单聊默认项目 →
    用户唯一项目 → 报错列出可选。返回 (project, "") 或 (None, 错误文案)。"""
    user_id = binding["user_id"]
    projects = db.list_projects(user_id)
    if name:
        for p in projects:
            if p["name"] == name:
                return p, ""
        hits = [p for p in projects if name in p["name"]]
        if len(hits) == 1:
            return hits[0], ""
        return None, f"项目「{name}」不在你的项目列表"
    if binding["default_project_id"]:
        for p in projects:
            if p["id"] == binding["default_project_id"]:
                return p, ""
    if len(projects) == 1:
        return projects[0], ""
    if not projects:
        return None, "你还没有项目，请先到站点创建"
    return None, ("请指明项目（回复「状态 项目名」），可选：" +
                  "、".join(p["name"] for p in projects[:8]))


def _find_cards(user_id, key):
    """跨用户项目找卡：纯数字按 id 前缀，否则标题包含；返回 [(project, card_dict)]
    （行转 dict 便于 .get 取值；仅搜用户自己的项目——多用户隔离）。"""
    hits = []
    for p in db.list_projects(user_id):
        for c in db.list_board_cards(p["id"]):
            row = dict(c)
            if key.isdigit():
                if str(row["id"]).startswith(key):
                    hits.append((p, row))
            elif key in (row["title"] or ""):
                hits.append((p, row))
    return hits


def _card_detail(p, c):
    """卡片详情文案：列位/阻塞原因/最近错误/会话。"""
    lines = [f"卡片 #{c['id']} [{p['name']}] {(c['title'] or '')[:40]}",
             f"状态：{_COL_LABELS.get(c['column_key'], c['column_key'])}"]
    if c["column_key"] == "blocked":
        lines.append(f"阻塞原因：{c.get('block_text') or c.get('block_kind') or '未知'}")
    if c.get("last_error"):
        lines.append(f"最近错误：{c['last_error'][:120]}")
    lines.append("回复「作答 %s <选项序号|文字>」回复提问；「同意 %s」/「拒绝 %s」"
                 "处理审批；「通过 %s」完成审核；「驳回 %s 意见」打回"
                 % (c["id"], c["id"], c["id"], c["id"], c["id"]))
    return "\n".join(lines)


def _board_summary(p):
    """项目摘要：任务队列计数与最近任务 + 看板五列计数 + 阻塞卡列表。"""
    tasks = db.list_tasks(p["id"]) or []
    n_run = sum(1 for t in tasks if t["status"] == "running")
    n_que = sum(1 for t in tasks if t["status"] == "queued")
    lines = [f"[{p['name']}] 任务：运行中 {n_run} / 排队 {n_que}（共 {len(tasks)}）"]
    for t in tasks:
        if t["status"] in ("running", "queued"):
            lines.append(f"· #{t['id']} {t['name'][:30]}（{_TASK_STATUS.get(t['status'], t['status'])}）")
    cards = [dict(c) for c in db.list_board_cards(p["id"])]
    by_col = {}
    for c in cards:
        by_col[c["column_key"]] = by_col.get(c["column_key"], 0) + 1
    lines.append("看板：" + " ".join(
        f"{_COL_LABELS.get(k, k)}{by_col.get(k, 0)}" for k in _COL_ORDER))
    blocked = [c for c in cards if c["column_key"] == "blocked"]
    for c in blocked[:5]:
        lines.append(f"⛔ #{c['id']} {(c['title'] or '')[:30]}"
                     f"（{c.get('block_text') or c.get('block_kind') or ''}）")
    return "\n".join(lines)


_COL_ORDER = ("todo", "doing", "blocked", "review", "done")
_COL_LABELS = {"todo": "待开发", "doing": "正在开发", "blocked": "阻塞",
               "review": "待审核", "done": "已完成"}
_TASK_STATUS = {"queued": "排队", "running": "运行中", "done": "已完成",
                "failed": "失败", "stopped": "已停止", "interrupted": "中断"}

# ---------- 投递线程（outbox → 飞书） ----------

def _send_one(row):
    """同步发送一条 outbox 行：发送时刻补 timestamp/sign（secret 不落日志，
    错误摘要只含飞书返回 code/msg）。返回 (ok, err)——任何失败（含坏 URL 等
    构造期错误）都转错误串，不外抛（外抛会让 daemon 该行永不标记、每秒空转重试）。"""
    ts = str(int(time.time()))
    try:
        body = json.loads(row["payload"])
    except ValueError as e:
        return False, str(e)[:200]
    if row["secret"]:
        body["timestamp"] = ts
        body["sign"] = sign(row["secret"], ts)
    try:
        req = urllib.request.Request(
            row["target"],
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=SEND_TIMEOUT) as resp:
            out = json.loads(resp.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, OSError, ValueError) as e:
        return False, str(e)[:200]
    if isinstance(out, dict) and out.get("code") == 0:
        return True, ""
    if isinstance(out, dict):
        return False, f"code={out.get('code')} {out.get('msg', '')}"[:200]
    return False, str(out)[:200]


def _send_one_and_mark(row):
    """发送 + 落账：成功标 sent；失败 retries+1 按 RETRY_DELAYS 退避续期 pending，
    超过 3 次标 failed 留痕（管理端可见，不再重试）。"""
    ok, err = _send_one(row)
    if ok:
        db.feishu_outbox_mark(row["id"], "sent", row["retries"], 0, "")
        return True
    n = row["retries"] + 1
    if n > len(RETRY_DELAYS):
        db.feishu_outbox_mark(row["id"], "failed", n, 0, err)
    else:
        db.feishu_outbox_mark(row["id"], "pending", n,
                              time.time() + RETRY_DELAYS[n - 1], err)
    return False


def _send_loop():
    """投递线程循环（daemon，1s tick）：每轮取到期 pending 行逐条发送。"""
    while True:
        try:
            for row in db.feishu_outbox_due(time.time()):
                try:
                    _send_one_and_mark(row)
                except Exception:
                    pass
        except Exception:
            pass
        time.sleep(_TICK)


def start_notifier():
    """幂等启动投递线程（server main 启动时调用一次；未配置时空转无害）。"""
    global _SENDER_STARTED
    if _SENDER_STARTED:
        return
    _SENDER_STARTED = True
    threading.Thread(target=_send_loop, daemon=True,
                     name="feishu-notifier").start()


# ---------- CLI（自测通道） ----------

def _cli():
    """python3 feishu.py selftest <pid> / send --url U --text T / outbox"""
    ap = argparse.ArgumentParser(description="Touchstone 飞书出站推送（M1）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_st = sub.add_parser("selftest", help="向项目绑定 webhook 同步发一条测试消息")
    p_st.add_argument("project_id", type=int)
    p_send = sub.add_parser("send", help="直接向指定 webhook 发文本（不经 outbox）")
    p_send.add_argument("--url", required=True)
    p_send.add_argument("--secret", default="")
    p_send.add_argument("--text", required=True)
    sub.add_parser("outbox", help="查看最近投递记录")
    a = ap.parse_args()
    db.init_db()
    if a.cmd == "selftest":
        h = hook_of(a.project_id)
        if h is None:
            print("该项目未绑定 webhook（项目所有者也未配置用户级默认），先到站点设置", file=sys.stderr)
            return 1
        proj = db.get_project(a.project_id)
        name = proj["name"] if proj else f"#{a.project_id}"
        ok, err = _send_one({"target": h["target"], "secret": h["secret"],
                             "payload": _payload(f"✅ Touchstone 飞书推送自测 [{name}]"),
                             "id": 0, "retries": 0})
        print("OK" if ok else f"FAIL {err}")
        return 0 if ok else 1
    if a.cmd == "send":
        ok, err = _send_one({"target": a.url, "secret": a.secret,
                             "payload": _payload(a.text), "id": 0, "retries": 0})
        print("OK" if ok else f"FAIL {err}")
        return 0 if ok else 1
    for r in db.feishu_outbox_recent(30):
        print(r["id"], r["status"], r["retries"],
              (r["last_error"][:60] or "-"), r["created_at"])
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
