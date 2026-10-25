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
import asyncio
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
import urllib.parse
import urllib.request

import db
import feishu_conv
import i18n
import requests

FEISHU_EVENTS = ("blocked_interaction", "task_failed", "card_review")
# 未单独绑定项目时的默认事件集（与设置页 `GET /api/projects/<pid>/feishu-hook` 的
# 默认回显一致：交互等待/任务失败开、卡片待审核默认关）。2026-10-10 之前回落分支
# 写死全事件 ⇒ 界面显示「未勾选」而实际会推，是与设置页不一致的实障来源。
FEISHU_DEFAULT_EVENTS = ("blocked_interaction", "task_failed")
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

# 不可远程作答（board._iw_interaction 的 `answerable=false`）时的**统一引导文案**
# （2026-10-07 纠偏）。这类等待的提问由**非平台自持会话**发起——用户在 dsh GUI 里
# 直跑的会话，以及宿主重启丢掉会话池身份后由 GUI 续跑的会话；此时插件只旁听、
# 挂起标记的 call_id 为空 ⇒ 站点会话窗（webui SessionView 按 answerable 门控选项
# 与「提交」）与飞书卡片都只展示、不出作答控件，**唯一能作答的地方是 dsh 宿主的
# 会话窗口**。旧文案「请到站点会话窗口处理」把用户引到同样答不了的地方，故统一
# 换成这段（旧文案出现的其余几处属于「可作答但飞书无处可点」的场合，站点会话窗
# 确实可答，保持原样不动）。
_NO_REMOTE_ANSWER_HINT = ("该等待不支持远程作答（提问由 dsh 直跑会话发起），"
                          "请在 dsh 会话窗口作答")


def user_config(user_id):
    """用户飞书配置（feishu_user_cfgs 表；enabled/base_url/默认 webhook/应用凭据）。
    2026-09-09 起飞书设置为用户级：每个用户配置自己的机器人，无全局配置。"""
    return db.get_feishu_user_cfg(user_id)


def notify_events(project_id):
    """项目级推送事件闸门（**全通道共用**，2026-10-10 修「设置不生效」实障）。

    群 webhook 文本推送（`push_event`）与飞书单聊交互卡片（`_dm_interaction_card`）
    都只按本函数放行——此前单聊卡片是旁路发送、不受任何项目开关约束，用户把
    「启用推送」与全部事件取消勾选后仍持续收到推送。

    口径（先到先算）：
    - **用户级总控 `push_enabled`**（设置页「飞书推送总控」，2026-10-10 新增）：
      关 ⇒ 返回空集，**一票否决**——项目行开着也照样全通道静默。它必须先算：
      旧用户级 `enabled` 只在下面的「无绑定行回落」分支参与判定，项目有绑定行时
      完全不看它，故用户关掉旧开关仍会收到作答卡（实障观感「设置了不生效」）。
      缺键按开处理（`.get(..., True)`）⇒ 存量配置升级后行为不变，零迁移。
    - 有绑定行：`enabled=0` ⇒ **该项目全通道静默**（显式关闭，不回落用户配置）；
      `enabled=1` ⇒ 取行内勾选的事件（可为空集＝都不推）。
    - 无绑定行：回落项目所有者的默认集 `FEISHU_DEFAULT_EVENTS`，并受其用户级
      旧开关 `enabled` 约束（关 ⇒ 空集）。项目被删（取不到 owner）时按 user_id=0
      的配置判定，与 `hook_of` 同口径。

    「按类别」开关不在本函数里另开用户级字段：项目行的 `events` 勾选即可分类
    （作答卡片=`blocked_interaction`），且群与单聊卡片共用同一份。

    返回 set[str]；空集 = 该项目不推任何事件。
    """
    row = db.get_feishu_hook(project_id)
    proj = db.get_project(project_id)
    owner_id = proj["user_id"] if proj else 0
    cfg = user_config(owner_id)
    if not cfg.get("push_enabled", True):   # 用户级总控：一票否决（先于项目行判定）
        return set()
    if row is not None:
        if not row["enabled"]:
            return set()
        return {e for e in FEISHU_EVENTS if e in (row["events"] or "")}
    if not cfg.get("enabled", True):
        return set()
    return set(FEISHU_DEFAULT_EVENTS)


def hook_of(project_id):
    """项目推送**群 webhook 目的地**：绑定行 URL 优先；行内无 url（或无绑定行）时
    回落**项目所有者**的用户级默认 webhook（回落要求其总开关 enabled 开着且配了
    `default_webhook`）。附 base_url（通知「详情」链接）与 user_id（投递记录归属）。

    事件过滤不在这里判断——一律取 `notify_events`（群与单聊卡片同一闸门），
    事件集为空即视为不推；这样「回落默认 webhook」时也尊重项目的事件勾选
    （2026-10-10 前回落分支写死全事件）。
    返回 {"target","secret","events","base_url","user_id"} 或 None（不推）。"""
    events = notify_events(project_id)
    if not events:
        return None
    row = db.get_feishu_hook(project_id)
    proj = db.get_project(project_id)  # 所有者为 0 时（项目被删）回落 user_config(0)={}
    owner_id = proj["user_id"] if proj else 0
    base_url = (user_config(owner_id).get("base_url") or "").rstrip("/") if proj else ""
    if row is not None and row["webhook_url"]:
        return {"target": row["webhook_url"], "secret": row["webhook_secret"] or "",
                "events": events, "base_url": base_url, "user_id": owner_id}
    cfg = user_config(owner_id)
    if not cfg.get("enabled", True):
        return None
    if not cfg.get("default_webhook"):
        return None
    return {"target": cfg["default_webhook"], "secret": cfg.get("default_secret", ""),
            "events": events, "base_url": base_url,
            "user_id": owner_id}


def user_lang(user_id):
    """飞书出站文案的**用户语言**（R22：绑定用户的 `user_prefs(user_id, 0)["lang"]`）。

    口径（双端逐字对应 Node `feishu_cfg.userLang`）：
    - `TS_I18N=0`（回滚开关）⇒ 恒 `zh`，且**连偏好都不读**（镜像 `i18n.is_i18n_disabled`）；
    - 无偏好行 / 偏好里没有 `lang` / 坏值（非 `{"v":"zh"|"en"}`）/ 读库异常 ⇒ `zh`；
    - 合法偏好经 `i18n.resolve_lang(user_pref=...)` 归一（认 `{"v":"en"}` 包装）。

    本函数**绝不抛错**：出站文案是旁路能力，不能因读偏好失败影响主流程。
    """
    if i18n.is_i18n_disabled():
        return "zh"
    try:
        pref = (db.get_user_prefs(int(user_id or 0), 0) or {}).get("lang")
    except Exception:  # noqa: BLE001 —— 任何读库/类型异常都回落中文
        pref = None
    # 只认站点的持久化形状 `{"v": "zh"|"en"}`：裸字符串/数组/其他对象一律按坏值
    # 回落中文（R22；`resolve_lang` 本身对裸字符串是宽松的，此处不放宽）。
    raw = pref.get("v") if isinstance(pref, dict) else None
    if not isinstance(raw, str):
        raw = None
    return i18n.resolve_lang(user_pref=raw)


def project_lang(project_id):
    """**项目级**出站文案语言（群推送 / 项目卡）：取项目所有者（与 `hook_of` 同一身份）。

    与 `user_lang` 拆开是为了调用点可读：DM/回执用 `user_lang(binding["user_id"])`，
    群/项目推送用 `project_lang(project_id)`（所有者 = 项目 `user_id`；项目被删 ⇒ 0）。
    项目不存在 / 读库异常 ⇒ `zh`；`TS_I18N=0` 时**连项目行都不读**（R22：先判开关，
    再决定是否读库；镜像 Node `feishu_cfg.projectLang`）。
    """
    if i18n.is_i18n_disabled():
        return "zh"
    try:
        proj = db.get_project(project_id)
        return user_lang(proj["user_id"] if proj else 0)
    except Exception:  # noqa: BLE001 —— 与 user_lang 同一条「绝不抛错」约定
        return "zh"


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


def _render(kind, ctx, project_id, base_url="", lang="zh"):
    """事件 → 通知文案：首行标题 [项目名]，按 kind 拼 卡片/任务/提问/选项/
    错误/pipeline 跳过 行，末行可选站点链接（项目所有者的用户配置 base_url）；
    凭据永不入文案。blocked_interaction 按 ctx.kind 分形态给「可直接回复」的
    作答指引（提问=作答指令；审批=同意/拒绝指令；不可远程作答的等待仍
    引导站点）。

    语言（T12b）：`lang` 由 `push_event` 按 `project_lang(project_id)` 解析一次
    （R22：项目所有者；缺偏好/异常 ⇒ zh；`TS_I18N=0` ⇒ zh 且不读偏好）。默认
    `"zh"` 是兼容线——现有调用与对拍用例一行不改也逐字节不变。"""
    head, with_link = _EVENT_META[kind]
    proj = db.get_project(project_id)
    title = i18n.t("api", head, lang)
    lines = [f"{title} [{proj['name'] if proj else f'#{project_id}'}]"]
    if "card_id" in ctx:
        lines.append(i18n.t("api", "卡片 #{cid} {title}", lang,
                            cid=str(ctx["card_id"]),
                            title=(ctx.get("title") or "")[:60]))
    if "task_id" in ctx:
        lines.append(i18n.t("api", "任务 #{tid} {name}（{type}）", lang,
                            tid=str(ctx["task_id"]),
                            name=(ctx.get("name") or "")[:50],
                            type=ctx.get("type") or ""))
    cid = ctx.get("card_id")
    if ctx.get("kind") == "approval":
        # 审批等待：动作/工具/内容摘要 + 同意/拒绝指令（比通用「agent 提问」行更准确）
        lines.append(i18n.t(
            "api", "审批请求：{action}", lang,
            action=ctx.get("action") or ctx.get("tool")
            or i18n.t("api", "工具调用", lang)))
        if ctx.get("tool"):
            lines.append(i18n.t("api", "工具：{tool}", lang, tool=ctx["tool"]))
        if ctx.get("input"):
            lines.append(i18n.t("api", "内容：{input}", lang,
                                input=str(ctx["input"])[:200]))
        lines.append(i18n.t(
            "api", "飞书回复「同意 {cid}」批准，「拒绝 {cid}」拒绝；"
                   "「同意 {cid} 会话」本会话内同类调用自动放行", lang, cid=cid))
    else:
        qs = [q for q in (ctx.get("questions") or []) if q]
        if len(qs) > 1:
            # 多子题：逐题完整展示（旧实现只渲染首题 q0，其余子题在飞书上不可见）
            lines.append(i18n.t("api", "agent 提问（共 {n} 题）：", lang,
                                n=len(qs)))
            lines.extend(_question_text_lines(_question_views(qs, lang), lang))
        elif ctx.get("question"):
            lines.append(i18n.t("api", "agent 提问：{question}", lang,
                                question=ctx["question"]))
            for i, o in enumerate(ctx.get("options") or [], 1):
                lines.append(f"  {i}) {o}")
        if kind == "blocked_interaction":
            n_q = len(qs) or ctx.get("questions_count") or 0
            if not ctx.get("answerable"):
                # 不可远程作答的等待（answerable=false）：引导回 dsh 会话窗口——
                # 站点会话窗此时同样不出作答控件，旧文案「请到站点会话窗口处理」
                # 会把用户引到死胡同（见 _NO_REMOTE_ANSWER_HINT）
                lines.append(i18n.t("api", _NO_REMOTE_ANSWER_HINT, lang))
            elif n_q > 1:
                # 多子题：一条指令按题号逐题答全（表单卡超 form 体积硬限时同样走这条）
                lines.append(_multi_answer_help(cid, qs or [None] * int(n_q),
                                                lang))
            else:
                tips = [i18n.t("api", "飞书回复「作答 {cid} <选项序号>」按选项作答",
                               lang, cid=cid)]
                if ctx.get("multi_select"):
                    tips.append(i18n.t("api", "多选逗号分隔（作答 {cid} 1,3）",
                                       lang, cid=cid))
                if ctx.get("allow_other"):
                    tips.append(i18n.t("api", "「作答 {cid} <文字>」自定义回答",
                                       lang, cid=cid))
                lines.append(i18n.t("api", "；", lang).join(tips))
    if ctx.get("error"):
        lines.append(i18n.t("api", "错误：{error}", lang,
                            error=str(ctx["error"])[:200]))
    if ctx.get("skipped_n"):
        lines.append(i18n.t("api", "pipeline 后段 {n} 条已连带跳过", lang,
                            n=str(ctx["skipped_n"])))
    if with_link:
        base = (base_url or "").rstrip("/")
        if base:
            lines.append(i18n.t("api", "详情：{url}", lang, url=base))
    return "\n".join(lines)


def push_event(project_id, kind, ctx):
    """旁路事件入队（任何异常吞掉，绝不影响业务主流程）：
    hook 选择 → events 过滤 → 渲染 → 幂等入 outbox（记项目所有者 user_id）。

    文案语言按**项目所有者**解析一次（`project_lang`；R22）。`TS_I18N=0` 时
    `project_lang` 在读项目行/偏好之前短路为 zh，行为与旧版逐字节相同。"""
    try:
        h = hook_of(project_id)
        if h is None or kind not in h["events"]:
            return
        lang = project_lang(project_id)
        text = _render(kind, ctx, project_id, h.get("base_url") or "", lang)
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


def _question_views(qs, lang="zh"):
    """interaction.questions（1-4 题）→ 逐题渲染视图（飞书卡片与群文本共用）。

    多子题必须**逐题完整展示**：旧实现只渲染首题（q0），其余子题在飞书上完全
    不可见（2026-10-06 实障：agent 一次问 3 题，卡片上只见第 1 题）。视图：
      {no, header, question, body, options:[{no,label,description}],
       multi_select, allow_other, other_label}
    `lang` 只影响「其他」这个缺省自定义标签（数据不译）。"""
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
            "other_label": _clip_text(q.get("other_label") or i18n.t("api", "其他", lang), 40),
        })
    return views


def _single_question_view(ctx, lang="zh"):
    """单题提问 ctx → 单题视图（与 `_question_views` 同形态，供 mini 表单取选项）。

    `ctx["questions"]`（逐题全量视图，见 `card_blocked`）优先；旧调用面/测试替身
    只给平面字段（`question`/`options` 为 label 串、`multi_select`/`allow_other`）
    时按平面字段兜底，组不出视图不让卡片构建抛异常。"""
    qs = [q for q in (ctx.get("questions") or []) if q]
    if qs:
        return _question_views(qs, lang)[0]
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
            "other_label": _clip_text(ctx.get("other_label") or i18n.t("api", "其他", lang), 40)}



def _single_multi_select_pick(cid, ctx, lang="zh"):
    """单题**多选**且可远程作答 → `(mini 表单元素 or None, 指引文案)`。

    多选组件 `multi_select_static` 按飞书官方规定**只能内嵌表单容器**（`checker`
    只回 `checked` 布尔、表达不了「N 选 M」），故单题多选与多子题里的多选同款：
    卡片上给「单题 mini 表单 + 提交按钮」，回调 `t=mq/n=1` 走 `_answer_multi_click`
    （单题点满即整批送达，见 2026-10-07 第四档）。

    表单 JSON 超 `_MQ_FORM_MAX_BYTES`（飞书 form 元素 1000 字节硬限，超限必被
    `230099/11310` 拒收且整卡静默丢失）或该题没有选项时**不发控件**，只回文本
    作答指引——绝不发出必被拒的卡。"""
    q = _single_question_view(ctx, lang)
    tail = (i18n.t("api", "；自定义文字回复「作答 {cid} <文字>」", lang, cid=cid)
            if q["allow_other"] else "")
    if not q["options"]:
        return None, (i18n.t("api", "请回复「作答 {cid} <文字>」作答", lang, cid=cid)
                      if q["allow_other"]
                      else i18n.t("api", "该提问没有可选选项，请到站点会话窗口处理", lang))
    form = _multi_select_form(cid, q, i18n.t("api", "提交作答", lang), lang)
    if len(json.dumps(form, ensure_ascii=False)) > _MQ_FORM_MAX_BYTES:
        return None, i18n.t("api",
                            "多选题：请回复「作答 {cid} 1,3」（逗号分隔序号）{tail}",
                            lang, cid=str(cid), tail=tail)
    return form, i18n.t("api",
                        "多选题：勾选后点「提交作答」送达；"
                        "也可回复「作答 {cid} 1,3」（逗号分隔序号）{tail}",
                        lang, cid=str(cid), tail=tail)



def _caps_line(caps, lang="zh"):
    """能力标注（多选/可自定义）→ 一行文本；无标注返回空串。

    括号与分隔符也是文案的一部分（中文全角、英文半角），故一并走词典；
    空列表返回空串（调用方据此决定是否追加整行）。"""
    if not caps:
        return ""
    sep = i18n.t("api", "；", lang)
    return i18n.t("api", "（{caps}）", lang, caps=sep.join(caps))


def _question_card_blocks(views, lang="zh"):
    """多子题 → DM 卡片逐题 markdown 元素（**只读**展示；可点选时由
    `_multi_click_elements` 在同一份排版后追加下拉组件）。
    卡片无状态：不可远程作答时只展示题面，作答指引由调用方 hint 承担。"""
    return [_question_md_element(v, len(views), lang) for v in views]


def _question_text_lines(views, lang="zh"):
    """多子题 → 群 webhook 文本行（msg_type=text 不渲染 markdown，按纯文本排版）。

    `lang` 只影响排版用文案（题号/括号/能力标注）；题面与选项是数据，不译。"""
    lines = []
    for v in views:
        title = v["header"] or i18n.t("api", "第 {no} 题", lang, no=v["no"])
        head = i18n.t("api", "【{no}/{total} {title}】", lang,
                      no=v["no"], total=len(views), title=title)
        lines.append(f"{head}{v['question']}" if v["question"] else head)
        if v["body"]:
            lines.append(f"  {v['body']}")
        for o in v["options"]:
            lines.append(f"  {o['no']}) {o['label']}")
            if o["description"]:
                lines.append(f"     {o['description']}")
        caps = []
        if v["multi_select"]:
            caps.append(i18n.t("api", "多选", lang))
        if v["allow_other"]:
            caps.append(i18n.t("api", "可自定义：{label}", lang,
                               label=v["other_label"]))
        if caps:
            lines.append("  " + i18n.t("api", "（{caps}）", lang,
                                      caps=i18n.t("api", "；", lang).join(caps)))
    return lines


def _question_md_element(v, n, lang="zh"):
    """单题 → markdown 元素（题号/题头/题面/补充说明/选项与描述/能力标注）。
    「只读展示」与「逐题点选卡」共用同一份排版（2026-10-07 抽公共，避免两处漂移）。"""
    title = v["header"] or v["question"] or i18n.t("api", "第 {no} 题", lang,
                                                   no=v["no"])
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
        caps.append(i18n.t("api", "多选", lang))
    if v["allow_other"]:
        caps.append(i18n.t("api", "可自定义：{label}", lang,
                           label=v["other_label"]))
    line = _caps_line(caps, lang)
    if line:
        md.append(line)
    return {"tag": "markdown", "content": "\n".join(md)}


def _multi_click_elements(cid, views, lang="zh"):
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
        els.append(_question_md_element(v, n, lang))
        if not v["options"]:
            text_only.append(v["no"])
            continue
        if v["multi_select"]:
            form = _multi_select_form(cid, v, lang=lang)
            if len(json.dumps(form, ensure_ascii=False)) <= _MQ_FORM_MAX_BYTES:
                els.append(form)
            else:
                text_only.append(v["no"])   # 组件装不进 form 硬限：退回文本作答
            continue
        els.append({
            "tag": "select_static",
            "name": f"mq{cid}_{v['no']}",
            "placeholder": {"tag": "plain_text",
                            "content": i18n.t("api", "请选择", lang)},
            "options": [{"text": {"tag": "plain_text", "content": o["label"]},
                         "value": str(o["no"])} for o in v["options"]],
            "behaviors": [{"type": "callback",
                           "value": {"t": "mq", "c": cid, "n": v["no"]}}]})
    return els, text_only


def _multi_select_form(cid, v, btn_text="", lang="zh"):
    """多选题 → **单题 mini 表单**（飞书规定 `multi_select_static` 只能内嵌表单容器，
    见 `_multi_click_elements`）。提交按钮与组件同带 `t=mq/c/n`：飞书表单提交帧走
    **按钮**的 behaviors.value，组件值在 `action.form_value[<组件 name>]`（数组）。
    `btn_text` 空则用「提交第 N 题」（多子题卡带题号更好认；单题卡传「提交作答」）。"""
    return {
        "tag": "form", "name": f"mqf{cid}_{v['no']}",
        "elements": [
            {"tag": "multi_select_static", "name": f"mq{cid}_{v['no']}",
             "placeholder": {"tag": "plain_text",
                             "content": i18n.t("api", "请选择（可多选）", lang)},
             "options": [{"text": {"tag": "plain_text", "content": o["label"]},
                          "value": str(o["no"])} for o in v["options"]],
             "behaviors": [{"type": "callback",
                            "value": {"t": "mq", "c": cid, "n": v["no"]}}]},
            {"tag": "button", "name": f"mqs{cid}_{v['no']}",
             "form_action_type": "submit", "type": "primary",
             "text": {"tag": "plain_text",
                      "content": btn_text or i18n.t("api", "提交第 {no} 题", lang,
                                                    no=v["no"])},
             "behaviors": [{"type": "callback",
                            "value": {"t": "mq", "c": cid, "n": v["no"]}}]},
        ]}


def _multi_click_hint(cid, qs, text_only=(), multi_forms=(), lang="zh"):
    """逐题点选卡末行指引：点满自动整批送达；要写自定义文字（或控件放不下的题）
    给文本补答语法（文本指令与已点选的答案**可混用**——已点选的题不必重复给，
    见 `_answer_by_token`）。`text_only` = 卡片上没有可点控件的题号；
    `multi_forms` = 卡片上发了多选 mini 表单的题号（多选是「勾选 + 点提交」两步，
    不点名容易被当成勾上就算答了）。`lang` 只影响包装文案，题号/卡号是数据。"""
    extra = sorted(set(text_only)
                   | {i for i, q in enumerate(qs, 1) if (q or {}).get("allow_other")})
    lines = [i18n.t("api", "逐题选择即可，答满 {n} 题自动送达 agent。", lang,
                    n=len(qs))]
    forms = sorted(set(multi_forms))
    if forms:
        sep = i18n.t("api", "；", lang)
        lines.append(sep.join(
            i18n.t("api", "第 {i} 题是多选：勾选后点「提交第 {i} 题」", lang,
                   i=i) for i in forms))
    if extra:
        nos = i18n.t("api", "、", lang).join(str(i) for i in extra)
        values = " ".join(i18n.t("api", "{i}:<值>", lang, i=i) for i in extra)
        lines.append(
            i18n.t("api", "第 {nos} 题请回复「作答 {cid} {values}」作答", lang,
                   nos=nos, cid=str(cid), values=values)
            + i18n.t("api", "（自定义文字写 <文字>，可选项写序号，多选逗号分隔；"
                            "已点选的题不用重复给）", lang))
    return "\n".join(lines)


def _build_interaction_card(ctx, project_name, lang="zh"):
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
    选项白名单，天然防过期 qid 重放与伪造（board 侧还有整批白名单校验兜底）。
    `lang` 只影响包装文案；标题/题面/选项等数据原样插入（不翻译）。"""
    kind = ctx.get("kind")
    cid = ctx.get("card_id")
    elements = []
    # M6（2026-10-10）：方案先上——用户报障"仅凭选项无法决策"，故题面之前先给
    # 折叠面板（Card 2.0 `collapsible_panel`；内部只放 markdown，飞书规定不能放
    # form）+ 完整方案文档链接。两个字段都由 `_attach_plan` 挂在 ctx 上，
    # 取不到方案（无会话/读不到转录）时整块不出现，卡片形状与旧版一致。
    if ctx.get("plan_inline") and kind != "approval":
        elements.append({
            "tag": "collapsible_panel", "expanded": True,
            "header": {"title": {"tag": "plain_text",
                                 "content": i18n.t(
                                     "api", "📄 agent 的方案 / 回答（点标题可折叠）",
                                     lang)}},
            "elements": [{"tag": "markdown", "content": ctx["plan_inline"]}]})
    if ctx.get("plan_doc_url") and kind != "approval":
        elements.append({"tag": "markdown",
                         "content": i18n.t(
                             "api", "📄 [查看完整方案（飞书文档）]({url})", lang,
                             url=ctx["plan_doc_url"])})
    if kind == "approval":
        raw_action = ctx.get("action") or ctx.get("tool")
        action = (str(raw_action) if raw_action
                  else i18n.t("api", "工具调用", lang))
        lines = [i18n.t("api", "**审批请求**：{action}", lang, action=action)]
        if ctx.get("tool"):
            lines.append(i18n.t("api", "工具：{tool}", lang,
                                tool=str(ctx["tool"])))
        if ctx.get("input"):
            lines.append(i18n.t("api", "内容：{input}", lang,
                                input=str(ctx["input"])[:200]))
        elements.append({"tag": "markdown", "content": "\n".join(lines)})
        for label, act, style in (("✅ 批准", "p", "primary"),
                                  ("🔁 会话内批准", "s", "default"),
                                  ("⛔ 拒绝", "d", "danger")):
            elements.append({
                "tag": "button", "type": style,
                "text": {"tag": "plain_text",
                         "content": i18n.t("api", label, lang)},
                "behaviors": [{"type": "callback", "value": {"t": act, "c": cid}}]})
    else:
        qs = [q for q in (ctx.get("questions") or []) if q]
        if len(qs) > 1:
            views = _question_views(qs, lang)
            elements.append({"tag": "markdown", "content": "\n".join([
                i18n.t("api", "**agent 提问（共 {n} 题）**", lang, n=len(qs)),
                i18n.t("api", "卡片 #{cid} {title}", lang,
                       cid=str(cid),
                       title=(ctx.get("title") or "")[:60])])})
            if ctx.get("answerable"):
                # 可远程作答：逐题点选（单选=根级下拉；多选=单题 mini 表单），
                # 点满自动整批送达；放不下控件的题由指引点名走文本补答
                click_els, text_only = _multi_click_elements(cid, views, lang)
                elements.extend(click_els)
                forms = [v["no"] for v in views
                         if v["multi_select"] and v["no"] not in text_only]
                elements.append({"tag": "markdown",
                                 "content": _multi_click_hint(cid, qs, text_only,
                                                              forms, lang)})
            else:
                # 不可远程作答（会话非平台自持）：逐题只读展示 + dsh 会话窗口引导。
                # 2026-10-06 前的实现落到下面的单题分支，只渲染首题（q0），其余
                # 子题在飞书上完全不可见（用户实障：agent 一次问 3 题只见第 1 题）。
                elements.extend(_question_card_blocks(views, lang))
                elements.append({"tag": "markdown",
                                 "content": i18n.t("api", _NO_REMOTE_ANSWER_HINT,
                                                   lang)})
        else:
            question = (ctx.get("question")
                        or i18n.t("api", "agent 正在等待你的回答", lang))
            md = [i18n.t("api", "**agent 提问**：{question}", lang,
                         question=question),
                  i18n.t("api", "卡片 #{cid} {title}", lang,
                         cid=str(cid),
                         title=(ctx.get("title") or "")[:60])]
            for i, o in enumerate(ctx.get("options") or [], 1):
                md.append(f"{i}) {o}")
            elements.append({"tag": "markdown", "content": "\n".join(md)})
            hint = None
            if not ctx.get("answerable"):
                # 不可远程作答：站点会话窗也答不了（见 _NO_REMOTE_ANSWER_HINT）
                hint = i18n.t("api", _NO_REMOTE_ANSWER_HINT, lang)
            elif (ctx.get("questions_count") or len(qs) or 0) > 1:
                hint = i18n.t("api",
                              "该提问含 {n} 道子题，请到站点会话窗口逐题作答", lang,
                              n=ctx.get("questions_count") or len(qs))
            elif ctx.get("multi_select"):
                # 单题多选：卡片上给单题 mini 表单（多选组件只能内嵌表单容器）；
                # 装不下/无选项时只给文本指引（见 _single_multi_select_pick）
                form, hint = _single_multi_select_pick(cid, ctx, lang)
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
                    hint = i18n.t("api", "自定义回答请回复「作答 {cid} <文字>」",
                                  lang, cid=str(cid))
            if hint:
                elements.append({"tag": "markdown", "content": hint})
    return {"schema": "2.0",
            "header": {"title": {"tag": "plain_text",
                                 "content": i18n.t("api", "🤔 卡片等待回复 [{name}]",
                                                   lang,
                                                   name=project_name)},
                       "template": "orange"},
            "body": {"elements": elements}}


# ---------- M6 作答方案：卡内摘要 + 完整方案飞书云文档（2026-10-10） ----------
#
# 用户报障（2026-10-10）：飞书作答卡片上只有题面（question 被 `_Q_TEXT_MAX=500`
# 截断）与选项，agent 的方案/回答（末条 assistant 文本，实测 0–3217 字）与思考
# （think，实测 122–18965 字）**一个字都不发** ⇒ 用户"仅凭选项无法决策"。
# 本批把方案送进飞书，两条腿：
#   ① 卡内折叠面板（`collapsible_panel`，Card 2.0）给摘要——不用跳转就能决策；
#   ② 完整方案建飞书云文档（提问**全文** + 全部子题/选项/描述 + 回答），
#      链接放卡上——卡片放不下的部分在这里补全。
#
# 2026-10-18 用户裁定（缩小思考暴露面）：**「思考摘录」不再进入任何飞书产物**——
# 卡内摘要与方案文档都只带 assistant 回答（及提问全文），think 的内部推理一律不渲染。
# 取数层 `_plan_session_texts` 仍返回 assistant/think（转录读取契约不变、便于将来
# 其他通路复用），但两个渲染函数不再消费 think；原 `_PLAN_THINK_MIN/_MAX` 随之退场。
#
# 为什么不在文档里直接放选项让人点（2026-10-10 取证结论）：docx 块类型清单里没有
# 投票/单选交互块（`lark-oapi` 生成的 `Block` 模型 63 个块字段无 poll/vote）；
# 「文件编辑」事件 `P2DriveFileEditV1` 只带 file_token/操作者、**不含改了哪一块**；
# 唯一"文档内点选"路线是内嵌多维表格 + `drive.file.bitable_record_changed_v1`
# 事件（或文档评论事件），都要建表/授权/事件订阅 + 轮询，不适合"挂起等作答"的
# 实时链路。故选项留在卡片上，文档承载方案与选项说明（文档内给文本补答语法）。

PLAN_ENV = "TS_FEISHU_PLAN"        # =0 关闭本批全部新行为（回滚阀，回到只有题面+选项）
_PLAN_INLINE_MAX = 1500            # 卡内折叠摘要上限（字符）
_PLAN_DOC_MAX = 20000              # 文档正文上限（字符）
_PLAN_DOC_TTL = 1800               # 建文档去重记录存活（秒）
_PLAN_DOCS = {}                    # (card_id, qid) -> {"url": str, "at": float}
_MD_BLOCK_MAX = 1800               # 文档单块文本上限（字符，超长块会被接口拒收）
_ASK_TOOL = "ask_user_question"    # dsh 提问工具名（"提问前上下文"的切点）
_DOC_TIMEOUT = 8                   # 文档类调用逐次超时（秒）


def plan_enabled():
    """作答方案增强总闸：`TS_FEISHU_PLAN=0` 关闭（一行回到"只有题面+选项"的现状）。"""
    return (os.environ.get(PLAN_ENV) or "1") != "0"


def _beijing_now():
    """北京时间字符串：容器本地时区=UTC、用户/浏览器=Asia/Shanghai，给人看的文档
    一律按 UTC+8 落（否则 22:00 的提问会写成 14:00，读者会误判成"8 小时前"）。"""
    return time.strftime("%Y-%m-%d %H:%M", time.gmtime(time.time() + 8 * 3600))


def _plan_session_texts(sid):
    """会话转录 → 提问前的「方案/回答」文本 `{"assistant", "think"}`。

    取「最后一次 `ask_user_question` **之前**」的末条 assistant 与末条 think——
    多轮提问时只取当前这次提问的上下文（更早的回答不是本次的方案）。转录里还没有
    该 tool_call（落盘滞后 / 旧会话）时回落整段末尾，语义相同（末尾即提问前内容）。

    无 sid / 会话读不到 / 解析异常 ⇒ 两项皆空串：方案取数失败绝不影响卡片发送。
    """
    empty = {"assistant": "", "think": ""}
    sid = str(sid or "").strip()
    if not sid:
        return empty
    try:
        import sessparse                     # 函数内懒 import：避免模块级循环依赖
        res = sessparse.load("dsh", sid, "main") or {}
        entries = res.get("entries") or []
        if not res.get("found") or not entries:
            return empty
        cut = len(entries)
        for i in range(len(entries) - 1, -1, -1):
            e = entries[i] or {}
            if e.get("kind") == "tool_call" and e.get("name") == _ASK_TOOL:
                cut = i
                break
        assistant = think = ""
        for e in reversed(entries[:cut]):
            e = e or {}
            if e.get("kind") == "assistant" and not assistant:
                assistant = str(e.get("text") or "").strip()
            elif e.get("kind") == "think" and not think:
                think = str(e.get("text") or "").strip()
            if assistant and think:
                break
        return {"assistant": assistant, "think": think}
    except Exception:
        return empty


def _plan_inline_markdown(ctx, texts, lang="zh"):
    """卡内折叠摘要（上限 `_PLAN_INLINE_MAX`）：只取末条 assistant 回答。

    2026-10-18 用户裁定：卡上不要「思考摘录」——think 不进卡（此前 assistant
    短于 200 字时会补 think 摘录，该行为已退场）。assistant 为空 ⇒ 返回空串，
    调用方不挂面板（完整方案文档链接仍会发）。
    """
    a = str((texts or {}).get("assistant") or "").strip()
    if not a:
        return ""
    md = a
    if len(md) > _PLAN_INLINE_MAX:
        md = md[:_PLAN_INLINE_MAX].rstrip() + i18n.t(
            "api", "\n\n…（摘要已截断，完整内容见下方飞书文档）", lang)
    return md


def _plan_question_md(ctx, lang="zh"):
    """提问**全文**（不截断）→ markdown：逐题题头/题面/补充说明/选项与描述/能力标注。

    与卡片渲染（`_question_views` 按 `_Q_TEXT_MAX`/`_Q_OPT_MAX`/`_Q_DESC_MAX` 截断）
    刻意分开：文档承载的正是卡片放不下的完整信息。旧调用面/测试替身只给平面字段
    （question + 字符串选项）时按平面字段兜底。
    """
    qs = [q for q in (ctx.get("questions") or []) if q]
    lines = []
    if not qs:
        q = str(ctx.get("question") or "").strip()
        if q:
            lines.append(q)
        for i, o in enumerate(ctx.get("options") or [], 1):
            lines.append(f"{i}) {_option_view(o)['label']}")
        return "\n".join(lines)
    n = len(qs)
    for i, q in enumerate(qs, 1):
        title = str(q.get("header") or q.get("question")
                    or i18n.t("api", "第 {no} 题", lang, no=i))
        lines.append(f"### {i}/{n} {title}")
        if q.get("header") and q.get("question"):
            lines.append(str(q["question"]))
        body = str(q.get("body") or "").strip()
        if body:
            lines.append(body)
        for j, o in enumerate(q.get("options") or [], 1):
            ov = _option_view(o)
            lines.append(f"{j}) {ov['label']}")
            if ov["description"]:
                lines.append(f"　　{ov['description']}")     # 全角缩进：描述次行
        caps = []
        if q.get("multi_select"):
            caps.append(i18n.t("api", "多选", lang))
        if q.get("allow_other"):
            caps.append(i18n.t("api", "可自定义：{label}", lang,
                               label=q.get("other_label")
                                or i18n.t("api", "其他", lang)))
        line = _caps_line(caps, lang)
        if line:
            lines.append(line)
    return "\n".join(lines)


def _plan_doc_title(ctx, lang="zh"):
    """文档标题：卡号 + 题头（云空间列表里能一眼认出是哪张卡哪次提问）。"""
    head = str(ctx.get("header") or ctx.get("question")
               or i18n.t("api", "提问", lang)).strip()
    head = (head.splitlines() or [""])[0]
    return _clip_text(i18n.t("api", "卡 {cid} · {head}", lang,
                             cid=str(ctx.get("card_id")), head=head), 80)


def _plan_doc_markdown(ctx, texts, project_name="", lang="zh"):
    """完整方案文档正文（markdown，经 `_md_blocks` 转飞书块）。

    含：提问**全文**（卡片截断的部分在此补全）+ 末条 assistant 回答 + 作答指引
    （文档内也能凭"回复序号"作答）；2026-10-18 起**不含 think 摘录**（用户裁定
    思考内容不进任何飞书产物）；整体按 `_PLAN_DOC_MAX` 截断。
    """
    cid = ctx.get("card_id")
    a = str((texts or {}).get("assistant") or "").strip()
    lines = [i18n.t("api", "# 卡 {cid} · agent 的方案与提问", lang,
                    cid=str(cid)), "",
             i18n.t("api", "- 项目：{name}", lang, name=project_name or "—"),
             i18n.t("api", "- 卡片：{title}", lang,
                    title=str(ctx.get("title") or "")[:60]),
             i18n.t("api", "- 时间：{time}（北京时间）", lang,
                    time=_beijing_now())]
    sid = str(ctx.get("session_id") or "").strip()
    if sid:
        lines.append(i18n.t("api", "- 会话：{sid}", lang, sid=sid))
    if a:
        lines += ["", i18n.t("api", "## agent 的方案 / 回答", lang), "", a]
    lines += ["", i18n.t("api", "## 提问（全文）", lang), "",
              _plan_question_md(ctx, lang)]
    lines += ["", i18n.t("api", "## 如何作答", lang), "",
              i18n.t("api",
                     "- 在飞书聊天里点卡片上的选项按钮 / 下拉即完成作答"
                     "（多选题勾选后点「提交」）；", lang),
              i18n.t("api",
                     "- 也可以直接回复：「作答 {cid} <序号>」（多选逗号分隔，"
                     "如 `作答 {cid} 1,3`），或「作答 {cid} <自定义文字>」写自由文本；",
                     lang, cid=str(cid)),
              i18n.t("api", "- 点选与文本作答可混用，已点选的题不必重复给。", lang)]
    md = "\n".join(lines)
    if len(md) > _PLAN_DOC_MAX:
        md = md[:_PLAN_DOC_MAX] + i18n.t("api", "\n\n…（正文已截断）", lang)
    return md


def _md_plain(s):
    """清掉 docx 文本块**不渲染**的行内 markdown 记号（`**粗**`/`*斜*`/反引号/`~~删~~`）：
    留着只会以字面量出现在文档里（文档接口不做 markdown 渲染）。"""
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
    s = re.sub(r"(?<!\*)\*([^*\n]+?)\*(?!\*)", r"\1", s)
    s = re.sub(r"~~(.+?)~~", r"\1", s)
    return s.replace("`", "")


def _md_blocks(text):
    """极简 markdown → 飞书文档块（标题/项目符号/有序/引用/代码/分隔线/正文）。

    - 强调符清掉（`_md_plain`）；表格分隔行（`| --- | --- |`）丢弃——飞书块不支持
      表格，留着只有噪声；数据行按普通文本保留。
    - 超长段落按 `_MD_BLOCK_MAX` 切块（单块过长会被文档接口拒收）。
    - 产出恒为合法块形状，绝不抛（方案文档失败不该拖垮发卡链路）。
    """
    blocks, in_code, buf = [], False, []

    def mk(bt, key, content):
        return {"block_type": bt,
                key: {"elements": [{"text_run": {
                    "content": content,
                    "text_element_style": {"bold": bt in (3, 4, 5)}}}],
                    "style": {}}}

    def add_text(bt, key, s):
        if not s:
            return
        for i in range(0, len(s), _MD_BLOCK_MAX):
            blocks.append(mk(bt, key, s[i:i + _MD_BLOCK_MAX]))

    def flush_code():
        if buf:
            add_text(14, "code", "\n".join(buf))
            buf.clear()

    for raw in str(text or "").split("\n"):
        line = raw.rstrip()
        if line.strip().startswith("```"):
            if in_code:
                flush_code()
                in_code = False
            else:
                in_code = True
            continue
        if in_code:
            buf.append(line)
            continue
        s = _md_plain(line)
        if not s.strip():
            continue
        if re.match(r"^\|[\s\-:|]+\|$", s.strip()):          # 表格分隔行：丢
            continue
        if s.startswith("### "):
            add_text(5, "heading3", s[4:])
        elif s.startswith("## "):
            add_text(4, "heading2", s[3:])
        elif s.startswith("# "):
            add_text(3, "heading1", s[2:])
        elif s.strip() == "---":
            blocks.append({"block_type": 22, "divider": {}})
        elif s.lstrip().startswith("> "):
            add_text(15, "quote", s.lstrip()[2:])
        elif re.match(r"^\s*[-*] ", s):
            add_text(12, "bullet", re.sub(r"^\s*[-*] ", "", s))
        elif re.match(r"^\s*\d+[.)] ", s):
            add_text(13, "ordered", re.sub(r"^\s*\d+[.)] ", "", s))
        else:
            add_text(2, "text", s)
    flush_code()
    return blocks


def _docx_create(title, md_text, cfg, open_id, timeout=_DOC_TIMEOUT):
    """建飞书云文档并授权给用户 → 返回规范链接（任一步失败抛 FeishuRestError）。

    配方（2026-10-10 真机实测通过）：
    ① 建文档 `POST /docx/v1/documents`（需 `docx:document` 权限）；
    ② 写正文 `POST /docx/v1/documents/{doc}/blocks/{doc}/children`（**单次 ≤50 块**）；
    ③ `PATCH /drive/v1/permissions/{doc}/public?type=docx` 设「组织内可阅读」
       ——**必做**：文档默认归应用所有，不做这步用户打不开；
    ④ `POST /drive/v1/permissions/{doc}/members` 把用户加成协作者（**best-effort**：
       失败只留痕，第③步已保证链接可读）；
    ⑤ `POST /drive/v1/metas/batch_query`（body 带 `with_url=true`）取规范链接
       ——漏 `with_url` 会 `code=0` 静默回空串，此时按租户域名兜底拼链接。
    """
    body = _rest("POST", "/open-apis/docx/v1/documents", json_body={"title": title},
                 cfg=cfg, timeout=timeout) or {}
    doc = (((body.get("data") or {}).get("document") or {}).get("document_id") or "")
    if not doc:
        raise FeishuRestError("建文档成功但没拿到 document_id")
    blocks = _md_blocks(md_text)
    for i in range(0, len(blocks), 50):
        _rest("POST", f"/open-apis/docx/v1/documents/{doc}/blocks/{doc}/children",
              json_body={"children": blocks[i:i + 50], "index": i},
              cfg=cfg, timeout=timeout)
    _rest("PATCH", f"/open-apis/drive/v1/permissions/{doc}/public",
          params={"type": "docx"},
          json_body={"link_share_entity": "tenant_readable",
                     "external_access_entity": "open"}, cfg=cfg, timeout=timeout)
    if open_id:
        try:
            # need_notification=false：文档链接已在卡上，再加一条"分享给你"的飞书
            # 通知就是重复打扰（提问多时尤甚）；membership 只是链接分享被组织策略
            # 限制时的兜底通道。
            _rest("POST", f"/open-apis/drive/v1/permissions/{doc}/members",
                  params={"type": "docx", "need_notification": "false"},
                  json_body={"member_type": "openid", "member_id": open_id,
                             "perm": "full_access"}, cfg=cfg, timeout=timeout)
        except FeishuRestError as e:
            print(f"feishu docx: 加协作者失败（第③步链接分享已可读，继续）: {e!r}",
                  file=sys.stderr, flush=True)
    meta = _rest("POST", "/open-apis/drive/v1/metas/batch_query",
                 params={"user_id_type": "open_id"},
                 json_body={"request_docs": [{"doc_token": doc, "doc_type": "docx"}],
                            "with_url": True}, cfg=cfg, timeout=timeout) or {}
    metas = (meta.get("data") or {}).get("metas") or []
    url = (metas[0].get("url") if metas else "") or ""
    return url or f"https://feishu.cn/docx/{doc}"     # 兜底：域名由飞书 301/302 重定向


def _plan_doc_get(key):
    """取该 (卡, 提问) 已建文档链接（顺带清过期记录，防无界增长）。"""
    now = time.time()
    for k in [k for k, v in _PLAN_DOCS.items() if now - v.get("at", 0) > _PLAN_DOC_TTL]:
        _PLAN_DOCS.pop(k, None)
    v = _PLAN_DOCS.get(key)
    return v.get("url", "") if v else ""


def _plan_doc_put(key, url):
    """记账（同一提问只建一次文档；上限截断防无界增长）。"""
    _PLAN_DOCS[key] = {"url": url, "at": time.time()}
    while len(_PLAN_DOCS) > 128:
        _PLAN_DOCS.pop(min(_PLAN_DOCS, key=lambda k: _PLAN_DOCS[k]["at"]), None)


def _attach_plan(ctx, project_name, cfg, open_id="", lang="zh"):
    """把「方案」挂到卡片上下文：`plan_inline`（卡内折叠摘要）+ `plan_doc_url`（文档链接）。

    best-effort：**绝不外抛**——方案是锦上添花，卡本身必须发出去（历史上 form 元素
    超限曾整卡静默丢失）。无会话（取不到方案）直接返回，不发无意义文档。
    同一 (卡, 提问) 只建一次文档：调和器理论上一提问只调一次 `card_blocked`，此处是
    重放/重试保险，且让重放复用同一链接。
    """
    try:
        sid = str(ctx.get("session_id") or "").strip()
        if not sid:
            return
        texts = _plan_session_texts(sid)
        inline = _plan_inline_markdown(ctx, texts, lang)
        if inline:
            ctx["plan_inline"] = inline
        key = (int(ctx.get("card_id") or 0), str(ctx.get("qid") or ""))
        cached = _plan_doc_get(key)
        if cached:
            ctx["plan_doc_url"] = cached
            return
        md = _plan_doc_markdown(ctx, texts, project_name, lang)
        if not md.strip():
            return
        url = _docx_create(_plan_doc_title(ctx, lang), md, cfg, open_id)
        if url:
            _plan_doc_put(key, url)
            ctx["plan_doc_url"] = url
    except Exception as e:
        print(f"feishu docx: 建方案文档失败（卡照发，仅卡内摘要）: {e!r}",
              file=sys.stderr, flush=True)


def _dm_interaction_card(project_id, ctx):
    """旁路：向项目所有者的飞书单聊发交互卡片（**受 `notify_events` 闸门约束**，
    再要求账号绑定 + 应用凭据齐全才发）。

    2026-10-10 修实障：此前这里只看绑定与凭据 ⇒ 用户把项目「启用推送」与全部
    事件取消勾选（甚至关掉用户级总开关）后，单聊卡片仍持续送达，设置形同虚设。
    现在项目的 `blocked_interaction` 未开即直接不发（与群 webhook 同一闸门）。
    卡片是即时交互载体，不走 outbox（过期提问的分钟级重试无意义）；失败仅
    留痕——群 webhook 文本推送（push_event）始终是主通道，不受影响。"""
    try:
        if "blocked_interaction" not in notify_events(project_id):
            return
        proj = db.get_project(project_id)
        owner = (proj["user_id"] if proj else 0) or 0
        binding = db.get_feishu_binding_by_user(owner)
        cfg = app_config(owner)
        if not binding or not cfg:
            return
        name = proj["name"] if proj else f"#{project_id}"
        # M6：把 agent 的方案/回答挂到卡上（卡内折叠摘要 + 完整方案飞书文档链接）。
        # 审批卡不做（它的"背景"由审批请求本身给出，建文档没意义）；开关可回滚。
        lang = user_lang(owner)
        if plan_enabled() and str(ctx.get("kind") or "") != "approval":
            _attach_plan(ctx, name, cfg, binding["open_id"] or "", lang)
        rest_send_card(binding["open_id"],
                       _build_interaction_card(ctx, name, lang), cfg)
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
        # M6：方案取数（`_attach_plan` 读会话转录）与建文档去重都要这两个键；
        # 缺了它们 M6 整块自动跳过（旧调用面/测试替身不受影响）。
        "session_id": str(card.get("session_id") or ""),
        "qid": str(interaction.get("qid") or ""),
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
    连接失败细节看 server.log。**形状是 `/api/me/feishu-cfg` 响应的子对象 ⇒ 只许这两键**
    （「线程绑的哪个应用」不放进这里，见 `inbound_thread_app_id`）。"""
    cfg = app_config(user_id)
    t = _WS_THREADS.get(user_id)
    return {"configured": cfg is not None,
            "thread": t is not None and t.is_alive()}


def inbound_thread_app_id(user_id):
    """**拉起入站线程时**用的 app_id（M10，2026-10-17）：换凭据后旧连接会一直在跑，
    doctor 靠它判「线程绑的应用 ≠ 配置里的应用」的假绿；M11 起这个不一致可由
    `restart_inbound_for` 在进程内收口（免重启站点）。
    空串 = 当前进程没为该用户拉过线程（老进程/测试替身）⇒ 调用方不许据此告警。
    刻意**不并进 `inbound_status`**：那是 `GET /api/me/feishu-cfg` 的响应子对象，
    多一个键就是对外契约变更（node 侧 5 条形状判据当场抓过这个泄漏）。"""
    return _WS_APP_ID.get(user_id) or ""


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


def _rest(method, path, *, params=None, json_body=None, cfg=None, timeout=10):
    """飞书 REST 统一调用（按用户应用 cfg 鉴权）：非 0 业务码抛 FeishuRestError。
    timeout 可按调用收敛（M6 建方案文档跑在 board 调和线程里，逐调用上限 8s）。
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
                json=json_body, timeout=timeout,
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


def _rest_bytes(method, path, *, params=None, cfg=None, timeout=30):
    """飞书 REST **二进制**下载（截图资源用）：路径规范化/token 取法与 `_rest` 完全
    一致，只是返回字节流而不是 JSON；**不重试**（大文件且失败一律由上层回中文文案）。
    鉴权头只带 Authorization——资源下载接口**不要**带 Content-Type 请求头（契约 §3.4）。

    返回 `(data: bytes, content_type: str)`；HTTP 非 2xx 抛 FeishuRestError：
    JSON 错误体带业务码（缺权限那三个码由调用方判定），非 JSON 只报 status。
    """
    if cfg is None:
        raise FeishuRestError("应用未配置（app_id/app_secret 缺失）")
    path = "/" + path.lstrip("/")
    if not path.startswith("/open-apis"):
        path = f"/open-apis{path}"
    url = f"https://open.feishu.cn{path}"
    try:
        r = requests.request(
            method, url, params=params, timeout=timeout,
            headers={"Authorization": f"Bearer {_tenant_token(cfg)}"})
    except (OSError, ValueError) as e:
        raise FeishuRestError(f"REST {method} {path} 失败: {e}") from e
    if not (200 <= r.status_code < 300):
        try:
            out = r.json()
        except ValueError:
            out = None
        if isinstance(out, dict):
            code = out.get("code")
            raise FeishuRestError(f"REST {path} code={code} {out.get('msg', '')}",
                                  code=code)
        raise FeishuRestError(f"REST {path} status={r.status_code}")
    return r.content or b"", (r.headers.get("Content-Type") or "")


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
# icon_key **必须**取 SLASH_ICON_KEYS（官方「Slash Command Icon Key 说明」全表）内的值，
# 表外的键（含按语义自造的）创建即报 40000031
SLASH_COMMANDS = (
    ("help",    "查看可用指令", "skill_outlined"),
    ("bind",    "绑定站点账号：/bind 绑定码", "member_outlined"),
    ("unbind",  "解除站点账号绑定", "clear_outlined"),
    ("project", "设置默认项目：/project 项目名", "home_outlined"),
    ("current",  "查看默认项目与当前会话", "home_outlined"),
    ("projects", "项目总览卡：点选设为默认项目", "database_outlined"),
    ("sessions", "默认项目最近会话：点选绑定", "chat_outlined"),
    ("new",      "在默认项目下新建会话并绑定：/new [标题]", "add-chat-ai_outlined"),
    ("use",      "绑定已有会话：/use 序号|关键字|会话id前缀", "global-link_outlined"),
    ("leave",    "解绑当前会话（保留默认项目）", "clear_outlined"),
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
_SLASH_ICON_HINT = "指令图标 icon_key 不合法（取值见官方 Slash Command Icon Key 说明）"
_SLASH_PARAM_HINT = "指令参数校验失败：指令名需为不含「/」的标识符，说明不可为空"
# 官方「Slash Command Icon Key 说明」全量可选值（2026-10-09 抄自开放平台文档
# https://open.feishu.cn/document/mcp_open_tools/agent-best-practices/agent-supports-slash-commands
# 的同名章节，共 72 个；缺省 skill_outlined）。**表外的键一律非法**，创建/更新报业务码
# 40000031——2026-10-09 真机取证：凭语义自造的 add_outlined / link_outlined 正是这样让
# 同步停在 15/17 条（设置页红字即 _SLASH_ICON_HINT）。改图标前先在本表内选，
# `tests/test_feishu_slash.py::test_slash_icons_are_official_keys` 会拦住表外的值。
SLASH_ICON_KEYS = frozenset((
    # AI 系（官方表前 31 项）
    "skill_outlined", "light-ai_outlined", "chat-ai_outlined",
    "ai-edit-continue_outlined", "education-ai_outlined", "ai-trans-switch_outlined",
    "language-ai_outlined", "toolbar-more-ai_outlined", "image-ai_outlined",
    "ai-agent_outlined", "ai-deepthink_outlined", "ai-style_outlined",
    "ai-reminder_outlined", "ai-block_outlined", "ai-simplify-expression_outlined",
    "promptword_outlined", "meeting-ai_outlined", "ai-improvewriting_outlined",
    "slash-ai_outlined", "pa-cost-ai_outlined", "update-ai_outlined",
    "diagnosis-ai_outlined", "ai-functions_outlined", "mic-ai_outlined",
    "search-ai_outlined", "explanation-ai_outlined", "add-ai_outlined",
    "add-chat-ai_outlined", "ai-notification_outlined", "dynamic-layout_outlined",
    "ai-doc_outlined",
    # 通用（官方表其余 41 项）
    "home_outlined", "mail_outlined", "browser-mac_outlined", "flag_outlined",
    "calendar-line_outlined", "sent_outlined", "gift_outlined", "tag_outlined",
    "cloud_outlined", "bonus-payroll_outlined", "vote_outlined", "chat_outlined",
    "emoji_outlined", "member_outlined", "robot_outlined", "mic_outlined",
    "raisehand_outlined", "officephone_outlined", "effects_outlined", "labs_outlined",
    "computer_outlined", "clear_outlined", "mouse_outlined", "cellphone_outlined",
    "cursor_outlined", "plugin_outlined", "edit_outlined", "style-fillcolor_outlined",
    "codeblock_outlined", "code_outlined", "folder_outlined", "file-link-word_outlined",
    "file-link-sheet_outlined", "file-link-image_outlined", "global-link_outlined",
    "champion_outlined", "local_outlined", "day_outlined", "waiting_outlined",
    "database_outlined", "marketplace_outlined",
))


# ---------- M5 配置自动化：清单真源 / 事件打点 / 环境总闸 ----------
# 2026-10-10：新用户「扫码一键接入 + 配置补齐 + 自检」批次（设计见
# doc_ai/plan/202610/20261010_1700_飞书配置自动化（扫码一键接入与配置自检）.md）。
# 下列清单是**唯一真源**：doctor 的逐项检查、register_app 的 addons 预置、
# application/v7 config 的补齐三处共用同一份（改这里即可，勿在前端另抄一份）。
PROVISION_ENV = "TS_FEISHU_PROVISION"   # =0 关闭全部写操作（doctor/status 只读不受影响）
REQUIRED_SCOPES = (
    ("im:message.p2p_msg:readonly", "tenant", "接收单聊消息"),
    ("im:message.group_at_msg:readonly", "tenant", "接收群聊 @机器人 消息"),
    ("im:message:send_as_bot", "tenant", "以机器人身份发消息/卡片"),
    ("application:app_slash_command:read", "tenant", "读取斜杠指令"),
    ("application:app_slash_command:write", "tenant", "注册斜杠指令"),
    # 截图接收（2026-10-22）：下载消息内图片资源要求 im:message / im:message:readonly
    # / im:message.history:readonly 任一；取较窄的「获取单聊、群组消息」，让「接入」的
    # 「补齐配置 → 发布」能把它开通（缺权限时下载回 MEDIA_SCOPE_HINT 引导）
    ("im:message:readonly", "tenant", "读取消息中的图片/文件资源"),
)
REQUIRED_EVENTS = (("im.message.receive_v1", "接收消息"),)
REQUIRED_CALLBACKS = (("card.action.trigger", "卡片按钮回调"),)
EVENT_FRESH_S = 300                     # doctor 判「事件订阅真生效」的新鲜窗口（秒）
SEND_PROBE_MIN_S = 60                   # send_probe 每用户频控（秒），防连点刷屏
PROVISION_TTL = 600                     # 扫码流程状态存活上限（秒），过期视为 idle

# 应用配置/发布端点（官方 application/v7；能力开关在 ability 子路径）
_APP_ABILITY_API = "/open-apis/application/v7/applications/%s/ability"
_APP_CONFIG_API = "/open-apis/application/v7/applications/%s/config"
_APP_PUBLISH_API = "/open-apis/application/v7/applications/%s/publish"
_APP_VERSIONS_API = "/open-apis/application/v6/applications/%s/app_versions"
# 补齐应用配置所需的权限（冷启动点：扫码新建的应用默认没有它，需控制台加一次或管理员免审）
_PATCH_SCOPE = "application:application:patch"
_PATCH_SCOPE_HINT = (f"应用缺少「{_PATCH_SCOPE}」权限：请到开发者后台 → 权限管理添加该权限"
                     "并创建版本发布；或把该权限对应用设为免审后再试")

_LAST_EVENT_TS = {}    # user_id -> 最近一次收到飞书事件（消息/卡片回调）的时刻


def _touch_event(user_id):
    """事件到达打点：入站长连接的 handler 入口调用（消息与卡片回调都算）。
    doctor 的「事件订阅是否真生效」只能靠真实事件证明（订阅方式配错时连接照样
    建得起来），此时间戳即唯一证据；仅进程内存态，重启归零。"""
    _LAST_EVENT_TS[user_id] = time.time()


def provision_enabled():
    """配置自动化写操作（扫码建应用/补齐配置/提交发布）总闸：TS_FEISHU_PROVISION=0 关闭。
    只读的 status/doctor 不受影响——关掉后仍可体检，只是不能改用户应用配置。"""
    return (os.environ.get(PROVISION_ENV) or "1") != "0"


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


def slash_error_hint(err, lang="zh"):
    """飞书业务码 → 用户可操作的引导（不抛异常）。

    默认 `lang="zh"`：设置页展示（T12d 数据面）与既有断言逐字节不变；
    飞书 DM 回执（权限卡「重试注册」失败）显式传收件人语言（T12b）。
    三个固定引导都走 `api` 词条：zh 原文即 key，返回原串。"""
    code = getattr(err, "code", None)
    if code in _SLASH_PERM_CODES:
        return i18n.t("api", _SLASH_PERM_HINT, lang)
    if code == 40000031:
        return i18n.t("api", _SLASH_ICON_HINT, lang)
    if code == 99992402:
        return i18n.t("api", _SLASH_PARAM_HINT, lang)
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


def slash_status(user_id, lang="zh"):
    """设置页读取口：TS 期望清单 + 飞书侧现状（含用户自己的其他指令）。
    凭据缺失/权限不足等一律走 error 字段返回，不抛异常（页面照常渲染并给引导）；
    need_scope=缺「应用指令」scope（页面据此提供「发飞书权限卡片」入口）。

    语言（T12d/Task1）：默认 ``lang="zh"``（设置页 slash 卡既有中文数据面不变）；
    ``lang`` 由设置页端点按请求语言传入，只影响 ``error`` 里的固定中文引导；
    17 条 ``desired[].description`` 是飞书注册说明，保持中文（KB-08/R23）。
    doctor 的 slash_scope 项也显式传**请求语言**，让该项 detail/hint 跟随页面语言。"""
    desired = [{"command": c, "description": d, "icon": i}
               for c, d, i in SLASH_COMMANDS]
    cfg = app_config(user_id)
    if cfg is None:
        return {"configured": False, "desired": desired, "remote": [], "extra": [],
                "need_scope": False,
                "error": i18n.t(
                    "api",
                    "未配置应用凭据（App ID/App Secret），先在上方「飞书机器人配置」保存后重试",
                    lang)}
    try:
        remote = list_slash_commands(cfg)
    except FeishuRestError as e:
        return {"configured": True, "desired": desired, "remote": [], "extra": [],
                "need_scope": _need_scope(e),
                "error": slash_error_hint(e, lang)}
    extra = sorted(r["command"] for r in remote if r["command"] not in _SLASH_NAMES)
    return {"configured": True, "desired": desired, "remote": remote, "extra": extra,
            "need_scope": False, "error": ""}


def sync_slash_commands(user_id, lang="zh"):
    """把 TS 指令清单幂等同步到飞书：只增/改**自己的**指令，**绝不删**用户的其他指令。
    返回 {ok, created, updated, kept, extra, failed, need_scope, error} 供设置页展示
    （need_scope=True 时调用方应发权限引导卡片并等用户确认后重试）。

    `lang` 缺省 `"zh"`：设置页/对拍路径（T12d 数据面）逐字节不变；飞书 DM 回执
    （权限卡重试失败）显式传收件人语言，让 `error`（诊断数据）与回执同语言。"""
    cfg = app_config(user_id)
    if cfg is None:
        return {"ok": False, "need_scope": False,
                "error": i18n.t("api", "未配置应用凭据（App ID/App Secret）", lang)}
    try:
        remote = list_slash_commands(cfg)
    except FeishuRestError as e:
        return {"ok": False, "need_scope": _need_scope(e),
                "error": slash_error_hint(e, lang)}
    by_name = {r["command"]: r for r in remote}
    buckets = {"created": [], "updated": [], "kept": []}
    failed = []
    need_scope = False
    for name, desc, icon in SLASH_COMMANDS:
        if icon not in SLASH_ICON_KEYS:
            # 本地预检：表外的键飞书必回 40000031，先在此拦下——省一次请求，
            # 且不让远端停在「同步到一半」的状态（同步是逐条进行的）
            failed.append(f"{name}: {i18n.t('api', _SLASH_ICON_HINT, lang)}")
            continue
        try:
            buckets[_slash_upsert(cfg, name, desc, icon, by_name)].append(name)
        except FeishuRestError as e:
            need_scope = need_scope or _need_scope(e)
            failed.append(f"{name}: {slash_error_hint(e, lang)}")
    return {"ok": not failed,
            "created": buckets["created"], "updated": buckets["updated"],
            "kept": buckets["kept"],
            "extra": sorted(n for n in by_name if n not in _SLASH_NAMES),
            "failed": failed, "need_scope": need_scope,
            "error": failed[0] if failed else ""}


def clear_slash_commands(user_id, lang="zh"):
    """删除**TS 自己的**指令（名字命中 SLASH_COMMANDS 的远端项）；用户其他指令不动。

    `lang` 缺省 `"zh"`：设置页 slash 卡既有中文数据面逐字节不变；设置页端点按
    请求语言传入后，``error``/``failed`` 里的固定中文引导跟随页面语言。"""
    cfg = app_config(user_id)
    if cfg is None:
        return {"ok": False, "need_scope": False,
                "error": i18n.t("api", "未配置应用凭据（App ID/App Secret）", lang)}
    try:
        remote = list_slash_commands(cfg)
    except FeishuRestError as e:
        return {"ok": False, "need_scope": _need_scope(e),
                "error": slash_error_hint(e, lang)}
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
            failed.append(f"{r['command']}: {slash_error_hint(e, lang)}")
    return {"ok": not failed, "deleted": sorted(deleted),
            "extra": sorted(r["command"] for r in remote if r["command"] not in _SLASH_NAMES),
            "failed": failed, "need_scope": need_scope,
            "error": failed[0] if failed else ""}


def _slash_summary(out, lang="zh"):
    """同步结果一句话摘要（DM 卡片回执与设置页提示共用）。

    `lang` 缺省 `"zh"`：设置页调用点（T12d 数据面）一行不改；DM 回执按收件人语言。"""
    s = i18n.t("api", "新增 {created}、更新 {updated}、已是最新 {kept}", lang,
               created=len(out.get("created") or []),
               updated=len(out.get("updated") or []),
               kept=len(out.get("kept") or []))
    if out.get("failed"):
        s += i18n.t("api", "、失败 {failed}", lang,
                    failed=len(out["failed"]))
    return s


def slash_perm_card(app_id, user_id, lang="zh"):
    """权限引导卡片（schema 2.0，DM 单聊）：说明缺哪个 scope、三步怎么开通、
    开发者后台直达链接，底部「我已开通，重试注册」按钮——点它回调里重跑同步
    （卡片无状态，value 只带身份 u 与动作 t=sc，回调时按 open_id→binding 复核）。
    按钮形态与既有交互卡片完全一致（behaviors/callback），避免未验证的元素类型。
    链接只给「应用详情页」根 URL（官方文档只保证菜单路径「开发配置 → 权限管理 /
    应用发布 → 版本管理与发布」，深链路由未在文档中出现，不猜）。

    语言（T12b）：`lang` 由发卡入口按收件人 `user_lang(user_id)` 传入；默认 `"zh"`。"""
    url = (f"https://open.feishu.cn/app/{app_id}"
           if app_id else "https://open.feishu.cn/app")
    content = i18n.t(
        "api",
        "**Touchstone 快捷指令**（机器人私聊输入框打「/」弹出的指令面板）需要你的飞书应用先开通权限：\n"
        "· `application:app_slash_command:read`\n"
        "· `application:app_slash_command:write`\n\n"
        "**开通三步**：\n"
        "1. 打开 [开发者后台 · 本应用]({url})，左侧 **开发配置 → 权限管理**，点「开通权限」\n"
        "2. 搜索 `app_slash_command`，把读、写两个权限都勾上并确认开通\n"
        "3. 左侧 **应用发布 → 版本管理与发布** → 创建版本并发布"
        "（权限改动必须发版、过审后才生效）\n\n"
        "完成后点下面的按钮，我立刻重试注册；若刚发版，可等约 1 分钟再点一次。",
        lang, url=url)
    payload = {"t": "sc", "a": "retry", "u": int(user_id)}
    return {"schema": "2.0",
            "header": {"title": {"tag": "plain_text",
                                 "content": i18n.t(
                                     "api", "🔑 需要开通「应用指令」权限", lang)},
                       "template": "orange"},
            "body": {"elements": [
                {"tag": "markdown", "content": content},
                {"tag": "button", "type": "primary",
                 "text": {"tag": "plain_text",
                          "content": i18n.t("api", "我已开通，重试注册", lang)},
                 "behaviors": [{"type": "callback", "value": payload}]},
            ]}}


def send_slash_perm_card(user_id):
    """向该用户的飞书单聊发权限引导卡片（需已绑定 + 应用凭据齐全）。
    返回 (ok, err)：未绑定/未配凭据属正常情形，调用方据此给站点侧提示，不抛异常。

    `err` 会回显在站点设置页（T12d 数据面）⇒ 保持中文；卡片按收件人语言。"""
    cfg = app_config(user_id)
    if cfg is None:
        return False, "未配置应用凭据（App ID/App Secret），先保存配置再发卡片"
    binding = db.get_feishu_binding_by_user(user_id)
    if not binding:
        return False, "尚未绑定飞书账号：设置页生成绑定码后在机器人单聊回复「绑定 <码>」"
    try:
        rest_send_card(binding["open_id"],
                       slash_perm_card(cfg.get("app_id", ""), user_id,
                                       user_lang(user_id)), cfg)
        return True, ""
    except FeishuRestError as e:
        return False, f"卡片发送失败：{e}"


def _on_slash_perm_action(sender, value, cfg):
    """权限引导卡片的按钮回调：复核身份（必须是该卡片指向的、已绑定的用户）→
    重跑 sync_slash_commands → DM 文本回执 + toast。返回 None 表示不更新卡片。

    语言（T12b）：入口按点击者解析一次（未绑定 ⇒ R22 中文兜底），DM 与 toast 同语言；
    重试失败的诊断（`slash_error_hint` / 未配凭据）随 `lang` 本地化（zh 原文不变）。"""
    binding = db.get_feishu_binding_by_open(sender)
    if binding is None:
        _dm_text(sender, i18n.t("api", "尚未绑定 Touchstone 账号：登录站点 → 侧栏「设置」→ "
                                       "飞书设置，生成绑定码后在这里回复「绑定 <码>」完成绑定",
                                "zh"), cfg)
        return {"toast": {"type": "error",
                          "content": i18n.t("api", "尚未绑定站点账号", "zh")}}
    lang = user_lang(binding["user_id"])
    uid = int(value.get("u") or 0)
    if uid and uid != int(binding["user_id"]):
        # 防串号：卡片只对它发给的那个人生效
        return {"toast": {"type": "error",
                          "content": i18n.t("api", "该卡片不属于当前账号", lang)}}
    out = sync_slash_commands(binding["user_id"], lang)
    if out.get("ok"):
        _dm_text(sender, i18n.t(
            "api", "✅ 快捷指令注册完成：{summary}\n"
                   "约 5 分钟后在机器人私聊输入「/」即可看到"
                   "（重启飞书客户端可加速）。",
            lang, summary=_slash_summary(out, lang)), cfg)
        return {"toast": {"type": "success",
                          "content": i18n.t("api", "注册完成", lang)}}
    text = i18n.t("api", "❌ 仍未成功：{error}", lang,
                  error=out.get("error") or i18n.t("api", "未知错误", lang))
    if out.get("need_scope"):
        text += i18n.t(
            "api", "\n看起来权限还没生效：确认已在权限管理里添加读+写并"
                   "**创建版本发布**，稍等约 1 分钟再点一次卡片上的按钮。", lang)
    _dm_text(sender, text, cfg)
    return {"toast": {"type": "error",
                      "content": i18n.t("api", "仍未成功，看私聊回复", lang)}}


# ---------- M2 入站：ws 长连接与消息主流程 ----------

HELP_TEXT = (
    "Touchstone 指令（单聊可用）：\n"
    "直接发普通文字 = 与当前会话对话（未绑定会在默认项目自动新建）。\n"
    "· 帮助 — 本说明\n"
    "· 接入 — 飞书接入操作卡片（换应用/重连/绑定码/自检/补齐/发布）\n"
    "· 绑定 <码> — 绑定站点账号（绑定码在站点侧栏「设置」→ 飞书设置 生成）\n"
    "· 解绑 — 解除绑定\n"
    "· 当前 — 查看默认项目与当前会话\n"
    "· 项目 — 项目总览卡（点选即设为默认项目）\n"
    "· 会话 — 默认项目最近活跃的 10 个会话（点选即绑定）\n"
    "· 新建会话 [标题] — 在默认项目下新建并绑定\n"
    "· 绑定会话 <序号|标题关键字|会话id前缀> — 绑定已有会话\n"
    "· 解绑会话 — 只解绑会话，保留默认项目\n"
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


def help_text(lang="zh"):
    """帮助文本（T12b）：`HELP_TEXT` 是中文原文（即词典 key），`lang` 决定查表。

    **指令词不译**（帮助/接入/绑定/作答…）：`_INTENT_RULES` 只认这些中文词与
    `/别名`，英文说明里保留原词用户才照着发得出来（R23 同款边界：slash 注册
    schema 仍是中文，只有回复/帮助本地化）。zh 分支与旧常量逐字节相同。"""
    return i18n.t("api", HELP_TEXT, lang)

_WS_THREADS = {}       # user_id -> 入站线程（已拉起且在 run 的；线程退出后残留引用）
# user_id -> **拉起该线程时**用的 app_id（M10，2026-10-17）：换凭据后旧连接会一直在跑，
# doctor 拿它判「线程绑的应用 ≠ 配置里的应用」（M11 起这种不一致可由 `restart_inbound_for`
# 在进程内收口，不再只有「重启站点」一条路）。
_WS_APP_ID = {}
# user_id -> (client, loop)：M11 起每条长连接独立 event loop、可在进程内停止
# （`stop_inbound_for`/`restart_inbound_for` 用；见 `_ws_run` 的 loop 说明）。
_WS_CLIENTS = {}
_WS_STOP_TIMEOUT = 8.0  # 停连接时等线程退出的上限（秒）；实测收口在毫秒级
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
    凭据变更后用 `restart_inbound_for` 停旧起新（M11 起免重启站点）；
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
    _WS_APP_ID[user_id] = cfg.get("app_id") or ""     # 记「这条线程绑的是哪个应用」
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
    handler 内禁上抛。cfg 是**拉起时**的凭据快照——换凭据后由
    `restart_inbound_for` 停旧起新（M11 起免重启站点）。

    M11（2026-10-17）关键结构：每条连接**独立 event loop**（patch
    `lark_oapi.ws.client.loop`）。SDK 的 `start()` 用模块级 loop 且 `_select()` 永不返回，
    共享 loop 就无法只停一条连接；独立 loop 让 `stop_inbound_for` 只收口自己这条。
    必须同时 `asyncio.set_event_loop(loop)`：SDK 的 `ExpiringCache.__init__` 用
    `asyncio.get_event_loop()` 起清扫任务（`core/cache/expiring_cache.py:12-18`），
    不设的话该任务会建在另一条永不运行的 loop 上，退出时报「Task was destroyed」。"""
    try:
        import lark_oapi as lark
        from lark_oapi.ws import client as ws_sdk_client
    except ImportError:
        print("feishu inbound: lark-oapi 未安装，入站禁用",
              file=sys.stderr, flush=True)
        return  # 依赖未装：入站禁用（M1 出站 webhook 不受影响）

    def _handler(data):
        _touch_event(user_id)      # 事件到达打点（doctor 判「订阅是否真生效」）
        _on_message_event(data, cfg)

    def _on_card_sdk(data):
        # 返回值（toast）由 ws 客户端序列化回响应帧——丢弃则点击反馈（toast）
        # 恒不生效（SDK 路径此前即如此）
        _touch_event(user_id)
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
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)                 # SDK 内部 ExpiringCache 取的是它（见 docstring）
    loop.set_exception_handler(lambda _loop, _ctx: None)   # 私有 loop：asyncio 层噪声不外溢
    ws_sdk_client.loop = loop                    # SDK start() 读/写模块级 loop（client.py:164-179）
    client = _make_ws_client(cfg, handler, lambda data: _on_card_action(data, cfg),
                             log_level=lark.LogLevel.DEBUG if ws_debug
                             else lark.LogLevel.ERROR)
    _WS_CLIENTS[user_id] = (client, loop)
    print(f"feishu inbound: 用户 {user_id} 连接长连接网关（app_id={cfg['app_id']}）…",
          file=sys.stderr, flush=True)
    try:
        client.start()
    except asyncio.CancelledError:
        pass              # 停止请求（M11 `stop_inbound_for`）：不是异常，不刷 ERROR 行
    except Exception as e:  # 连接建立失败/网关拒绝等：留痕后线程退出（不再自动重试）
        print(f"feishu inbound: 用户 {user_id} 长连接异常退出: {e!r}（重启站点重试）",
              file=sys.stderr, flush=True)
    finally:
        _WS_CLIENTS.pop(user_id, None)
        _drain_ws_loop(loop)


def _drain_ws_loop(loop):
    """收口一条入站连接的 event loop（M11）：有界等待取消送达 → 关闭。
    无界等会卡在 SDK 心跳的 120s sleep 上；1s 足够让任务取消收敛（实测毫秒级）。"""
    try:
        pending = [t for t in asyncio.all_tasks(loop) if not t.done()]
        if pending:
            loop.run_until_complete(asyncio.wait(pending, timeout=1.0))
    except BaseException:     # noqa: BLE001 - 收口阶段吞掉一切（含已关闭/已停止）
        pass
    try:
        loop.close()
    except BaseException:     # noqa: BLE001
        pass


def stop_inbound_for(user_id):
    """停掉该用户的入站长连接（M11：换应用凭据后免重启站点）。返回是否真的停了
    一条在跑的连接——幂等：没在跑 ⇒ False、零副作用。

    收口算法（实测见 plan 记录）：关闭 ws（SDK 的 `_disconnect`）→ 置
    `_auto_reconnect=False`（否则 receive loop 会立刻重连）→ 取消该 loop 上全部任务 →
    停 loop；线程退出后 `_ws_run` 的 finally 再关 loop。线程是 daemon：即使超时
    未退也不会阻塞进程退出。"""
    th = _WS_THREADS.get(user_id)
    if th is None or not th.is_alive():
        return False
    ent = _WS_CLIENTS.get(user_id)
    if ent is None:              # 线程已起、客户端还在构造/导入 SDK 中：有界等一小段
        for _ in range(50):
            if not th.is_alive():
                return False
            time.sleep(0.02)
            ent = _WS_CLIENTS.get(user_id)
            if ent is not None:
                break
    if ent is None:
        return False
    client, loop = ent
    try:
        from lark_oapi.core.log import logger as lark_logger
    except Exception:            # noqa: BLE001 - 没有日志模块也不影响停止
        lark_logger = None
    try:
        if lark_logger is not None:
            # 主动停连接时 SDK 的 receive loop 会打一条 ERROR「receive message loop exit」——
            # 那是预期内收口、不是故障；临时抬到 CRITICAL，停完复原（默认级别就是 ERROR）。
            lark_logger.setLevel(logging.CRITICAL)
        client._auto_reconnect = False
        try:
            asyncio.run_coroutine_threadsafe(client._disconnect(), loop).result(3.0)
        except BaseException:    # noqa: BLE001 - 连接可能已断/loop 已停
            pass

        def _shutdown():
            try:
                for task in asyncio.all_tasks(loop):
                    task.cancel()
            except BaseException:    # noqa: BLE001
                pass
            loop.call_later(0.05, loop.stop)

        try:
            loop.call_soon_threadsafe(_shutdown)
        except RuntimeError:     # loop 已关闭：线程自己会退
            pass
        th.join(_WS_STOP_TIMEOUT)
    finally:
        if lark_logger is not None:
            try:
                lark_logger.setLevel(logging.ERROR)
            except Exception:    # noqa: BLE001
                pass
    return not th.is_alive()


def restart_inbound_for(user_id):
    """换掉该用户的入站长连接（M11）：停旧 → 用**当前库里**的凭据起新。
    返回是否起了新连接（False = 旧线程没停下来导致新连接没起，或凭据不全）。
    停超时也照常尝试起新——但 `start_inbound_for` 见线程还活着会短路，故不会并存两条。
    M11.1 起由 `POST /api/me/feishu/reconnect`（设置页面板「重连入站」按钮）直接暴露。"""
    stop_inbound_for(user_id)
    return start_inbound_for(user_id)



# ---------- 截图接收（2026-10-22，单聊 image/post 消息转投绑定会话） ----------
# 契约真源：doc_ai/plan/202610/20261022_0837_飞书单聊截图支持（图片与图文消息转投
# 绑定会话）.md §三（文案/常量/行为顺序双后端逐字一致，测试按此断言）。
# 链路：入站 image/post → 解析 content（§3.3）→ 逐张下载到内存（§3.4，全有或全无）
# → feishu_conv.route_text(images=…) 存 <work_dir>/board_media 并按站点会话窗同款
# markdown 绝对路径投递绑定会话（§3.5/§3.6）→ agent 用 read_image 看图。
MEDIA_ENV = "TS_FEISHU_MEDIA"           # =0 关闭本功能（回退旧「暂不支持该消息类型」）
MEDIA_MAX_BYTES = 10 * 1024 * 1024      # 单张图片上限（与看板附件上限同值）
MEDIA_MAX_COUNT = 9                     # 单条消息最多转几张（多余静默丢弃）
MEDIA_TYPE_HINT = "暂不支持该消息类型，请发送文字指令"   # 旧回执原串提取为常量
# 未绑定引导（文字与媒体两条路径共用同一串：§3.2 步骤 4 要求与文字路径逐字一致）
UNBOUND_DM_MSG = ("尚未绑定 Touchstone 账号：登录站点 → 侧栏「设置」→ 飞书设置，"
                  "生成绑定码后在这里回复「绑定 <码>」完成绑定")
# 卡片回调路径的未绑定引导（与 UNBOUND_DM_MSG **不是同一句**：这里说「在单聊回复」，
# 消息路径说「在这里回复」；2026-10-22 截图批次的 Node `UNBOUND_DM_CARD` 同串）。
_UNBOUND_DM_CARD = ("尚未绑定 Touchstone 账号：登录站点 → 侧栏「设置」→ 飞书设置，"
                    "生成绑定码后在单聊回复「绑定 <码>」完成绑定")

# 固定长文案（Python 模块级常量；Node 同名导出常量，中文逐字一致）
MEDIA_SCOPE_HINT = ("截图功能需要飞书应用额外开通「获取单聊、群组消息（im:message:readonly）」"
                    "权限：在「接入」卡片点「补齐配置」→「发布」，或到开发者后台「权限管理」"
                    "添加该权限并发布新版本后重试。")
MEDIA_FAIL_PREFIX = "截图接收失败："          # 后接具体原因
MEDIA_TOO_LARGE = "图片过大（单张上限 10MB），请压缩后重发"
MEDIA_NO_IMAGE = "消息里没有可下载的图片"
MEDIA_SAVE_FAIL_PREFIX = "截图保存失败："      # 后接 OSError 文案（feishu_conv 使用）
MEDIA_HEADER_FMT = "[飞书截图] 用户从飞书发送了 %d 张截图"
MEDIA_HEADER_NOTE = "（未附文字说明）"          # 原消息无文字时追加在 header 后

# mime → 落盘扩展名（_download_image 归一后使用；feishu_conv 存盘共用同一份映射）
MEDIA_MIME_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg",
                  "image/gif": "gif", "image/webp": "webp"}
# 下载消息资源缺权限时的飞书业务码（三种都按「缺权限」回 MEDIA_SCOPE_HINT）
_MEDIA_SCOPE_CODES = (99991640, 99991672, 99991679)
_MEDIA_LOCALES = ("zh_cn", "en_us", "ja_jp")


class MediaTooLarge(Exception):
    """下载的图片字节数超过 MEDIA_MAX_BYTES（不是网络/权限错误，单独回「过大」文案）。"""


def media_enabled():
    """截图接收总开关（默认开；TS_FEISHU_MEDIA=0 回退旧「暂不支持该消息类型」）。"""
    return (os.environ.get(MEDIA_ENV) or "").strip() != "0"


def _sniff_image_mime(data):
    """按魔数嗅探图片类型（仅契约列出的 4 种）；识别不了返回空串。

    PNG 89 50 4E 47 / JPEG FF D8 FF / GIF GIF8 / WEBP RIFF....WEBP。
    """
    if data[:4] == b"\x89PNG":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:4] == b"GIF8":
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return ""


def _media_items(evt):
    """解析 image/post 消息内容 → `(text, [image_key, ...])`（契约 §3.3）。

    - image：content 取 `image_key`（非空字符串），text 恒空；
    - post：先解 locale 包裹（zh_cn/en_us/ja_jp 按序取第一个 dict；事件体通常是
      扁平形态，两种都容忍，locale 包裹主要出现在「查询消息」接口回包）；
      title（strip 后非空）作第一行；content 为「段落数组的数组」，段内 text/a
      取显示文字（a 不取 href）、img 追加 image_key、其它 tag 忽略；段落文字用
      `\n` 连接、空段落不产生空行；
    - 其它类型 / JSON 非法 / 形状不对 ⇒ `("", [])`。
    """
    raw = evt.get("content")
    if isinstance(raw, str):
        try:
            content = json.loads(raw or "{}")
        except ValueError:
            return "", []
    elif isinstance(raw, dict):
        content = raw
    else:
        return "", []
    if not isinstance(content, dict):
        return "", []
    mtype = evt.get("message_type")
    if mtype == "image":
        key = content.get("image_key")
        return "", ([key] if isinstance(key, str) and key else [])
    if mtype != "post":
        return "", []
    post = content
    for loc in _MEDIA_LOCALES:
        if isinstance(content.get(loc), dict):
            post = content[loc]
            break
    lines, keys = [], []
    title = post.get("title")
    if isinstance(title, str) and title.strip():
        lines.append(title.strip())
    paragraphs = post.get("content")
    if isinstance(paragraphs, list):
        for para in paragraphs:
            if not isinstance(para, list):
                continue
            buf = []
            for blk in para:
                if not isinstance(blk, dict):
                    continue
                tag = blk.get("tag")
                if tag in ("text", "a"):
                    txt = blk.get("text")
                    if isinstance(txt, str):
                        buf.append(txt)
                elif tag == "img":
                    key = blk.get("image_key")
                    if isinstance(key, str) and key:
                        keys.append(key)
            line = "".join(buf)
            if line.strip():        # 空文字/纯图片段落不产生空行
                lines.append(line)
    return "\n".join(lines), keys


def _download_image(message_id, image_key, cfg):
    """下载消息内图片资源 → `{"data": bytes, "mime": 归一 mime}`（契约 §3.4）。

    路径 `GET /open-apis/im/v1/messages/<mid>/resources/<key>?type=image`
    （tenant token 鉴权、不带 Content-Type 头、超时 30s、不重试）。
    mime 先按 Content-Type 归一（去参数转小写 + MEDIA_MIME_EXT），未知再按魔数嗅探；
    仍未知按二进制（mime=application/octet-stream，落盘 ext=bin）。
    字节数 > MEDIA_MAX_BYTES ⇒ 抛 MediaTooLarge；REST 失败抛 FeishuRestError。
    """
    path = (f"/open-apis/im/v1/messages/{urllib.parse.quote(str(message_id), safe='')}"
            f"/resources/{urllib.parse.quote(str(image_key), safe='')}")
    data, ctype = _rest_bytes("GET", path, params={"type": "image"},
                              cfg=cfg, timeout=30)
    if len(data) > MEDIA_MAX_BYTES:
        raise MediaTooLarge(f"图片 {len(data)} 字节超过上限 {MEDIA_MAX_BYTES} 字节")
    mime = (ctype or "").split(";")[0].strip().lower()
    if mime not in MEDIA_MIME_EXT:
        mime = _sniff_image_mime(data) or "application/octet-stream"
    return {"data": data, "mime": mime}


def _media_hint_lang(sender):
    """媒体**早退档**（功能关/类型不支持/对话关）回执的语言。

    为什么单独一个函数：这三档的判定必须与旧版同序（在绑定校验之前），但它们都要回
    同一条可本地化的提示，所以需要语言。约束：
    - `TS_I18N=0` ⇒ 恒 `zh`，**连绑定行都不读**（回滚开关下与旧版零读库一致）；
    - 读绑定行/偏好失败 ⇒ `zh` 兜底，保证固定提示仍发得出去（旧版 DB 故障时也不静默）；
    - 正常路径只读一次绑定行；真正投递的档位在早退判定之后照旧再读一次（旧版位置），
      不重复计读。
    """
    if i18n.is_i18n_disabled():
        return "zh"
    try:
        binding = db.get_feishu_binding_by_open(sender)
        return user_lang(binding["user_id"]) if binding else "zh"
    except Exception:  # noqa: BLE001 —— 回执是旁路，读库失败不能吞掉提示本身
        return "zh"


def _handle_media_message(evt, cfg):
    """单聊 image/post 消息：解析 → 逐张下载（全有或全无）→ 投递绑定会话（§3.2）。

    判定顺序（与 Node 严格同序）：功能开关 → 类型 → 通用对话开关 → 绑定校验 →
    解析（post 纯文字当普通文本投递）→ 张数截断 → 逐张下载 → route_text(images=…)。
    任一张失败就一张都不投递（避免半截图文）；失败一律回执，绝不静默。

    语言（T12b）：发送者绑定用户（回执收件人）；未绑定无身份 ⇒ R22 中文兜底。
    早退档的提示语言走 `_media_hint_lang`（`TS_I18N=0` 零读库）；需要真正投递的
    档位在早退判定之后才读绑定行（与旧版同一位置，不提前读）。"""
    mid = evt.get("message_id")
    mtype = evt.get("message_type")
    sender = evt.get("sender_open_id") or ""
    if not media_enabled():
        rest_reply(mid, i18n.t("api", MEDIA_TYPE_HINT,
                               _media_hint_lang(sender)), cfg)
        return
    if mtype not in ("image", "post"):
        rest_reply(mid, i18n.t("api", MEDIA_TYPE_HINT,
                               _media_hint_lang(sender)), cfg)
        return
    if not feishu_conv.enabled():
        rest_reply(mid, i18n.t("api", MEDIA_TYPE_HINT,
                               _media_hint_lang(sender)), cfg)
        return
    binding = db.get_feishu_binding_by_open(sender)
    if binding is None:
        rest_reply(mid, UNBOUND_DM_MSG, cfg)
        return
    lang = user_lang(binding["user_id"])
    text, keys = _media_items(evt)
    print(f"feishu inbound: 媒体消息 type={mtype} images={len(keys)}",
          file=sys.stderr, flush=True)
    if not keys:
        if mtype == "post" and text:
            # post 纯文字（无图）：当普通文本走同一套路由/自动新建/排队语义
            rest_reply(mid, feishu_conv.route_text(binding, text, cfg, lang=lang), cfg)
        else:
            rest_reply(mid, i18n.t("api", MEDIA_FAIL_PREFIX, lang)
                       + i18n.t("api", MEDIA_NO_IMAGE, lang), cfg)
        return
    keys = keys[:MEDIA_MAX_COUNT]
    images = []
    for key in keys:
        try:
            images.append(_download_image(mid, key, cfg))
        except MediaTooLarge:
            rest_reply(mid, i18n.t("api", MEDIA_FAIL_PREFIX, lang)
                       + i18n.t("api", MEDIA_TOO_LARGE, lang), cfg)
            return
        except FeishuRestError as e:
            if getattr(e, "code", None) in _MEDIA_SCOPE_CODES:
                rest_reply(mid, i18n.t("api", MEDIA_SCOPE_HINT, lang), cfg)
            else:
                rest_reply(mid, i18n.t("api", MEDIA_FAIL_PREFIX, lang)
                           + str(e), cfg)
            return
        except Exception as e:      # 下载异常（非 FeishuRestError）同样要回执
            rest_reply(mid, i18n.t("api", MEDIA_FAIL_PREFIX, lang)
                       + str(e), cfg)
            return
    rest_reply(mid, feishu_conv.route_text(binding, text, cfg, images=images,
                                           lang=lang), cfg)


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
    去重 → 群聊 @ 判定（未 @ 静默）→ 非 text 分流（单聊 image/post 走
    `_handle_media_message`，群聊媒体消息静默）→ 文本抽取（剥 @占位符）→ 绑定校验
    （未绑引导）→ 意图解析 → 执行 → reply。**未识别文本**不是一律回帮助：单聊且通用
    对话开启（`feishu_conv.enabled()`）时走 `feishu_conv.route_text` 投递给绑定的会话；
    群聊与 `TS_FEISHU_CONV=0` 才回 `HELP_TEXT`。任何异常吞掉。
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
            if evt.get("chat_type") == "group":
                return          # 旧行为：群聊媒体消息静默（不转发、不回执）
            _handle_media_message(evt, cfg)
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
                rest_reply(mid, i18n.t("api", "当前账号已绑定，无需重复绑定"
                                              "（解绑后可重新绑定）",
                                       user_lang(binding["user_id"])), cfg)
                return
            err = bind_user(intent["groups"][0], sender)
            if err is None:
                # 绑定刚写成 ⇒ 现在能解析出用户语言（绑定回执按收件人语言）
                row = db.get_feishu_binding_by_open(sender)
                lang = user_lang(row["user_id"] if row else 0)
                rest_reply(mid, i18n.t("api", "绑定成功，发「帮助」查看可用指令",
                                       lang), cfg)
            else:
                rest_reply(mid, err, cfg)
            return
        if binding is None:
            rest_reply(mid, UNBOUND_DM_MSG, cfg)
            return
        # 入口解析一次、向下传：同一动作内的多条回执必须同语言
        lang = user_lang(binding["user_id"])
        # M11「接入」：发一张可点的飞书接入操作卡片（换应用/重连/绑定码/自检/补齐/发布），
        # 用**当前这条连接**的应用凭据发——卡片按钮回调会回到同一条连接
        if intent is not None and intent["action"] == "setup":
            ok, err = send_setup_card(binding["user_id"], cfg, lang)
            rest_reply(mid, i18n.t(
                "api", "🛠 已发送「飞书接入操作卡片」，请在卡片上操作。", lang)
                if ok else i18n.t("api", "卡片发送失败：{err}", lang, err=err), cfg)
            return
        if intent is None:
            if evt.get("chat_type") != "group" and feishu_conv.enabled():
                # 单聊未识别文本 → 通用对话路由（投递给当前会话；无会话按默认项目自动新建）
                reply = feishu_conv.route_text(binding, text, cfg, lang=lang)
            else:
                # 群聊保持原行为：不落会话；回复语言 = 发送者（已绑定）偏好
                reply = help_text(lang)
            rest_reply(mid, reply, cfg)
            return
        reply = execute_intent(binding, intent, sender, cfg, lang)
        if reply:
            rest_reply(mid, reply, cfg)
    except Exception as e:
        print(f"feishu inbound: 处理异常: {e!r}", file=sys.stderr, flush=True)


# ---------- DM 交互卡片点击回调（card.action.trigger，schema 2.0） ----------

def _toast_for(reply, lang="zh"):
    """执行器回执文案 → 卡片回调 toast 载荷（reply=None 表示无需回执）。

    成功前缀与执行器约定对齐（`已收下` / `✅`；英文成功回执同样以 `✅` 开头，
    见各执行器的英文译法）；完整结果走 DM 文本，toast 只做轻提示。"""
    if reply is None:
        return None
    ok = reply.startswith(("已收下", "✅"))
    return {"toast": {"type": "success" if ok else "error",
                      "content": i18n.t("api", "已收下，详情看机器人单聊" if ok
                                        else "操作失败，详情看机器人单聊", lang)}}


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
    d 拒绝 / sc 快捷指令权限卡片「我已开通，重试注册」/
    dp 项目总览卡点选设默认项目 / ss 会话列表卡点选绑定会话）→ 与文本指令共用的
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
        # M11 接入操作卡片（t=fs）：同样不带卡号，独立于看板/通用对话卡片流；
        # 身份（open_id→binding）+ nonce 双复核在 _on_setup_card_action 里
        if t == "fs":
            return _on_setup_card_action(sender, value, cfg)
        # 通用对话卡片（t=dp 项目总览 / t=ss 会话列表）同样不带卡号：在既有看板
        # 卡片白名单**之前**分流，看板回调（a/mq/p/s/d）路径一个字节都不动
        if t in ("dp", "ss"):
            binding = db.get_feishu_binding_by_open(sender)
            if binding is None:
                _dm_text(sender, i18n.t("api", _UNBOUND_DM_CARD, "zh"), cfg)
                return {"toast": {"type": "error",
                                  "content": i18n.t("api", "尚未绑定站点账号", "zh")}}
            return feishu_conv.on_card_action(sender, binding, value, action, cfg,
                                              user_lang(binding["user_id"]))
        if t not in ("a", "mq", "p", "s", "d") or not key:
            return None
        binding = db.get_feishu_binding_by_open(sender)
        if binding is None:
            # 未绑定者没有用户偏好可言 ⇒ 语言按 R22 兜底中文（不读库）
            _dm_text(sender, i18n.t("api", _UNBOUND_DM_CARD, "zh"), cfg)
            return {"toast": {"type": "error",
                              "content": i18n.t("api", "尚未绑定站点账号", "zh")}}
        # 入口解析一次、向下传：同一动作内的 DM 回执与 toast 必须同语言
        lang = user_lang(binding["user_id"])
        found, err = _find_user_card(binding["user_id"], key, lang)
        if found is None:
            _dm_text(sender, err, cfg)
            return {"toast": {"type": "error",
                              "content": i18n.t("api", "没找到对应卡片", lang)}}
        p, c = found
        if t == "mq":
            # 多选类点选：每次点击自带 toast（含进度），答满那次才发 DM 文本
            reply, toast = _answer_multi_click(p, c, value, action, lang)
            if reply:
                _dm_text(sender, reply, cfg)
            return toast
        if t == "a":
            reply = _answer_by_token(p, c, str(value.get("i") or ""), lang)
        else:
            decision = "approved" if t in ("p", "s") else "rejected"
            reply = _decide_approval(p, c, decision,
                                     "session" if t == "s" else "", lang)
        if reply:
            _dm_text(sender, reply, cfg)
        return _toast_for(reply, lang)
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


# ---------- M11：换凭据免重启 + 飞书接入操作卡片（2026-10-17） ----------
#
# 用户痛点（M10 §五.1）：换应用后必须重启站点才换长连接，而绑定码是进程内存态
# （10 分钟 TTL）⇒「先生成码再重启」的顺序必然踩「绑定码无效/已过期」。M11 把长连接
# 做成可停可换（`stop_inbound_for`/`restart_inbound_for`），并把「换应用 → 取新绑定码
# → 重连 → 去新机器人绑定」做成一张 DM 卡片的按钮，**顺序由代码保证**，不依赖用户记忆。
#
# 卡片安全：按钮 value 只带 {t=fs, a=动作, u=用户id, n=nonce}——回调按 open_id→binding
# 复核身份，再按 nonce（进程内存态、10 分钟、绑定到该用户）复核新鲜度/归属；卡片本身
# 无状态（动作全部在服务端重读配置与线程态），过期后发「接入」重新获取。
#
# 两条投递通道（都按「open_id 属于哪个应用」决定用谁的凭据发）：
#   - 用户主动发「接入」→ 用**当前连接**的凭据（cfg 参数）发卡；
#   - 换应用成功后自动发「确认切换」卡 → 必须用**旧应用**凭据（绑定行的 open_id 是旧
#     应用下的标识，新应用还不认识它；见 `maybe_send_switch_card`）。

_SETUP_NONCES = {}     # nonce -> (user_id, expires epoch)；内存态不入库
_SETUP_NONCE_TTL = 600


def _setup_nonce(user_id):
    """发接入卡片时登记一个按钮 nonce（顺带清过期项；每张卡片一个，多按钮共用）。"""
    now = time.time()
    for key in [k for k, v in list(_SETUP_NONCES.items()) if now > v[1]]:
        _SETUP_NONCES.pop(key, None)
    nonce = secrets.token_hex(8)
    _SETUP_NONCES[nonce] = (int(user_id), now + _SETUP_NONCE_TTL)
    return nonce


def setup_card(user_id, app_id, thread_app, nonce, lang="zh"):
    """「飞书接入操作卡片」（schema 2.0，DM 单聊）。**纯函数**：给定入参 ⇒ 确定 JSON
    （两侧后端逐字节对拍用；node 侧 `feishu_inbound.js::setupCard`）。

    入参：user_id=站点用户 id；app_id=配置里的应用；thread_app=入站长连接**当前绑的**
    应用（空串=连接未运行）；nonce=按钮防伪令牌。两应用不同 ⇒ 卡片切到「换用新应用」
    形态（换绑后自动发的那张：按钮会先取新绑定码，再用新应用重连）。

    语言（T12b）：`lang` 由发卡入口按收件人 `user_lang(user_id)` 解析后传入；默认
    `"zh"` 是兼容线（现有单测/对拍用例一行不改也逐字节不变）。"""
    app_id = str(app_id or "")
    thread_app = str(thread_app or "")
    switching = bool(app_id) and bool(thread_app) and app_id != thread_app
    uid = int(user_id)

    def _button(label, action, style="default"):
        return {"tag": "button", "type": style,
                "text": {"tag": "plain_text", "content": label},
                "behaviors": [{"type": "callback",
                               "value": {"t": "fs", "a": action, "u": uid, "n": nonce}}]}

    app_line = (i18n.t("api", "**当前应用**：", lang)
                + (("`" + app_id + "`") if app_id
                   else i18n.t("api", "（未配置）", lang)))
    conn_line = (i18n.t("api", "**入站长连接**：", lang)
                 + (i18n.t("api", "运行中 · 绑在 `{app}`", lang, app=thread_app)
                    if thread_app else i18n.t("api", "未运行", lang)))
    elements = [{"tag": "markdown", "content": "\n".join([app_line, conn_line])}]
    if switching:
        elements.append({"tag": "markdown", "content": i18n.t(
            "api", "检测到应用凭据已换为 `{app}`，但长连接还绑在旧应用 "
                   "`{thread}` 上。点「换用新应用」：我会先把新绑定码发到本会话，"
                   "再用新应用重连——之后在新机器人单聊里回复「绑定 <码>」即可。",
            lang, app=app_id, thread=thread_app)})
        elements.append(_button(i18n.t("api", "🔁 换用新应用", lang),
                                "switch", "primary"))
    else:
        elements.append({"tag": "markdown", "content": i18n.t(
            "api", "需要时点下面的按钮；换应用后我会自动发一张新的确认卡片。",
            lang)})
        elements.append(_button(i18n.t("api", "🔄 重连入站", lang),
                                "restart", "primary"))
    elements.append(_button(i18n.t("api", "🔑 生成绑定码", lang), "bindcode"))
    elements.append(_button(i18n.t("api", "🩺 配置自检", lang), "doctor"))
    elements.append(_button(i18n.t("api", "🧩 补齐配置", lang), "apply"))
    elements.append(_button(i18n.t("api", "🚀 提交发布", lang), "publish"))
    elements.append({"tag": "markdown", "content": i18n.t(
        "api", "卡片 10 分钟内有效；过期后发「接入」重新获取。", lang)})
    return {"schema": "2.0",
            "header": {"title": {"tag": "plain_text",
                                 "content": i18n.t(
                                     "api", "🔁 飞书应用已变更" if switching
                                     else "🛠 飞书接入操作", lang)},
                       "template": "orange" if switching else "blue"},
            "body": {"elements": elements}}


def send_setup_card(user_id, cfg=None, lang=None):
    """给该用户 DM 发「飞书接入操作卡片」。返回 (ok, err)。
    `cfg` 缺省=当前配置；**换应用自动发送时调用方必须传旧应用的 cfg**（见模块段注释）。
    `lang` 缺省按收件人偏好解析（入口已解析时显式传，避免同一动作两次读偏好）。

    语言（T12b）：失败文案按收件人语言出。zh 逐字节保持历史形态——REST 失败时内层
    仍带 `卡片发送失败：` 前缀（调用方外层再包一次，存量断言即此形态）；en 的内层只留
    诊断，前缀由调用方的英文包装统一负责（否则会出现
    `Failed to send the card: 卡片发送失败：…` 的中英拼接）。"""
    if lang is None:
        lang = user_lang(user_id)
    if cfg is None:
        cfg = app_config(user_id)
    if cfg is None:
        return False, i18n.t(
            "api", "未配置应用凭据（App ID / App Secret），先保存配置再发卡片", lang)
    binding = db.get_feishu_binding_by_user(user_id)
    if not binding:
        return False, i18n.t(
            "api", "尚未绑定飞书账号：设置页生成绑定码后在机器人单聊回复"
                   "「绑定 <码>」", lang)
    cur = app_config(user_id) or {}
    thread_app = (inbound_thread_app_id(user_id)
                  if inbound_status(user_id).get("thread") else "")
    card = setup_card(user_id, cur.get("app_id") or "", thread_app,
                      _setup_nonce(user_id), lang)
    try:
        rest_send_card(binding["open_id"], card, cfg)
        return True, ""
    except FeishuRestError as e:
        if i18n.normalize_lang(lang) == "en" and not i18n.is_i18n_disabled():
            return False, str(e)
        return False, f"卡片发送失败：{e}"


def maybe_send_switch_card(user_id, old_cfg):
    """换应用凭据后自动发「确认切换」卡片（M11）：绑定行的 open_id 属于旧应用，故必须用
    **旧凭据**发这条 DM（新凭据发不进这个单聊）。条件：① 旧连接还在跑；② 配置里的应用
    与旧连接不同；③ 有绑定行。绝不抛出（后台线程/扫码 worker 调用），失败只留一行 stderr。
    返回是否真的发出。"""
    try:
        old_app = str((old_cfg or {}).get("app_id") or "")
        new_app = str((app_config(user_id) or {}).get("app_id") or "")
        if not old_app or not new_app or old_app == new_app:
            return False
        if not inbound_status(user_id).get("thread"):
            return False
        if inbound_thread_app_id(user_id) == new_app:
            return False
        binding = db.get_feishu_binding_by_user(user_id)
        if not binding:
            return False
        card = setup_card(user_id, new_app, old_app, _setup_nonce(user_id),
                          user_lang(user_id))
        rest_send_card(binding["open_id"], card, old_cfg)
        return True
    except Exception as e:     # noqa: BLE001 - 自动卡片绝不反噬换凭据主流程
        print(f"feishu provision: 用户 {user_id} 换应用确认卡片发送失败: {e!r}",
              file=sys.stderr, flush=True)
        return False


def _setup_switch(user_id, sender, cfg, lang="zh"):
    """「换用新应用」：生成新绑定码 → 用**旧应用** DM 发出 → 停旧连接、用新凭据重连。
    顺序是设计要点：码必须先到用户手上（旧应用通道），再断旧连接（断完就发不出了）。
    返回 (toast, dm_text)；dm_text 为空表示已有独立 DM 说明（不再重复发）。"""
    cur = app_config(user_id)
    new_app = str((cur or {}).get("app_id") or "")
    old_app = str((cfg or {}).get("app_id") or "")
    if cur is None or not new_app:
        return ({"toast": {"type": "error",
                           "content": i18n.t("api", "新应用凭据不完整", lang)}},
                i18n.t("api", "❌ 应用凭据不完整：先在设置页保存新应用的 "
                              "App ID / App Secret，再点本按钮。", lang))
    if old_app == new_app:     # 同应用（只换了 secret）：直接重连，绑定关系不变
        if restart_inbound_for(user_id):
            return ({"toast": {"type": "success",
                               "content": i18n.t("api", "已重连", lang)}},
                    i18n.t("api", "🔄 已用当前应用 `{app}` 重新建立长连接，"
                                  "绑定关系不变。", lang, app=new_app))
        return ({"toast": {"type": "error",
                           "content": i18n.t("api", "重连失败，看私聊", lang)}},
                i18n.t("api", "❌ 重连失败：旧连接未在超时内退出；稍后再点一次，"
                              "仍不行请重启站点。", lang))
    code = make_bind_code(user_id)
    text = i18n.t("api", "🔁 已切换到新应用 `{app}`。\n"
                         "**新的绑定码：{code}**（10 分钟内有效）\n"
                         "本（旧）机器人的连接马上断开；请到新机器人单聊里回复：\n"
                         "绑定 {code}", lang, app=new_app, code=code)
    try:
        rest_send_text(sender, text, cfg)
    except FeishuRestError as e:
        # 码没送到就不动连接（否则用户既进不去新机器人、旧机器人也断了）
        return ({"toast": {"type": "error",
                           "content": i18n.t("api", "绑定码发送失败", lang)}},
                i18n.t("api", "❌ 绑定码没能发进本会话（{err}）；重连未执行，"
                              "可重试本按钮。", lang, err=str(e)))
    if restart_inbound_for(user_id):
        return ({"toast": {"type": "success",
                           "content": i18n.t("api", "已切换，去新机器人绑定", lang)}},
                "")
    return ({"toast": {"type": "error",
                       "content": i18n.t("api", "已换应用但重连失败，看私聊", lang)}},
            i18n.t("api", "⚠️ 新应用 `{app}` 重连失败（旧连接未退出）；"
                          "绑定码 {code} 仍有效，可稍后再点本按钮，或重启站点。",
                   lang, app=new_app, code=code))


def _setup_restart(user_id, lang="zh"):
    """「重连入站」：停旧连接、用当前库里的凭据重连（同应用换 secret 的主路径）。"""
    cur = app_config(user_id)
    if cur is None:
        return ({"toast": {"type": "error",
                           "content": i18n.t("api", "应用凭据未配置", lang)}},
                i18n.t("api", "❌ 应用凭据未配置（App ID / App Secret）："
                              "先在设置页保存，再点本按钮。", lang))
    app_id = str(cur.get("app_id") or "")
    if restart_inbound_for(user_id):
        return ({"toast": {"type": "success",
                           "content": i18n.t("api", "已重连", lang)}},
                i18n.t("api", "🔄 已用当前应用 `{app}` 重新建立长连接。",
                       lang, app=app_id))
    return ({"toast": {"type": "error",
                       "content": i18n.t("api", "重连失败，看私聊", lang)}},
            i18n.t("api", "❌ 重连失败：旧连接未在超时内退出，稍后再点一次；"
                          "仍不行请重启站点。", lang))


def _setup_bindcode(user_id, lang="zh"):
    """「生成绑定码」：发一个新码（10 分钟、内存态；旧码不失效，码均可用一次）。"""
    code = make_bind_code(user_id)
    return ({"toast": {"type": "success",
                       "content": i18n.t("api", "绑定码已私聊发你", lang)}},
            i18n.t("api", "🔑 新的绑定码：{code}（10 分钟内有效）\n"
                          "· 未绑定：在本机器人单聊回复「绑定 <码>」\n"
                          "· 已绑定换号：先发「解绑」，再发「绑定 <码>」",
                   lang, code=code))


def _setup_slow_action(user_id, sender, action, cfg, lang="zh"):
    """慢动作（自检/补齐配置/提交发布）后台执行，结果 DM 回执。绝不外抛。
    走后台线程的理由：卡片回调要尽快返回 ACK，这几项是多次 REST（2~5s）。

    语言（T12b + KB-27）：`lang` = DM 收件人（绑定用户）语言；除了消息框与回执句，
    **数据面**（doctor 八项 label/detail/hint、apply/publish 的 error/步骤）也跟随它
    ——`doctor(data_lang=lang)`、`provision_apply(lang=lang)`、
    `provision_publish(lang=lang)`。`send_probe=False`（默认）不真发探测 DM，故 doctor
    的 `lang`（探针收件人语言）无需传。
    `provision_publish` 的 remark/changelog 是发给飞书的版本说明，保持中文（KB-38）。"""
    try:
        if action == "doctor":
            out = doctor(user_id, data_lang=lang)
            summary = out.get("summary") or {}
            bad = [it for it in (out.get("items") or [])
                   if it.get("state") in ("fail", "warn")]
            lines = [i18n.t(
                "api", "🩺 配置自检：ok {ok} / fail {fail} / warn {warn} / "
                       "skip {skip}", lang,
                ok=summary.get("ok", 0), fail=summary.get("fail", 0),
                warn=summary.get("warn", 0), skip=summary.get("skip", 0))]
            for it in bad:
                lines.append(
                    i18n.t("api", "· {label}：{detail}", lang,
                           label=str(it.get("label")),
                           detail=str(it.get("detail")))
                    + (i18n.t("api", "（{hint}）", lang, hint=it.get("hint"))
                       if it.get("hint") else ""))
            text = "\n".join(lines)
        elif action == "apply":
            out = provision_apply(user_id, lang=lang)
            text = (i18n.t("api", "🧩 配置补齐成功：机器人能力 / 权限 / 长连接订阅 / "
                                  "事件 / 回调已写入（需发布新版本生效）。", lang)
                    if out.get("ok")
                    else i18n.t("api", "❌ 配置补齐失败：{err}", lang,
                                err=out.get("error")
                                or i18n.t("api", "未知错误", lang)))
        else:
            out = provision_publish(user_id, lang=lang)
            text = (i18n.t("api", "🚀 已提交发布版本 {version}；"
                                  "仍需租户管理员审批后线上生效。", lang,
                           version=out.get("version") or "")
                    if out.get("ok")
                    else i18n.t("api", "❌ 提交发布失败：{err}", lang,
                                err=out.get("error")
                                or i18n.t("api", "未知错误", lang)))
        _dm_text(sender, text, cfg)
    except Exception as e:     # noqa: BLE001 - 后台线程兜底，绝不外抛
        print(f"feishu inbound: 接入卡片后台动作异常: {e!r}", file=sys.stderr, flush=True)


def _on_setup_card_action(sender, value, cfg):
    """「飞书接入操作卡片」按钮回调（M11）：open_id→binding + nonce 双重复核 → 动作分发。
    返回 toast dict（None=不更新卡片）。`cfg` = 点击到达那条连接的应用凭据——旧应用发的
    卡片必须用旧应用凭据回 DM，否则发不进当前单聊。

    语言（T12b）：入口按点击者（= 卡片所属用户）解析一次并向下传，DM 与 toast 同语言；
    未绑定者没有用户偏好可言 ⇒ R22 中文兜底（不读偏好）。"""
    binding = db.get_feishu_binding_by_open(sender)
    if binding is None:
        _dm_text(sender, i18n.t("api", "尚未绑定 Touchstone 账号：登录站点 → 侧栏「设置」→ "
                                       "飞书设置，生成绑定码后在单聊回复「绑定 <码>」完成绑定",
                                "zh"), cfg)
        return {"toast": {"type": "error",
                          "content": i18n.t("api", "尚未绑定站点账号", "zh")}}
    user_id = int(binding["user_id"])
    lang = user_lang(user_id)
    uid = int(value.get("u") or 0)
    if uid and uid != user_id:
        return {"toast": {"type": "error",
                          "content": i18n.t("api", "该卡片不属于当前账号", lang)}}
    nonce = str(value.get("n") or "")
    item = _SETUP_NONCES.get(nonce)
    if item is None or item[0] != user_id:
        return {"toast": {"type": "error",
                          "content": i18n.t("api", "卡片已失效，发「接入」重新获取",
                                            lang)}}
    if time.time() > item[1]:
        _SETUP_NONCES.pop(nonce, None)
        return {"toast": {"type": "error",
                          "content": i18n.t("api", "卡片已过期，发「接入」重新获取",
                                            lang)}}
    action = str(value.get("a") or "")
    try:
        if action == "switch":
            toast, text = _setup_switch(user_id, sender, cfg, lang)
        elif action == "restart":
            toast, text = _setup_restart(user_id, lang)
        elif action == "bindcode":
            toast, text = _setup_bindcode(user_id, lang)
        elif action in ("doctor", "apply", "publish"):
            # 慢动作：后台线程执行 + 立即 toast（避免卡片回调 ACK 超时）
            threading.Thread(target=_setup_slow_action,
                             args=(user_id, sender, action, cfg, lang), daemon=True,
                             name=f"feishu-setup-{action}-{user_id}").start()
            return {"toast": {"type": "success",
                              "content": i18n.t("api", "已收到，结果稍后私聊发你",
                                                lang)}}
        else:
            return None
    except Exception as e:     # noqa: BLE001 - 卡片回调绝不外抛
        print(f"feishu inbound: 接入卡片动作异常: {e!r}", file=sys.stderr, flush=True)
        return {"toast": {"type": "error",
                          "content": i18n.t("api", "操作失败，详情看站点日志", lang)}}
    if text:
        _dm_text(sender, text, cfg)
    return toast


# 规则意图表（M3：未命中且 nl_parse=agent 时走 agent headless 兜底解析）
# 每条规则的「中文写法 | 斜杠别名」两分支共用同一组捕获组（组数必须一致，执行器按
# groups 取值）：斜杠别名对应 SLASH_COMMANDS 注册的指令名，用户从飞书指令面板选中后
# 投递过来的文本就是「/名称 [参数]」，与中文指令落到同一个 action。
_INTENT_RULES = (
    ("help",            r"^(?:帮助|help|/help)$"),
    ("setup",           r"^(?:接入)$"),
    ("bind",            r"^(?:绑定|/bind)\s*([A-Za-z0-9]{4,8})$"),
    ("unbind",          r"^(?:解绑|/unbind)$"),
    ("default_project", r"^(?:默认项目|/project)\s+(\S+)$"),
    ("current",         r"^(?:当前|/current)$"),
    ("projects",        r"^(?:项目|/projects)$"),
    ("sessions",        r"^(?:会话|/sessions)$"),
    ("new",             r"^(?:新建会话|/new)(?:\s+(.+))?$"),
    ("use",             r"^(?:绑定会话|/use)\s+(.+)$"),
    ("leave",           r"^(?:解绑会话|/leave)$"),
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
    """校验绑定码并绑定（open_id 侧发起）。返回 None=成功，str=错误文案。

    语言（R22）：**无效码**没有身份可依 ⇒ 中文兜底；**过期码**知道码所属 user_id
    ⇒ 用该用户的偏好（用户可能在站点切过英文，重绑时不该突然回中文）。"""
    item = _BIND_CODES.pop((code or "").strip().upper(), None)
    if item is None:
        return i18n.t("api", "绑定码无效或已被使用", "zh")
    user_id, expires = item
    lang = user_lang(user_id)
    if time.time() > expires:
        return i18n.t("api", "绑定码已过期，请到站点重新生成", lang)
    db.set_feishu_binding(open_id, user_id)
    return None


def execute_intent(binding, intent, sender_open_id, cfg=None, lang="zh"):
    """绑定用户身份执行意图；返回回复文案（空串=不回复）。项目/卡片访问一律先过
    归属（list_projects(user_id) 限用户项目），异常统一转友好文案。
    cfg = 本次消息所属应用的凭据（转交通用对话层做卡片/回执）。"""
    action, g = intent["action"], intent["groups"]
    try:
        if action == "help":
            return help_text(lang)
        if action == "bind":
            return i18n.t("api", "当前账号已绑定，无需重复绑定", lang)
        if action == "unbind":
            db.del_feishu_binding_by_open(sender_open_id)
            return i18n.t("api", "已解绑。重新绑定请到站点生成新的绑定码", lang)
        if action == "default_project":
            return _set_default_project(binding, g[0] or "", lang=lang)
        if action in ("current", "projects", "sessions", "new", "use", "leave"):
            return feishu_conv.conv_intent(binding, action, g, sender_open_id, cfg,
                                          lang)
        return _execute_board_action(binding, intent, sender_open_id, lang)
    except FeishuRestError:
        return i18n.t("api", "飞书接口调用失败，请稍后重试", lang)
    except Exception:
        return i18n.t("api", "指令执行失败，请稍后重试", lang)


def _set_default_project(binding, name, project_id=0, lang=None):
    """设置单聊默认项目：`project_id` 非 0 时**按 id** 设（卡片点选 `t=dp` 路径），
    否则按名匹配（精确名 → 唯一包含匹配）。两条路径共用
    `feishu_conv.set_default_project`，换项目时自动清当前会话（设计 §3.2）。

    `lang` 缺省（None）时按绑定用户偏好解析——与 Node 入口 `langOfBinding` 同口径：
    显式 `lang` 优先（文本指令入口已解析一次向下传），直调（单测/未来的卡片路径）也不会
    静默回落中文。"""
    if lang is None:
        lang = user_lang(binding["user_id"])
    if project_id:
        project = feishu_conv._project_by_id(binding, project_id)
        if project is None:
            return i18n.t("api", "项目不在你的项目列表", lang)
        return feishu_conv.set_default_project(binding, project, lang)
    user_id = binding["user_id"]
    projects = db.list_projects(user_id)
    for p in projects:
        if p["name"] == name:
            return feishu_conv.set_default_project(binding, p, lang)
    hits = [p for p in projects if name in p["name"]]
    if len(hits) == 1:
        return feishu_conv.set_default_project(binding, hits[0], lang)
    return i18n.t("api", "项目「{name}」不在你的项目列表", lang, name=name)


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


def _answer_multi_click(p, c, value, action, lang="zh"):
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
        return (i18n.t("api", "卡片 #{cid} 当前没有等待中的提问", lang, cid=c["id"]),
                _toast("error", i18n.t("api", "提问已结束", lang)))
    if st.get("kind") != "question":
        return (i18n.t("api", "卡片 #{cid} 当前等待的不是提问，"
                              "请回复「同意 {cid}」或「拒绝 {cid}」",
                      lang, cid=c["id"]),
                _toast("error", i18n.t("api", "该等待是审批", lang)))
    if not st.get("answerable"):
        return (i18n.t("api", _NO_REMOTE_ANSWER_HINT, lang),
                _toast("error", i18n.t("api", "请到 dsh 会话窗口作答", lang)))
    qs = [q for q in (st.get("questions") or []) if q]
    n = len(qs)
    if n < 1:
        return (i18n.t("api", "卡片 #{cid} 当前没有等待中的提问", lang, cid=c["id"]),
                _toast("error", i18n.t("api", "提问已结束", lang)))
    if n == 1 and not (qs[0] or {}).get("multi_select"):
        return (i18n.t("api", "该提问是单选题，请用卡片上的选项按钮，或回复"
                              "「作答 {cid} <选项序号>」", lang, cid=c["id"]),
                _toast("error", i18n.t("api", "单题单选请用按钮", lang)))
    try:
        no = int(value.get("n"))
    except (TypeError, ValueError):
        no = 0
    if no < 1 or no > n:
        return (i18n.t("api", "题号无效（卡片可能已过期），请重新作答", lang),
                _toast("error", i18n.t("api", "题号无效", lang)))
    q = qs[no - 1] or {}
    opts = q.get("options") or []
    if not opts:
        return (i18n.t("api", "第 {no} 题没有选项，请回复「作答 {cid} {no}:<文字>」",
                       lang, no=no, cid=c["id"]),
                _toast("error", i18n.t("api", "该题请写文字", lang)))
    idxs = _multi_click_index(action, bool(q.get("multi_select")),
                              f"mq{c['id']}_{no}")
    if idxs is None:
        return (i18n.t("api", "没收到你选的选项，请改用「作答 {cid} {no}:<选项序号>」",
                       lang, cid=c["id"], no=no),
                _toast("error", i18n.t("api", "未收到选项，请看单聊", lang)))
    if any(i < 1 or i > len(opts) for i in idxs):
        return (i18n.t("api", "第 {no} 题选项序号无效（共 {count} 个选项）", lang,
                       no=no, count=len(opts)),
                _toast("error", i18n.t("api", "选项无效", lang)))
    if len(idxs) > 1 and not q.get("multi_select"):
        return (i18n.t("api", "第 {no} 题为单选，请只选一项", lang, no=no),
                _toast("error", i18n.t("api", "单选只能选一项", lang)))
    val = ",".join(str(i) for i in sorted(set(idxs)))   # 与文本指令同一形态
    done, total, ready = _mq_put(c["id"], st.get("qid"), n, no, val)
    if not ready:
        return ("", _toast("success",
                           i18n.t("api", "已记下第 {no} 题（{done}/{total}）", lang,
                                  no=no, done=done, total=total)))
    parts = _mq_take(c["id"], st.get("qid"), n)
    if len(parts) < n:
        # 极端竞态（取走前被 TTL 清掉/并发取走）：不提交半份，让用户重选
        return (i18n.t("api", "作答未提交（暂存已过期），请重新逐题选择", lang),
                _toast("error", i18n.t("api", "暂存过期，请重选", lang)))
    answers, err = _multi_answers(qs, parts, lang)
    if err:
        return (i18n.t("api", "作答未提交：{err}", lang, err=str(err)),
                _toast("error", i18n.t("api", "作答未提交", lang)))
    err = board.answer_interaction(p, c, st.get("qid"), answers)
    if err:
        return (i18n.t("api", "作答失败：{err}", lang, err=str(err)),
                _toast("error", i18n.t("api", "作答失败", lang)))
    return (i18n.t("api", "已收下：卡片 #{cid} {n} 道作答，排队送达中", lang,
                   cid=c["id"], n=len(answers)),
            _toast("success", i18n.t("api", "{n} 题已答完，已送达", lang,
                                     n=len(answers))))


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


def _multi_answer_help(cid, qs, lang="zh"):
    """多子题作答语法回执（缺题/格式不符时给用户看）。
    两条路都可：卡片上逐题点选（点满自动送达），或一条指令按题号一次给全；
    两者**可混用**——已点选的题不必在群里重复给（见 `_answer_by_token`）。"""
    marks = " ".join(i18n.t("api", "{no}:<选项序号>", lang, no=i)
                     for i in range(1, len(qs) + 1))
    return i18n.t("api",
                  "该提问含 {n} 道子题：可在卡片上逐题点选（点满自动送达），"
                  "或回复「作答 {cid} {marks}」一次答全；"
                  "多选写「1:2,3」，自定义写「1:文字」",
                  lang, n=len(qs), cid=str(cid), marks=marks)


def _multi_answers(qs, parts, lang="zh"):
    """多题逐题值 → board.answer_interaction 的 answers 载荷。

    返回 `(answers, err)`：err 非空即 answers=None（**不提交**）。kind 规则对齐
    站点会话窗（SessionView.answerOf）：单选=single、多选=multi、自定义=other；
    序号按**当前**服务端白名单换回 option id，防过期卡片/提问已变。缺题直接回执
    所缺题号，不落地半份答案。文本指令与卡片点选暂存两路的题值都走这里。"""
    n = len(qs)
    seen = {}
    for no, val in parts:
        if no < 1 or no > n:
            return None, i18n.t("api", "题号 {no} 无效（本提问共 {n} 题）", lang,
                                no=no, n=n)
        if no in seen:
            return None, i18n.t("api", "第 {no} 题重复作答", lang, no=no)
        seen[no] = str(val or "").strip()
    missing = [i for i in range(1, n + 1) if i not in seen]
    if missing:
        unnamed = i18n.t("api", "未命名", lang)
        heads = i18n.t("api", "、", lang).join(
            i18n.t("api", "第 {no} 题（{name}）", lang,
                   no=i, name=(qs[i - 1] or {}).get("header") or unnamed)
            for i in missing)
        return None, i18n.t("api", "还差 {heads} 未作答，请一次答全 {n} 题", lang,
                            heads=heads, n=n)
    out = []
    for i, q in enumerate(qs, 1):
        q = q or {}
        val = seen[i]
        wire = str(q.get("id") or f"q_{i - 1}")
        opts = q.get("options") or []
        multi = bool(q.get("multi_select"))
        if re.fullmatch(r"\d+(?:\s*,\s*\d+)*", val):    # 序号形态（单个/逗号多选）
            if not opts:
                return None, i18n.t("api", "第 {no} 题没有选项，请直接写回答文字", lang,
                                    no=i)
            idxs = [int(x) for x in re.split(r"\s*,\s*", val)]
            if any(x < 1 or x > len(opts) for x in idxs):
                return None, (i18n.t("api", "第 {no} 题选项序号无效（共 {count} 个选项）",
                                     lang, no=i, count=len(opts))
                              if len(opts) > 1
                              else i18n.t("api", "第 {no} 题只有一个选项，序号填 1",
                                          lang, no=i))
            if len(idxs) > 1 and not multi:
                return None, i18n.t("api", "第 {no} 题为单选，请只给一个序号", lang,
                                    no=i)
            ids = [str((opts[x - 1] or {}).get("id") or "") for x in idxs]
            if len(ids) > 1:
                out.append({"wire": wire, "kind": "multi", "option_ids": ids})
            else:
                out.append({"wire": wire, "kind": "single", "option_id": ids[0]})
            continue
        if not val:
            return None, i18n.t("api", "第 {no} 题未作答", lang, no=i)
        if len(val) > 2000:
            return None, i18n.t("api", "第 {no} 题自定义输入过长（限 2000 字）", lang,
                                no=i)
        if not q.get("allow_other", True):
            return None, i18n.t("api", "第 {no} 题不支持自定义输入，请给选项序号",
                                lang, no=i)
        out.append({"wire": wire, "kind": "other", "text": val})
    return out, ""


def _answer_by_token(p, c, token, lang="zh"):
    """作答单题提问（文本指令「作答 卡号 …」与 DM 卡片选项按钮共用）：
    token = 选项序号 / 逗号分隔多序号（multi 形态）/ 自由文本（other 形态）。
    校验一律对 interaction_of_sid 缓存里的服务端值取白名单；返回回执文案。"""
    import board
    st = board.interaction_of_sid(c["session_id"] or "")
    if not st or not st.get("pending"):
        return i18n.t("api", "卡片 #{cid} 当前没有等待中的提问", lang, cid=c["id"])
    if st.get("kind") == "approval":
        # 审批等待收到「作答」：引导用同意/拒绝指令（answer_interaction 只收提问）
        return i18n.t("api", "该等待是工具审批，请回复「同意 {cid}」或「拒绝 {cid}」",
                      lang, cid=c["id"])
    if not st.get("answerable"):
        return i18n.t("api", _NO_REMOTE_ANSWER_HINT, lang)
    # 作答须一次给全全部子题（answers 逐题 record，漏项即未答）：多子题走
    # 「题号:值」逐题形态（2026-10-06 第二档），并与卡片点选暂存**合并**
    # （2026-10-07 第三档）——文本只需给没点过的题，缺题仍不提交
    qs = st.get("questions") or []
    if len(qs) > 1:
        parts = _multi_answer_parts(token)
        staged = _mq_peek(c["id"], st.get("qid"))
        if parts is None:
            if not staged:
                return _multi_answer_help(c["id"], qs, lang)
            parts = sorted(staged.items())
        else:
            nos = [no for no, _ in parts]
            dup = next((x for x in nos if nos.count(x) > 1), None)
            if dup is not None:
                return i18n.t("api", "第 {no} 题重复作答", lang, no=dup)
            merged = dict(staged)
            merged.update({no: val for no, val in parts})
            parts = sorted(merged.items())
        answers, err = _multi_answers(qs, parts, lang)
        if err:
            return err
        err = board.answer_interaction(p, c, st.get("qid"), answers)
        _mq_drop(c["id"], st.get("qid"))     # 提交后被消费（成功与否都清，防陈旧）
        if err:
            return i18n.t("api", "作答失败：{err}", lang, err=str(err))
        return i18n.t("api", "已收下：卡片 #{cid} {n} 道作答，排队送达中", lang,
                      cid=c["id"], n=len(answers))
    if _multi_answer_parts(token) is not None:
        # 单题提问收到「1:2」这类逐题语法：明确纠正，别把它当自由文本提交
        return i18n.t("api", "该提问只有一道题，请回复「作答 {cid} <选项序号>」"
                              "或「作答 {cid} <文字>」", lang, cid=c["id"])
    q0 = qs[0] if qs else {}
    opts = q0.get("options") or st.get("options") or []
    wire = q0.get("id") or "q_0"
    opt_list = " / ".join(f"{i + 1}){(o or {}).get('label', '')}"
                          for i, o in enumerate(opts))
    if re.fullmatch(r"\d+(?:\s*,\s*\d+)*", token):
        # 序号形态：单序号→single（选项按 1 起序）；逗号多序号→multi（须允许多选）
        idxs = [int(x) for x in re.split(r"\s*,\s*", token)]
        if any(i < 1 or i > len(opts) for i in idxs):
            return (i18n.t("api", "选项序号无效，可回复：{options}", lang,
                           options=opt_list) if opts
                    else i18n.t("api", "该提问没有可选选项", lang))
        if len(idxs) == 1:
            opt = opts[idxs[0] - 1]
            err = board.answer_interaction(p, c, st.get("qid"),
                                           [{"wire": wire, "kind": "single",
                                             "option_id": (opt or {}).get("id")}])
            if err:
                return i18n.t("api", "作答失败：{err}", lang, err=str(err))
            return i18n.t("api", "已收下：卡片 #{cid} 选择「{label}」，排队送达中",
                          lang, cid=c["id"], label=(opt or {}).get("label", ""))
        if not q0.get("multi_select"):
            return i18n.t("api", "该问题不支持多选，请回复单个选项序号", lang)
        chosen = [opts[i - 1] for i in idxs]
        err = board.answer_interaction(p, c, st.get("qid"),
                                       [{"wire": wire, "kind": "multi",
                                         "option_ids": [(o or {}).get("id")
                                                        for o in chosen]}])
        if err:
            return i18n.t("api", "作答失败：{err}", lang, err=str(err))
        labels = i18n.t("api", "、", lang).join(
            (o or {}).get("label", "") for o in chosen)
        return i18n.t("api", "已收下：卡片 #{cid} 多选「{labels}」，排队送达中", lang,
                      cid=c["id"], labels=labels)
    # 文本形态：自定义输入（须题目 allow_other；无选项提问同样按文本处理）
    if not q0.get("allow_other"):
        if opts:
            return i18n.t("api", "该问题不支持自定义输入，可回复选项序号：{options}",
                          lang, options=opt_list)
        return i18n.t("api", "该提问无选项且不支持自定义输入，请到站点会话窗口处理", lang)
    if len(token) > 2000:
        return i18n.t("api", "输入内容过长（限 2000 字）", lang)
    err = board.answer_interaction(p, c, st.get("qid"),
                                   [{"wire": wire, "kind": "other",
                                     "text": token}])
    if err:
        return i18n.t("api", "作答失败：{err}", lang, err=str(err))
    return i18n.t("api", "已收下：卡片 #{cid} 自定义回答，排队送达中", lang,
                  cid=c["id"])


def _decide_approval(p, c, decision, scope, lang="zh"):
    """审批决定（文本指令「同意/拒绝 卡片」与 DM 卡片按钮共用）：decision ∈
    approved/rejected，scope="session" 本会话内自动放行；经 board.answer_approval
    入统一队列、补位启动时送达（其余校验由 board 白名单把关）。返回回执文案。"""
    import board
    st = board.interaction_of_sid(c["session_id"] or "")
    if not st or not st.get("pending") or st.get("kind") != "approval":
        return i18n.t("api", "卡片 #{cid} 当前没有等待中的审批"
                              "（提问类请回复「作答 {cid} <选项序号|文字>」）",
                      lang, cid=c["id"])
    aid = str(st.get("approval_id") or "")
    if not aid:
        return i18n.t("api", "审批不存在或已过期，请到站点会话窗口处理", lang)
    err = board.answer_approval(p, c, aid, decision, scope)
    if err:
        return i18n.t("api", "审批失败：{err}", lang, err=str(err))
    verb = i18n.t("api", "已批准" if decision == "approved" else "已拒绝", lang)
    tail = (i18n.t("api", "（本会话内同类调用自动放行）", lang)
            if scope == "session" else "")
    return i18n.t("api", "✅ 卡片 #{cid} 审批{verb}{tail}，排队送达中", lang,
                  cid=c["id"], verb=verb, tail=tail)


def _execute_board_action(binding, intent, sender_open_id, lang="zh"):
    """看板/任务类动作：状态/找卡/通过/驳回/作答/同意/拒绝。
    函数级 import board（board 模块级 import feishu，防循环；runner._process_card
    同款处理）。所有动作限定在绑定用户自己的项目内；作答/审批核心在
    _answer_by_token / _decide_approval（与卡片回调共用，防两路逻辑漂移）。

    语言（T12b）：`lang` 由文本指令入口按绑定用户解析一次并向下传，同一条回执的
    数据（项目名/卡标题/列 key/错误详情）不译；`_COL_LABELS`/`_TASK_STATUS` 的键
    （todo/blocked…）不动，只翻译展示值。"""
    import board
    action, g = intent["action"], intent["groups"]
    user_id = binding["user_id"]
    if action == "status":
        p, err = _resolve_project(binding, g[0], lang)
        if p is None:
            return err
        return _board_summary(p, lang)
    key = (g[0] if g else "").strip()
    found, err = _find_user_card(user_id, key, lang)
    if found is None:
        return err
    p, c = found
    if action == "card":
        return _card_detail(p, c, lang)
    if action == "approve":
        if c["column_key"] != "review":
            return i18n.t("api", "卡片 #{cid} 不在「待审核」列"
                                  "（当前 {column}），无法通过", lang,
                          cid=c["id"], column=c["column_key"])
        _, err = board.move_card(p, c["id"], "done")
        if err:
            if "merge_pending" in err:
                # 独立 worktree 卡的待合并闸（2026-10-07 批次）：飞书侧没有弹框，
                # 不替用户选「交给 agent 合并 / 仅通过」，引导去网页看板操作
                mp = err.get("merge_pending") or {}
                return i18n.t(
                    "api", "卡片 #{cid} 还有 {ahead} 个提交没回流主分支"
                           "（{branch} → {target}）；请在网页看板上点「通过」，"
                           "选择「交给 agent 合并」或「仅通过（不合并）」", lang,
                    cid=c["id"], ahead=mp.get("ahead", 0),
                    branch=mp.get("branch", ""), target=mp.get("target", ""))
            return i18n.t("api", "审核失败：{error}", lang,
                          error=str(err.get("error") or err.get("blocked")
                                    or i18n.t("api", "门禁拦截", lang)))
        return i18n.t("api", "✅ 卡片 #{cid} {title} 已审核通过", lang,
                      cid=c["id"], title=(c["title"] or "")[:30])
    if action == "reject":
        if c["column_key"] != "review":
            return i18n.t("api", "卡片 #{cid} 不在「待审核」列"
                                  "（当前 {column}），无法驳回", lang,
                          cid=c["id"], column=c["column_key"])
        try:
            # T13：卡片语言首轮冻结＝本入口已解析的**收件人**语言（R22 语言源），
            # 不是命令文案/展示值；打回起跑同样走 start_card 的统一冻结点。
            board.start_card(p, c, extra=g[1] or "", lang=lang)
        except RuntimeError as e:
            return i18n.t("api", "打回失败：{error}", lang, error=str(e))
        return i18n.t("api", "↩️ 卡片 #{cid} 已打回继续开发，"
                              "打回意见将注入 agent", lang, cid=c["id"])
    if action == "answer":
        return _answer_by_token(p, c, (g[1] or "").strip(), lang)
    if action in ("agree", "deny"):
        decision = "approved" if action == "agree" else "rejected"
        scope = ("session" if (action == "agree"
                               and (g[1] if len(g) > 1 else "") == "会话") else "")
        return _decide_approval(p, c, decision, scope, lang)
    return help_text(lang)


def _resolve_project(binding, name, lang="zh"):
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
        return None, i18n.t("api", "项目「{name}」不在你的项目列表", lang,
                            name=name)
    if binding["default_project_id"]:
        for p in projects:
            if p["id"] == binding["default_project_id"]:
                return p, ""
    if len(projects) == 1:
        return projects[0], ""
    if not projects:
        return None, i18n.t("api", "你还没有项目，请先到站点创建", lang)
    return None, (i18n.t("api", "请指明项目（回复「状态 项目名」），可选：", lang)
                  + i18n.t("api", "、", lang).join(
                      p["name"] for p in projects[:8]))


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


def _find_user_card(user_id, key, lang="zh"):
    """找卡并消歧（文本指令与 DM 卡片按钮回调共用）：纯数字按 id 前缀、否则标题
    包含，仅限用户自己的项目（多用户隔离）。返回 (project, card) 或 (None, 错误文案)。"""
    hits = _find_cards(user_id, key)
    if not hits:
        return None, i18n.t(
            "api", "没有找到匹配「{key}」的卡片（仅搜你自己的项目；"
                   "支持 id 前缀/标题包含）", lang, key=key)
    if len(hits) > 1:
        lines = [i18n.t("api", "匹配到多张卡，请用更精确的 id 或关键字：", lang)]
        for p, c in hits[:6]:
            lines.append(f"· #{c['id']} [{p['name']}] {(c['title'] or '')[:30]}")
        return None, "\n".join(lines)
    return hits[0], ""


def _card_detail(p, c, lang="zh"):
    """卡片详情文案：列位/阻塞原因/最近错误/会话。"""
    lines = [i18n.t("api", "卡片 #{cid} [{project}] {title}", lang,
                    cid=c["id"], project=p["name"],
                    title=(c["title"] or "")[:40]),
             i18n.t("api", "状态：{status}", lang,
                    status=_col_label(c["column_key"], lang))]
    if c["column_key"] == "blocked":
        lines.append(i18n.t(
            "api", "阻塞原因：{reason}", lang,
            reason=c.get("block_text") or c.get("block_kind")
            or i18n.t("api", "未知", lang)))
    if c.get("last_error"):
        lines.append(i18n.t("api", "最近错误：{error}", lang,
                            error=c["last_error"][:120]))
    lines.append(i18n.t(
        "api", "回复「作答 {cid} <选项序号|文字>」回复提问；"
               "「同意 {cid}」/「拒绝 {cid}」处理审批；"
               "「通过 {cid}」完成审核；「驳回 {cid} 意见」打回",
        lang, cid=c["id"]))
    return "\n".join(lines)


def _board_summary(p, lang="zh"):
    """项目摘要：任务队列计数与最近任务 + 看板五列计数 + 阻塞卡列表。"""
    tasks = db.list_tasks(p["id"]) or []
    n_run = sum(1 for t in tasks if t["status"] == "running")
    n_que = sum(1 for t in tasks if t["status"] == "queued")
    lines = [i18n.t("api", "[{name}] 任务：运行中 {running} / 排队 {queued}"
                           "（共 {total}）", lang,
                    name=p["name"], running=n_run, queued=n_que,
                    total=len(tasks))]
    for t in tasks:
        if t["status"] in ("running", "queued"):
            lines.append(i18n.t("api", "· #{tid} {name}（{status}）", lang,
                                tid=t["id"], name=t["name"][:30],
                                status=_task_status(t["status"], lang)))
    cards = [dict(c) for c in db.list_board_cards(p["id"])]
    by_col = {}
    for c in cards:
        by_col[c["column_key"]] = by_col.get(c["column_key"], 0) + 1
    lines.append(i18n.t("api", "看板：", lang) + " ".join(
        i18n.t("api", "{label}{count}", lang,
               label=_col_label(k, lang), count=by_col.get(k, 0))
        for k in _COL_ORDER))
    blocked = [c for c in cards if c["column_key"] == "blocked"]
    for c in blocked[:5]:
        lines.append(i18n.t(
            "api", "⛔ #{cid} {title}（{reason}）", lang,
            cid=c["id"], title=(c["title"] or "")[:30],
            reason=c.get("block_text") or c.get("block_kind") or ""))
    return "\n".join(lines)


_COL_ORDER = ("todo", "doing", "blocked", "review", "done")
_COL_LABELS = {"todo": "待开发", "doing": "正在开发", "blocked": "阻塞",
               "review": "待审核", "done": "已完成"}
_TASK_STATUS = {"queued": "排队", "running": "运行中", "done": "已完成",
                "failed": "失败", "stopped": "已停止", "interrupted": "中断"}


def _col_label(key, lang="zh"):
    """看板列展示值（键 = 协议 token `todo/doing/…`，不译；未知键原样返回）。"""
    label = _COL_LABELS.get(key)
    return key if label is None else i18n.t("api", label, lang)


def _task_status(key, lang="zh"):
    """任务状态展示值（键 = DB 状态 token；未知键原样返回）。"""
    label = _TASK_STATUS.get(key)
    return key if label is None else i18n.t("api", label, lang)


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
    """幂等启动投递线程（server main 启动时调用一次；未配置时空转无害）。

    同时注册通用对话的消息终态钩子（feishu_conv.start，幂等）：答复回流靠它把
    「跑完的会话消息」推回飞书 DM——这是本模块唯一的接线点（server.main 已调用
    本函数），漏掉则回流全哑且无任何报错。
    """
    global _SENDER_STARTED
    if _SENDER_STARTED:
        return
    _SENDER_STARTED = True
    feishu_conv.start()                     # 幂等：注册 chat 的消息终态钩子
    threading.Thread(target=_send_loop, daemon=True,
                     name="feishu-notifier").start()


# ---------- CLI（自测通道） ----------

# ---------- M5 配置自动化：凭据快检 / 应用配置补齐 ----------

def verify_credentials(user_id, lang=None):
    """凭据快检（保存凭据后的即时反馈）：token 可取 → 机器人信息可读，两步。

    返回 {"ok": bool, "detail": str}，**绝不抛出**；无凭据时零请求。
    今天保存凭据只写库不校验，错了只能翻日志——本函数是那个缺口的补口。
    语言（T12d）：``lang`` 为**请求语言**（None/zh ⇒ 存量中文逐字节不变）；
    飞书上游错误原文（`str(e)`）与机器人名是动态/诊断值，按现状透传。"""
    def _t(key, **vars):
        return i18n.t("api", key, lang, **vars)

    cfg = app_config(user_id)
    if cfg is None:
        return {"ok": False,
                "detail": _t("应用凭据未配置（App ID / App Secret）")}
    try:
        _tenant_token(cfg)   # 第一步：凭据正确性（失败码 10003/10014 等）
        out = _rest("GET", "/open-apis/bot/v3/info", cfg=cfg)
        # /bot/v3/info 的 bot 在响应**顶层**（无 data 包裹，同 bot_open_id 的读法）
        bot = out.get("bot") or {}
        name = bot.get("app_name") or _t("（未命名）")
        act = bot.get("activate_status")
        tail = (_t("已启用") if act == 2 else
                _t("启用状态={act}（可能未发布/未启用）", act=str(act)))
        return {"ok": True,
                "detail": _t("凭据可用：机器人 {name}（{tail}）",
                             name=name, tail=tail)}
    except FeishuRestError as e:
        return {"ok": False, "detail": str(e)}
    except Exception as e:   # 兜底：网络/形态异常一律转文案，不抛到 HTTP 层
        return {"ok": False, "detail": _t("探测失败: {error}", error=f"{e!r}")}


def _apply_error(e, lang=None):
    """补齐失败的文案：缺 patch 权限给精确开通引导，其余原样透出。

    语言（T12d）：固定引导走 `api` 词条（None/zh 逐字节不变）；上游错误原样。"""
    if _need_scope(e):
        return i18n.t("api", _PATCH_SCOPE_HINT, lang)
    return str(e)


def provision_apply(user_id, lang=None):
    """把平台所需的**机器人能力 + 权限 + 长连接订阅 + 事件 + 回调**一次补齐到
    用户自己的应用（只动本用户配置里的 app_id，前端永不传 app_id）。

    两步：① PATCH .../ability 开机器人能力（{bot:{enable:true}}）；
    ② PATCH .../config 一次带上 scope.add_scopes / event.subscription_type=websocket
    + add_events / callback.add_callbacks。失败即停并如实报告（缺
    application:application:patch 时给开通引导，不静默）。

    返回 {"ok", "need_patch_scope", "error", "steps":[{key,label,ok,detail}]}。
    语言（T12d）：``lang`` 为**请求语言**（None/zh ⇒ 存量中文逐字节不变）；
    step 的 key/ok 是机器值不变，label/detail 走 `api` 词条。"""
    def _t(key, **vars):
        return i18n.t("api", key, lang, **vars)

    if not provision_enabled():
        return {"ok": False, "need_patch_scope": False, "steps": [],
                "error": _t("配置自动化已关闭（{env}=0）", env=PROVISION_ENV)}
    cfg = app_config(user_id)
    if cfg is None:
        return {"ok": False, "need_patch_scope": False, "steps": [],
                "error": _t("应用凭据未配置（App ID / App Secret），请先保存凭据")}
    app_id = cfg["app_id"]
    steps = []
    # ① 机器人能力（错误码 210041 即「未开启机器人能力」，先开它）
    try:
        _rest("PATCH", _APP_ABILITY_API % app_id,
              json_body={"bot": {"enable": True}}, cfg=cfg)
        steps.append({"key": "ability", "label": _t("开启机器人能力"),
                      "ok": True, "detail": _t("已开启")})
    except FeishuRestError as e:
        steps.append({"key": "ability", "label": _t("开启机器人能力"),
                      "ok": False, "detail": str(e)})
        return {"ok": False, "need_patch_scope": _need_scope(e),
                "error": _apply_error(e, lang), "steps": steps}
    # ② 权限 + 订阅方式（长连接）+ 事件 + 回调（一次 PATCH，减少请求与半生效窗口）
    body = {
        "scope": {"add_scopes": [{"scope_name": n, "token_type": t}
                                 for n, t, _ in REQUIRED_SCOPES]},
        "event": {"subscription_type": "websocket",
                  "add_events": [e for e, _ in REQUIRED_EVENTS]},
        "callback": {"callback_type": "websocket",
                     "add_callbacks": [c for c, _ in REQUIRED_CALLBACKS]},
    }
    try:
        _rest("PATCH", _APP_CONFIG_API % app_id, json_body=body, cfg=cfg)
        steps.append({"key": "config",
                      "label": _t("权限 / 长连接订阅 / 事件 / 回调"),
                      "ok": True,
                      "detail": _t("已写入（需发布新版本后生效）")})
    except FeishuRestError as e:
        steps.append({"key": "config",
                      "label": _t("权限 / 长连接订阅 / 事件 / 回调"),
                      "ok": False, "detail": str(e)})
        return {"ok": False, "need_patch_scope": _need_scope(e),
                "error": _apply_error(e, lang), "steps": steps}
    return {"ok": True, "need_patch_scope": False, "error": "", "steps": steps}


# ---------- M5 配置自动化：配置自检（doctor） ----------

_LAST_PROBE_TS = {}    # user_id -> 上次发「测试消息」的时刻（send_probe 频控）


def _doc_item(key, label, state, detail, hint=""):
    """doctor 单项（state ∈ ok|fail|warn|skip；hint 是中文修复指引）。"""
    return {"key": key, "label": label, "state": state, "detail": detail, "hint": hint}


def doctor(user_id, send_probe=False, lang=None, data_lang=None):
    """逐项配置体检（**只读为主**，绝不抛出）：把「存没存上、对不对、通不通」一次说清。

    八项：creds（凭据齐全）/ token（凭据有效）/ bot（机器人能力与启用状态）/
    inbound_ws（长连接线程在跑）/ inbound_event（**真实收到过事件**——订阅方式配错时
    连接照样建得起来，此时间戳是唯一证据）/ slash_scope（斜杠指令权限）/
    send_scope（发消息权限，send_probe=True 时才真发一条自检 DM，60s 频控）/
    webhook（默认推送地址已配）。

    语言（两个维度，别混）：
      - ``lang``（T12b）：`send_probe` 真发那条 DM 的**收件人**语言（None ⇒ 读绑定用户
        偏好；不探测/被频控拦下时不读偏好）；
      - ``data_lang``（T12d）：八项 label/detail/hint 的**请求语言**（None/zh ⇒ 存量
        中文逐字节不变）。两者分开是因为 DM 收件人语言与页面请求语言可能不同（R22）。
    返回 {"items":[{key,label,state,detail,hint}], "summary":{ok,fail,warn,skip}}。"""
    dlang = data_lang if data_lang is not None else "zh"

    def _t(key, **vars):
        return i18n.t("api", key, dlang, **vars)

    cfg = dict(user_config(user_id) or {})
    has_creds = bool(cfg.get("app_id") and cfg.get("app_secret"))
    items = [_doc_item(
        "creds", _t("应用凭据（App ID / App Secret）"),
        "ok" if has_creds else "fail",
        _t("已配置") if has_creds else _t("未配置"),
        "" if has_creds else _t("在「飞书机器人配置」填入 App ID 与 App Secret 并保存"))]

    token_ok = False
    if not has_creds:
        items.append(_doc_item("token", _t("凭据有效性（tenant_access_token）"),
                               "skip", _t("凭据未配置，跳过"), ""))
    else:
        try:
            _tenant_token(cfg)
            token_ok = True
            items.append(_doc_item("token", _t("凭据有效性（tenant_access_token）"),
                                   "ok", _t("token 获取成功"), ""))
        except FeishuRestError as e:
            # 上游错误原文（动态/诊断值）按现状透传，不翻译
            items.append(_doc_item("token", _t("凭据有效性（tenant_access_token）"),
                                   "fail", str(e),
                                   _t("核对取值：开发者后台 → 凭证与基础信息 的 "
                                      "App ID / App Secret")))
        except Exception as e:
            items.append(_doc_item("token", _t("凭据有效性（tenant_access_token）"),
                                   "fail", _t("探测失败: {error}", error=f"{e!r}"),
                                   _t("检查站点到 open.feishu.cn 的网络")))

    if not token_ok:
        items.append(_doc_item("bot", _t("机器人能力与启用状态"),
                               "skip", _t("凭据未通过，跳过"), ""))
    else:
        try:
            out = _rest("GET", "/open-apis/bot/v3/info", cfg=cfg)
            bot = out.get("bot") or {}
            act = bot.get("activate_status")
            name = bot.get("app_name") or _t("（未命名）")
            ok = act == 2
            items.append(_doc_item(
                "bot", _t("机器人能力与启用状态"), "ok" if ok else "warn",
                _t("{name}（activate_status={act}）", name=name, act=str(act)),
                "" if ok else
                _t("应用能力 → 添加「机器人」，并在版本管理与发布里发布后生效")))
        except FeishuRestError as e:
            items.append(_doc_item("bot", _t("机器人能力与启用状态"), "fail", str(e),
                                   _t("应用能力 → 添加应用能力 → 机器人，然后创建版本发布")))
        except Exception as e:
            items.append(_doc_item("bot", _t("机器人能力与启用状态"), "fail",
                                   _t("探测失败: {error}", error=f"{e!r}"),
                                   _t("稍后重试")))

    st = inbound_status(user_id)
    # M10（2026-10-17）：线程活着但**绑的不是配置里的应用** ⇒ 换凭据后没重启站点。
    # 这是真实踩过的坑：面板显示「已接入应用 X」、本项也绿，但消息仍打到旧机器人。
    # 「线程绑的 app」走独立访问口 `inbound_thread_app_id`，不动 `inbound_status` 的形状。
    cfg_app, thread_app = (cfg.get("app_id") or ""), inbound_thread_app_id(user_id)
    if not has_creds:
        items.append(_doc_item("inbound_ws", _t("入站长连接（长连接）"), "skip",
                               _t("凭据未配置，跳过"), ""))
    elif st.get("thread") and cfg_app and thread_app and thread_app != cfg_app:
        items.append(_doc_item(
            "inbound_ws", _t("入站长连接（长连接）"), "warn",
            _t("连接线程仍绑在 {thread}（配置已改为 {cfg}）",
               thread=thread_app, cfg=cfg_app),
            _t("在机器人私聊发「接入」点「换用新应用」即可免重启切换；"
               "仍不生效再重启站点")))
    else:
        items.append(_doc_item(
            "inbound_ws", _t("入站长连接（长连接）"),
            "ok" if st.get("thread") else "fail",
            _t("连接线程运行中") if st.get("thread") else _t("未运行"),
            "" if st.get("thread") else
            _t("凭据保存后自动连接；仍不启动看站点日志，并确认事件订阅方式为「长连接」")))

    last_ev = _LAST_EVENT_TS.get(user_id)
    if not has_creds:
        items.append(_doc_item("inbound_event", _t("事件订阅（真实收到过消息）"), "skip",
                               _t("凭据未配置，跳过"), ""))
    elif last_ev and (time.time() - last_ev) <= EVENT_FRESH_S:
        items.append(_doc_item("inbound_event", _t("事件订阅（真实收到过消息）"), "ok",
                               _t("{n} 秒前收到过事件",
                                  n=int(time.time() - last_ev)), ""))
    else:
        items.append(_doc_item(
            "inbound_event", _t("事件订阅（真实收到过消息）"), "warn",
            _t("尚未收到过事件") if not last_ev else _t("最近一次事件已超过 5 分钟"),
            _t("给机器人**发一条消息**验证：开发者后台 → 事件与回调 → "
               "订阅方式选「长连接」并添加 im.message.receive_v1"
               "（按钮交互还需回调 card.action.trigger）")))

    if not token_ok:
        items.append(_doc_item("slash_scope", _t("斜杠指令权限"), "skip",
                               _t("凭据未通过，跳过"), ""))
    else:
        try:
            # T12d：slash 诊断也跟随请求语言（固定引导有 api 词条，上游原文透传）
            sl = slash_status(user_id, dlang)
        except Exception as e:
            # slash_status 只吞 FeishuRestError；响应形态意外（如 data 非 dict）会漏出
            # 其他异常——doctor 承诺绝不外抛，这里降级为该项 fail。
            items.append(_doc_item("slash_scope", _t("斜杠指令权限"), "fail",
                                   _t("探测失败: {error}", error=f"{e!r}"),
                                   _t("稍后重试；仍失败可在「快捷指令」卡手动"
                                      "「注册 / 同步」看具体报错")))
            sl = None
        if sl is None:
            pass                      # 探测异常：已在上面落 fail 项
        elif sl.get("need_scope"):
            items.append(_doc_item(
                "slash_scope", _t("斜杠指令权限"), "fail",
                sl.get("error") or _t("缺权限"),
                _t("权限管理 添加 application:app_slash_command:read 与 write，"
                   "并创建版本发布；开通后回设置页点「注册 / 同步到飞书」")))
        elif sl.get("error"):
            items.append(_doc_item("slash_scope", _t("斜杠指令权限"), "warn",
                                   str(sl["error"]),
                                   _t("可在设置页「快捷指令」卡重试")))
        else:
            items.append(_doc_item("slash_scope", _t("斜杠指令权限"), "ok",
                                   _t("权限可用"), ""))

    binding = None
    try:
        binding = db.get_feishu_binding_by_user(user_id)
    except Exception:
        binding = None
    if not token_ok or not binding:
        items.append(_doc_item(
            "send_scope", _t("发消息权限（可选探测）"), "skip",
            _t("未绑定飞书账号，跳过") if not binding else _t("凭据未通过，跳过"),
            "" if binding else
            _t("先在下方生成绑定码并在飞书里发「绑定 <码>」")))
    elif not send_probe:
        items.append(_doc_item("send_scope", _t("发消息权限（可选探测）"), "skip",
                               _t("未探测（勾选「发送测试消息」后重跑自检）"), ""))
    elif (time.time() - (_LAST_PROBE_TS.get(user_id) or 0)) < SEND_PROBE_MIN_S:
        items.append(_doc_item("send_scope", _t("发消息权限（可选探测）"), "skip",
                               _t("{n} 秒内已发过测试消息，稍后再试",
                                  n=SEND_PROBE_MIN_S), ""))
    else:
        try:
            # 真要发这条 DM 才解析语言（无探测/被频控时不读偏好）
            probe_lang = lang if lang is not None else user_lang(user_id)
            rest_send_text(binding["open_id"],
                           i18n.t("api", "🔍 Touchstone 配置自检：收到这条消息说明"
                                         "「发消息」权限已开通。", probe_lang),
                           cfg)
            _LAST_PROBE_TS[user_id] = time.time()
            items.append(_doc_item("send_scope", _t("发消息权限（可选探测）"), "ok",
                                   _t("测试消息已发送，去飞书查看"), ""))
        except FeishuRestError as e:
            items.append(_doc_item("send_scope", _t("发消息权限（可选探测）"), "fail",
                                   str(e),
                                   _t("权限管理 添加 im:message:send_as_bot "
                                      "并创建版本发布")))
        except Exception as e:
            items.append(_doc_item("send_scope", _t("发消息权限（可选探测）"), "fail",
                                   _t("探测失败: {error}", error=f"{e!r}"),
                                   _t("稍后重试")))

    hook = cfg.get("default_webhook") or ""
    items.append(_doc_item(
        "webhook", _t("默认推送 Webhook"), "ok" if hook else "warn",
        _t("已配置") if hook else
        _t("未配置（不影响机器人对话，只影响阻塞事件推送）"),
        "" if hook else
        _t("群设置 → 群机器人 → 添加自定义机器人，把 Webhook 填到设置页")))

    summary = {"ok": 0, "fail": 0, "warn": 0, "skip": 0}
    for it in items:
        summary[it["state"]] = summary.get(it["state"], 0) + 1
    return {"items": items, "summary": summary}


# ---------- M5 配置自动化：扫码建应用（Device Flow 状态机） ----------

_PROVISION = {}    # user_id -> {"state","url","error","app_id","steps","started_at","cancel"}
_PROVISION_LOCK = threading.Lock()   # 「读状态 → 写状态」串行化（并发点两下只建一条流程）
_REGISTER_MIN_VERSION = (1, 5, 5)   # register_app 的 lark-oapi 下限


def _lark_min_ok():
    """lark-oapi 版本是否达标——**只读包元数据，不 import SDK**。

    为什么不 import：`lark_oapi.ws.client` 在模块级调 `asyncio.get_event_loop()`，
    在非主线程首次 import 有拿不到事件循环的风险（且拖慢首次调用）；真正的 SDK
    import 只发生在用户点「扫码创建」后的后台线程里（与既有 `_ws_run` 同路径）。"""
    try:
        import importlib.metadata as md
        ver = md.version("lark-oapi")
    except Exception:
        return False
    nums = []
    for part in ver.split(".")[:3]:
        digits = ""
        for ch in part:
            if not ch.isdigit():
                break
            digits += ch
        nums.append(int(digits or 0))
    return tuple(nums) >= _REGISTER_MIN_VERSION


def _register_app_impl(on_qr_code, on_status_change, cancel_event, addons):
    """SDK 调用的**可替换封装**（测试打桩点，也是唯一直接碰 SDK 的地方）。"""
    if not _lark_min_ok():
        raise RuntimeError("lark-oapi 版本过低或未安装（register_app 需 ≥1.5.5）")
    import lark_oapi
    return lark_oapi.register_app(on_qr_code=on_qr_code,
                                  on_status_change=on_status_change,
                                  cancel_event=cancel_event, addons=addons)


def provision_supported():
    """本机是否具备「扫码一键建应用」能力（lark-oapi ≥1.5.5 含 register_app）。"""
    return _lark_min_ok()


def _provision_addons():
    """register_app 的 addons 载荷：**创建时**就把平台所需的权限/事件/回调带上。

    这是绕开 `application:application:patch` 冷启动（新建应用默认没有该权限）
    的主路径；preset=False 表示不要官方智能体模板（最小权限，只声明我们自己的清单）。"""
    return {
        "preset": False,
        "scopes": {"tenant": [n for n, t, _ in REQUIRED_SCOPES if t == "tenant"]},
        "events": {"items": {"tenant": [e for e, _ in REQUIRED_EVENTS]}},
        "callbacks": {"items": [c for c, _ in REQUIRED_CALLBACKS]},
    }


def _provision_steps(steps, lang):
    """把 `_PROVISION` 里的 canonical（中文）steps 映射到请求语言。

    label/detail 全是固定文案或飞书上游错误原文：固定文案命中 `api` 词条即翻译，
    上游原文在词典里不存在 ⇒ `t` 原样返回（不吞诊断）。key/ok 机器值不动。"""
    return [{**s,
             "label": i18n.t("api", s.get("label", ""), lang),
             "detail": i18n.t("api", s.get("detail", ""), lang)}
            for s in steps or []]


def _provision_error(error, lang):
    """status.error 的已知文案映射；上游/动态错误原文原样透传（白名单）。"""
    if not error:
        return error
    if error == "扫码流程未返回应用凭据（可能超时或未确认），可重新发起":
        return i18n.t("api", error, lang)
    for prefix, key in (
            ("扫码创建失败: ", "扫码创建失败: {error}"),
            ("应用已创建，但配置补齐未完成：",
             "应用已创建，但配置补齐未完成：{error}")):
        if error.startswith(prefix):
            inner = error[len(prefix):]
            if inner == _PATCH_SCOPE_HINT:
                inner = i18n.t("api", inner, lang)
            return i18n.t("api", key, lang, error=inner)
    return error


def provision_status(user_id, lang=None):
    """扫码流程现状（设置页轮询口，只读）。等待超 TTL 即对外按失败呈现。

    `app_id` = 在跑流程的应用优先，否则回落**用户配置里已接入的应用**——前端据此
    决定「是否二次确认 + force」，只回进程内状态会让已有应用的用户永远发不出
    force（扫码换应用死锁；站点重启后连扫码建过应用的用户也会掉进去）。

    语言（T12d）：``lang`` 为请求语言；state/url/app_id/age_s 机器值不变，
    TTL error、canonical steps 的 label/detail、已知 error 前缀按语言渲染。"""
    st = _PROVISION.get(user_id) or {}
    state = st.get("state", "idle")
    error = st.get("error", "")
    if state == "waiting" and (time.time() - st.get("started_at", 0)) > PROVISION_TTL:
        state = "failed"
        error = error or i18n.t(
            "api", "确认链接已超时（10 分钟有效），可重新发起", lang)
    # 回落取**配置里的 app_id**（不要求 secret 齐——只填了 App ID 也算「已接入」，
    # 前端据此二次确认；真正的 force 闸门仍按 app_config（两件齐全）判定）
    app_id = st.get("app_id") or ((user_config(user_id) or {}).get("app_id") or "")
    return {"supported": provision_supported(), "enabled": provision_enabled(),
            "state": state, "url": st.get("url", ""),
            "error": _provision_error(error, lang),
            "app_id": app_id,
            "steps": _provision_steps(st.get("steps", []), lang),
            "age_s": int(time.time() - st["started_at"]) if st.get("started_at") else 0}


def provision_start(user_id, force=False, lang=None):
    """发起扫码建应用（后台线程跑 Device Flow）。返回 {"ok","state","url","error"}。

    闸门三条：总闸（TS_FEISHU_PROVISION=0）、SDK 可用性、已有应用需 force；
    同一用户重复点击**不重复建流程**（返回既有流程的现状）。「读状态 → 写状态」
    全程持 `_PROVISION_LOCK`：并发点两下不会各起一条 Device Flow（复阅 P1）。
    语言（T12d）：``lang`` 为请求语言，只影响三条闸门错误文案（state/url 机器值不变）。"""
    def _t(key, **vars):
        return i18n.t("api", key, lang, **vars)

    if not provision_enabled():
        return {"ok": False, "state": "idle", "url": "",
                "error": _t("配置自动化已关闭（{env}=0）", env=PROVISION_ENV)}
    if not provision_supported():
        return {"ok": False, "state": "idle", "url": "",
                "error": _t("本机 lark-oapi 版本过低（register_app 需 ≥1.5.5），"
                            "请升级依赖后重试")}
    with _PROVISION_LOCK:
        cur = _PROVISION.get(user_id) or {}
        if cur.get("state") == "waiting" and \
                (time.time() - cur.get("started_at", 0)) <= PROVISION_TTL:
            return {"ok": True, "state": "waiting", "url": cur.get("url", ""), "error": ""}
        cfg = app_config(user_id)
        if cfg is not None and not force:
            return {"ok": False, "state": "idle", "url": "",
                    "error": _t("已配置应用 {app_id}；如需换应用请确认后重试",
                                app_id=cfg.get("app_id"))}
        cancel = threading.Event()
        _PROVISION[user_id] = {"state": "waiting", "url": "", "error": "", "app_id": "",
                               "steps": [], "started_at": time.time(), "cancel": cancel}
        threading.Thread(target=_provision_worker, args=(user_id, cancel), daemon=True,
                         name=f"feishu-provision-{user_id}").start()
    return {"ok": True, "state": "waiting", "url": "", "error": ""}


def provision_cancel(user_id, lang=None):
    """取消进行中的扫码流程（置 cancel_event，SDK 侧即刻收尾）。"""
    st = _PROVISION.get(user_id) or {}
    if st.get("state") != "waiting":
        return {"ok": False, "state": st.get("state", "idle"),
                "error": i18n.t("api", "当前没有进行中的扫码流程", lang)}
    st["cancel"].set()
    st["state"] = "cancelled"
    return {"ok": True, "state": "cancelled", "error": ""}


def _provision_worker(user_id, cancel):
    """后台主体：跑 Device Flow（回调里落链接/状态）→ 成功即写凭据 → 起长连接 →
    自动补齐应用配置（能力/权限/事件/回调），全过程结果落 `_PROVISION` 供前端轮询。
    凭据不入日志；任何异常都转状态文案，绝不外抛。"""
    st = _PROVISION[user_id]

    def on_qr(url):
        st["url"] = url or ""

    def on_status(info):
        # 域切换（飞书/Lark）时链接作废，等 SDK 给新链接（旧 URL 已失效，不展示误导）
        if isinstance(info, dict) and info.get("status") == "domain_switched":
            st["url"] = ""

    try:
        out = _register_app_impl(on_qr, on_status, cancel, _provision_addons())
    except Exception as e:
        if st.get("state") != "cancelled":
            st["state"] = "failed"
            st["error"] = f"扫码创建失败: {e}"
        return
    if st.get("state") == "cancelled":
        return
    app_id = (out or {}).get("client_id") or ""
    secret = (out or {}).get("client_secret") or ""
    if not (app_id and secret):
        st["state"] = "failed"
        st["error"] = "扫码流程未返回应用凭据（可能超时或未确认），可重新发起"
        return
    # 合并写库：保留既有 enabled / webhook / base_url 等字段，只换应用凭据
    cfg = dict(user_config(user_id) or {})
    old_cfg = {"app_id": str(cfg.get("app_id") or ""),
               "app_secret": str(cfg.get("app_secret") or "")}
    cfg["app_id"] = app_id
    cfg["app_secret"] = secret
    db.set_feishu_user_cfg(user_id, cfg)
    _TOKEN_CACHE.pop(app_id, None)   # 新凭据：清同 app_id 的旧 token 缓存
    st["app_id"] = app_id
    # M11：换应用后旧连接仍在跑（绑定关系也还是旧应用的 open_id）⇒ 用**旧应用**通道发
    # 「确认切换」卡片；用户点按钮后由「先取码、再重连」顺序完成切换（无需重启站点）。
    # 必须在 start_inbound_for 之前发：那时旧线程还活着、旧 open_id 也还认得。
    maybe_send_switch_card(user_id, old_cfg)
    try:
        start_inbound_for(user_id)   # 起长连接（失败只留痕，状态里如实呈现）
    except Exception as e:
        print(f"feishu provision: 用户 {user_id} 长连接启动异常: {e!r}",
              file=sys.stderr, flush=True)
    applied = provision_apply(user_id)
    st["steps"] = applied.get("steps") or []
    st["state"] = "success"
    st["error"] = "" if applied.get("ok") else \
        f"应用已创建，但配置补齐未完成：{applied.get('error')}"


# ---------- M5 配置自动化：提交发布 ----------

def _next_version(items):
    """版本号递增：取远端版本列表里的**最大语义版本**补丁位 +1（无版本回 1.0.0）。
    解析失败的版本（非 x.y.z）忽略；比较用整数元组，避免 "1.0.10" < "1.0.3" 的字符串序陷阱。"""
    best = None
    for it in items or []:
        raw = str((it or {}).get("version") or "").strip()
        try:
            nums = tuple(int(x) for x in raw.split("."))
        except ValueError:
            continue
        if len(nums) != 3:
            continue
        if best is None or nums > best:
            best = nums
    if best is None:
        return "1.0.0"
    return "%d.%d.%d" % (best[0], best[1], best[2] + 1)


def provision_publish(user_id, version=None, remark="", changelog="", lang=None):
    """提交发布自建应用（POST application/v7/.../publish）：无待发布版本时由飞书自动建版本。

    版本号缺省自动递增（见 `_next_version`）；发布后仍需**租户管理员审批**才线上生效
    （无 API，走引导）。返回 {"ok","version","version_id","need_patch_scope","error"}。
    语言（T12d）：``lang`` 为请求语言，只影响 error；version/version_id 机器值不变。
    remark/changelog 是发给飞书的应用版本说明（不进站点响应），保持既有中文。"""
    def _t(key, **vars):
        return i18n.t("api", key, lang, **vars)

    if not provision_enabled():
        return {"ok": False, "version": "", "version_id": "", "need_patch_scope": False,
                "error": _t("配置自动化已关闭（{env}=0）", env=PROVISION_ENV)}
    cfg = app_config(user_id)
    if cfg is None:
        return {"ok": False, "version": "", "version_id": "", "need_patch_scope": False,
                "error": _t("应用凭据未配置（App ID / App Secret），请先保存凭据")}
    app_id = cfg["app_id"]
    ver = str(version or "").strip()
    try:
        if not ver:
            out = _rest("GET", _APP_VERSIONS_API % app_id, cfg=cfg)
            items = ((out.get("data") or {}).get("items")) or []
            ver = _next_version(items)
        body = {"version": ver,
                "remark": remark or "Touchstone 配置自动化",
                "changelog": changelog or "自动配置：机器人能力 / 权限 / 长连接事件订阅 / 卡片回调",
                "pc_default_ability": "bot", "mobile_default_ability": "bot"}
        out = _rest("POST", _APP_PUBLISH_API % app_id, json_body=body, cfg=cfg)
        data = out.get("data") or {}
        return {"ok": True, "version": data.get("version") or ver,
                "version_id": str(data.get("version_id") or ""),
                "need_patch_scope": False, "error": ""}
    except FeishuRestError as e:
        return {"ok": False, "version": ver, "version_id": "",
                "need_patch_scope": _need_scope(e),
                "error": _apply_error(e, lang)}
    except Exception as e:
        return {"ok": False, "version": ver, "version_id": "",
                "need_patch_scope": False,
                "error": _t("发布失败: {error}", error=f"{e!r}")}


# ---------- M5 配置自动化：保存配置（含凭据即时快检） ----------

def save_user_config(user_id, body, lang=None):
    """保存用户飞书配置并即时反馈（服务端设置页唯一写口；语义与既有实现逐字一致）：
    字段缺省=不改、显式空串=清除（前端对未编辑的 secret/webhook 不下发该键，防误清）。

    新增：凭据齐全时立刻 `verify_credentials` 快检——今天保存凭据只写库不校验，
    填错只能翻日志；`verify` 随响应回给页面做即时提示（凭据不全时为 None，零请求）。
    语言（T12d）：``lang`` 为请求语言，透传给 verify；None 时保持旧调用形状（单测桩
    只接受一个参数 ⇒ 存量用例零 churn）。
    返回 {"inbound_started": bool, "verify": {...}|None}。"""
    cfg = user_config(user_id)
    old_cfg = {"app_id": str(cfg.get("app_id") or ""),
               "app_secret": str(cfg.get("app_secret") or "")}
    # 推送总控（2026-10-10）：与旧 `enabled` 是两个独立开关——旧键只管「无绑定行回落
    # 默认 webhook」与入站，本键一票否决全部自动推送。缺省=不改（不在 body 里就不动）。
    if "push_enabled" in body:
        cfg["push_enabled"] = 1 if body["push_enabled"] else 0
    if "enabled" in body:
        cfg["enabled"] = 1 if body["enabled"] else 0
    for key in ("default_webhook", "default_secret", "base_url",
                "app_id", "app_secret"):
        if key in body:
            cfg[key] = str(body[key] or "").strip()
    db.set_feishu_user_cfg(user_id, cfg)
    started = start_inbound_for(user_id)
    verify = None
    if app_config(user_id):
        verify = (verify_credentials(user_id) if lang is None
                  else verify_credentials(user_id, lang))
    # M11：手工换应用（非扫码路径）同样发「确认切换」卡片——旧连接还活着时用旧应用通道
    # 通知用户点确认（后台线程发，REST 不阻塞保存响应；条件在 maybe_send_switch_card 里
    # 复核，凭据没变/线程没跑时是零请求空转）
    if ("app_id" in body or "app_secret" in body):
        threading.Thread(target=maybe_send_switch_card, args=(user_id, old_cfg),
                         daemon=True, name=f"feishu-switch-card-{user_id}").start()
    return {"inbound_started": bool(started), "verify": verify}


def _cli_uid(val):
    """CLI 的用户定位：显式 --user 优先；缺省时库中恰有一个用户即自动选中。
    返回 (user_id, None)；定位失败返回 (None, 退出码)，原因已打印到 stderr。"""
    if val:
        return int(val), None
    try:
        users = db.list_users()
    except Exception as e:
        print(f"读取用户失败：{e}", file=sys.stderr)
        return None, 1
    if len(users) == 1:
        return users[0]["id"], None
    if not users:
        print("库中还没有用户：先启动站点并创建账号", file=sys.stderr)
        return None, 1
    names = "、".join(f"{r['username']}(id={r['id']})" for r in users)
    print(f"库中有多个用户，请用 --user 指定：{names}", file=sys.stderr)
    return None, 1


def _cli():
    """命令行入口（M1 出站 + M5 配置自动化）：

      python3 feishu.py selftest <项目id> / send --url U --text T / outbox
      python3 feishu.py doctor   [--user ID] [--send-probe]   # 配置自检（有 fail 退出码 1）
      python3 feishu.py provision [--user ID] [--force] [--no-wait]  # 扫码建应用
      python3 feishu.py apply    [--user ID]                  # 补齐应用配置
      python3 feishu.py publish  [--user ID] [--version V]    # 提交发布
    """
    ap = argparse.ArgumentParser(description="Touchstone 飞书集成 CLI（出站推送 / 配置自动化）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_st = sub.add_parser("selftest", help="向项目绑定 webhook 同步发一条测试消息")
    p_st.add_argument("project_id", type=int)
    p_send = sub.add_parser("send", help="直接向指定 webhook 发文本（不经 outbox）")
    p_send.add_argument("--url", required=True)
    p_send.add_argument("--secret", default="")
    p_send.add_argument("--text", required=True)
    sub.add_parser("outbox", help="查看最近投递记录")
    p_doc = sub.add_parser("doctor", help="飞书配置自检（八项；有 fail 退出码 1）")
    p_doc.add_argument("--user", type=int, default=None, help="用户 id（库中只有一个用户可省）")
    p_doc.add_argument("--send-probe", action="store_true", help="额外发一条测试消息验证发消息权限")
    p_prov = sub.add_parser("provision", help="扫码创建飞书应用（打印确认链接，手机飞书打开）")
    p_prov.add_argument("--user", type=int, default=None)
    p_prov.add_argument("--force", action="store_true", help="已配置应用时也重新创建")
    p_prov.add_argument("--no-wait", action="store_true", help="发起后立即返回，不等扫码结果")
    p_apply = sub.add_parser("apply", help="补齐应用配置（机器人能力/权限/事件/回调）")
    p_apply.add_argument("--user", type=int, default=None)
    p_pub = sub.add_parser("publish", help="提交发布（需管理员审批或已开免审）")
    p_pub.add_argument("--user", type=int, default=None)
    p_pub.add_argument("--version", default="", help="版本号（缺省自动递增）")
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
    if a.cmd == "doctor":
        uid, rc = _cli_uid(a.user)
        if uid is None:
            return rc
        out = doctor(uid, send_probe=a.send_probe)
        marks = {"ok": "✅", "fail": "❌", "warn": "⚠️", "skip": "➖"}
        for it in out["items"]:
            print(f"{marks.get(it['state'], '?')} {it['label']}：{it['detail']}")
            if it.get("hint"):
                print(f"   提示：{it['hint']}")
        s = out["summary"]
        print(f"汇总：ok={s.get('ok', 0)} fail={s.get('fail', 0)} "
              f"warn={s.get('warn', 0)} skip={s.get('skip', 0)}")
        return 1 if s.get("fail") else 0
    if a.cmd == "provision":
        uid, rc = _cli_uid(a.user)
        if uid is None:
            return rc
        out = provision_start(uid, force=a.force)
        if not out.get("ok"):
            print(f"发起失败：{out.get('error')}", file=sys.stderr)
            return 1
        if out.get("url"):
            print(f"确认链接（手机飞书打开）：{out['url']}")
        if a.no_wait:
            print("已发起扫码流程（10 分钟内有效），稍后用 `doctor` 查看结果")
            return 0
        print("等待你在飞书里确认…（10 分钟有效）")
        printed = out.get("url") or ""
        st = provision_status(uid)
        deadline = time.time() + PROVISION_TTL
        while st.get("state") == "waiting" and time.time() < deadline:
            time.sleep(2)
            st = provision_status(uid)
            if st.get("url") and st["url"] != printed:   # 链接可能稍后就绪/换域
                printed = st["url"]
                print(f"确认链接（手机飞书打开）：{printed}")
        if st.get("state") != "success":
            print(f"未完成（state={st.get('state')}）：{st.get('error') or '等待超时'}",
                  file=sys.stderr)
            return 1
        print(f"✅ 应用已创建：{st.get('app_id')}")
        for s in st.get("steps") or []:
            print(f"  {'✅' if s.get('ok') else '❌'} {s.get('label')}：{s.get('detail')}")
        if st.get("error"):
            print(f"⚠️ {st['error']}")
        return 0
    if a.cmd == "apply":
        uid, rc = _cli_uid(a.user)
        if uid is None:
            return rc
        out = provision_apply(uid)
        for s in out.get("steps") or []:
            print(f"{'✅' if s.get('ok') else '❌'} {s.get('label')}：{s.get('detail')}")
        if not out.get("ok"):
            print(f"补齐失败：{out.get('error')}", file=sys.stderr)
            return 1
        print("✅ 应用配置已补齐（需创建版本发布后线上生效；可接着 `publish`）")
        return 0
    if a.cmd == "publish":
        uid, rc = _cli_uid(a.user)
        if uid is None:
            return rc
        out = provision_publish(uid, version=a.version or None)
        if not out.get("ok"):
            print(f"发布失败：{out.get('error')}", file=sys.stderr)
            return 1
        print(f"✅ 已提交发布：版本 {out.get('version')}"
              f"（version_id={out.get('version_id') or '-'}）")
        print("   发布需租户管理员审批（或管理员已开免审）后线上生效")
        return 0
    for r in db.feishu_outbox_recent(30):
        print(r["id"], r["status"], r["retries"],
              (r["last_error"][:60] or "-"), r["created_at"])
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
