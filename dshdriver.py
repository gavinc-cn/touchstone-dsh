#!/usr/bin/env python3
"""Touchstone 的 dsh 插件进程内 agent 驱动客户端（路线 A，纯标准库）。

单族世界（P7b B4，2026-10-03）：kimiweb.py / ocweb.py 两个「平台拉起并托管外部服务
进程 + REST 驱动」的驱动已随族退场删除，本模块是平台**唯一**的 agent 驱动：
- 本模块**不拉起任何进程**：dsh 插件（`dsh-plugin/lib/agent-driver.js`）跑在 dsh 宿主
  Node 进程内，把平台任务映射成进程内常驻 agent 会话，并把会话事件**推**回本进程。

连接信息由插件经子进程环境变量下发（见 dsh-plugin/lib/index.js `apply()`）：
  TS_AGENT_DRIVER_URL    驱动前缀地址，如 http://127.0.0.1:3080/touchstone-agent
  TS_AGENT_DRIVER_TOKEN  一次性驱动令牌（插件每次 apply 重新生成，防同机他进程驱动 agent）

为什么事件走 SSE 长连而不是「查状态接口」（方案 §3.3 的关键前提）：
  轮询对象从 kimi web 换成 dsh 插件，kimiweb 那套 TTL/SWR/线程池/死会话负缓存补丁会
  原样复活。dsh 侧 `turn/end`、`agent/status` 本身就是事件，只有推送通道才能真正退休
  `_wait_turn_end` 的 2s 轮询与看板 5s 全量遍历（B4 已随族删除）。

红线：令牌不落任何日志；驱动端点仅回环可达（插件侧同时校验来源地址与令牌）。
"""

import http.client
import json
import os
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

# 由 dsh 插件注入的驱动连接信息（独立形态下两者皆空 → 驱动不可用）
URL_ENV = "TS_AGENT_DRIVER_URL"
TOKEN_ENV = "TS_AGENT_DRIVER_TOKEN"

# 普通请求超时（秒）：建/恢复会话要加载持久化日志，给足余量
REQUEST_TIMEOUT = 120
# 探活超时（秒）：health 必须秒级返回，用于「驱动是否可用」的快速判定
HEALTH_TIMEOUT = 5
# SSE 空闲超时（秒）：插件每 15s 发一帧 keepalive 注释，超过该值视为链路僵死
STREAM_IDLE_TIMEOUT = 90
# stop 唤醒粒度（秒，P7a 缺陷 C 修复）：见 _stop_watcher。
# 原实现只在 read1() **返回之后**才求值 stop()，而 SSE 空闲时 read1 要等下一帧
# keepalive 才唤醒——真插件的 keepalive 间隔是 15s，于是收尾的「stream_stop.set()
# + join(timeout=5)」必然白等满 5s（实测时间线：驱动侧 /prompt → turn/end 仅
# 0.21s，平台轮次日志却是「开始 09:07:54 / 结束 09:07:59」；把 keepalive 调成
# 0.5s 后同一轮 ≈1s），订阅线程还会一直滞留到下一帧或 90s 空闲超时。
# 为什么不用「把 socket 读超时调小 + 超时重试」：Python 的 SocketIO 一旦超时即
# 永久毒化（_timeout_occurred=True，后续任何读都抛 OSError("cannot read from
# timed out object")，实测重试不可行），所以改为旁路线程在 stop 置位时
# shutdown 连接唤醒阻塞读（见 _stop_watcher），阻塞读仍保持原 idle_timeout。
STOP_WATCH_INTERVAL = 0.25


class DshDriverError(RuntimeError):
    """驱动/会话调用失败。code 为 HTTP 状态码或负值（-1=未配置 / -2=网络异常）。

    args 一律为 `(code, message)` 二元组（平台既有约定）：board 的
    `_answer_question_gone` 等判据直接读 `err.args[0]`；server 端点把 code 409
    映射为 HTTP 409，平台侧「会话运行中」的忙拒绝也用本异常（`(409, "…")`）。
    `__str__` 覆写为纯消息，避免日志里出现 `(-2, '驱动不可达')` 这种元组串。
    """

    def __init__(self, code, message):
        super().__init__(code, message)
        self.code = code
        self.message = message

    def __str__(self):
        return str(self.message)


def driver_url():
    """驱动前缀地址（未配置返回空串）。"""
    return (os.environ.get(URL_ENV) or "").strip().rstrip("/")


def configured():
    """本进程是否运行在 dsh 插件形态下（插件已下发驱动地址）。"""
    return bool(driver_url())


def _headers():
    """统一请求头：驱动令牌走自定义头（不回显、不落日志）。"""
    token = os.environ.get(TOKEN_ENV) or ""
    head = {"content-type": "application/json; charset=utf-8",
            "accept": "application/json"}
    if token:
        head["x-ts-driver-token"] = token
    return head


def _split_url():
    """把驱动地址拆成 (host, port, base_path)，供 http.client 直连使用。"""
    parsed = urllib.parse.urlsplit(driver_url())
    if parsed.scheme != "http" or not parsed.hostname:
        raise DshDriverError(-1, f"驱动地址不可用: {driver_url() or '(空)'}")
    return parsed.hostname, parsed.port or 80, parsed.path.rstrip("/")


def _request(method, path, payload=None, timeout=REQUEST_TIMEOUT):
    """向驱动端点发一次 JSON 请求，返回解析后的 dict（失败抛 DshDriverError）。"""
    if not configured():
        raise DshDriverError(-1, "未配置 dsh agent 驱动（非插件形态或插件未下发驱动地址）")
    body = None
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(driver_url() + path, data=body, method=method,
                                 headers=_headers())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = json.loads(e.read().decode("utf-8", errors="replace")).get("error", "")
        except (ValueError, OSError, AttributeError):
            detail = ""
        raise DshDriverError(e.code, detail or f"驱动返回 HTTP {e.code}") from e
    except (urllib.error.URLError, OSError) as e:
        raise DshDriverError(-2, f"驱动不可达: {e}") from e
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except ValueError as e:
        raise DshDriverError(-2, f"驱动响应不是 JSON: {raw[:200]}") from e


# ---------- 探活与状态 ----------

def health(timeout=HEALTH_TIMEOUT):
    """探活：返回 {ok, live, ...}；驱动未配置/不可达/未就绪一律抛错（调用方按需捕获）。"""
    return _request("GET", "/health", timeout=timeout)


def available(timeout=HEALTH_TIMEOUT):
    """驱动是否可用且 agents 服务已就绪（不抛异常的布尔口径，供族分派与 UI 判定）。"""
    if not configured():
        return False
    try:
        return bool(health(timeout=timeout).get("ok"))
    except DshDriverError:
        return False


def live():
    """当前可见会话表（含外部直跑会话）：替代逐会话 REST 探测的实时态来源。"""
    return _request("GET", "/live", timeout=10).get("sessions", [])


def status(session_id):
    """单会话状态：{status, last_seq, last_turn_reason, interaction, cwd, task}。"""
    return _request("GET", "/status?session_id=" + urllib.parse.quote(session_id), timeout=15)


# ---------- 会话生命周期 ----------

def split_model(model):
    """把平台侧模型值拆成 `(provider, model)`，供 `/session` 下传。

    平台侧模型值统一是 `provider/模型 id`（模型下拉口径，见 `server._dsh_plugin_models`），
    而宿主只有 `/model` 端点会拆 `provider/model`——`/session`（建/恢复会话）不拆，
    provider 前缀会被当成模型名的一部分。故走 `/session` 的两处调用点（runner 首轮建
    会话、board 卡片起会话）必须先经本函数拆开。

    无前缀的存量值/裸模型名（如 `deepseek-flash`）返回 `provider=''`，由宿主沿用该
    agent 当前的 provider；空串原样返回 `('', '')`。
    """
    s = (model or "").strip()
    head, sep, tail = s.partition("/")
    if sep and head and tail:
        return head, tail
    return "", s


def create_session(cwd, task="", model="", provider=""):
    """新建常驻会话（sid 由插件生成并回执），返回 session_id。"""
    payload = {"cwd": cwd, "task": task}
    if model:
        payload["model"] = model
    if provider:
        payload["provider"] = provider
    return _request("POST", "/session", payload)["session_id"]


def resume_session(session_id, task="", cwd="", model="", provider=""):
    """恢复已持久化会话（消灭「headless 无 resume、每轮独立会话」），返回 session_id。"""
    payload = {"session_id": session_id, "task": task, "cwd": cwd}
    if model:
        payload["model"] = model
    if provider:
        payload["provider"] = provider
    return _request("POST", "/session", payload)["session_id"]


def ensure_session(session_id, cwd, task="", model="", provider=""):
    """有 sid 则恢复、无则新建的统一入口（runner 首轮/续轮同一出口）。"""
    if session_id:
        return resume_session(session_id, task=task, cwd=cwd, model=model, provider=provider)
    return create_session(cwd, task=task, model=model, provider=provider)


def prompt(session_id, text):
    """投递一轮提示词（followup，立刻返回；轮次结束由 SSE 的 turn/end 帧判定）。"""
    return _request("POST", "/prompt", {"session_id": session_id, "prompt": text})


def steer(session_id, text):
    """运行中插话（steer 到最近 step 边界；空闲则直接起一轮）。"""
    return _request("POST", "/steer", {"session_id": session_id, "prompt": text})


def cancel(session_id, keep_inbox=False):
    """优雅中断当前 turn（保留已流式交付的文本；keep_inbox 连排队项一起保留）。"""
    return _request("POST", "/cancel",
                    {"session_id": session_id, "keep_inbox": bool(keep_inbox)})


def dispose(session_id):
    """释放常驻会话（停轮次 + 移出 registry/会话存储）。"""
    return _request("POST", "/dispose", {"session_id": session_id}, timeout=60)


# ---------- P3 对齐端点（2026-10-03）----------

def compact(session_id):
    """触发宿主侧压缩（插件走 `/compact` 命令）。

    触发即返回（压缩在 dsh 进程内异步进行，要过一次模型）；真正的失败只落宿主
    日志——平台侧 compact 语义本就是「发起」。返回 `{started: true}`。
    """
    return _request("POST", "/compact", {"session_id": session_id})


def fork(session_id, at_seq=None):
    """完整复制会话为新会话（宿主 `sessionController.fork`）。

    `at_seq` 给定时按该事件 seq 精确切分（缺省=最近一个完整 turn 的前缀）。
    返回 `{new_session_id}`——新会话**不在**驱动池里：平台把它绑到卡片/任务后，
    下一轮 `/session` 带该 sid 走 resume 自然接进池。
    """
    payload = {"session_id": session_id}
    if at_seq:
        payload["at_seq"] = int(at_seq)
    return _request("POST", "/fork", payload, timeout=60)


def rename(session_id, title):
    """改会话标题（与 dsh 侧栏同一份标题）。返回 `{title}`。"""
    return _request("POST", "/rename", {"session_id": session_id, "title": title})


def set_model(session_id, model, provider="", reasoning_effort=""):
    """会话级模型切换（宿主 `sessionController.selectModel`）。

    `model` 支持 `provider/model` 写法（拆分在插件侧）；只给模型名时由插件沿用
    该 agent 当前的 provider。`model` 为空而 `reasoning_effort` 非空＝**只改思考
    等级**（插件从会话当前模型选择回读 provider/model，见 `/model` 端点注释）。
    返回 `{selected: {provider, model, reasoningEffort?}}`。
    """
    payload = {"session_id": session_id, "model": model}
    if provider:
        payload["provider"] = provider
    if reasoning_effort:
        payload["reasoning_effort"] = reasoning_effort
    return _request("POST", "/model", payload, timeout=60)


# ---------- P3 第二批：审批代答 + 权限 preset（2026-10-03）----------

# 平台三档权限 → dsh preset 名（2026-10-03 P3 第二批）。manual 逐条确认 ↔
# workspace-write（sandbox=workspace-write + approval=ask；平台随即接管该会话审批
# 代答，见 answer_approval）；yolo 自动通过 / auto 完全自主 ↔ danger-full-access
# （approval=never，本机默认档）。⚠️ 这是**语义近似**：dsh 的 preset 是
# sandbox×approval 组合，与平台三档并不一一对应（yolo 与 auto 落到同一档）。
# 定义收在这里（dshdriver）而不是 server：board/runner 起会话时也要按项目默认值
# 应用权限档，而 server 反向依赖 board（循环导入），只能由最底层的驱动模块持有。
PERMISSION_PRESETS = {"manual": "workspace-write",
                      "yolo": "danger-full-access",
                      "auto": "danger-full-access"}
# 反向近似（宿主 preset → 平台三档）：仅用于「平台没记过档位」的会话（用户在 dsh 侧
# 直跑后被接管的卡会话）。正向映射本就多对一（yolo/auto 同 preset），反查统一取 yolo
# 作展示；平台自己切过的会话以驱动记下的 mode 为准，不走这里。
PRESET_MODES = {"workspace-write": "manual", "danger-full-access": "yolo"}
# 思考等级（dsh 宿主 reasoningEffort）合法取值：pi-ai 的 ModelThinkingLevel 全集。
# `off`＝不思考（宿主模型目录会把它列进 efforts，dsh 自己的控件也提供），故一并放行；
# 具体某个模型支持哪几档由宿主模型目录（驱动 `/models` 的 `efforts`）给出，平台只做
# 白名单校验（挡下拼写错误/注入）。
EFFORT_LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh", "max")

def answer_approval(session_id, approval_id, decision):
    """应答会话挂起的**审批**（宿主 `approval/request` waterfall 代答）。

    前提：插件已认领该会话的审批（`POST /permission` 接管过，`/status.approval_held=true`），
    否则审批由 dsh GUI 作答，这里返回 409。
    `decision` 用 dsh 原生度：`allowed-once` / `rejected` / `cancelled`（平台侧
    `approved/rejected` 的映射见 `board.answer_approval`）。
    `approval_id` 取自 interaction 标记的 `id`（插件自生成 `ap-<n>`）。
    返回 `{outcome}`。
    """
    return _request("POST", "/approval",
                    {"session_id": session_id, "approval_id": approval_id,
                     "decision": decision}, timeout=30)


def set_permission(session_id, preset, mode=None):
    """切换会话权限 preset（宿主 `permissionPresets.set`）并**把该会话的审批交给平台**。

    preset 名来自 `/presets` 的 options[].value。preset 的 approval=ask 时平台必须
    用 `answer_approval` 作答（插件据此认领 waterfall）；never 时瀑布不会被调用。
    `mode`（可选）＝平台三档 manual/yolo/auto：preset 到三档是多对一，只有平台知道
    用户点的哪一档，故随写一起交给驱动记下（后续经 `driver/permission` 状态帧回读，
    供会话窗「权限」控件显示）。返回 `{preset, approval, hold_approvals, permission}`。
    """
    body = {"session_id": session_id, "preset": preset}
    if mode:
        body["mode"] = mode
    return _request("POST", "/permission", body, timeout=30)


# ---------- 会话归档（看板「已完成」双向同步，2026-10-05） ----------

# 归档端点「会话不存在」的独立状态码（插件侧 `WorkspaceUnknownSessionError` 映射）。
# 与「未知驱动端点」的 404 分开：旧插件没实现本端点时返回 404，平台按硬失败处理；
# 410 则是**目标不存在**（历史遗留 sid / 会话存储已删），调用方跳过该 sid 放行卡片。
ARCHIVE_UNKNOWN_SESSION = 410


def archived(timeout=HEALTH_TIMEOUT):
    """读宿主归档集整表（`ctx.workspaceRegistry.archivedSessionIds`）。

    平台侧两个用途：① EventHub（重）连对齐时取一次基线；② 测试/诊断。
    返回会话 id 列表（宿主无归档 → 空列表）；驱动未配置/不可达抛 DshDriverError。
    """
    return list((_request("GET", "/archived", timeout=timeout) or {}).get("archived") or [])


def archive(session_id, archived=True, timeout=30):
    """归档 / 取消归档一个会话（驱动 `POST /archive`，两条都幂等）。

    - `archived=True`：宿主归档该会话（`stopActivity: true`——平台拖入「已完成」时刚
      发过 abort，异步生效前宿主可能仍认为有在跑的工作，带此开关避免竞态拒绝）；
    - `archived=False`：取消归档（不校验会话是否存在，幂等）。

    失败语义：会话不存在抛 `DshDriverError(ARCHIVE_UNKNOWN_SESSION, ...)`（调用方按
    「无同步对象」跳过）；其余 HTTP/传输错误原样抛（调用方按硬失败回滚卡片列）。
    """
    return _request("POST", "/archive",
                    {"session_id": session_id, "archived": bool(archived)},
                    timeout=timeout)


def unarchive(session_id, timeout=30):
    """取消归档（`archive(sid, archived=False)` 的同义封装，读侧语义更直白）。"""
    return archive(session_id, archived=False, timeout=timeout)


def apply_session_defaults(session_id, model="", provider="",
                           reasoning_effort="", permission_mode="", log=None):
    """把项目级默认（思考等级 / 权限档）应用到刚建或刚续的会话上（best-effort）。

    起会话路径（board._start_web / runner._run_round_dshplugin）在 create/resume
    之后调本函数：项目里配了默认值就下发，没配就什么都不做（沿用宿主默认）。

    为什么走 `/model`（selectModel）而不是建会话时塞 agentOptions：宿主对
    reasoningEffort 的校验发生在**请求装配**时（dsh-llm resolveCallConfig，
    模型不支持的档位直接抛 UNSUPPORTED_REASONING_EFFORT）——塞进 agentOptions
    会让「档位与模型不匹配」变成整轮失败；走 `/model` 则同步返回错误，这里捕获后
    只记一行告警，会话照常跑（不因一个配置错误起不来）。

    **best-effort**：每一步失败只收集告警文本，绝不抛异常（调用方把告警写进会话
    日志）。返回告警列表（空列表＝全部成功或无需应用）。

    参数：
      model/provider     会话当前模型（可为空：档位不变、仅改思考等级时由插件回读）；
      reasoning_effort   思考等级（dshdriver.EFFORT_LEVELS 之一，空=不改）；
      permission_mode    平台三档（manual/yolo/auto，空=不改）；
      log                可选 `callable(text)`，逐条即时落日志（失败场景）。
    """
    warns = []

    def _warn(text):
        warns.append(text)
        if callable(log):
            try:
                log(text)
            except Exception:
                pass                                  # 日志失败绝不影响起会话

    if permission_mode:
        preset = PERMISSION_PRESETS.get(permission_mode, "")
        if not preset:
            _warn(f"### 项目权限档 {permission_mode!r} 非法，已跳过（会话沿用宿主默认）\n")
        else:
            try:
                set_permission(session_id, preset, mode=permission_mode)
            except DshDriverError as e:
                _warn(f"### 项目权限档 {permission_mode} 未生效：{e}\n")
    if reasoning_effort:
        if reasoning_effort not in EFFORT_LEVELS:
            _warn(f"### 项目思考等级 {reasoning_effort!r} 非法，已跳过"
                  f"（合法值：{'/'.join(EFFORT_LEVELS)}）\n")
        else:
            try:
                set_model(session_id, model, provider=provider,
                          reasoning_effort=reasoning_effort)
            except DshDriverError as e:
                _warn(f"### 项目思考等级 {reasoning_effort} 未生效：{e}\n")
    return warns


def media(attachment_id):
    """读宿主图片附件字节（`GET /media?id=`；插件走 `attachments.imageHostPath`）。

    返回 `{content_type, bytes, data(base64)}`——平台侧解码成 `(bytes, ctype)`。
    附件不存在/引用非法 → DshDriverError(404)。
    """
    return _request("GET", "/media?id="
                    + urllib.parse.quote(str(attachment_id), safe=""), timeout=30)


def models():
    """读宿主模型目录（`sessionController.modelCatalog`，插件缓存 60s）。

    返回 `{default:{provider,model}, groups:[{id,name,models:[{id,name,...}]}],
    routable_providers[], failures[]}`——平台侧格式化成 `provider/model` 供下拉。
    """
    return _request("GET", "/models", timeout=30)


def presets(session_id):
    """读会话可选权限 preset：`{current, options:[{value,name,description}], default}`。"""
    return _request("GET", "/presets?session_id="
                    + urllib.parse.quote(str(session_id), safe=""), timeout=30)


def answer_question(session_id, call_id, answers):
    """回答会话挂起的提问（dsh 原生格式）。

    answers 为 `[{"id": 题 id, "selected": [选项标签...], "custom": 自由文本}]`
    ——插件侧转成 `ctx.userQuestions.answer(agent, callId, {answers})`，
    即 Web GUI 同一条作答通道。call_id 取自 `/live` 或 `/status` 的
    interaction.call_id（= dsh 的 tool callId）。
    返回插件的布尔受理结果（False = 问题已不存在/已答）。
    """
    resp = _request("POST", "/answer",
                    {"session_id": session_id, "call_id": call_id,
                     "answers": answers}, timeout=30)
    return bool(resp.get("accepted"))


# ---------- 事件流（SSE） ----------

def parse_stream_line(line):
    """把一行 SSE 文本解析成帧 dict；注释/空行/非 data 行返回 None。"""
    if not line.startswith("data:"):
        return None
    try:
        return json.loads(line[len("data:"):].strip())
    except ValueError:
        return None


def feed_into(sid, since, waiter, stop_event, on_frame=None):
    """SSE 订阅线程体（runner / chat / board 共用）：把事件帧喂给 TurnWaiter。

    on_frame 为可选的额外处理（如 runner 把帧翻译成轮次日志行）；它抛异常不影响
    等待线程——日志写失败绝不能让轮次收口逻辑失联。链路异常在未主动断开时经
    `waiter.fail()` 上抛（等待方据此收口，而不是无限等）。
    """
    def handle(frame):
        if on_frame is not None:
            try:
                on_frame(frame)
            except Exception:       # 落日志失败不致命：等待线程照常推进
                pass
        waiter.feed(frame)

    try:
        stream(sid, handle, since=since, stop=stop_event.is_set)
    except DshDriverError as e:
        if not stop_event.is_set():     # 主动断开不算异常
            waiter.fail(str(e))


def stream(session_id, on_frame, since=0, stop=None, idle_timeout=STREAM_IDLE_TIMEOUT):
    """订阅会话事件流（阻塞直到 stop() 为真、链路结束或空闲超时）。

    - on_frame(frame)：每收到一帧调用一次（调用方在此落日志/唤醒等待者）；
    - stop()：可选回调，返回 True 即主动断开（用于任务停止/超时收口）；
    - since：从该 seq 之后开始（会话池 ring 补发），避免重连后重复消费历史帧；
    - idle_timeout：超过该时长没有任何字节（含 keepalive 注释）判定链路僵死并抛错。

    返回 (帧数, 最后 seq)。链路断开/超时抛 DshDriverError。
    """
    return _stream_events(urllib.parse.urlencode({"session_id": session_id,
                                                  "since": int(since)}),
                          on_frame, since=since, stop=stop, idle_timeout=idle_timeout)


def state_stream(on_frame, since=0, stop=None, idle_timeout=STREAM_IDLE_TIMEOUT):
    """订阅**全局状态流**（`?scope=state`，P4 事件化；dshevents.EventHub 的唯一连接）。

    帧形 `{seq, time, type, session_id, data}`，type ∈ `session/created|disposed`、
    `driver/attached|detached`、`agent/status`、`turn/start|end`、`driver/interaction`。
    语义与 `stream()` 一致（since 续传、stop 主动断开、空闲超时判僵死）。
    """
    return _stream_events(urllib.parse.urlencode({"scope": "state", "since": int(since)}),
                          on_frame, since=since, stop=stop, idle_timeout=idle_timeout)


def _stop_watcher(stop, sock, done, interval=STOP_WATCH_INTERVAL):
    """旁路看门线程：stop() 置位即 shutdown 连接，唤醒阻塞在 read1 的订阅线程。

    为什么需要它（P7a 缺陷 C）：read1 阻塞期间订阅线程无法观察 stop()（原实现只
    在 read1 返回后才检查，真插件 keepalive 15s ⇒ 收尾白等满 join timeout）；
    而「缩短 socket 读超时 + 超时重试」不可行——SocketIO 超时即永久毒化
    （_timeout_occurred=True，之后任何读都抛 cannot read from timed out object）。
    shutdown(SHUT_RDWR) 是标准库下唯一能**跨线程**唤醒阻塞 recv 的手段：recv 立刻
    返回 0（EOF）或以连接被断报错，订阅线程据 stop() 判定「主动断开」正常收尾。
    本线程随流结束（done 置位）退出，daemon 化不阻碍进程收尾。
    """
    while not done.is_set():
        if stop():
            try:
                if sock is not None:
                    sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            return
        done.wait(interval)


def _stream_events(query, on_frame, since=0, stop=None, idle_timeout=STREAM_IDLE_TIMEOUT):
    """SSE 消费循环（会话流与全局状态流共用）。

    停止响应（P7a 缺陷 C）：stop 置位后由 _stop_watcher 断开连接，订阅线程秒级
    退出（不再等下一帧 keepalive，见 STOP_WATCH_INTERVAL）；主动断开不算链路
    异常——由 stop() 复核区分「我关的」与「对端关的」。
    空闲超时语义不变：idle_timeout 秒无任何字节（含 keepalive 注释）抛
    DshDriverError(-2, 事件流空闲超时…)，等待方据此收口。
    """
    if not configured():
        raise DshDriverError(-1, "未配置 dsh agent 驱动（非插件形态或插件未下发驱动地址）")
    host, port, base = _split_url()
    conn = http.client.HTTPConnection(host, port, timeout=idle_timeout)
    frames = 0
    last_seq = int(since)
    stop_done = threading.Event()
    resp = None
    try:
        conn.request("GET", f"{base}/events?{query}", headers={
            **_headers(), "accept": "text/event-stream"})
        # 先留一份 socket 引用再 getresponse：will_close 响应（无 content-length、
        # 非 chunked 的「以连接关闭收尾」型，tests/fakedriver.py 的假驱动即此形态）
        # 会让 getresponse 内部 close() 连接并把 conn.sock 置空，看门线程就再也
        # 拿不到 socket；真插件是 chunked（will_close=False）不受影响。
        sock = conn.sock
        resp = conn.getresponse()
        if resp.status != 200:
            detail = resp.read().decode("utf-8", errors="replace")
            raise DshDriverError(resp.status, f"事件流被拒: {detail[:200]}")
        # 连接与响应头阶段用完整 idle_timeout；进入流式读之后挂 stop 看门线程
        if stop is not None:
            threading.Thread(target=_stop_watcher, args=(stop, sock, stop_done),
                             name="dsh-stream-stop", daemon=True).start()
        buffer = ""
        while True:
            if stop is not None and stop():
                break
            try:
                # 必须用 read1（"至多一次底层读"）：HTTPResponse.read(n) 对 chunked
                # 响应会**攒够 n 字节才返回**，长连 SSE 下每帧几百字节，read(4096)
                # 会一直阻塞到连接关闭——实测踩中（真机冒烟：事件齐发但一帧未收）
                chunk = resp.read1(65536)
            except socket.timeout as e:
                if stop is not None and stop():      # 与主动断开同时到期：按主动处理
                    break
                raise DshDriverError(-2, f"事件流空闲超时（>{idle_timeout}s 无数据）") from e
            except (OSError, http.client.HTTPException) as e:
                # shutdown 唤醒的阻塞读可能以 OSError（连接被断）或 IncompleteRead
                # （chunked 流被截断）形式回来：主动断开不算链路异常
                if stop is not None and stop():
                    break
                raise DshDriverError(-2, f"事件流读取失败: {e}") from e
            if not chunk:
                # shutdown 让 recv 返回 EOF（b""）：主动断开同样不算异常
                if stop is not None and stop():
                    break
                raise DshDriverError(-2, "事件流被对端关闭")
            buffer += chunk.decode("utf-8", errors="replace")
            while "\n\n" in buffer:
                block, buffer = buffer.split("\n\n", 1)
                for line in block.split("\n"):
                    frame = parse_stream_line(line.strip())
                    if frame is None:
                        continue
                    frames += 1
                    seq = frame.get("seq")
                    if isinstance(seq, int) and seq > last_seq:
                        last_seq = seq
                    on_frame(frame)
    finally:
        stop_done.set()
        # will_close 响应下 conn.close() 是空操作（socket 归 resp 所有），显式关掉
        # 响应才能确定性地释放连接，不等 GC
        try:
            if resp is not None:
                resp.close()
        except OSError:
            pass
        try:
            conn.close()
        except OSError:
            pass
    return frames, last_seq


# ---------- 轮次等待（runner/chat 共用） ----------

# 判定「本轮的 turn 结束」的帧类型
TURN_END = "turn/end"
# 判定「会话进入等人工输入（提问/审批）」的帧类型
INTERACTION = "driver/interaction"


def turn_exit_code(reason):
    """turn/end 的 reason.kind → 平台轮次退出码（与 kimi_web 口径对齐）。"""
    return {"completed": 0, "aborted": 130}.get(reason or "", 1)


class TurnWaiter:
    """一轮的事件收集器：在 SSE 回调里落日志、抓 turn/end、记录挂起交互。

    线程安全：`feed()` 由 SSE 读取线程调用，`wait_turn()` 由轮次主线程调用；
    两者通过 Condition 同步——等待是**条件变量阻塞**而不是轮询远端状态，
    这正是方案 §3.3「事件驱动替代轮询」在任务/消息侧的落点。
    """

    def __init__(self):
        self._cond = threading.Condition()
        self._done = False
        self.started = False            # 是否见过 turn/start（判定「turn 压根没起来」）
        self.exit_code = None           # turn/end 换算出的退出码（None = 尚无结论）
        self.turn_reason = None
        self.interaction = None         # 挂起等作答实况（consume-on-read：读后清零）
        self.error = None               # SSE 链路错误

    def feed(self, frame):
        """处理一帧：更新 seq、判定 turn 结束与挂起交互，并唤醒等待者。"""
        with self._cond:
            ftype = frame.get("type")
            if ftype == "turn/start":
                self.started = True
            elif ftype == TURN_END:
                # dsh 的 cancel 落盘 reason=**null**（P0 实测；插件已按 aborted 归一）。
                # 这里再兜一道：装机副本可能是旧版（`file:` 拷贝），null 直落会让
                # 「用户主动中断」被判轮次失败（`turn_exit_code(None)=1`，P7a 真机
                # 实测缺口：状态流已归一、会话流未归一）。
                raw = (frame.get("data") or {}).get("reason")
                reason = raw.get("kind") if isinstance(raw, dict) else raw
                if reason is None:
                    reason = "aborted"
                self.turn_reason = reason
                self.exit_code = turn_exit_code(reason)
                self._done = True
            elif ftype == INTERACTION:
                data = frame.get("data") or {}
                if data.get("state") == "asked":
                    self.interaction = data.get("interaction")
                    self.started = True     # 提问意味着 turn 已在跑
            self._cond.notify_all()

    def fail(self, message):
        """链路异常：落错误并唤醒等待者（wait_turn 返回 'error'）。"""
        with self._cond:
            self.error = message
            self._done = True
            self._cond.notify_all()

    def wait_turn(self, timeout=None):
        """等本轮结论，返回 'turn_end' | 'interaction' | 'error' | 'timeout'。

        'interaction' 为 consume-on-read：返回后 `self.interaction` 已清零，
        调用方要么据此让位、要么记一行日志后继续等（同一轮内可能多次提问）。
        'timeout' 只表示本地等待窗口到期，不代表远端异常——调用方可继续等，
        也可借此窗口检查停止标记（本地集合，不碰远端）。
        """
        deadline = None if timeout is None else time.time() + timeout
        with self._cond:
            while True:
                if self.exit_code is not None:
                    return "turn_end"
                if self.error:
                    return "error"
                if self.interaction is not None:
                    self.interaction = None
                    return "interaction"
                remain = None if deadline is None else deadline - time.time()
                if remain is not None and remain <= 0:
                    return "timeout"
                self._cond.wait(remain if remain is not None else 1.0)
