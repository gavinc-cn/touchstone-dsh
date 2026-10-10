#!/usr/bin/env python3
"""Touchstone 站点服务器：登录鉴权 + 多项目管理 + 任务执行 + 实时监控面板。

仅用 Python 标准库（http.server / sqlite3 / subprocess）。静态页为 webui/dist 的 SPA 构建产物，
登录 /login、应用 /app、监控 /monitor、后台 /admin、日志 /log 由 react-router 前端路由处理，
服务端对这些路径统一回退 index.html。

用法:
    python3 server.py [--port 4601] [--host 127.0.0.1]

默认仅监听回环 127.0.0.1（安全默认，仅本机可访问）；需局域网/远程访问时显式
指定 --host 0.0.0.0（启动器等价用 TS_HOST 环境变量）。

依赖模块: db.py（SQLite 数据层）、auth.py（密码哈希/会话）、agents.py（CLI 扫描）、
runner.py（任务轮次执行）、prompts.py（轮次 prompt）。
"""

import base64
import collections
import faulthandler
import json
import os
import re
import secrets
import signal
import socket
import sqlite3
import string
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote

# 原生崩溃取证（2026-10-09）：本进程 2026-10-08 21:48 在插件形态下两次被 SIGSEGV 带走
# （薄壳只留一行 `sig=SIGSEGV`，无任何 Python 栈）。faulthandler 常开：SIGSEGV/SIGABRT 等
# 致命中止时把**各线程的 Python 栈**打印到 stderr ⇒ 插件形态落 `<库目录>/plugin-backend.log`
# （薄壳逐行落盘）、独立形态落 `.run/server.log`。零成本、不改变任何行为。
faulthandler.enable()

import auth
import board
import builtin_assets
import chat
import db
import dshevents
import dshdriver
import localbus
import feishu
import lib
import lifecycle
import loadcase
import rag
import runner
import sessparse
from agents import scan_agents, scan_skills, DSH_PLUGIN_PREFIX
from lib import norm_status, parse_fields, parse_status_md, read_text

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# 静态页面目录: Vite 构建产物 webui/dist (可用 --web-dir 或环境变量覆盖)
WEB_DIR = os.environ.get("TS_WEB_DIR") or os.path.join(BASE_DIR, "webui", "dist")
PROJECTS_DIR = os.path.join(BASE_DIR, "projects")
# 启停运行产物（与 touchstone.py / touchstone.sh 的 RUN_DIR 同目录）：实际监听端口落盘
# .run/server.port，touchstone 脚本探活与展示按它读取（端口自动顺延后须能感知）。
# TOUCHSTONE_RUN_DIR 供 e2e 隔离实例重定向（默认 .run 与真实启停共用，
# e2e spawn 的 server 不得污染真实实例的端口标记）
RUN_DIR = os.environ.get("TOUCHSTONE_RUN_DIR") or os.path.join(BASE_DIR, ".run")
PORT_FILE = os.path.join(RUN_DIR, "server.port")
PORT_RETRY = 10  # 端口绑定失败时自动 port+1 顺延重试的上限（次数）

# dsh 插件形态免登（--trust-internal-user 开启时生效）：Node 薄壳反代请求统一
# 注入该头（值恒为 admin），_current_user 视为 admin 已登录；多用户隔离逻辑不变
TRUST_USER_HEADER = "X-TS-Internal-User"
TRUST_INTERNAL_USER = False  # 由 main() 按 --trust-internal-user 置位（仅限回环监听）

# dsh 会话级权限档映射（2026-10-03 P3 第二批；2026-10-04 常量搬到 dshdriver ——
# board/runner 起会话时也要按**项目默认值**应用权限档，而 server 反向依赖 board
# （循环导入），映射只能由最底层的驱动模块持有；此处保留同名别名，既有引用不变）。
# manual 逐条确认 ↔ workspace-write（sandbox=workspace-write + approval=ask；平台随即
# 接管该会话审批代答，见 board.answer_approval / dshdriver.set_permission）；
# yolo 自动通过 / auto 完全自主 ↔ danger-full-access（approval=never，本机默认档）。
# ⚠️ 这是**语义近似**：dsh 的 preset 是 sandbox×approval 组合，与平台三档并不一一
# 对应（yolo 与 auto 落到同一档）；UI 改用 dsh 原生 preset 名的下拉是后续细化项。
DSH_PERMISSION_PRESETS = dshdriver.PERMISSION_PRESETS
# 反向近似（宿主 preset → 平台三档）：仅用于「平台没记过档位」的会话（用户在 dsh 侧
# 直跑后被接管的卡会话）。正向映射本就多对一（yolo/auto 同 preset），反查统一取 yolo
# 作展示；平台自己切过的会话以驱动记下的 mode 为准，不走这里。
DSH_PRESET_MODES = dshdriver.PRESET_MODES
# 思考等级合法值白名单（dsh reasoningEffort）：项目默认值与会话级切换都校验它
DSH_EFFORT_LEVELS = dshdriver.EFFORT_LEVELS


def normalize_effort(value):
    """思考等级取值归一（项目默认值/会话切换共用）。

    ''（或 None/空白）=不指定（沿用智能体默认）；白名单内的值原样返回；
    非法值返回 None，调用方据此报 400（**不静默丢弃**——静默丢弃会让用户以为
    设置生效了，实际上宿主仍按默认档跑）。
    """
    v = str(value or "").strip()
    if not v:
        return ""
    return v if v in DSH_EFFORT_LEVELS else None


def normalize_permission_mode(value):
    """权限档取值归一（项目默认值用）：''=不指定；manual/yolo/auto 原样；非法返回 None。"""
    v = str(value or "").strip()
    if not v:
        return ""
    return v if v in DSH_PERMISSION_PRESETS else None

# 用例文件夹名：FS0004_用例名称
CASE_DIR_RE = lib.CASE_DIR_RE
# 各层 INDEX.md 用例一览表行：| FS0004 | 名称 | 测试点 | 状态 | 关联 bug_report |
CASE_ROW_RE = re.compile(r"^\|\s*(FS\d{4})\s*\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|", re.M)
# INDEX.md 首行引用作为目录描述：> xxx
DESC_RE = re.compile(r"^>\s*(.+)$", re.M)
# bug_report 目录名时间戳前缀：20260822_2027_FS_描述
BUG_DIR_RE = re.compile(r"^\d{8}_\d{4}_(.+)$")

# ~/.dsh/settings.yaml 的 agent-default-model 段: provider 行后的 model 行
DSH_DEFAULT_MODEL_RE = re.compile(
    r"^agent-default-model:[ \t]*$\n^[ \t]+provider:[ \t]*\S+[ \t]*$\n"
    r"^[ \t]+model:[ \t]*([^\n#]+)", re.M)
# 模型列表缓存: agent_path -> (ts, 结果)。宿主 /models 列举与配置回读都走它，
# 60s TTL 避免每次打开项目弹窗/会话窗都打一次驱动。
_MODELS_CACHE = {}
_MODELS_CACHE_TTL = 60.0


def _dsh_default_model():
    """读 dsh(DeepSeek Harness) 默认模型（~/.dsh/settings.yaml 的
    agent-default-model.model），失败返回 ''。"""
    try:
        conf = os.path.expanduser("~/.dsh/settings.yaml")
        if os.path.isfile(conf):
            with open(conf, encoding="utf-8", errors="replace") as f:
                m = DSH_DEFAULT_MODEL_RE.search(f.read())
                if m and m.group(1).strip():
                    return m.group(1).strip().strip("\"'")
    except Exception:
        pass
    return ""


def _dsh_plugin_models(cache_key):
    """dsh 插件族模型列表（P6，2026-10-03；2026-10-03 二次修订：值与显示分离）。

    **值**（`name`）= `provider/<模型 id>`：宿主 `selectModel` 的可用性校验按 **id**
    严格匹配（`dsh-api-session-controller` 的 `modelAvailable` → `models.some(
    m => m.id === selection.model)`），传显示名会被判 `session/model-unavailable`；
    provider 前缀供平台侧拆开下传（`dshdriver.split_model`），`/session` 端点不拆
    `provider/model`，只有 `/model` 会拆。

    **显示**（`display_name`）= `provider/<显示名>`：同一 id 在两个 provider
    （deepseek-official / deepseek-account）下都有，不带前缀无法区分；description
    不参与展示（原先塞进 display_name，会让下拉出现「只有一行英文描述、没有模型名」
    的项，2026-10-03 实测确认为困惑来源）。

    `default` 仍为 `provider/<id>`（宿主部署默认值），前端按值在列表里查 display_name
    做占位文案。结果同样进 `_MODELS_CACHE`（60s）。

    2026-10-04（项目级思考等级）：每项再透传宿主的**可选思考等级**
    `efforts: [{id, name}]` 与 `default_effort`（宿主模型目录 `reasoning.efforts /
    reasoning.defaultEffort`）——前端「思考等级」下拉据此只列该模型真正支持的档位
    （宿主对不支持的档位直接抛 `UNSUPPORTED_REASONING_EFFORT`，不能瞎列）。
    老版本插件不上报这些字段时两个键为空，前端回落内置档位表。
    """
    hit = _MODELS_CACHE.get(cache_key)
    if hit and time.time() - hit[0] < _MODELS_CACHE_TTL:
        return hit[1]
    models = []
    default = ""
    try:
        catalog = dshdriver.models()
    except dshdriver.DshDriverError:
        return {"models": [], "default": ""}       # 驱动不可用：空列表（下拉回落默认）
    for group in catalog.get("groups") or []:
        provider = str((group or {}).get("id") or "")
        for m in (group or {}).get("models") or []:
            mid = str((m or {}).get("id") or "").strip()
            label = str((m or {}).get("name") or "").strip() or mid   # 显示名缺省回落 id
            if not (mid or label):
                continue
            model_id = mid or label
            # 思考等级选项（模型支持哪些档位）：只认 id 落在平台白名单内的项，
            # 名字缺省回落 id（宿主给的是首字母大写的英文名，如 High）
            efforts = []
            for e in ((m or {}).get("efforts") or []):
                eid = str((e or {}).get("id") or "").strip()
                if eid not in DSH_EFFORT_LEVELS:
                    continue
                efforts.append({"id": eid,
                                "name": str((e or {}).get("name") or "").strip() or eid})
            models.append({"name": f"{provider}/{model_id}" if provider else model_id,
                           "display_name": f"{provider}/{label}" if provider else label,
                           "efforts": efforts,
                           "default_effort": str((m or {}).get("default_effort") or "")})
    sel = catalog.get("default") or {}
    if sel.get("provider") and sel.get("model"):
        default = f"{sel['provider']}/{sel['model']}"
    result = {"models": models, "default": default}
    _MODELS_CACHE[cache_key] = (time.time(), result)
    return result


def agent_models(agent_path):
    """列出指定 agent 可用的模型，供项目/任务的模型下拉选择。

    单族世界（P7b）：只剩 `dsh_plugin` —— 模型目录来自 dsh 宿主（驱动 `/models`，
    值与显示分离，见 `_dsh_plugin_models`）。空 agent_path（db 默认 ''）与未知路径
    都归默认族 dsh_plugin，但路径串本身无驱动信息（驱动地址经环境下发），故不列模型、
    只回读 dsh 部署默认模型（~/.dsh/settings.yaml）。退场族的存量路径（agent_family
    归 `retired`）同样只回读默认模型——项目改绑 dsh 插件后即走上面那一支。
    返回 {"models": [{"name", "display_name"}], "default": 默认模型名}（缓存 60s）。
    """
    ap = (agent_path or "").strip()
    # dsh 插件族：模型列表走宿主驱动
    if ap.startswith(DSH_PLUGIN_PREFIX):
        return _dsh_plugin_models(ap)
    hit = _MODELS_CACHE.get(ap)
    if hit and time.time() - hit[0] < _MODELS_CACHE_TTL:
        return hit[1]
    result = {"models": [], "default": _dsh_default_model()}
    _MODELS_CACHE[ap] = (time.time(), result)
    return result


def effective_model(task_id, model):
    """任务实际使用的模型名：
    1) 任务显式指定(创建/更新时的 model 字段)；
    2) 首轮日志 ### CMD 行中的 -m/--model 参数（存量 CLI 轮次日志）；
    3) dsh 部署默认模型（~/.dsh/settings.yaml 的 agent-default-model）。
    返回 '' 表示完全无法判定（前端显示“默认”回退文案）。
    """
    model = (model or "").strip()
    if model:
        return model
    try:
        # 日志 CMD 提取（只查首轮首行 CMD，避免多次读文件）
        for r in db.list_rounds(task_id):
            path = r["log_path"]
            if not path or not os.path.isfile(path):
                continue
            with open(path, encoding="utf-8", errors="replace") as f:
                for line in f:
                    if line.startswith("### CMD "):
                        m = re.search(r"(?:-m|--model)\s+(\S+)", line)
                        if m:
                            return m.group(1)
                        break
            break
    except Exception:
        pass
    # dsh 部署默认模型（dsh 插件族不做本地子进程，会话实际模型由会话窗 meta 回读）
    return _dsh_default_model()


def family_capabilities(family):
    """session 窗口能力声明（前端按此渲染输入区/按钮）。

    dsh_plugin（唯一族，路线 A）：会话常驻 dsh 宿主进程内、事件流实时推送，
    chat/queue/steer/abort/compact/fork/rewind/profile/permission 全开
    （followup 忙时排进 agent inbox = 服务端排队，steer 注入最近 step 边界）；
    events=True（插件全局状态流），会话窗口据此事件化、零轮询。
    已退场族（kimi_web / opencode_web / CLI 各族，P7b 删除）一律返回全 False 的
    能力位：前端据此隐藏输入区，服务端 chat 端点也按「族已下线」拒绝。
    """
    if family == "dsh_plugin":
        # P3（2026-10-03）：compact（驱动 /compact 命令）、fork（宿主
        # sessionController.fork）、profile=会话级**模型**切换（/model）、
        # permission=**权限档**切换（/permission → permissionPresets.set，档位
        # 用 DSH_PERMISSION_PRESETS 语义近似映射；ask 档下平台接管审批代答）。
        return {"stream": True, "chat": True, "queue": True,
                "steer": True, "abort": True, "compact": True,
                "fork": True, "rewind": True, "profile": True, "permission": True,
                # events=True：本族有推送通道（插件全局状态流），会话窗口可事件化
                "events": True}
    return {"stream": False, "chat": False, "queue": False,
            "steer": False, "abort": False, "compact": False,
            "fork": False, "rewind": False, "profile": False, "permission": False,
            "events": False}


def _sess_family(family):
    """sessparse 解析族：dsh_plugin 的会话就是 dsh 宿主的会话
    （~/.dsh/sessions/<bucket>/session-<uuid>/），按 `dsh` 解析族读取
    （P7b B5 单族化：遗留族名 `deepseek` 已改名 dsh）；其余族原样返回——已退场族
    由 `sessparse.FAMILIES` 白名单统一拒绝。"""
    return {"dsh_plugin": "dsh"}.get(family, family)


def _dsh_live_sid(cwd):
    """dsh 插件族「运行中会话」精确探测：读插件内存态（零 mtime 启发式）。

    路线 A 起 sid 由插件在轮次开始即回执并入库（runner._run_round_dshplugin），
    本函数只覆盖「建会话请求已发出、db 尚未写入」的毫秒级窗口；命中判据 =
    驱动池自持（owned）+ cwd 匹配 + 最近创建。驱动不可用返回空串（交既有
    各族探测路径兜底，调用方不因此报错）。
    """
    try:
        rows = dshdriver.live()
    except dshdriver.DshDriverError:
        return ""
    want = (cwd or "").rstrip("/")
    best, best_ts = "", -1
    for row in rows:
        if not row.get("owned"):
            continue
        if want and (row.get("cwd") or "").rstrip("/") != want:
            continue
        ts = int(row.get("started_at") or 0)
        if ts > best_ts:
            best, best_ts = row.get("session_id", ""), ts
    return best


def _project_busy(project_id):
    """项目是否已有单元在跑（统一队列视角：运行前缀窗口已满，外部条目 ext 行
    作为前缀成员天然计入）。

    会话端点 meta 下发 `project_busy`：前端据此把发送按钮/占位文案切到「排队」
    （消息本身由 chat.submit 登记统一队列，服务端不依赖该字段做仲裁）。
    runner 缺位（单测/独立脚本）或异常按 False（不阻塞前端展示）。
    """
    inst = runner.INSTANCE
    if inst is None or not project_id:
        return False
    try:
        return bool(inst.unit_busy(project_id))
    except Exception:
        return False


def _unit_state(project_id, key):
    """单元在统一队列中的态（会话详情页标题「队列」徽标）：runner.unit_state 直读。

    任务会话传 `t:<task_id>`、看板卡片会话传 `c:<card_id>`；runner 缺位
    （单测/独立脚本）或异常返回 None——前端按「未下发」不渲染徽标。
    已作答·待送达的卡片（board.is_answer_pending）改按 `a:<cid>` 键求值
    （P6 解冻，2026-09-21——P2 冻结覆盖 {"state":"queued","pos":0,"total":0}
    到期）：waiting 行按 seq 计真实 pos/total（**v2a T4 起位次含运行前缀，
    前缀成员=行**，裁决 R7：pos=前缀成员数
    （项目内 starting/running/finishing 行）+等待区排号）；
    a: 行恰为 starting（送达中）时数不到 waiting 行落 idle——与 worker 正在
    送达的实况一致。
    `m:` 消息单元（P3）的位次同为真实值（P4 起位次由 wait_items 表驱动）。
    """
    inst = runner.INSTANCE
    if inst is None or not project_id:
        return None
    if key.startswith("c:"):
        try:
            cid = int(key[2:])
        except ValueError:
            cid = None
        # P6 解冻（P2 不变量③「不给 answer 真实位次（留 P6）」到期）：
        # answer 等待项按 a:<cid> 键求真实位次（形状 {"state","pos","total"} 不变）
        if cid is not None and board.is_answer_pending(cid):
            key = f"a:{cid}"
    try:
        return inst.unit_state(key, project_id)
    except Exception:
        return None


def _board_session_running(owner_cid, proj, sid):
    """board 会话运行态（会话端点 meta.running；前端「工作中…」脉冲与输入区分态源）。

    平台在管运行（runner.running_map）或会话实况 busy（含用户在 dsh 侧直跑的
    同步卡）。已作答·待送达（答案排队，2026-09-14）：平台已收下答案、等空闲送达，
    会话实况仍 busy（提问挂起中）但不算运行——返回 False，前端不点亮运行态、
    头部「队列」徽标走排队中（与看板卡「排队中」徽标同源）。无卡/查询失败按 False。
    """
    if not owner_cid:
        return False
    if board.is_answer_pending(owner_cid):
        return False
    if board.running_map().get(owner_cid):
        return True
    return board.web_session_busy(proj, sid)


def _session_owned(sid):
    """会话归属（会话端点 meta.owned；C 批 T8，2026-10-10）：**三态**返回。

    - `True`  = 平台自持（驱动池内会话）：平台的停止/中断本来就有效，前端照现状渲染；
    - `False` = 外部会话（用户在 dsh GUI 里直跑/接管）：轮次由 dsh GUI 持有，平台停不了，
                前端据此出「外部会话」提示条并把「停止」置灰；
    - `None`  = 注册表未知（未连接 / 热重载后 /live 未对齐 / 没见过该 sid）：前端
                **按「池内」渲染**，与现状一致——「未知 ≠ 外部」是本批统一判定阶梯，
                绝不据不可信快照反向推断成外部会话。

    判定阶梯与投递前置闸 `chat._external_preflight` 的第 ②③④ 步逐条对齐（未知放行、
    不可信快照放行、owned 为真放行，其余才是外部）。

    为什么不是 `bool(...)`：外部会话上报的也是 `owned:false`，与「注册表未知」的兜底
    值撞车——布尔下发会让断连/未对齐窗口里的池内会话被误判成外部（误出提示条，还误
    停用「停止」/「取消排队」）。故未知一律下发 `None`，把「未知 ≠ 外部」落进线上格式。
    """
    st = dshevents.get(sid)
    if st is None or not dshevents.aligned():
        return None
    return bool(st.get("owned"))


def _session_permission_mode(state):
    """会话级权限档（会话窗「权限」控件的数据源，2026-10-04 修恒置灰）。

    `state` = `dshevents` 注册表里的会话实时态（`permission` 由插件的
    `driver/permission` 状态帧折入，见 dshevents）。取值优先级：

    1. `mode`——平台三档 manual/yolo/auto（驱动随写记下，唯一能区分 yolo/auto 的
       来源，二者落到同一宿主 preset）；
    2. 反查 `preset`——宿主 preset 实况（会话在平台外被改过，或插件是老版本）；
       经 DSH_PRESET_MODES 近似映射。danger-full-access 反查取 yolo。

    两者都无 → 返回空串（调用方不下发 `permission`，前端保持置灰：**不猜**）。
    """
    perm = (state or {}).get("permission") or {}
    mode = str(perm.get("mode") or "")
    if mode:
        return mode
    return DSH_PRESET_MODES.get(str(perm.get("preset") or ""), "")


def _session_queue_state(project_id, unit_state, running=False,
                         answer_pending=False, server_queued=False,
                         starting=False, interaction_pending=False):
    """session meta 的 queue_state 派生（看板会话 REST 与任务会话 SSE 同源；
    裁决 R2/R10 会话级判定序，枚举值见 board.QS_*；v2a T4 加 starting 七枚举，
    裁决 R6；2026-09-25 加 interaction_pending 八枚举）。

    判定序（高→低）：answer_pending > server_queued > interaction_pending
    > running > starting > queued_serial/foreign_busy > idle。
    - answer_pending/server_queued/interaction_pending 仅看板卡片会话在场
      （任务会话恒 False，按 unit_state/外部条目行退化为 running/queued_serial/
      foreign_busy/idle 四态）；
    - running 为调用方口径（_board_session_running，含外部实况 busy）；
      unit_state=running（本单元有运行中行）同样判 running；
    - starting（板卡已交 runner、会话未证实运行的启动宽限窗口）：c: 行
      starting 由调用方判给（board.card_starting）；**行口径的
      unit_state=running**——证实运行前徽标报「启动中」而非「运行中」；
      任务会话恒 False（starting 不抑制 unit_state 的 running，现状保持）；
    - queued 分叉：unit_state=queued 时按外部条目行（board.ext_active，
      项目活跃 ext 行在场=外部会话在跑）分
      foreign_busy/queued_serial——走到 queued 分支即本单元无运行中行（非占位者），
      前方位次来自他单元→串行位、来自外部会话（外部条目 ext 行）→foreign_busy。
    """
    if answer_pending:
        return board.QS_ANSWER
    if server_queued:
        return board.QS_SERVER
    if interaction_pending:
        return board.QS_INTERACTION
    st = (unit_state or {}).get("state")
    if running:
        return board.QS_RUNNING
    if starting:
        return board.QS_STARTING
    if st == "running":
        return board.QS_RUNNING
    if st == "queued":
        if project_id and board.ext_active(project_id):
            return board.QS_FOREIGN
        return board.QS_QUEUED
    return board.QS_IDLE


# ROUNDS.md 角度覆盖表行：| 第 1 轮 | 时间 | 阅读范围 | 角度 | FS0001~FS0015（15 条） | 2 |
ROUND_ROW_RE = re.compile(
    r"^\|\s*第\s*(\d+)\s*轮\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|\s*(\d+)\s*\|", re.M)
# ROUNDS.md 轮次明细小节标题：### 第 1 轮（2026-08-22）
ROUND_SEC_RE = re.compile(r"^###\s*第\s*(\d+)\s*轮[^\n]*$", re.M)
# 明细小节执行统计：'通过 16 / 失败 0 / 跳过 0'
EXEC_STAT_RE = re.compile(r"通过\s*(\d+)\s*/\s*失败\s*(\d+)(?:\s*/\s*跳过\s*(\d+))?")
# 角度表入库用例数：'（15 条）'
CASES_COUNT_RE = re.compile(r"（\s*(\d+)\s*条\s*）")

# 静态页白名单（API 之外可公开访问的页面）
PUBLIC_PAGES = {"/login"}

# 「首次登录强制改密」白名单：must_change_pw=1 的账号只放行这三个端点，其余 API 一律 403
# （2026-10-02：未设 TS_ADMIN_PASSWORD 时种子口令改为随机生成，登录后必须先改密）
# 2026-10-08 增例外：dsh 插件形态的免登信任头路径**整体跳过**此门（见 _must_change_pw_blocked）
MUST_CHANGE_PW_ALLOW = ("/api/auth/me", "/api/auth/change_password", "/api/auth/logout")

# 压测指标 SSE 首次连接的回放行数上限（2026-09-19 压测面板重构批次）：
# tidy 指标通道每秒可有几十行（指标×维度），全量回放对长任务既慢又无意义
# （前端点数预算也会截断早期数据），故只补最后这一段，其余按增量续推。
LOAD_STREAM_REPLAY_MAX = 20000

# 任务类型合法值（reject=修例：报告被拒绝后按理由修正关联用例并沉淀教训；
# script_retest=脚本复测：不对外暴露，创建 retest_scope=仅复测 且关联用例全固化时自动转换；
# regression=回归：按必填指令重跑存量用例；pipeline=后段：探索/回归终点>生成报告时
# 平台自动创建的后续任务，不对外暴露）
TASK_TYPES = {"normal", "fix", "retest_bug", "reject", "script_retest", "stress",
              "regression", "pipeline"}

# ---------- 生命周期阶段（七阶段；与 webui/src/components/TasksTab.jsx 的 STAGES 一致） ----------

# 阶段 key（有序，index 即先后）；runner/prompts 因防循环依赖各自定义同值常量
STAGES = ("gen_case", "execute", "report", "analyze", "fix", "deploy", "retest")
STAGE_LABELS = {"gen_case": "测试用例生成", "execute": "测试", "report": "生成报告",
                "analyze": "报告分析", "fix": "问题修复", "deploy": "重新部署",
                "retest": "复测"}

# 类型 × 阶段矩阵：start=固定起点；default=终点缺省；ends=可选终点集合（空=不涉及
# 终点选择）。stress 的两步执行链路特殊（agent 场景轮+平台发压轮），不落阶段列；
# retest_bug 的范围来自 retest_scope 三选一映射（RETEST_SCOPES）
STAGE_MATRIX = {
    "normal":        {"start": "gen_case", "default": "report",
                      "ends": ("gen_case", "execute", "report", "analyze", "fix",
                               "deploy", "retest")},
    "regression":    {"start": "execute", "default": "report",
                      "ends": ("execute", "report", "analyze", "fix", "deploy", "retest")},
    "stress":        {"start": "", "default": "", "ends": ()},
    "fix":           {"start": "analyze", "default": "fix",
                      "ends": ("analyze", "fix", "deploy", "retest")},
    "retest_bug":    {"start": "", "default": "", "ends": ()},
    "reject":        {"start": "", "default": "", "ends": ()},
    "script_retest": {"start": "", "default": "", "ends": ()},
    "pipeline":      {"start": "analyze", "default": "", "ends": ()},
}

# 复测范围三选一 → (start_stage, end_stage)
RETEST_SCOPES = {"retest_only": ("retest", "retest"),
                 "deploy_retest": ("deploy", "retest"),
                 "deploy_only": ("deploy", "deploy")}

# 提交日期范围（复测/探索/回归可选）：YYYY-MM-DD，from<=to；空串=不限
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _norm_date_range(date_from, date_to):
    """校验日期范围，(from, to, err)；非法时 err 非空（并返回单值兜底）。"""
    try:
        if date_from and not DATE_RE.match(date_from):
            return "", "", "bad date_from"
        if date_to and not DATE_RE.match(date_to):
            return "", "", "bad date_to"
        if date_from and date_to:
            from_d = time.strptime(date_from, "%Y-%m-%d")
            to_d = time.strptime(date_to, "%Y-%m-%d")
            if from_d > to_d:
                return "", "", "from > to"
    except ValueError:
        return "", "", "bad date"
    return date_from, date_to, ""


def _resolve_stages(task_type, body):
    """按类型解析创建请求的 (start_stage, end_stage, err)。

    ends 为空（stress/reject/script_retest/pipeline/retest_bug）返回 ("", "", None)；
    终点不在可选集合时 err 为错误文案。
    """
    spec = STAGE_MATRIX.get(task_type) or {}
    if not spec.get("ends"):
        return ("", "", None)
    end = (str(body.get("end_stage") or "").strip() or spec["default"])
    if end not in spec["ends"]:
        return ("", "", "end_stage 非法")
    return (spec["start"], end, None)

# 用户名合法格式：2-32 位字母/数字/下划线/点/横杠
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.\-]{2,32}$")


def _pw_str(val):
    """密码入参规范化：非字符串（JSON null、数字等）一律按空串处理。

    客户端显式传 "password": null 时 dict.get 的默认值不生效，None 会一路
    传进哈希/比对函数在 .encode/.len 处崩掉（无响应断连），此处统一收口。
    """
    return val if isinstance(val, str) else ""


def _req_str(val):
    """请求输入字段字符串规范化：非字符串（JSON 数组/数字/null 等）一律按空串处理。

    与 _pw_str 同理，防止 list/dict/int 等类型在 .strip()/数据库参数绑定处
    抛未捕获异常导致连接被服务端关闭（无 HTTP 响应）。
    """
    return val if isinstance(val, str) else ""


# ---------------------------------------------------------------------------
# 扫描层文件缓存

# 状态聚合每拍(TTL 1s)全量扫盘; 按 (mtime_ns, size) 缓存解析结果,
# 文件未被改写时不再重复读取/解析(runner 写入会改 mtime, 缓存自动失效)
_FILE_CACHE = {}


def cached_file(path, loader):
    """按 (mtime_ns, size) 缓存 loader(path) 的结果; stat 失败(文件不存在)时不缓存。

    内存上界约为案例库全部小文件之和(几 MB), 可接受; 删除的用例目录残留条目
    量级极小, 不主动清理。
    """
    try:
        st = os.stat(path)
        stamp = (st.st_mtime_ns, st.st_size)
    except OSError:
        _FILE_CACHE.pop(path, None)
        return loader(path)
    hit = _FILE_CACHE.get(path)
    if hit and hit[0] == stamp:
        return hit[1]
    value = loader(path)
    _FILE_CACHE[path] = (stamp, value)
    return value


def parse_index_cases(text):
    """从 INDEX.md 表格解析 id -> (名称, 测试点)，索引里的名称/测试点比目录名更准确。"""
    result = {}
    for m in CASE_ROW_RE.finditer(text):
        name = m.group(2).strip()
        point = m.group(3).strip()
        if name and name != "—":
            result[m.group(1)] = (name, point if point != "—" else "")
    return result


def scan_dir(path, rel):
    """递归扫描案例库目录，生成嵌套树（分类目录 -> children / cases）。跳过隐藏目录（如 .live）。"""
    node = {"name": os.path.basename(path), "path": rel, "desc": "", "children": [], "cases": []}
    index_cases = {}
    index_path = os.path.join(path, "INDEX.md")
    index_text = cached_file(index_path, read_text)
    if index_text:
        m = DESC_RE.search(index_text)
        if m:
            node["desc"] = m.group(1).strip()
        index_cases = parse_index_cases(index_text)
    try:
        entries = sorted(os.listdir(path))
    except OSError:
        return node
    for entry in entries:
        if entry.startswith("."):
            continue
        full = os.path.join(path, entry)
        if not os.path.isdir(full):
            continue
        m = CASE_DIR_RE.match(entry)
        if m and os.path.isfile(os.path.join(full, "status.md")):
            case = {"id": m.group(1), "name": m.group(2), "point": "",
                    "relpath": os.path.join(rel, entry)}
            case.update(cached_file(os.path.join(full, "status.md"), parse_status_md))
            if m.group(1) in index_cases:
                case["name"], case["point"] = index_cases[m.group(1)]
            node["cases"].append(case)
        elif not m:
            node["children"].append(scan_dir(full, os.path.join(rel, entry)))
    return node


def collect_stats(node, stats):
    """递归统计各状态用例数。"""
    for case in node["cases"]:
        stats["total"] += 1
        key = {"通过": "passed", "失败": "failed", "需要复测": "retest",
               "跳过": "skipped"}.get(case["status"], "pending")
        stats[key] += 1
    for child in node["children"]:
        collect_stats(child, stats)
    return stats


def scan_bugs(bug_dir):
    """扫描 bug_report 目录下测试任务生成的报告（目录名含 _FS_），按时间倒序，最多 50 条。"""
    bugs = []
    try:
        entries = sorted(os.listdir(bug_dir), reverse=True)
    except OSError:
        return bugs
    for entry in entries:
        if "_FS_" not in entry:
            continue
        full = os.path.join(bug_dir, entry)
        if not os.path.isdir(full):
            continue
        report = cached_file(os.path.join(full, "bug_report.md"), read_text)
        fields = parse_fields(report)
        m = BUG_DIR_RE.match(entry)
        bugs.append({
            "dir": entry,
            "title": m.group(1) if m else entry,
            "status": fields.get("状态", ""),
            "cases": sorted(set(re.findall(r"FS\d{4}", report)))[:20],
        })
        if len(bugs) >= 50:
            break
    return bugs


def bug_last_task(tasks, bug_dir):
    """在任务列表中找该 bug 最近的 fix/retest_bug/reject/script_retest 任务（按创建时间倒序已排）。"""
    for t in tasks:
        if t["task_type"] not in ("fix", "retest_bug", "script_retest", "reject"):
            continue
        try:
            if json.loads(t["payload"] or "{}").get("bug_dir") == bug_dir:
                return {"id": t["id"], "task_type": t["task_type"], "name": t["name"],
                        "status": t["status"], "created_at": t["created_at"]}
        except ValueError:
            continue
    return None


def list_project_bugs(project):
    """bug 列表：扫描结果 + 每个 bug 最近的修复/复测/修例任务信息。

    复测通过（已闭环）与已拒绝（被用户否决）的报告沉到列表末尾作为历史报告，
    其余保持扫描出的时间倒序（sorted 稳定，组内相对顺序不变）。
    """
    bugs = scan_bugs(project["bug_dir"])
    tasks = db.list_tasks(project["id"])
    for b in bugs:
        b["last_task"] = bug_last_task(tasks, b["dir"])
    bugs.sort(key=lambda b: 1 if re.search(r"复测通过|已拒绝", b["status"] or "") else 0)
    return bugs


def parse_rounds(root):
    """解析 ROUNDS.md：角度表取 轮次/时间/角度/入库数/新bug，明细小节补 通过/失败/跳过。"""
    text = cached_file(os.path.join(root, "ROUNDS.md"), read_text)
    if not text:
        return []
    detail = {}
    secs = list(ROUND_SEC_RE.finditer(text))
    for i, m in enumerate(secs):
        end = secs[i + 1].start() if i + 1 < len(secs) else len(text)
        em = EXEC_STAT_RE.search(text[m.end():end])
        if em:
            detail[int(m.group(1))] = {"passed": int(em.group(1)), "failed": int(em.group(2)),
                                       "skipped": int(em.group(3) or 0)}
    rounds = []
    for m in ROUND_ROW_RE.finditer(text):
        no = int(m.group(1))
        cm = CASES_COUNT_RE.search(m.group(5))
        item = {"round": no, "time": m.group(2).strip(), "angle": m.group(4).strip(),
                "cases": int(cm.group(1)) if cm else 0, "new_bugs": int(m.group(6)),
                "passed": 0, "failed": 0, "skipped": 0}
        item.update(detail.get(no, {}))
        rounds.append(item)
    return rounds


def load_live(work_dir):
    """读取运行状态文件 <工作目录>/.live/live.json；返回 (内容, mtime)，不存在或解析失败返回 (None, None)。"""
    path = os.path.join(lib.runtime_dir(work_dir, ".live"), "live.json")
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f), os.path.getmtime(path)
    except (OSError, ValueError):
        return None, None


def build_state(root, bug_dir, work_dir):
    """聚合一次完整的 UI 状态。

    root=案例库根（扫案例树/bug），work_dir=工作目录（读 live.json 运行状态）。
    """
    tree = scan_dir(root, ".")
    stats = collect_stats(tree, {"total": 0, "passed": 0, "failed": 0,
                                 "retest": 0, "skipped": 0, "pending": 0})
    live, live_mtime = load_live(work_dir)
    return {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "live": live,
        "live_mtime": live_mtime,
        "library": {"tree": tree, "stats": stats},
        "bugs": scan_bugs(bug_dir),
        "rounds": parse_rounds(root),
    }


class StateCache:
    """按项目缓存聚合状态（TTL 1s），SSE 0.5s 轮询时避免反复扫盘。

    内容指纹在构建时算好一并缓存(剔除 generated_at), SSE 每拍只做字符串比较,
    不再对全量 state 做 json.dumps。
    """

    def __init__(self, ttl=1.0):
        self.ttl = ttl
        self._lock = threading.Lock()
        self._cache = {}  # project_id -> (ts, state, fingerprint)

    def get(self, project_id, root, bug_dir, work_dir):
        with self._lock:
            hit = self._cache.get(project_id)
            if hit and time.time() - hit[0] < self.ttl:
                return hit[1]
        state = build_state(root, bug_dir, work_dir)
        fingerprint = json.dumps(
            {k: v for k, v in state.items() if k != "generated_at"},
            ensure_ascii=False, sort_keys=True)
        with self._lock:
            self._cache[project_id] = (time.time(), state, fingerprint)
        return state

    def fingerprint(self, project_id):
        """返回该项目缓存状态的构建时指纹; 紧随 get() 调用, 一定存在(无则返回 None)。"""
        with self._lock:
            hit = self._cache.get(project_id)
            return hit[2] if hit else None


def normalize_project_name(name):
    """项目名规范化：去空白、斜杠防路径穿越。"""
    name = (name or "").strip().replace("/", "_").replace("\\", "_")
    return name or "project"


# 目录浏览 API 单目录子目录数上限: 防超大目录拖垮响应
FS_BROWSE_LIMIT = 500


def path_last_segment(path):
    """取路径最后一段（项目名称留空时的自动命名来源）。

    跨平台：/ 与 \\ 均按分隔符切分（Windows 反斜杠路径在 Linux 服务端也能解析），
    忽略尾部分隔符与纯盘符段（如 "D:"）；无有效段返回空串。
    """
    segs = [s for s in re.split(r"[\\/]+", (path or "").strip()) if s]
    for seg in reversed(segs):
        if not re.fullmatch(r"[A-Za-z]:", seg):
            return seg
    return ""


def fs_roots():
    """按服务端平台返回目录浏览的根路径列表。

    Windows: 逐盘符 A:~Z: 探测实际存在的盘符根；Linux/macOS: 单根 "/"。
    """
    if os.name == "nt":
        roots = [f"{letter}:\\" for letter in string.ascii_uppercase
                 if os.path.exists(f"{letter}:\\")]
        return roots or ["C:\\"]
    return ["/"]


# 项目文件预览（会话详情页点击回答里的路径）读取上限：超出只给前 256KB 并置
# truncated 标记；原文（raw=1）按流式下载，超过 FILE_RAW_MAX 拒绝（防大文件打爆）
FILE_PREVIEW_MAX = 256 * 1024
FILE_RAW_MAX = 32 * 1024 * 1024


def _within_root(path, root):
    """path 是否等于 root 或位于 root 之内（调用前双方均须 realpath 规范化）。"""
    if not path or not root:
        return False
    p, r = os.path.normcase(path), os.path.normcase(root.rstrip("/\\"))
    return p == r or p.startswith(r + os.sep)


def resolve_project_file(project, raw_path):
    """把会话里出现的路径解析为项目范围内可读的文件（越界不读）。

    解析规则（与 agent CLI 运行 cwd=project_dir 一致）：
    - 绝对路径原样规范化；相对路径先按 <项目目录>、再按 <工作目录> 拼接
    - 两侧都存在时项目目录优先（正是 agent 相对路径的基准）

    返回 (real_path, root_key, err)：root_key ∈ {project, work}；
    err ∈ {"", empty, outside, dir, missing}——outside 表示路径落在两个根之外
    （含 ../ 目录穿越与任意系统路径），一律由调用方按 403 处理，不读内容。
    """
    raw = (raw_path or "").strip()
    if not raw:
        return None, "", "empty"
    roots = []
    for key, value in (("project", project["project_dir"]), ("work", project["work_dir"])):
        p = (value or "").strip()
        if p:
            roots.append((key, os.path.realpath(p)))
    candidates = []
    if os.path.isabs(raw):
        candidates.append((None, os.path.realpath(raw)))
    else:
        candidates.extend((key, os.path.realpath(os.path.join(root, raw)))
                          for key, root in roots)
    inside = [(key, p) for key, p in candidates
              if any(_within_root(p, root) for _, root in roots)]
    outside = [p for key, p in candidates if (key, p) not in inside]
    for key, p in inside:
        if os.path.isfile(p):
            # 绝对路径命中时归属按包含它的根判定（file 视图里显示相对路径用）
            if key is None:
                key = next((k for k, root in roots if _within_root(p, root)), "")
            return p, key, ""
    for key, p in inside:
        if os.path.exists(p):
            return p, key or "", "dir"
    if inside:
        return inside[0][1], "", "missing"
    return (outside[0] if outside else raw), "", "outside"


def read_text_preview(path, limit=FILE_PREVIEW_MAX):
    """读文件前 limit 字节并按 UTF-8 解码，返回 (text, size, truncated, binary)。

    二进制判定：含 NUL 字节，或非 UTF-8（截断切断多字节字符时先退 1~3 字节重试）。
    二进制不返回内容（前端提示不可预览，可走 raw=1 下载）。
    """
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        data = f.read(limit + 1)
    truncated = len(data) > limit
    if truncated:
        data = data[:limit]
    if b"\x00" in data:
        return "", size, truncated, True
    try:
        return data.decode("utf-8"), size, truncated, False
    except UnicodeDecodeError:
        if truncated:  # 截断处可能切断多字节字符：逐字节回退再试
            for drop in (1, 2, 3):
                try:
                    return data[:len(data) - drop].decode("utf-8"), size, truncated, False
                except UnicodeDecodeError:
                    continue
        return "", size, truncated, True


def fs_browse(raw_path):
    """列出一个目录下的子目录（不含文件），供前端目录选择对话框浏览。

    返回 platform(服务端平台)/roots(根列表)/path(规整后的绝对路径)/
    parent(上级目录, 已到根时为 None)/dirs(子目录 {name, path} 列表)。
    raw_path 为空时返回根视角（dirs 即根列表）。目录不存在或不可读返回 None。
    """
    platform = "windows" if os.name == "nt" else ("macos" if sys.platform == "darwin" else "linux")
    roots = fs_roots()
    if not (raw_path or "").strip():
        return {"platform": platform, "roots": roots, "path": "", "parent": None,
                "dirs": [{"name": r, "path": r} for r in roots]}
    path = os.path.realpath(raw_path)
    if not os.path.isdir(path):
        return None
    dirs = []
    try:
        with os.scandir(path) as it:
            for entry in it:
                try:
                    if entry.is_dir():
                        dirs.append({"name": entry.name, "path": entry.path})
                except OSError:
                    continue  # 无权限/已失效的条目跳过，不中断整个目录列举
                if len(dirs) >= FS_BROWSE_LIMIT:
                    break
    except OSError:
        return None
    dirs.sort(key=lambda d: d["name"])
    parent = os.path.dirname(path)
    if parent == path:  # os.path.dirname 对根目录返回自身，视为已到根
        parent = None
    return {"platform": platform, "roots": roots, "path": path,
            "parent": parent, "dirs": dirs}


def fs_mkdir(raw_path, raw_name):
    """在指定目录下新建一个子目录，供前端目录选择对话框的「新建文件夹」使用。

    返回 (data, error) 二元组：成功为 ({"name", "path"(新目录绝对路径)}, None)，
    失败为 (None, 原因文本——直接展示给用户，故用中文)。
    名称两端空白先 strip 归整（与前端输入框 .trim() 一致），只接受单级目录名：
    拒绝空名、路径分隔符、`.`/`..` 与结尾点（Windows 会截掉结尾点/空格，跨平台统一拒绝）。
    父目录须已存在；同名文件或目录已存在时拒绝（不覆盖、不静默复用）。
    """
    parent = (raw_path or "").strip()
    if not parent or not os.path.isdir(os.path.realpath(parent)):
        return None, "请先进入一个存在的目录再新建文件夹"
    parent = os.path.realpath(parent)
    name = (raw_name or "").strip()
    if not name:
        return None, "文件夹名称不能为空"
    if name in (".", "..") or re.search(r"[\\/]", name) or "\x00" in name:
        return None, "文件夹名称不能包含路径分隔符，也不能是 . 或 .."
    if name != name.rstrip(". "):  # Windows 会把结尾点/空格截掉，跨平台统一拒绝
        return None, "文件夹名称不能以点或空格结尾"
    target = os.path.join(parent, name)
    if os.path.lexists(target):
        return None, "同名文件或目录已存在"
    try:
        os.mkdir(target)
    except OSError as e:  # 无写权限/名称为系统保留字等，一律回给用户看原因
        return None, f"新建失败：{e.strerror or e}"
    return {"name": name, "path": os.path.realpath(target)}, None


class Handler(BaseHTTPRequestHandler):
    """路由 + 鉴权 + 静态页 + REST + SSE。"""

    server_version = "TouchstoneSite/1.0"
    limiter = auth.LoginLimiter()
    state_cache = StateCache()

    # ---------- 入口 ----------

    def do_GET(self):
        parsed = parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
        path = self.path.split("?", 1)[0]
        if path in ("/",):
            self._redirect("/app" if self._current_user() else "/login")
            return
        # SPA: 前端路由页面统一返回 index.html, 由 react-router 处理子页与鉴权
        if path in PUBLIC_PAGES or path in ("/app", "/monitor", "/admin", "/log"):
            self._send_file(os.path.join(WEB_DIR, "index.html"), "text/html; charset=utf-8")
            return
        # API 统一鉴权
        if path.startswith("/api/"):
            user = self._current_user()
            if not user:
                self._respond(401, b'{"error":"unauthorized"}', "application/json; charset=utf-8")
                return
            if self._must_change_pw_blocked(user, path):
                return
        self._route_get(path, parsed)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/auth/login":
            self._api_login()
            return
        if path == "/api/auth/register":
            self._api_register()
            return
        if path.startswith("/api/"):
            user = self._current_user()
            if not user:
                self._respond(401, b'{"error":"unauthorized"}', "application/json; charset=utf-8")
                return
            if self._must_change_pw_blocked(user, path):
                return
        if path == "/api/auth/logout":
            self._api_logout()
            return
        if path == "/api/auth/change_password":
            self._api_change_password()
            return
        body = self._read_json() or {}
        if path == "/api/fs/mkdir":
            # 新建目录（供前端目录选择对话框「新建文件夹」）：body {path, name}
            self._api_fs_mkdir(body)
            return
        if path == "/api/admin/users":
            self._api_admin_create_user(body)
            return
        if path == "/api/me/feishu-cfg":
            self._api_me_feishu_cfg_set(body)
            return
        if path == "/api/me/feishu-bindcode":
            self._api_me_feishu_bindcode()
            return
        if path == "/api/me/feishu/slash-commands":
            self._api_me_feishu_slash_set(body)
            return
        if path == "/api/me/feishu/provision":
            self._api_me_feishu_provision_set(body)
            return
        if path == "/api/me/feishu/doctor":
            self._api_me_feishu_doctor(body)
            return
        if path == "/api/me/feishu-hook/apply":
            # 项目推送绑定批量应用（设置页「同时应用到我的全部项目」，2026-10-10）
            self._api_me_feishu_hook_apply(body)
            return
        m = re.match(r"^/api/admin/users/(\d+)$", path)
        if m:
            self._api_admin_update_user(int(m.group(1)), body)
            return
        if path == "/api/admin/rag/test":
            self._api_admin_rag_test(body)
            return
        if path == "/api/projects":
            self._api_create_project(body)
            return
        m = re.match(r"^/api/builtin-assets/([a-z0-9][a-z0-9._-]*)/(install|uninstall)$",
                     path)
        if m:
            # 内置资产安装/卸载：用户级仅管理员、项目级仅项目所有者（见 handler 内门禁）
            self._api_builtin_asset_action(m.group(1), m.group(2), body)
            return
        if path == "/api/prefs":
            self._api_prefs_set(body)
            return
        m = re.match(r"^/api/projects/(\d+)/(archive|unarchive)$", path)
        if m:
            self._api_archive_project(int(m.group(1)), m.group(2) == "archive")
            return
        m = re.match(r"^/api/projects/(\d+)/tasks$", path)
        if m:
            self._api_create_task(int(m.group(1)), body)
            return
        m = re.match(r"^/api/projects/(\d+)/bugs/([^/]+)/reject$", path)
        if m:
            self._api_reject_bug(int(m.group(1)), m.group(2), body)
            return
        m = re.match(r"^/api/projects/(\d+)/board/cards$", path)
        if m:
            self._api_board_create_card(int(m.group(1)), body)
            return
        m = re.match(r"^/api/projects/(\d+)/board/media$", path)
        if m:
            self._api_board_upload_media(int(m.group(1)), body)
            return
        m = re.match(r"^/api/projects/(\d+)/board/reorder$", path)
        if m:
            self._api_board_reorder(int(m.group(1)), body)
            return
        m = re.match(r"^/api/projects/(\d+)/board/trash/(\d+)/restore$", path)
        if m:
            self._api_board_trash_restore(int(m.group(1)), int(m.group(2)))
            return
        m = re.match(r"^/api/projects/(\d+)/board/trash/empty$", path)
        if m:
            self._api_board_trash_empty(int(m.group(1)))
            return
        m = re.match(r"^/api/projects/(\d+)/board/cards/(\d+)/(move|start|stop)$", path)
        if m:
            self._api_board_card_action(int(m.group(1)), int(m.group(2)), m.group(3), body)
            return
        # worktree 改动回流：把合并任务交给卡片会话（回统一队列排队，2026-10-07 批次）
        m = re.match(r"^/api/projects/(\d+)/board/cards/(\d+)/worktree/merge$", path)
        if m:
            self._api_board_card_worktree_merge(int(m.group(1)), int(m.group(2)))
            return
        # 卡片「已查看」（2026-10-07 批次）：前端打开卡片详情时调用，清「有更新」标记
        m = re.match(r"^/api/projects/(\d+)/board/cards/(\d+)/viewed$", path)
        if m:
            self._api_board_mark_viewed(int(m.group(1)), int(m.group(2)))
            return
        m = re.match(r"^/api/projects/(\d+)/board/cards/(\d+)/compact$", path)
        if m:
            self._api_board_compact(int(m.group(1)), int(m.group(2)), body)
            return
        m = re.match(r"^/api/projects/(\d+)/board/cards/(\d+)/fork-compact$", path)
        if m:
            self._api_board_fork_compact(int(m.group(1)), int(m.group(2)), body)
            return
        m = re.match(r"^/api/projects/(\d+)/board/cards/(\d+)/fork$", path)
        if m:
            self._api_board_fork(int(m.group(1)), int(m.group(2)), body)
            return
        m = re.match(r"^/api/projects/(\d+)/board/cards/(\d+)/interaction/answer$", path)
        if m:
            self._api_board_answer_interaction(int(m.group(1)), int(m.group(2)), body)
            return
        m = re.match(r"^/api/projects/(\d+)/board/cards/(\d+)/answer/deliver$", path)
        if m:
            self._api_board_deliver_answer(int(m.group(1)), int(m.group(2)))
            return
        m = re.match(r"^/api/projects/(\d+)/board/sessions/([\w-]+)/profile$", path)
        if m:
            self._api_board_session_profile(int(m.group(1)), m.group(2), body)
            return
        m = re.match(r"^/api/projects/(\d+)/board/sessions/([\w-]+)/inject$", path)
        if m:
            self._api_board_session_inject(int(m.group(1)), m.group(2), body)
            return
        m = re.match(r"^/api/projects/(\d+)/board/sessions/([\w-]+)/rewind$", path)
        if m:
            self._api_board_session_rewind(int(m.group(1)), m.group(2), body)
            return
        m = re.match(r"^/api/projects/(\d+)/board/cards/(\d+)/comments$", path)
        if m:
            self._api_board_add_comment(int(m.group(1)), int(m.group(2)), body)
            return
        m = re.match(r"^/api/projects/(\d+)/board/cards/(\d+)/comments/(\d+)/send$", path)
        if m:
            self._api_board_send_comment(int(m.group(1)), int(m.group(2)), int(m.group(3)),
                                         body)
            return
        m = re.match(r"^/api/projects/(\d+)/board/jira/(test|import)$", path)
        if m:
            self._api_board_jira(int(m.group(1)), m.group(2), body)
            return
        m = re.match(r"^/api/tasks/(\d+)/(stop|restart)$", path)
        if m:
            self._api_task_action(int(m.group(1)), m.group(2))
            return
        m = re.match(r"^/api/tasks/(\d+)/continue$", path)
        if m:
            self._api_continue_task(int(m.group(1)), body)
            return
        m = re.match(r"^/api/tasks/(\d+)/load/rerun$", path)
        if m:
            self._api_load_rerun(int(m.group(1)))
            return
        m = re.match(r"^/api/tasks/(\d+)/load/diagnose$", path)
        if m:
            self._api_load_diagnose(int(m.group(1)))
            return
        m = re.match(r"^/api/tasks/(\d+)/session/chat$", path)
        if m:
            self._api_session_chat(int(m.group(1)), body)
            return
        m = re.match(r"^/api/tasks/(\d+)/session/chat/inject$", path)
        if m:
            self._api_session_chat_inject(int(m.group(1)), body)
            return
        m = re.match(r"^/api/tasks/(\d+)/session/rewind$", path)
        if m:
            self._api_session_rewind(int(m.group(1)), body)
            return
        m = re.match(r"^/api/tasks/(\d+)/session/interaction/answer$", path)
        if m:
            self._api_task_answer_interaction(int(m.group(1)), body)
            return
        m = re.match(r"^/api/tasks/(\d+)/session/profile$", path)
        if m:
            self._api_task_session_profile(int(m.group(1)), body)
            return
        m = re.match(r"^/api/tasks/(\d+)/session/chat/stop$", path)
        if m:
            self._api_session_chat_stop(int(m.group(1)))
            return
        self._respond(404, b'{"error":"not found"}', "application/json; charset=utf-8")

    def do_PATCH(self):
        path = self.path.split("?", 1)[0]
        if not self._current_user():
            self._respond(401, b'{"error":"unauthorized"}', "application/json; charset=utf-8")
            return
        m = re.match(r"^/api/projects/(\d+)$", path)
        if m:
            self._api_update_project(int(m.group(1)), self._read_json() or {})
            return
        m = re.match(r"^/api/tasks/(\d+)$", path)
        if m:
            self._api_update_task(int(m.group(1)), self._read_json() or {})
            return
        m = re.match(r"^/api/admin/users/(\d+)$", path)
        if m:
            self._api_admin_update_user(int(m.group(1)), self._read_json() or {})
            return
        m = re.match(r"^/api/projects/(\d+)/board/cards/(\d+)$", path)
        if m:
            self._api_board_update_card(int(m.group(1)), int(m.group(2)), self._read_json() or {})
            return
        m = re.match(r"^/api/projects/(\d+)/board/settings$", path)
        if m:
            self._api_board_update_settings(int(m.group(1)), self._read_json() or {})
            return
        m = re.match(r"^/api/me/feishu-cfg$", path)
        if m:
            self._api_me_feishu_cfg_set(self._read_json() or {})
            return
        m = re.match(r"^/api/admin/rag$", path)
        if m:
            self._api_admin_rag_set(self._read_json() or {})
            return
        m = re.match(r"^/api/projects/(\d+)/feishu-hook$", path)
        if m:
            self._api_feishu_hook_set(int(m.group(1)), self._read_json() or {})
            return
        self._respond(404, b'{"error":"not found"}', "application/json; charset=utf-8")

    def do_DELETE(self):
        path = self.path.split("?", 1)[0]
        if not self._current_user():
            self._respond(401, b'{"error":"unauthorized"}', "application/json; charset=utf-8")
            return
        m = re.match(r"^/api/me/feishu$", path)
        if m:
            self._api_me_feishu_delete()
            return
        m = re.match(r"^/api/projects/(\d+)$", path)
        if m:
            self._api_delete_project(int(m.group(1)))
            return
        m = re.match(r"^/api/tasks/(\d+)$", path)
        if m:
            self._api_delete_task(int(m.group(1)))
            return
        m = re.match(r"^/api/admin/users/(\d+)$", path)
        if m:
            self._api_admin_delete_user(int(m.group(1)))
            return
        m = re.match(r"^/api/projects/(\d+)/board/trash/(\d+)$", path)
        if m:
            self._api_board_trash_purge(int(m.group(1)), int(m.group(2)))
            return
        m = re.match(r"^/api/projects/(\d+)/board/cards/(\d+)/worktree$", path)
        if m:
            # 清理卡片独立 worktree（2026-10-06 批次，plan D8）：运行中 409、
            # 有未提交改动 400，绝不 --force（见 board.cleanup_card_worktree）
            self._api_board_card_worktree_cleanup(int(m.group(1)), int(m.group(2)))
            return
        m = re.match(r"^/api/projects/(\d+)/board/cards/(\d+)$", path)
        if m:
            self._api_board_delete_card(int(m.group(1)), int(m.group(2)))
            return
        m = re.match(r"^/api/projects/(\d+)/board/cards/(\d+)/comments/(\d+)$", path)
        if m:
            self._api_board_delete_comment(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            return
        self._respond(404, b'{"error":"not found"}', "application/json; charset=utf-8")

    # ---------- 路由分发 ----------

    def _route_get(self, path, parsed):
        if path == "/api/auth/me":
            self._api_me()
        elif path == "/api/me/feishu":
            self._api_me_feishu_get()
        elif path == "/api/me/feishu-cfg":
            self._api_me_feishu_cfg_get()
        elif path == "/api/me/feishu/outbox":
            self._api_me_feishu_outbox()
        elif path == "/api/me/feishu/slash-commands":
            self._api_me_feishu_slash_get()
        elif path == "/api/me/feishu/provision":
            self._api_me_feishu_provision_get()
        elif path == "/api/admin/users":
            self._api_admin_list_users()
        elif path == "/api/admin/rag":
            self._api_admin_rag_get()
        elif path == "/api/builtin-assets":
            # 平台内置资产（skill）清单 + 指定目标下的安装状态
            # （登录即可读；安装/卸载在 action 端点按目标分别把权限）
            self._api_builtin_assets_list(parsed)
        elif path == "/api/agents/scan":
            self._respond(200, json.dumps(scan_agents(), ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
        elif path == "/api/agents/models":
            # 指定 agent 已配置的模型列表(唯一族 dsh 走宿主驱动 /models), 供模型下拉
            self._respond(200, json.dumps(agent_models(parsed.get("agent_path", [""])[0]),
                                          ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
        elif path == "/api/agents/skills":
            # 指定 agent CLI 可用的 skill 列表(用户级+项目级 SKILL.md 扫描),
            # 供项目弹窗「理解/部署/提交」三项能力的 skill 下拉; dsh 恒为空
            self._respond(200, json.dumps(
                {"skills": scan_skills(parsed.get("agent_path", [""])[0],
                                       parsed.get("project_dir", [""])[0])},
                ensure_ascii=False).encode("utf-8"),
                "application/json; charset=utf-8")
        elif path == "/api/projects":
            self._api_list_projects()
        elif path == "/api/projects/dup_check":
            self._api_dup_check(parsed)
        elif path == "/api/fs/browse":
            # 目录浏览（供前端目录选择对话框）：只列子目录，附带平台与根列表
            self._api_fs_browse(parsed)
        elif path == "/api/prefs":
            # 用户 UI 偏好（标签页布局/看板列过滤等，按 用户+项目 维度持久化）
            self._api_prefs_get(parsed)
        elif path == "/api/state":
            self._api_state(parsed)
        elif path == "/api/stream":
            self._stream(parsed)
        elif (m := re.match(r"^/api/projects/(\d+)/board/stream$", path)):
            # 看板变更事件流（P4 事件化；替代前端 5s 轮询）
            self._api_board_stream(int(m.group(1)))
        elif (m := re.match(
                r"^/api/projects/(\d+)/board/sessions/([^/]+)/stream$", path)):
            # 会话实时事件流（P4 事件化；替代会话窗口 2s 轮询）
            self._api_board_session_stream(int(m.group(1)), unquote(m.group(2)))
        elif path == "/api/tasks":
            self._respond(200, b'{"error":"task id required"}',
                          "application/json; charset=utf-8")
        else:
            m = re.match(r"^/api/projects/(\d+)$", path)
            if m:
                self._api_get_project(int(m.group(1)))
                return
            m = re.match(r"^/api/projects/(\d+)/file$", path)
            if m:
                # 项目文件预览（会话详情页点击回答里的路径；raw=1 走原文）
                self._api_project_file(int(m.group(1)), parsed)
                return
            m = re.match(r"^/api/projects/(\d+)/tasks$", path)
            if m:
                self._api_list_tasks(int(m.group(1)))
                return
            m = re.match(r"^/api/projects/(\d+)/board$", path)
            if m:
                self._api_get_board(int(m.group(1)))
                return
            m = re.match(r"^/api/projects/(\d+)/board/sessions$", path)
            if m:
                self._api_board_sessions(int(m.group(1)))
                return
            m = re.match(r"^/api/projects/(\d+)/board/session/messages$", path)
            if m:
                self._api_board_session_messages(int(m.group(1)), parsed)
                return
            m = re.match(r"^/api/projects/(\d+)/board/session/media/(.+)$", path)
            if m:
                self._api_board_session_media(int(m.group(1)), m.group(2), parsed)
                return
            m = re.match(r"^/api/projects/(\d+)/board/media/([A-Za-z0-9._-]+)$", path)
            if m:
                self._api_board_get_media(int(m.group(1)), m.group(2))
                return
            m = re.match(r"^/api/projects/(\d+)/board/trash$", path)
            if m:
                self._api_board_trash_list(int(m.group(1)))
                return
            m = re.match(r"^/api/projects/(\d+)/board/cards/(\d+)/worktree$", path)
            if m:
                # 独立 worktree 预览（2026-10-06 批次，plan §3.4）：不落盘，供「开始」
                # 下拉判断该项可否选（项目非 git 仓库 / 卡片已有主会话 ⇒ supported=false）
                self._api_board_card_worktree_preview(int(m.group(1)), int(m.group(2)))
                return
            m = re.match(r"^/api/projects/(\d+)/feishu-hook$", path)
            if m:
                self._api_feishu_hook_get(int(m.group(1)))
                return
            m = re.match(r"^/api/projects/(\d+)/bugs$", path)
            if m:
                self._api_list_bugs(int(m.group(1)))
                return
            m = re.match(r"^/api/projects/(\d+)/bugs/(.+)$", path)
            if m:
                self._api_get_bug(int(m.group(1)), m.group(2))
                return
            m = re.match(r"^/api/tasks/(\d+)$", path)
            if m:
                self._api_get_task(int(m.group(1)))
                return
            m = re.match(r"^/api/tasks/(\d+)/rounds$", path)
            if m:
                self._api_list_rounds(int(m.group(1)))
                return
            m = re.match(r"^/api/tasks/(\d+)/dialogue$", path)
            if m:
                self._api_task_dialogue(int(m.group(1)))
                return
            m = re.match(r"^/api/tasks/(\d+)/log$", path)
            if m:
                self._api_task_log(int(m.group(1)), parsed)
                return
            m = re.match(r"^/api/tasks/(\d+)/load_series$", path)
            if m:
                self._api_load_metrics(int(m.group(1)), parsed)  # 旧路径别名（无 UI 调用，保留兼容）
                return
            m = re.match(r"^/api/tasks/(\d+)/load/case$", path)
            if m:
                self._api_load_case(int(m.group(1)), parsed)
                return
            m = re.match(r"^/api/tasks/(\d+)/load/metrics$", path)
            if m:
                self._api_load_metrics(int(m.group(1)), parsed)
                return
            m = re.match(r"^/api/tasks/(\d+)/load/runs$", path)
            if m:
                self._api_load_runs(int(m.group(1)))
                return
            m = re.match(r"^/api/tasks/(\d+)/load/custom_html$", path)
            if m:
                self._api_load_custom_html(int(m.group(1)))
                return
            m = re.match(r"^/api/tasks/(\d+)/load_report$", path)
            if m:
                self._api_load_report(int(m.group(1)), parsed)
                return
            m = re.match(r"^/api/tasks/(\d+)/load/stream$", path)
            if m:
                self._api_load_stream(int(m.group(1)), parsed)
                return
            m = re.match(r"^/api/tasks/(\d+)/session/messages$", path)
            if m:
                self._api_session_messages(int(m.group(1)), parsed)
                return
            m = re.match(r"^/api/tasks/(\d+)/session/stream$", path)
            if m:
                self._api_session_stream(int(m.group(1)), parsed)
                return
            m = re.match(r"^/api/tasks/(\d+)/session/media/(.+)$", path)
            if m:
                self._api_session_media(int(m.group(1)), m.group(2), parsed)
                return
            if path.startswith("/api/"):
                self._respond(404, b'{"error":"not found"}', "application/json; charset=utf-8")
            else:
                self._serve_static(path)
            return

    # ---------- auth API ----------

    def _api_login(self):
        ip = self.client_address[0]
        if not self.limiter.allow(ip):
            self._respond(429, '{"error":"尝试过于频繁，请稍后再试"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        data = self._read_json() or {}
        username = _req_str(data.get("username", ""))
        password = _pw_str(data.get("password"))
        row = db.get_user_by_name(username)
        self.limiter.record(ip)
        if row is None or not auth.verify_password(password, row["pass_hash"], row["salt"]):
            self._respond(401, '{"error":"用户名或密码错误"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        token = auth.new_token()
        db.create_session(row["id"], token, auth.session_expiry())
        body = json.dumps({"token": token, "username": row["username"],
                           "must_change_password": bool(row["must_change_pw"])},
                          ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Set-Cookie",
                         f"{auth.COOKIE_NAME}={token}; HttpOnly; SameSite=Lax; "
                         f"Path=/; Max-Age={auth.SESSION_TTL}")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _api_logout(self):
        token = self._cookie_token()
        db.delete_session(token)
        body = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Set-Cookie",
                         f"{auth.COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _api_me(self):
        user = self._current_user()
        self._respond(200, json.dumps({"username": user["username"],
                                       "is_admin": self._is_admin(),
                                       "must_change_password": bool(user["must_change_pw"])},
                                      ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_register(self):
        """注册新用户：用户名唯一，密码 MD5 存储（需求约定），成功后自动登录。"""
        data = self._read_json() or {}
        username = _req_str(data.get("username")).strip()
        password = _pw_str(data.get("password"))
        if not USERNAME_RE.match(username):
            self._respond(400, '{"error":"用户名须为 2-32 位字母数字或 _ . -"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        if len(password) < 6:
            self._respond(400, '{"error":"密码至少 6 位"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        pw_hash, salt = auth.md5_password(password)
        try:
            user_id = db.insert_user(username, pw_hash, salt)
        except sqlite3.IntegrityError:
            self._respond(400, '{"error":"用户名已存在"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        # 注册成功自动登录（发会话 cookie），前端直接进主界面
        token = auth.new_token()
        db.create_session(user_id, token, auth.session_expiry())
        body = json.dumps({"token": token, "username": username},
                          ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Set-Cookie",
                         f"{auth.COOKIE_NAME}={token}; HttpOnly; SameSite=Lax; "
                         f"Path=/; Max-Age={auth.SESSION_TTL}")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _api_change_password(self):
        """改密。插件形态（免登信任头）下**不校验原口令**（2026-10-08）。

        为什么：插件形态首装的随机一次性口令只印在启动横幅里（薄壳曾整段丢弃），
        存量库的旧口令用户也可能不知道——要求原口令等于把面板锁死。信任头本就等价
        admin 全权（_current_user），这里放行不新增任何权限面。
        """
        user = self._current_user()
        data = self._read_json() or {}
        old_pw = _pw_str(data.get("old_password"))
        new_pw = _pw_str(data.get("new_password"))
        if not self._trusted_admin_request() and \
                not auth.verify_password(old_pw, user["pass_hash"], user["salt"]):
            self._respond(400, '{"error":"原密码错误"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        if len(new_pw) < 6:
            self._respond(400, '{"error":"新密码至少 6 位"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        pw_hash, salt = auth.md5_password(new_pw)
        db.change_password(user["id"], pw_hash, salt)
        self._respond(200, b'{"ok":true}', "application/json; charset=utf-8")

    # ---------- admin（用户管理）API ----------

    def _is_admin(self):
        """当前用户是否为管理员（admin 账号，后台管理页面/API 专用）。"""
        user = self._current_user()
        return bool(user) and user["username"] == "admin"

    def _require_admin(self):
        """非管理员统一返回 403；已由通用鉴权保证已登录。"""
        if not self._is_admin():
            self._respond(403, '{"error":"仅管理员可操作"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return False
        return True

    def _user_admin_json(self, row):
        return {"id": row["id"], "username": row["username"],
                "created_at": row["created_at"], "is_admin": row["username"] == "admin"}

    def _api_admin_list_users(self):
        if not self._require_admin():
            return
        rows = db.list_users()
        self._respond(200, json.dumps([self._user_admin_json(r) for r in rows],
                                      ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_admin_create_user(self, body):
        if not self._require_admin():
            return
        username = _req_str(body.get("username")).strip()
        password = _pw_str(body.get("password"))
        if not USERNAME_RE.match(username):
            self._respond(400, '{"error":"用户名须为 2-32 位字母数字或 _ . -"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        if len(password) < 6:
            self._respond(400, '{"error":"密码至少 6 位"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        pw_hash, salt = auth.md5_password(password)
        try:
            user_id = db.insert_user(username, pw_hash, salt)
        except sqlite3.IntegrityError:
            self._respond(400, '{"error":"用户名已存在"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        self._respond(200, json.dumps({"id": user_id}, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_admin_update_user(self, user_id, body):
        """改用户名/重置密码；admin 账号禁止改名（防止后台管理入口丢失）。"""
        if not self._require_admin():
            return
        row = db.get_user_by_id(user_id)
        if row is None:
            self._respond(404, b'{"error":"user not found"}',
                          "application/json; charset=utf-8")
            return
        username = _req_str(body.get("username") or row["username"]).strip()
        if row["username"] == "admin" and username != "admin":
            self._respond(400, '{"error":"管理员账号不允许改名"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        if not USERNAME_RE.match(username):
            self._respond(400, '{"error":"用户名须为 2-32 位字母数字或 _ . -"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        new_pw = _pw_str(body.get("password"))
        if new_pw != "":
            if len(new_pw) < 6:
                self._respond(400, '{"error":"密码至少 6 位"}'.encode("utf-8"),
                              "application/json; charset=utf-8")
                return
            pw_hash, salt = auth.md5_password(new_pw)
        else:
            pw_hash, salt = row["pass_hash"], row["salt"]
        try:
            db.update_user(user_id, username, pw_hash, salt)
        except sqlite3.IntegrityError:
            self._respond(400, '{"error":"用户名已存在"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        self._respond(200, b'{"ok":true}', "application/json; charset=utf-8")

    def _api_admin_delete_user(self, user_id):
        """删除用户；admin 账号与当前登录用户不可删除。"""
        if not self._require_admin():
            return
        row = db.get_user_by_id(user_id)
        if row is None:
            self._respond(404, b'{"error":"user not found"}',
                          "application/json; charset=utf-8")
            return
        if row["username"] == "admin":
            self._respond(400, '{"error":"管理员账号不允许删除"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        user = self._current_user()
        if user["id"] == user_id:
            self._respond(400, '{"error":"不能删除当前登录用户"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        db.delete_user(user_id)
        self._respond(200, b'{"ok":true}', "application/json; charset=utf-8")

    # ---------- projects API ----------

    def _project_json(self, row):
        return {"id": row["id"], "name": row["name"], "project_dir": row["project_dir"],
                "agent_path": row["agent_path"], "work_dir": row["work_dir"],
                "bug_dir": row["bug_dir"], "guide_text": row["guide_text"],
                "commit_spec": row["commit_spec"], "deploy_spec": row["deploy_spec"],
                "env_label": row["env_label"], "model": row["model"],
                "skill_understand": row["skill_understand"],
                "skill_deploy": row["skill_deploy"],
                "skill_commit": row["skill_commit"],
                "skill_test": row["skill_test"],
                "skill_cases": row["skill_cases"],
                # 项目级会话默认值（2026-10-04）：思考等级 / 权限档（空=不指定）
                "reasoning_effort": row["reasoning_effort"],
                "permission_mode": row["permission_mode"],
                "archived": bool(row["archived"]),
                "created_at": row["created_at"]}

    # ---------- 飞书设置（用户级：用户自己的机器人/应用配置 + 投递记录） ----------

    def _mask_webhook(self, url):
        """webhook URL 打码回显：保留前 48 字符（域名+hook 路径前缀），
        token 尾段不回显；secret 永不回显（只回 has_* 布尔）。"""
        if not url:
            return ""
        return url if len(url) <= 48 else url[:48] + "…"

    def _api_me_feishu_cfg_get(self):
        """当前用户飞书配置读取（所有用户可访问，各看各的）：
        webhook 打码、secret 只回布尔 + 本人入站长连接状态。"""
        user = self._current_user()
        cfg = feishu.user_config(user["id"])
        self._respond(200, json.dumps({
            "enabled": bool(cfg.get("enabled", True)),
            "default_webhook": self._mask_webhook(cfg.get("default_webhook", "")),
            "has_default_secret": bool(cfg.get("default_secret")),
            "base_url": cfg.get("base_url", ""),
            # 入站：自建应用凭据（app_id 非密可回显；secret 只回布尔）
            "app_id": cfg.get("app_id", ""),
            "has_app_secret": bool(cfg.get("app_secret")),
            # 本用户入站长连接状态（明示配置/连接进度，避免「存没存上」不可见）
            "inbound": feishu.inbound_status(user["id"]),
        }, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _api_me_feishu_cfg_set(self, body):
        """当前用户飞书配置更新（业务在 feishu.save_user_config：字段缺省=不改、
        显式空串=清除；凭据齐全时拉起入站长连接并**即时快检**）。
        响应 = 既有字段 + verify（快检结果；凭据不全时 null）——前端据此即时提示对错。"""
        user = self._current_user()
        out = feishu.save_user_config(user["id"], body)
        self._respond(200, json.dumps(
            {"ok": True, **out},
            ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _api_me_feishu_provision_get(self):
        """扫码建应用流程现状（设置页轮询口，只读）：能力/总闸/状态/确认链接/步骤。"""
        user = self._current_user()
        self._respond(200, json.dumps(feishu.provision_status(user["id"]),
                                      ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_me_feishu_provision_set(self, body):
        """扫码建应用四动作（全部返回 200 + 摘要，页面据此渲染引导；非法 action 400）：
        start=发起（force 覆盖已有应用）/ cancel=取消 / apply=补齐机器人能力+权限+
        长连接订阅+事件+回调 / publish=提交发布（版本号缺省自动递增）。"""
        user = self._current_user()
        action = str(body.get("action") or "")
        uid = user["id"]
        if action == "start":
            out = feishu.provision_start(uid, force=bool(body.get("force")))
        elif action == "cancel":
            out = feishu.provision_cancel(uid)
        elif action == "apply":
            out = feishu.provision_apply(uid)
        elif action == "publish":
            out = feishu.provision_publish(uid,
                                           version=str(body.get("version") or "") or None,
                                           remark=str(body.get("remark") or ""),
                                           changelog=str(body.get("changelog") or ""))
        else:
            self._respond(400, json.dumps(
                {"error": "action 仅支持 start / cancel / apply / publish"},
                ensure_ascii=False).encode("utf-8"),
                "application/json; charset=utf-8")
            return
        self._respond(200, json.dumps(out, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_me_feishu_doctor(self, body):
        """配置自检（八项）：只读为主；send_probe=true 时额外发一条测试消息（60s 频控）。"""
        user = self._current_user()
        out = feishu.doctor(user["id"], send_probe=bool(body.get("send_probe")))
        self._respond(200, json.dumps(out, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_me_feishu_outbox(self):
        """当前用户的最近投递记录（target 打码——URL 本身含 token 即凭据）。"""
        user = self._current_user()
        out = [{"id": r["id"], "status": r["status"], "retries": r["retries"],
                "last_error": r["last_error"], "created_at": r["created_at"],
                "target": self._mask_webhook(r["target"])}
               for r in db.feishu_outbox_recent(50, user_id=user["id"])]
        self._respond(200, json.dumps(out, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_me_feishu_slash_get(self):
        """当前用户的飞书快捷指令（斜杠指令）现状：TS 期望清单 + 飞书侧已注册
        （各看各的应用）。凭据缺失/权限不足不报错，走 error 字段供页面展示引导。"""
        user = self._current_user()
        self._respond(200, json.dumps(feishu.slash_status(user["id"]),
                                      ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_me_feishu_slash_set(self, body):
        """斜杠指令三动作：sync=注册/同步（只增改 TS 自己的指令）、clear=清除 TS 指令、
        notify=向本人飞书单聊发「权限引导卡片」（用户在飞书卡片上点「我已开通，重试注册」
        即由回调重跑同步）。缺 scope 的失败会自动补发一次权限卡片（card_sent/card_error
        回报）；三个动作都返回 200 + 摘要（ok/error），设置页据此渲染差异与引导。"""
        user = self._current_user()
        action = str(body.get("action") or "sync")
        if action not in ("sync", "clear", "notify"):
            self._respond(400, json.dumps(
                {"error": "action 仅支持 sync / clear / notify"},
                ensure_ascii=False).encode("utf-8"),
                "application/json; charset=utf-8")
            return
        if action == "notify":
            ok, err = feishu.send_slash_perm_card(user["id"])
            out = {"ok": ok, "card_sent": ok, "card_error": err}
        else:
            out = (feishu.sync_slash_commands(user["id"]) if action == "sync"
                   else feishu.clear_slash_commands(user["id"]))
            out["card_sent"], out["card_error"] = False, ""
            if out.get("need_scope"):
                # 缺权限：顺手把引导卡片推到飞书（发不出去也不影响设置页的报错展示）
                ok, err = feishu.send_slash_perm_card(user["id"])
                out["card_sent"], out["card_error"] = ok, err
        self._respond(200, json.dumps(out, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    # ---------- 管理页：RAG 检索配置（仅管理员；落 ~/.touchstone/rag.json，即改即生效）----------

    def _api_admin_rag_get(self):
        """RAG 检索配置读取（仅管理员）：api_key 打码回显（永不回明文）；
        回显 raw 文件值便于补全半填配置，configured=三关键字段齐备（当前是否已生效）。"""
        if not self._require_admin():
            return
        raw = rag.raw_config() or {}
        key = str(raw.get("api_key") or "")
        masked = ("****" + key[-4:]) if len(key) >= 8 else ("****" if key else "")
        self._respond(200, json.dumps({
            "configured": rag.load_config() is not None,
            "config_path": rag.config_path(),
            "api_base": str(raw.get("api_base") or ""),
            "model": str(raw.get("model") or ""),
            "has_api_key": bool(key),
            "api_key_masked": masked,
            "timeout_s": raw.get("timeout_s") or rag.DEF_TIMEOUT_S,
            "batch_size": raw.get("batch_size") or rag.DEF_BATCH_SIZE,
        }, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _api_admin_rag_set(self, body):
        """RAG 检索配置保存（仅管理员）：api_key 留空=保持现有值；clear=true 停用（删配置）。
        校验失败 400 返回原因；保存立即生效（rag 配置每次调用热读取，无需重启）。"""
        if not self._require_admin():
            return
        try:
            if body.get("clear"):
                rag.disable()
            else:
                api_key = str(body.get("api_key") or "").strip()
                if not api_key:  # 输入框留空 = 沿用已存 key（GET 回显只有打码形态）
                    api_key = str((rag.raw_config() or {}).get("api_key") or "")
                rag.save_config({"api_base": body.get("api_base"), "model": body.get("model"),
                                 "api_key": api_key,
                                 "timeout_s": body.get("timeout_s"),
                                 "batch_size": body.get("batch_size")})
        except ValueError as exc:
            self._respond(400, json.dumps({"error": str(exc)}, ensure_ascii=False)
                          .encode("utf-8"), "application/json; charset=utf-8")
            return
        self._respond(200, b'{"ok":true}', "application/json; charset=utf-8")

    def _api_admin_rag_test(self, body):
        """RAG 配置连通性测试（仅管理员）：按表单当前值（api_key 留空用已存值）发一次
        单文本嵌入探测，不落盘；结果恒 200（ok=false 时 error 供前端直接展示）。"""
        if not self._require_admin():
            return
        api_key = str(body.get("api_key") or "").strip()
        if not api_key:
            api_key = str((rag.raw_config() or {}).get("api_key") or "")
        result = rag.test_connection({"api_base": body.get("api_base"), "model": body.get("model"),
                                      "api_key": api_key,
                                      "timeout_s": body.get("timeout_s"),
                                      "batch_size": body.get("batch_size")})
        self._respond(200, json.dumps(result, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    # ---------- 平台内置资产（skill）安装：用户级仅管理员、项目级仅项目所有者 ----------

    def _assets_target(self, target, project_id, write=False):
        """解析资产操作目标，返回 (ok, project_dir, pid)。

        用户级写服务进程 HOME 下的 agent 配置（影响本机所有项目）→ 写操作仅管理员，
        读状态放开给所有登录用户（面板据此显示「仅管理员可操作」）；项目级读/写都要
        过 `_owned_project`（越权一律 404 not found，与既有按 project_id 端点同口径）。
        错误路径已回响应，调用方按返回的 ok=False 直接 return。
        """
        if target == "user":
            if write and not self._is_admin():
                self._respond(403, json.dumps(
                    {"error": "用户级安装影响本机所有项目，仅管理员可操作"},
                    ensure_ascii=False).encode("utf-8"),
                    "application/json; charset=utf-8")
                return False, "", None
            return True, "", None
        if target != "project":
            self._respond(400, json.dumps(
                {"error": "target 必须是 user 或 project"}, ensure_ascii=False).encode("utf-8"),
                "application/json; charset=utf-8")
            return False, "", None
        if not isinstance(project_id, int) or isinstance(project_id, bool):
            self._respond(400, json.dumps(
                {"error": "项目级操作需要 project_id"}, ensure_ascii=False).encode("utf-8"),
                "application/json; charset=utf-8")
            return False, "", None
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return False, "", None
        return True, row["project_dir"], row["id"]

    def _api_builtin_assets_list(self, parsed):
        """内置资产（skill）清单 + 指定目标下的安装状态。

        GET /api/builtin-assets?target=user|project&project_id=N（target 缺省 user）；
        响应 can_install 为当前用户在该目标的写权限，逐资产 supported 为「该资产是否
        支持此目标」。
        """
        target = (_req_str(parsed.get("target", ["user"])[0]) or "user").strip()
        raw_pid = _req_str(parsed.get("project_id", [""])[0]).strip()
        pid = int(raw_pid) if raw_pid.isdigit() else None
        ok, project_dir, pid = self._assets_target(target, pid)
        if not ok:
            return
        try:
            assets = builtin_assets.list_assets(target, project_dir)
        except builtin_assets.AssetError as e:
            self._respond(e.code, json.dumps({"error": e.message}, ensure_ascii=False)
                          .encode("utf-8"), "application/json; charset=utf-8")
            return
        can_install = self._is_admin() if target == "user" else True
        self._respond(200, json.dumps(
            {"target": target, "project_id": pid, "can_install": can_install,
             "assets": assets}, ensure_ascii=False).encode("utf-8"),
            "application/json; charset=utf-8")

    def _api_builtin_asset_action(self, asset_id, action, body):
        """安装（收敛到期望状态）/ 卸载（删除清单内文件）一个内置资产。

        POST body {target, project_id?}；安装失败（项目目录不存在/路径越界等）按
        AssetError.code 回 400/500，成功回 {ok, state, files_written|files_deleted, asset}。
        """
        target = (_req_str(body.get("target")) or "user").strip()
        pid = body.get("project_id")
        pid = pid if isinstance(pid, int) and not isinstance(pid, bool) else None
        ok, project_dir, _pid = self._assets_target(target, pid, write=True)
        if not ok:
            return
        asset = builtin_assets.get_asset(asset_id)
        if asset is None:
            self._respond(404, json.dumps({"error": f"未知资产：{asset_id}"},
                                          ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        try:
            if action == "install":
                result = builtin_assets.install(asset, target, project_dir)
            else:
                result = builtin_assets.uninstall(asset, target, project_dir)
        except builtin_assets.AssetError as e:
            self._respond(e.code, json.dumps({"error": e.message}, ensure_ascii=False)
                          .encode("utf-8"), "application/json; charset=utf-8")
            return
        except OSError as e:
            # 磁盘异常（权限/空间）统一 500，带原因供前端 toast
            self._respond(500, json.dumps({"error": f"操作失败：{e}"}, ensure_ascii=False)
                          .encode("utf-8"), "application/json; charset=utf-8")
            return
        self._respond(200, json.dumps(result, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_feishu_hook_get(self, project_id):
        """项目推送绑定读取（_owned_project 隔离；webhook 打码、secret 只回布尔）。"""
        if self._owned_project(project_id) is None:
            self._respond(404, b'{"error":"not found"}',
                          "application/json; charset=utf-8")
            return
        row = db.get_feishu_hook(project_id)
        if row is None:
            # 未配置默认值：三事件开（设计默认集），card_review 默认关
            self._respond(200, json.dumps({
                "webhook_url": "", "has_webhook_secret": False, "enabled": True,
                "events": [e for e in feishu.FEISHU_EVENTS if e != "card_review"]},
                ensure_ascii=False).encode("utf-8"),
                "application/json; charset=utf-8")
            return
        self._respond(200, json.dumps({
            "webhook_url": self._mask_webhook(row["webhook_url"]),
            "has_webhook_secret": bool(row["webhook_secret"]),
            "enabled": bool(row["enabled"]),
            "events": [e for e in feishu.FEISHU_EVENTS if e in (row["events"] or "")],
        }, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _api_feishu_hook_set(self, project_id, body):
        """项目推送绑定更新（_owned_project 隔离）：字段缺省=不改当前值，
        events 白名单校验；webhook/secret 空串=清除。"""
        if self._owned_project(project_id) is None:
            self._respond(404, b'{"error":"not found"}',
                          "application/json; charset=utf-8")
            return
        row = db.get_feishu_hook(project_id)
        cur_url = (row["webhook_url"] if row is not None else "")
        cur_secret = (row["webhook_secret"] if row is not None else "")
        cur_enabled = (bool(row["enabled"]) if row is not None else True)
        if row is not None:
            cur_events = [e for e in feishu.FEISHU_EVENTS
                          if e in (row["events"] or "")]
        else:
            cur_events = [e for e in feishu.FEISHU_EVENTS if e != "card_review"]
        if "webhook_url" in body:
            cur_url = str(body["webhook_url"] or "").strip()
        if "webhook_secret" in body:
            cur_secret = str(body["webhook_secret"] or "").strip()
        if "events" in body:
            req = body["events"]
            if not isinstance(req, list) or not set(req) <= set(feishu.FEISHU_EVENTS):
                self._respond(400, '{"error":"events 含非法事件"}'.encode("utf-8"),
                              "application/json; charset=utf-8")
                return
            cur_events = req
        if "enabled" in body:
            cur_enabled = bool(body["enabled"])
        db.set_feishu_hook(project_id, cur_url, cur_secret,
                           ",".join(cur_events), 1 if cur_enabled else 0)
        self._respond(200, b'{"ok":true}', "application/json; charset=utf-8")

    def _api_me_feishu_hook_apply(self, body):
        """项目推送绑定**批量应用**（设置页「同时应用到我的全部项目」，2026-10-10）。

        把一份配置写进当前用户**本人的全部未归档项目**（归档项目不再产生推送，
        故不纳入；跨用户项目一律不碰——多用户隔离红线）。字段语义与单项目端点
        `_api_feishu_hook_set` 完全对齐：**缺省=不改该字段**，因此前端只在输入框
        有内容时才带 `webhook_url`/`webhook_secret` 键 ⇒「留空 = 各项目保留原值」，
        只统一「启用推送」与事件勾选；显式传空串=清除。`events` 走白名单校验。

        返回 {ok, updated, archived_skipped, projects}：projects = 实际写入的项目名
        （供前端回执列出「改了什么」）。
        """
        user = self._current_user()
        req_events = None
        if "events" in body:
            req_events = body["events"]
            if not isinstance(req_events, list) \
                    or not set(req_events) <= set(feishu.FEISHU_EVENTS):
                self._respond(400, '{"error":"events 含非法事件"}'.encode("utf-8"),
                              "application/json; charset=utf-8")
                return
        names, skipped = [], 0
        for proj in db.list_projects(user["id"]):
            if proj["archived"]:
                skipped += 1
                continue
            row = db.get_feishu_hook(proj["id"])
            cur_url = (row["webhook_url"] if row is not None else "")
            cur_secret = (row["webhook_secret"] if row is not None else "")
            cur_enabled = (bool(row["enabled"]) if row is not None else True)
            if row is not None:
                cur_events = [e for e in feishu.FEISHU_EVENTS
                              if e in (row["events"] or "")]
            else:
                # 无绑定行的默认事件集与设置页回显一致（卡片待审核默认关）
                cur_events = list(feishu.FEISHU_DEFAULT_EVENTS)
            if "webhook_url" in body:
                cur_url = str(body["webhook_url"] or "").strip()
            if "webhook_secret" in body:
                cur_secret = str(body["webhook_secret"] or "").strip()
            if req_events is not None:
                cur_events = req_events
            if "enabled" in body:
                cur_enabled = bool(body["enabled"])
            db.set_feishu_hook(proj["id"], cur_url, cur_secret,
                               ",".join(cur_events), 1 if cur_enabled else 0)
            names.append(proj["name"])
        self._respond(200, json.dumps(
            {"ok": True, "updated": len(names), "archived_skipped": skipped,
             "projects": names}, ensure_ascii=False).encode("utf-8"),
            "application/json; charset=utf-8")

    # ---------- 个人飞书绑定（M2 入站身份映射） ----------

    def _api_me_feishu_bindcode(self):
        """当前用户生成飞书绑定码（6 位、10 分钟有效，内存态）。"""
        user = self._current_user()
        self._respond(200, json.dumps(
            {"code": feishu.make_bind_code(user["id"])},
            ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _api_me_feishu_get(self):
        """当前用户绑定状态（open_id 打码、默认项目名）。"""
        user = self._current_user()
        row = db.get_feishu_binding_by_user(user["id"])
        out = {"bound": row is not None}
        if row is not None:
            oid = row["open_id"]
            out["open_id"] = oid[:6] + "…" if len(oid) > 6 else oid
            proj = db.get_project(row["default_project_id"]) \
                if row["default_project_id"] else None
            out["default_project"] = proj["name"] if proj else ""
        self._respond(200, json.dumps(out, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_me_feishu_delete(self):
        """当前用户解绑飞书号。"""
        user = self._current_user()
        db.del_feishu_binding_by_user(user["id"])
        self._respond(200, b'{"ok":true}', "application/json; charset=utf-8")

    def _owned_project(self, project_id):
        """当前用户的项目行；不存在或不属于当前用户返回 None（多用户隔离）。

        db.get_project 不校验归属，所有按 project_id 进入的接口必须先过这里，
        防止用户越权访问/操作他人项目的任务、bug 报告等。
        """
        row = db.get_project(project_id)
        if row is None:
            return None
        user = self._current_user()
        if user is None or row["user_id"] != user["id"]:
            return None
        return row

    def _api_list_projects(self):
        user = self._current_user()
        rows = db.list_projects(user["id"])
        # 看板三列数量（正在开发/阻塞/待审核）批量预计算，供侧栏项目列表展示
        counts = db.board_counts_many([r["id"] for r in rows])
        out = []
        for r in rows:
            pj = self._project_json(r)
            pj["board_counts"] = counts.get(r["id"]) or \
                {"doing": 0, "blocked": 0, "review": 0}
            out.append(pj)
        self._respond(200, json.dumps(out, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_get_project(self, project_id):
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        pj = self._project_json(row)
        # 同列表端点：refreshProject 用单项目端点替换列表项时保持计数一致
        pj["board_counts"] = db.board_counts_many([row["id"]])[row["id"]]
        self._respond(200, json.dumps(pj, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_dup_check(self, parsed):
        """目录重复检测（跨用户）：project_dir / work_dir 与已存在项目相同时返回重复项。

        仅做提醒不阻止写入；exclude=<id> 用于编辑项目时排除自身。
        """
        pdir = (parsed.get("project_dir", [""])[0] or "").strip()
        wdir = (parsed.get("work_dir", [""])[0] or "").strip()
        exclude = parsed.get("exclude", [""])[0]
        exclude_id = int(exclude) if exclude.isdigit() else None

        def norm(p):
            return os.path.normpath(p) if p else ""

        dups = []
        for p in db.list_projects_all():
            if exclude_id is not None and p["id"] == exclude_id:
                continue
            owner = db.get_user_by_id(p["user_id"])
            uname = owner["username"] if owner else "未知"
            if pdir and norm(pdir) == norm(p["project_dir"]):
                dups.append({"field": "project_dir", "value": pdir,
                             "project_id": p["id"], "project_name": p["name"],
                             "username": uname})
            if wdir and norm(wdir) == norm(p["work_dir"]):
                dups.append({"field": "work_dir", "value": wdir,
                             "project_id": p["id"], "project_name": p["name"],
                             "username": uname})
        self._respond(200, json.dumps(dups, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_create_project(self, body):
        project_dir = (body.get("project_dir") or "").strip() or os.path.expanduser("~")
        # 项目名称留空时自动取项目路径最后一段（前端已先行填充, 此处兜底）
        name = normalize_project_name(
            (body.get("name") or "").strip() or path_last_segment(project_dir))
        agent_path = (body.get("agent_path") or "").strip()
        # 项目设置只填一个工作目录（未填默认 <项目目录>/.touchstone）；
        # 案例库根 free_style 与 bug 报告目录 bug_report 由平台按固定子目录派生、自动创建
        work_dir = (body.get("work_dir") or "").strip() or \
            os.path.join(project_dir, ".touchstone")
        guide_text = str(body.get("guide_text", "") or "")
        env_label = str(body.get("env_label", "") or "")
        model = str(body.get("model", "") or "").strip()
        skill_understand = str(body.get("skill_understand", "") or "").strip()
        skill_deploy = str(body.get("skill_deploy", "") or "").strip()
        skill_commit = str(body.get("skill_commit", "") or "").strip()
        skill_test = str(body.get("skill_test", "") or "").strip()
        skill_cases = str(body.get("skill_cases", "") or "").strip()
        # 项目级会话默认值（2026-10-04）：思考等级 / 权限档（空=不指定）
        reasoning_effort = normalize_effort(body.get("reasoning_effort"))
        permission_mode = normalize_permission_mode(body.get("permission_mode"))
        if reasoning_effort is None or permission_mode is None:
            self._respond(400, json.dumps(
                {"error": "思考等级或权限档非法"}, ensure_ascii=False).encode("utf-8"),
                "application/json; charset=utf-8")
            return
        try:
            # 工作目录 + 两个派生子目录一并创建（幂等）
            for d in (work_dir, db.cases_root_of(work_dir), db.bug_root_of(work_dir)):
                os.makedirs(d, exist_ok=True)
            user = self._current_user()
            # commit_spec/deploy_spec 已废弃（信息并入 guide_text），恒为空串。
            # 2026-10-04 顺手补 skill_test/skill_cases：本端点一直读了这两个字段却没
            # 往下传（insert_project 的默认参数吃掉了），新建项目时「测试项目/用例规范」
            # 静默丢失、只有再编辑一次才存得下（既有缺陷，见 bug_report）。
            project_id = db.insert_project(user["id"], name, project_dir, agent_path,
                                           work_dir,
                                           guide_text, "", "", env_label,
                                           model,
                                           skill_understand, skill_deploy, skill_commit,
                                           skill_test, skill_cases,
                                           reasoning_effort=reasoning_effort,
                                           permission_mode=permission_mode)
        except sqlite3.IntegrityError:
            self._respond(400, json.dumps({"error": "项目名已存在"}, ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        except OSError as e:
            # work_dir 等路径已存在同名普通文件时 exist_ok 不适用（只容忍同名目录），
            # makedirs 抛 OSError，这里转 400 而不是未处理异常断连
            self._respond(400, json.dumps({"error": f"工作目录不可用: {e}"}, ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        self._respond(200, json.dumps({"id": project_id}, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_update_project(self, project_id, body):
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        # 项目级会话默认值：未带键＝保持存量值；带了非法值报 400（不静默丢弃）
        reasoning_effort = normalize_effort(
            body.get("reasoning_effort", row["reasoning_effort"]))
        permission_mode = normalize_permission_mode(
            body.get("permission_mode", row["permission_mode"]))
        if reasoning_effort is None or permission_mode is None:
            self._respond(400, json.dumps(
                {"error": "思考等级或权限档非法"}, ensure_ascii=False).encode("utf-8"),
                "application/json; charset=utf-8")
            return
        try:
            new_dir = (body.get("project_dir") or row["project_dir"]).strip()
            new_work = (body.get("work_dir") or row["work_dir"]).strip()
            if new_work != row["work_dir"]:
                # 工作目录变更：新目录与派生子目录一并创建（幂等），旧目录文件不动
                for d in (new_work, db.cases_root_of(new_work), db.bug_root_of(new_work)):
                    os.makedirs(d, exist_ok=True)
            db.update_project(project_id,
                              # 名称留空时自动取项目路径最后一段（与新建逻辑一致）
                              normalize_project_name((body.get("name") or "").strip()
                                                     or path_last_segment(new_dir)),
                              new_dir,
                              (body.get("agent_path") or row["agent_path"]).strip(),
                              new_work,
                              str(body.get("guide_text", row["guide_text"]) or ""),
                              # commit_spec/deploy_spec 已废弃：保留存量值但不再接受更新
                              str(row["commit_spec"]),
                              str(row["deploy_spec"]),
                              str(body.get("env_label", row["env_label"]) or ""),
                              str(body.get("model", row["model"]) or "").strip(),
                              str(body.get("skill_understand", row["skill_understand"]) or "").strip(),
                              str(body.get("skill_deploy", row["skill_deploy"]) or "").strip(),
                              str(body.get("skill_commit", row["skill_commit"]) or "").strip(),
                              str(body.get("skill_test", row["skill_test"]) or "").strip(),
                              str(body.get("skill_cases", row["skill_cases"]) or "").strip(),
                              reasoning_effort, permission_mode)
        except sqlite3.IntegrityError:
            self._respond(400, json.dumps({"error": "项目名已存在"}, ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        except OSError as e:
            # 新工作目录指向已存在的普通文件等情形，makedirs 抛 OSError，转 400
            self._respond(400, json.dumps({"error": f"工作目录不可用: {e}"}, ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        self._respond(200, b'{"ok":true}', "application/json; charset=utf-8")

    def _api_delete_project(self, project_id):
        """删除已归档项目：仅删 DB 记录（级联任务/轮次），磁盘文件一律保留。

        磁盘上的案例库 / bug 报告 / 任务日志由用户手动清理（需求约定，平台不做自动删除）。
        防误删双保险：仅归档项目可删 + 前端回传项目名（confirm_name）完全一致。
        """
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        if not row["archived"]:
            self._respond(400, json.dumps({"error": "仅已归档的项目可删除，请先归档"},
                                          ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        body = self._read_json() or {}
        if (body.get("confirm_name") or "").strip() != row["name"]:
            self._respond(400, json.dumps({"error": "确认名称与项目名不一致"},
                                          ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        db.delete_project(project_id)
        self._respond(200, b'{"ok":true}', "application/json; charset=utf-8")

    def _api_fs_browse(self, parsed):
        """目录浏览：返回当前目录的子目录列表 + 服务端平台 + 根列表（供目录选择对话框）。"""
        data = fs_browse(parsed.get("path", [""])[0])
        if data is None:
            self._respond(400, json.dumps({"error": "目录不存在或不可读"},
                                          ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        self._respond(200, json.dumps(data, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_fs_mkdir(self, body):
        """新建目录：在 body.path 下创建子目录 body.name（供目录选择对话框「新建文件夹」）。"""
        data, err = fs_mkdir(body.get("path") or "", body.get("name"))
        if data is None:
            self._respond(400, json.dumps({"error": err}, ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        self._respond(200, json.dumps(data, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    # ---------- 项目文件预览 API（会话详情页点击回答里的路径） ----------

    def _api_project_file(self, project_id, parsed):
        """读取项目范围内的文件内容供会话页预览（只读，多用户隔离）。

        query: path=相对/绝对路径（相对按 项目目录 → 工作目录 解析）；
               raw=1 直接返回原文（前端「新标签打开」用）。
        安全：路径须落在本项目「项目目录/工作目录」之内（realpath 包含判定，
        防目录穿越与越权读他人文件）；raw 一律 text/plain + nosniff——这些文件是
        agent 在工作区写的内容，按扩展名猜类型内联下发会让同源页面执行其中脚本。
        """
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        path, root_key, err = resolve_project_file(row, parsed.get("path", [""])[0])
        messages = {
            "empty": (400, "path 不能为空"),
            "outside": (403, "路径不在项目目录/工作目录范围内"),
            "dir": (400, "该路径是目录，暂不支持预览"),
            "missing": (404, "文件不存在或不可读"),
        }
        if err in messages:
            code, msg = messages[err]
            self._respond(code, json.dumps({"error": msg}, ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        if parsed.get("raw", ["0"])[0] in ("1", "true", "yes"):
            self._send_project_file_raw(path)
            return
        try:
            text, size, truncated, binary = read_text_preview(path)
            mtime = int(os.path.getmtime(path))
        except OSError:
            self._respond(404, json.dumps({"error": messages["missing"][1]},
                                          ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        root_dir = (row["project_dir"] if root_key == "project" else row["work_dir"]) or ""
        rel = os.path.relpath(path, root_dir).replace(os.sep, "/") if root_dir else path
        payload = {"path": path, "rel": rel, "root": root_key or "project",
                   "name": os.path.basename(path),
                   "ext": os.path.splitext(path)[1].lstrip(".").lower(),
                   "size": size, "mtime": mtime,
                   "text": text, "truncated": truncated, "binary": binary}
        self._respond(200, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _send_project_file_raw(self, path):
        """原文（新标签打开/二进制下载）：文本按 text/plain，二进制按附件流式下载。

        超过 FILE_RAW_MAX 拒绝（防一次点开把内存/带宽打满）；流式分块写，
        客户端提前断开静默处理。
        """
        try:
            size = os.path.getsize(path)
        except OSError:
            self._respond(404, json.dumps({"error": "文件不存在或不可读"},
                                          ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        if size > FILE_RAW_MAX:
            self._respond(413, json.dumps({"error": "文件过大，无法按原文打开"},
                                          ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        name = os.path.basename(path)
        try:
            with open(path, "rb") as f:
                binary = b"\x00" in f.read(min(size, 65536))
        except OSError:
            binary = True   # 探测失败按二进制处理（只影响下载方式，不影响内容）
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream" if binary
                         else "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if binary:
            ascii_name = re.sub(r'[^A-Za-z0-9._-]', "_", name) or "download"
            self.send_header("Content-Disposition",
                             'attachment; filename="%s"; filename*=UTF-8\'\'%s'
                             % (ascii_name, quote(name)))
        self.end_headers()
        try:
            with open(path, "rb") as f:
                while True:
                    chunk = f.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass  # 客户端提前断开属常态，静默处理

    def _api_archive_project(self, project_id, archived):
        """归档/恢复项目：仅切换 archived 标记，不删数据、不影响运行中任务。

        归档后前端项目列表默认隐藏，可在「已归档」筛选中恢复。
        """
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        db.set_project_archived(project_id, archived)
        self._respond(200, b'{"ok":true}', "application/json; charset=utf-8")

    # ---------- user prefs API（用户 UI 偏好：标签页布局/看板列过滤等前端记忆） ----------

    def _api_prefs_get(self, parsed):
        """当前用户在某项目下的全部 UI 偏好：{prefs: {key: value_dict}}。
        project_id 缺省按 0（跨项目全局，预留）；给定时须为本人项目（多用户隔离）。"""
        user = self._current_user()
        if user is None:
            self._respond(401, b'{"error":"unauthorized"}',
                          "application/json; charset=utf-8")
            return
        try:
            pid = int((parsed.get("project_id") or ["0"])[0] or 0)
        except ValueError:
            pid = 0
        if pid and self._owned_project(pid) is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        self._respond(200, json.dumps({"prefs": db.get_user_prefs(user["id"], pid)},
                                      ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_prefs_set(self, body):
        """UPSERT 一条 UI 偏好：body={project_id, key, value}。
        key 限小写字母/下划线 ≤64 字符；value 须为对象且序列化后 ≤16KB
        （前端布局类数据很小，超限视为异常请求）。"""
        user = self._current_user()
        if user is None:
            self._respond(401, b'{"error":"unauthorized"}',
                          "application/json; charset=utf-8")
            return
        key = str(body.get("key") or "").strip()
        if not re.fullmatch(r"[a-z_]{1,64}", key):
            self._respond(400, '{"error":"key 非法"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        value = body.get("value")
        try:
            text = json.dumps(value, ensure_ascii=False) if isinstance(value, dict) else None
        except (TypeError, ValueError):
            text = None
        if text is None or len(text) > 16384:
            self._respond(400, '{"error":"value 非法"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        try:
            pid = int(body.get("project_id") or 0)
        except (TypeError, ValueError):
            pid = 0
        if pid and self._owned_project(pid) is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        db.set_user_pref(user["id"], pid, key, value)
        self._respond(200, b'{"ok":true}', "application/json; charset=utf-8")

    # ---------- tasks API ----------

    def _task_json(self, row):
        """任务 JSON；new_cases 为相对创建时案例基数的增量（当前库总数 - cases_base）。"""
        new_cases = 0
        try:
            proj = db.get_project(row["project_id"])
            if proj:
                state = self.state_cache.get(proj["id"], proj["cases_root"],
                                             proj["bug_dir"], proj["work_dir"])
                total = state["library"]["stats"].get("total", 0)
                new_cases = max(0, total - int(row["cases_base"] or 0))
        except Exception:
            new_cases = 0
        return {"id": row["id"], "project_id": row["project_id"], "name": row["name"],
                "auto_fix": bool(row["auto_fix"]), "retest": row["retest"],
                "stop_type": row["stop_type"], "stop_value": row["stop_value"],
                "task_type": row["task_type"], "payload": row["payload"],
                "start_stage": row["start_stage"] or "", "end_stage": row["end_stage"] or "",
                "date_from": row["date_from"] or "", "date_to": row["date_to"] or "",
                "extra": row["extra"],
                # 返回实际使用模型(显式指定/日志 -m/CLI 默认), 供 UI 直接展示
                "model": effective_model(row["id"], row["model"]),
                "permission": row["permission"],
                "auto_commit": bool(row["auto_commit"]), "auto_deploy": bool(row["auto_deploy"]),
                "auto_retest": bool(row["auto_retest"]),
                "new_cases": new_cases,
                "status": row["status"], "session_id": row["session_id"],
                # 会话标题（dsh 读标题事件；无标题概念的族留空）
                "session_title": self._session_title(row),
                "current_round": row["current_round"], "new_bugs": row["new_bugs"],
                "created_at": row["created_at"], "started_at": row["started_at"],
                "ended_at": row["ended_at"], "error": row["error"]}

    @staticmethod
    def _session_title(row):
        """任务会话标题：dsh 会话读宿主标题事件（其余族已退场，一律留空）。"""
        try:
            sid = row["session_id"] or ""
            if not sid:
                return ""
            proj = db.get_project(row["project_id"])
            if not proj:
                return ""
            family = runner.agent_family(proj["agent_path"])
            if _sess_family(family) == "dsh":
                return sessparse.dsh_title(sid)
        except Exception:
            return ""
        return ""

    def _api_list_tasks(self, project_id):
        if self._owned_project(project_id) is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        rows = db.list_tasks(project_id)
        self._respond(200, json.dumps([self._task_json(r) for r in rows],
                                      ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_create_task(self, project_id, body):
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        task_type = body.get("task_type", "normal")
        if task_type not in TASK_TYPES:
            self._respond(400, '{"error":"task_type 非法"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        # 提交日期范围（复测/探索可选）：YYYY-MM-DD；首轮 prompt 注入该范围内
        # git 提交与变更文件；复测任务（retest_bug）带日期范围时可不绑定 bug 报告
        date_from = str(body.get("date_from", "") or "").strip()
        date_to = str(body.get("date_to", "") or "").strip()
        date_from, date_to, date_err = _norm_date_range(date_from, date_to)
        if date_err:
            self._respond(400, '{"error":"日期范围非法"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        # 阶段范围解析：探索/回归/修复按 STAGE_MATRIX 校验终点；复测范围来自
        # retest_scope 三选一（缺省 retest_only=仅复测，兼容旧客户端/复测按钮）
        start_stage, end_stage, scope = "", "", ""
        if task_type == "retest_bug":
            scope = str(body.get("retest_scope") or "retest_only").strip()
            if scope not in RETEST_SCOPES:
                self._respond(400, '{"error":"retest_scope 非法"}'.encode("utf-8"),
                              "application/json; charset=utf-8")
                return
            start_stage, end_stage = RETEST_SCOPES[scope]
        else:
            start_stage, end_stage, err = _resolve_stages(task_type, body)
            if err:
                self._respond(400, '{"error":"end_stage 非法"}'.encode("utf-8"),
                              "application/json; charset=utf-8")
                return
        # pipeline 为平台自动创建的后段任务，不接受外部直接创建
        if task_type == "pipeline":
            self._respond(400, '{"error":"pipeline 为平台自动创建的后段任务，不支持手动创建"}'
                          .encode("utf-8"), "application/json; charset=utf-8")
            return
        # 回归任务：重跑指令（extra）必填——agent 按指令决定重跑哪些用例
        if task_type == "regression" and not str(body.get("extra") or "").strip():
            self._respond(400, '{"error":"请填写重跑指令"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        # fix / retest_bug / reject / script_retest 绑定一枚 bug 报告（目录名），固定只跑一轮；
        # retest_bug 带日期范围（date_from/date_to）时不绑定报告（无报告复测，LLM 判影响面）
        payload = ""
        if task_type in ("fix", "retest_bug", "reject", "script_retest"):
            bug_dir = (body.get("bug_dir") or "").strip().strip("/")
            if not bug_dir and task_type == "retest_bug" and (date_from or date_to):
                pass  # 日期范围复测：无需 bug 报告
            elif not bug_dir or not os.path.isdir(os.path.join(row["bug_dir"], bug_dir)):
                self._respond(400, '{"error":"bug 报告目录不存在"}'.encode("utf-8"),
                              "application/json; charset=utf-8")
                return
            else:
                payload_obj = {"bug_dir": bug_dir}
                if task_type == "reject":
                    # 拒绝理由随任务固化：修例 prompt 的依据，重启重跑仍携带
                    reason = (body.get("reason") or "").strip()
                    if not reason:
                        self._respond(400, '{"error":"请填写拒绝理由"}'.encode("utf-8"),
                                      "application/json; charset=utf-8")
                        return
                    payload_obj["reason"] = reason
                payload = json.dumps(payload_obj, ensure_ascii=False)
                # 复测自动选型：仅「仅复测」范围且关联用例全部已固化（各有 verify.py）时
                # 改走平台脚本复测；范围含重新部署时跳过选型（部署需 agent 执行）。
                if task_type == "retest_bug" and scope == "retest_only":
                    _, case_ids = lib.bug_cases(os.path.join(row["bug_dir"], bug_dir))
                    if lib.bug_cases_scripted(row["cases_root"], case_ids):
                        task_type = "script_retest"
        name = (body.get("name") or "").strip()
        if not name and task_type in ("fix", "retest_bug", "reject", "script_retest"):
            prefix = {"fix": "修复 ", "retest_bug": "复测 ", "reject": "修例 ",
                      "script_retest": "脚本复测 "}[task_type]
            name = prefix + \
                (BUG_DIR_RE.match(bug_dir).group(1) if BUG_DIR_RE.match(bug_dir) else bug_dir) \
                if bug_dir else \
                f"{prefix}{date_from or '最早'}..{date_to or '现在'}"
        if not name and task_type == "stress":
            name = f"压测 {db.now_str()}"
        if not name and task_type == "regression":
            name = f"回归 {db.now_str()}"
        if not name:
            name = f"任务 {db.now_str()}"
        stop_type = body.get("stop_type", "rounds")
        stop_value = str(body.get("stop_value", "1"))
        if stop_type not in ("rounds", "bugs", "deadline", "duration"):
            self._respond(400, '{"error":"stop_type 非法"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        # 压测任务：压测说明入 payload（agent 首轮与前端详情共用）；
        # 轮次条件固定 1 轮 agent（发压轮由平台直接追加），不接受其他停止条件
        if task_type == "stress":
            payload = json.dumps(
                {"brief": str(body.get("brief", "") or "").strip()},
                ensure_ascii=False)
            stop_type, stop_value = "rounds", "1"
        auto_fix = bool(body.get("auto_fix", False))
        retest = body.get("retest", "不复测")
        extra = str(body.get("extra", "") or "")
        # 模型回落链: 任务显式指定 > 项目级模型(项目设置) > ''(CLI 默认模型)。
        # 项目模型在创建任务这一刻固化进任务行, 之后改项目模型不影响已建任务。
        model = str(body.get("model", "") or "").strip() or (row["model"] or "").strip()
        permission = str(body.get("permission", "") or "").strip()
        auto_commit = bool(body.get("auto_commit", False))
        auto_deploy = bool(body.get("auto_deploy", False))
        auto_retest = bool(body.get("auto_retest", False))
        # 修复任务：部署勾选由终点推导（终点含部署/复测即需要部署）；复测归宿由
        # 终点决定（终点=retest 为任务内复测），「自动创建复测任务」语义不再使用
        if task_type == "fix":
            auto_deploy = end_stage in ("deploy", "retest")
            auto_retest = 0
        # 记录创建时的案例库总数，作为该任务新增案例数的基线
        try:
            state = self.state_cache.get(row["id"], row["cases_root"],
                                         row["bug_dir"], row["work_dir"])
            cases_base = state["library"]["stats"].get("total", 0)
        except Exception:
            cases_base = 0
        task_id = db.insert_task(project_id, name, auto_fix, retest, stop_type,
                                 stop_value, task_type, payload, extra, model,
                                 permission, auto_commit, auto_deploy,
                                 auto_retest=auto_retest, cases_base=cases_base,
                                 start_stage=start_stage, end_stage=end_stage,
                                 date_from=date_from, date_to=date_to)
        runner_instance.submit(task_id)
        # 探索/回归终点在「生成报告」之后：连带创建后段任务（单轮，报告分析→终点），
        # 同项目 FIFO 保证其排在前段之后执行
        pipeline_id = None
        if task_type in ("normal", "regression") \
                and STAGES.index(end_stage) > STAGES.index("report"):
            pipeline_id = db.insert_task(
                project_id, f"{name}·后段", auto_fix=0, retest="不复测",
                stop_type="rounds", stop_value="1", task_type="pipeline",
                payload=json.dumps({"parent_task_id": task_id}, ensure_ascii=False),
                start_stage="analyze", end_stage=end_stage)
            runner_instance.submit(pipeline_id)
        self._respond(200, json.dumps({"id": task_id, "pipeline_id": pipeline_id},
                                      ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_list_bugs(self, project_id):
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        self._respond(200, json.dumps(list_project_bugs(row), ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    # ---------- 看板 ----------

    def _board_owned(self, project_id, card_id=None):
        """项目归属 + 卡片归属联合校验。返回 (project_row, card_row)；
        任一失败已响应 404 并返回 (None, None)。"""
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return None, None
        if card_id is None:
            return row, None
        card = db.get_board_card(card_id)
        if card is None or card["project_id"] != row["id"]:
            self._respond(404, b'{"error":"card not found"}',
                          "application/json; charset=utf-8")
            return None, None
        return row, card

    def _board_owns_sid(self, row, sid):
        """sid 是否归属本项目卡片的会话并集（每卡 sessions ∪ {session_id}）。
        返回归属卡片行（调用方可读 id/column_key 等）；不归属返回 None
        （防经会话端点读任意会话）。"""
        for c in db.list_board_cards(row["id"]):
            if sid in set(json.loads(c["sessions"] or "[]")):
                return c
            if c["session_id"] and sid == c["session_id"]:
                return c
        return None

    def _api_get_board(self, project_id):
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        payload = board.board_payload(row["id"], board.running_map())
        # 项目级 agent 族与能力声明（前端看板按 capabilities 泛化门控，同 session 窗口先例）
        family = runner.agent_family(row["agent_path"])
        payload["family"] = family
        payload["capabilities"] = family_capabilities(family)
        # 卡片相关会话的标题映射（前端列表展示；解析族归一后逐 sid 读取，sessparse 侧有缓存）
        pfamily = _sess_family(family)
        titles = {}
        for c in payload["cards"]:
            for sid in c["sessions"]:
                if sid not in titles:
                    titles[sid] = sessparse.session_title(pfamily, sid)
        payload["session_titles"] = titles
        self._respond(200, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_board_create_card(self, project_id, body):
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        # 允许空标题建卡（用户先建空卡再单击打开详情编辑，标题在详情内补）
        title = body.get("title")
        if not isinstance(title, str):  # 非字符串（数字/数组等）按缺失处理
            title = ""
        title = title.strip()[:200]
        cid = db.insert_board_card(row["id"], title,
                                   (body.get("description") or "")[:20000],
                                   (body.get("jira_key") or "")[:100])
        self._respond(200, json.dumps(board.card_json(db.get_board_card(cid)),
                                      ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    # ---------- 卡片附件媒体（描述粘贴图片/文件） ----------
    # fid 格式 m<毫秒>_<hex10>.<ext>（只含安全字符，防路径穿越）；
    # 存储于项目工作目录 board_media/ 子目录（工作目录缺省 <项目目录>/.touchstone，
    # 由 lib.ensure_runtime_dirs 创建并写入 .gitignore）
    BOARD_MEDIA_SUBDIR = "board_media"
    BOARD_MEDIA_MAX = 10 * 1024 * 1024  # 单文件上限 10MB
    BOARD_MEDIA_EXTS = {
        "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
        "image/webp": "webp", "image/svg+xml": "svg", "image/bmp": "bmp",
        "image/x-icon": "ico", "text/plain": "txt", "text/csv": "csv",
        "text/html": "html", "application/pdf": "pdf", "application/json": "json",
        "application/zip": "zip", "application/gzip": "gz",
        "application/x-tar": "tar", "application/x-sh": "sh",
        "application/x-python": "py",
    }

    def _api_board_upload_media(self, project_id, body):
        """卡片附件上传：base64 JSON（name/mime/data），返回 {fid, url, abs, size}。

        限制：单文件 ≤10MB；mime 未知时按二进制 bin 存储（前端以链接形式展示）；
        读取走 GET /api/projects/<pid>/board/media/<fid>（同源 cookie 鉴权）。
        """
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        mime = str(body.get("mime") or "application/octet-stream")[:100]
        name = str(body.get("name") or "file")[:200]
        try:
            data = base64.b64decode(str(body.get("data") or ""))
        except (ValueError, TypeError):
            self._respond(400, b'{"error":"bad base64"}',
                          "application/json; charset=utf-8")
            return
        if not data:
            self._respond(400, b'{"error":"empty file"}',
                          "application/json; charset=utf-8")
            return
        if len(data) > self.BOARD_MEDIA_MAX:
            self._respond(400, b'{"error":"file too large"}',
                          "application/json; charset=utf-8")
            return
        ext = self.BOARD_MEDIA_EXTS.get(mime, "bin")
        fid = f"m{int(time.time() * 1000)}_{secrets.token_hex(5)}.{ext}"
        mdir = os.path.join(row["work_dir"] or
                            os.path.join(row["project_dir"], ".touchstone"),
                            self.BOARD_MEDIA_SUBDIR)
        try:
            os.makedirs(mdir, exist_ok=True)
            with open(os.path.join(mdir, fid), "wb") as f:
                f.write(data)
        except OSError as e:
            self._respond(500, json.dumps({"error": f"save failed: {e}"},
                                          ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        self._respond(200, json.dumps({"fid": fid,
                                       "url": f"/api/projects/{project_id}/board/media/{fid}",
                                       "abs": os.path.join(mdir, fid),
                                       "name": name, "size": len(data)},
                                      ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_board_get_media(self, project_id, fid):
        """卡片附件读取：_owned_project 鉴权 + fid 白名单（防路径穿越）。"""
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        if not re.match(r"^m\d+_[0-9a-f]{10}\.[A-Za-z0-9]{1,10}$", fid):
            self._respond(400, b'{"error":"bad fid"}',
                          "application/json; charset=utf-8")
            return
        mdir = os.path.join(row["work_dir"] or
                            os.path.join(row["project_dir"], ".touchstone"),
                            self.BOARD_MEDIA_SUBDIR)
        ext = fid.rsplit(".", 1)[-1].lower()
        ctype = {v: k for k, v in self.BOARD_MEDIA_EXTS.items()}.get(ext,
                                                                    "application/octet-stream")
        self._send_file(os.path.join(mdir, fid), ctype)

    def _api_board_update_card(self, project_id, card_id, body):
        """改卡：白名单字段直接过；parent_card_id 走 set_parent 防循环。"""
        row, card = self._board_owned(project_id, card_id)
        if row is None:
            return
        if "title" in body and not str(body["title"]).strip():
            self._respond(400, b'{"error":"title required"}',
                          "application/json; charset=utf-8")
            return
        fields = {}
        newly_bound = ""   # 本次真正新增的绑定会话（done 卡需同步归档，见文件尾）
        for k in ("title", "description", "block_text"):
            if k in body:
                # 标题与建卡同限 200 字，其余长文本 20000
                fields[k] = str(body[k])[:200 if k == "title" else 20000]
        if "scheduled_at" in body:
            v = body["scheduled_at"]
            try:
                fields["scheduled_at"] = int(v) if v else None
            except (TypeError, ValueError):
                self._respond(400, b'{"error":"bad scheduled_at"}',
                              "application/json; charset=utf-8")
                return
        if "session_id" in body:  # 设主会话（须已在 sessions 列表内）
            sid = str(body["session_id"])
            if sid in json.loads(card["sessions"] or "[]"):
                fields["session_id"] = sid
        if "bind_session" in body:  # 绑定外部会话 id
            sid = str(body["bind_session"]).strip()
            if sid:
                sessions = json.loads(card["sessions"] or "[]")
                if sid not in sessions:
                    sessions.append(sid)
                    newly_bound = sid
                fields["sessions"] = json.dumps(sessions, ensure_ascii=False)
                if not card["session_id"]:
                    fields["session_id"] = sid
        if "unbind_session" in body:  # 解绑（主会话被解绑时取剩余第一个）
            sid = str(body["unbind_session"])
            sessions = [s for s in json.loads(card["sessions"] or "[]") if s != sid]
            fields["sessions"] = json.dumps(sessions, ensure_ascii=False)
            if card["session_id"] == sid:
                fields["session_id"] = sessions[0] if sessions else ""
        if "parent_card_id" in body:
            err = board.set_parent(row["id"], card_id, body["parent_card_id"])
            if err:
                self._respond(400, b'{"error":"\xe5\xbe\xaa\xe7\x8e\xaf\xe4\xbe\x9d\xe8\xb5\x96\xe6\x88\x96\xe7\x88\xb6\xe4\xbb\xbb\xe5\x8a\xa1\xe4\xb8\x8d\xe5\xad\x98\xe5\x9c\xa8"}',
                              "application/json; charset=utf-8")
                return
        if fields:
            db.update_board_card(card_id, **fields)
        if newly_bound:
            # 归档同步（2026-10-05）：卡片在「已完成」时，新绑定的会话（含 fork /
            # 压缩新建后的绑定）也要归档——I2「done 卡全部绑定会话都归档」。
            # best-effort：失败只记提示 + 退避重试，不回滚绑定。
            board.archive_bound_session(db.get_board_card(card_id), newly_bound)
        self._respond(200, json.dumps(board.card_json(db.get_board_card(card_id)),
                                      ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_board_delete_card(self, project_id, card_id):
        """删除卡片 = 移入回收站（软删除）：停会话 + 清平台侧残留（出队行收口），再置 trashed 标记；
        行与评论保留，回收站「彻底删除/清空」才真删。"""
        row, card = self._board_owned(project_id, card_id)
        if row is None:
            return
        board.stop_card(card_id)  # 运行中进程先停
        # 清平台侧残留（打回意见暂存/统一队列等待行/运行行），
        # 防删除后 runner 项目运行位泄漏；幂等，任何状态可安全调用
        board.delete_card_cleanup(card_id)
        db.trash_board_card(card_id)
        self._respond(200, b'{"ok":true,"trashed":true}',
                      "application/json; charset=utf-8")

    def _api_board_trash_list(self, project_id):
        """回收站列表（项目卡片按删除时间倒序）。"""
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        cards = [board.card_json(r, bool(board.running_map().get(r["id"])))
                 for r in db.list_trashed_cards(row["id"])]
        self._respond(200, json.dumps({"cards": cards}, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_board_trash_restore(self, project_id, card_id):
        """还原回收站卡片（回原列原位置）。"""
        row, card = self._board_owned(project_id, card_id)
        if row is None:
            return
        if not card["trashed"]:
            self._respond(400, b'{"error":"card not in trash"}',
                          "application/json; charset=utf-8")
            return
        db.restore_board_card(card_id)
        self._respond(200, b'{"ok":true}', "application/json; charset=utf-8")

    def _api_board_trash_purge(self, project_id, card_id):
        """彻底删除回收站卡片（连带评论，不可恢复）。"""
        row, card = self._board_owned(project_id, card_id)
        if row is None:
            return
        if not card["trashed"]:
            self._respond(400, b'{"error":"card not in trash"}',
                          "application/json; charset=utf-8")
            return
        board.delete_card_cleanup(card_id)  # 幂等兜底：真删前清平台侧残留占用
        db.purge_board_card(card_id)
        self._respond(200, b'{"ok":true}', "application/json; charset=utf-8")

    def _api_board_trash_empty(self, project_id):
        """清空项目回收站（全部真删，不可恢复）。"""
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        db.purge_trashed_cards(row["id"])
        self._respond(200, b'{"ok":true}', "application/json; charset=utf-8")

    def _api_board_reorder(self, project_id, body):
        """列内拖排：body={card_id, before_id(null=列尾)}。

        doing 列不限 manual（v2c T2，裁决 R11：调序落点=wait_items 位次，
        队序即展示序）；其余列维持 manual 模式限定（sort_order 整列重写）。
        模式判定与落点语义收口 board.reorder_card，本端点只做参数整形。"""
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        try:
            card_id = int(body.get("card_id"))
        except (TypeError, ValueError):
            self._respond(400, b'{"error":"card_id required"}',
                          "application/json; charset=utf-8")
            return
        try:
            before_id = int(body["before_id"]) if body.get("before_id") is not None else None
        except (TypeError, ValueError):
            before_id = None
        err = board.reorder_card(row["id"], card_id, before_id)
        if err:
            self._respond(400, json.dumps({"error": err}, ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        self._respond(200, b'{"ok":true}', "application/json; charset=utf-8")

    def _api_board_mark_viewed(self, project_id, card_id):
        """标记卡片已查看（POST /api/projects/<pid>/board/cards/<cid>/viewed）。

        2026-10-07 批次「卡片状态有更新·用户还没打开过 ⇒ 卡面打标记」的清除端：
        前端打开卡片详情（点击卡面正文 / 详情按钮）或点卡面操作行上任意一个按钮时调用，
        清 `board_cards.unread`。
        幂等：本来就未读/标记已被别的标签页清掉都回 200；`changed` 说明本次是否真的
        清了标记（不清就不发看板变更信号，前端也不必重取）。归属校验走
        `_board_owned`（多用户隔离红线：越权访问他人卡片一律 404）。
        """
        row, card = self._board_owned(project_id, card_id)
        if row is None:
            return
        changed = db.mark_card_viewed(card_id)
        self._respond(200, json.dumps({"ok": True, "unread": False,
                                       "changed": bool(changed)}).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_board_card_action(self, project_id, card_id, action, body):
        """move / start / stop。move 走门禁仲裁；start 额外带打回意见起会话；
        stop 停运行中的会话（CLI 杀进程组；web 走 REST abort）；等待区卡
        （doing/queue 排队占位）stop 取消排队并落待审核（v2b T3，裁决 R9——
        stop 端点与 start 端点对称放行，board.stop_card 内分流）。"""
        row, card = self._board_owned(project_id, card_id)
        if row is None:
            return
        if action == "stop":
            hit = board.stop_card(card_id)
            self._respond(200, json.dumps({"ok": True, "stopped": hit}).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        if action == "move":
            target = (body.get("column") or "").strip()
            try:
                before_id = int(body["before_id"]) if body.get("before_id") is not None else None
            except (TypeError, ValueError):
                before_id = None
            # merge_ack（2026-10-07 批次）：独立 worktree 卡进「已完成」的待合并闸。
            # 默认 false ⇒ 有待合并提交时 move_card 回 {"merge_pending": ...} 且列不动，
            # 前端弹「交给 agent 合并 / 仅通过」；用户选「仅通过」时前端带 true 再来一次，
            # 后端跳过该闸（= 旧行为，分支保留）。
            card_dict, err = board.move_card(row, card_id, target,
                                             (body.get("block_text") or "")[:2000],
                                             before_id=before_id,
                                             merge_ack=bool(body.get("merge_ack")))
            if err:
                if "blocked" in err or "merge_pending" in err:
                    # 父任务拦截 / 合并询问：前端弹确认框，不算错误（列未变）
                    self._respond(200, json.dumps(err, ensure_ascii=False).encode("utf-8"),
                                  "application/json; charset=utf-8")
                    return
                self._respond(400, json.dumps(err, ensure_ascii=False).encode("utf-8"),
                              "application/json; charset=utf-8")
                return
            self._respond(200, json.dumps({"card": card_dict}, ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        # start：归档项目禁止；门禁+起会话+落列原子化走 board.start_into_doing
        # （queue 落 doing 排队占位与成功落 doing 均清 scheduled_at，防陈旧定时被调度线程点燃）
        if row["archived"]:
            self._respond(400, b'{"error":"\xe9\xa1\xb9\xe7\x9b\xae\xe5\xb7\xb2\xe5\xbd\x92\xe6\xa1\xa3"}',
                          "application/json; charset=utf-8")
            return
        opinion = (body.get("opinion") or "")[:20000]
        # doing+queue 排队占位卡放行 start（2026-09-06 起占位落 doing 列）：
        # force=true 直起跳队（board._enter_doing force 分支出队+清占位），
        # 非 force 幂等补队自愈滞留卡；其余 doing 卡照旧拒绝。
        # done 列放行（2026-09-11）：已完成卡拖入「正在开发」= 接着干（续接主
        # 会话只发「继续」，见 board.build_start_prompt），完成后再走待审核。
        if card["column_key"] not in ("todo", "review", "blocked", "done") and not \
                (card["column_key"] == "doing" and card["block_kind"] == "queue"):
            self._respond(400, b'{"error":"\xe5\xbd\x93\xe5\x89\x8d\xe7\x8a\xb6\xe6\x80\x81\xe4\xb8\x8d\xe5\x8f\xaf\xe5\xbc\x80\xe5\xa7\x8b"}',
                          "application/json; charset=utf-8")
            return
        card_dict, err = board.start_into_doing(row, card, opinion,
                                                force=bool(body.get("force")),
                                                worktree=bool(body.get("worktree")))
        if err:
            if "blocked" in err:  # 父任务拦截：前端弹确认框，不算错误
                self._respond(200, json.dumps(err).encode("utf-8"),
                              "application/json; charset=utf-8")
                return
            self._respond(400, json.dumps(err, ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        # queue 形态同样走这里：card.column=='blocked' 正常返回
        self._respond(200, json.dumps({"card": card_dict}, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_board_card_worktree_preview(self, project_id, card_id):
        """独立 worktree 预览（GET .../board/cards/<id>/worktree，2026-10-06 批次）。

        只读、不落盘：算路径/分支并给出 supported 与中文原因（项目非 git 仓库 /
        卡片已有主会话 ⇒ supported=false）。前端「开始」下拉据此决定菜单项是否置灰
        （plan §3.4），避免用户点了必然失败的入口。
        """
        row, card = self._board_owned(project_id, card_id)
        if row is None:
            return
        info = board.worktree_preview(row, card)
        self._respond(200, json.dumps(info, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_board_card_worktree_cleanup(self, project_id, card_id):
        """清理卡片独立 worktree（DELETE .../board/cards/<id>/worktree）。

        运行中的卡 409（会话还在跑时不能抽走它的 cwd）；工作树有未提交改动 400
        （plan D8：绝不 `--force`，改动由用户自己处置）；成功清 `card.worktree` 标记。
        """
        row, card = self._board_owned(project_id, card_id)
        if row is None:
            return
        if board.running_map().get(card_id):
            self._respond(409, json.dumps({"error": "会话运行中，请先停止卡片再清理 worktree"},
                                          ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        ok, err = board.cleanup_card_worktree(row, card)
        if not ok:
            self._respond(400, json.dumps({"error": err}, ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        self._respond(200, b'{"ok": true}', "application/json; charset=utf-8")

    def _api_board_card_worktree_merge(self, project_id, card_id):
        """把 worktree 改动回流主分支的合并任务交给卡片会话（2026-10-07 批次）。

        `POST .../board/cards/<id>/worktree/merge`。「通过」时若判定有待合并提交
        （move 端点回 `merge_pending`），前端弹框让用户选——这条端点即「交给 agent
        合并」：平台只投递指令 + 把卡片送回统一队列，agent 在卡片会话里执行同步
        主分支与合并回流（冲突由 agent 解），干完这轮卡片自动回待审核，用户再点
        「通过」时已无待合并提交、直接进「已完成」。
        硬错误 400（无待合并提交 / 无主会话 / 工作树读不到）；卡片运行中由
        `board._enter_doing` 的入口预检拦下（同样 400 带中文原因）。
        """
        row, card = self._board_owned(project_id, card_id)
        if row is None:
            return
        card_dict, err = board.handoff_worktree_merge(row, card)
        if err:
            self._respond(400, json.dumps(err, ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        self._respond(200, json.dumps({"card": card_dict}, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_board_compact(self, project_id, card_id, body):
        """卡片会话 compact（压缩上下文）。busy 拒绝（409）；族不支持 400；
        CLI 族异步触发即返回（日志落工作目录 .web/board_compact_*）。"""
        row, card = self._board_owned(project_id, card_id)
        if row is None:
            return
        sid = str(body.get("sid") or card["session_id"] or "").strip()
        if not sid:
            self._respond(400, b'{"error":"sid required"}', "application/json; charset=utf-8")
            return
        if board.running_map().get(card_id):
            self._respond(409, json.dumps({"error": "会话运行中，稍后再试"},
                                          ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        try:
            board.compact_session(row, card, sid)
        except RuntimeError as e:
            self._respond(400, json.dumps({"error": str(e)}, ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        self._respond(200, b'{"ok":true}', "application/json; charset=utf-8")

    def _api_board_fork_compact(self, project_id, card_id, body):
        """卡片会话「压缩并新建」（dsh_plugin）：**等价近似**（dsh 没有「读压缩
        摘要再注入新会话」的等价物）——fork 出完整副本 → 把**新会话**压缩，
        上下文随即变轻；差别是新会话日志仍保留完整历史（窗口渲染更重），
        见 `board.fork_compact_session` 与 spec/board。
        busy 拒绝（409）；退场族 400（RETIRED_MSG）；压缩失败/超时 400。
        返回 {ok, new_sid, compact_ok}。"""
        row, card = self._board_owned(project_id, card_id)
        if row is None:
            return
        sid = str(body.get("sid") or card["session_id"] or "").strip()
        if not sid:
            self._respond(400, b'{"error":"sid required"}', "application/json; charset=utf-8")
            return
        if board.running_map().get(card_id):
            self._respond(409, json.dumps({"error": "会话运行中，稍后再试"},
                                          ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        try:
            new_sid, compact_ok = board.fork_compact_session(row, card, sid)
        except RuntimeError as e:
            self._respond(400, json.dumps({"error": str(e)}, ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        self._respond(200, json.dumps({"ok": True, "new_sid": new_sid,
                                       "compact_ok": compact_ok},
                                      ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_board_fork(self, project_id, card_id, body):
        """卡片会话 fork（dsh_plugin）：完整复制源会话为新会话（历史/上下文全量
        保留，同 workspace/cwd），不改变主会话——新 sid 由前端经 bind_session
        追加进卡片会话列表。busy 拒绝（409）；族不支持/会话不属于卡片 400。
        返回 {ok, new_sid}。"""
        row, card = self._board_owned(project_id, card_id)
        if row is None:
            return
        sid = str(body.get("sid") or card["session_id"] or "").strip()
        if not sid:
            self._respond(400, b'{"error":"sid required"}', "application/json; charset=utf-8")
            return
        if board.running_map().get(card_id):
            self._respond(409, json.dumps({"error": "会话运行中，稍后再试"},
                                          ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        try:
            new_sid = board.fork_session(row, card, sid)
        except RuntimeError as e:
            self._respond(400, json.dumps({"error": str(e)}, ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        self._respond(200, json.dumps({"ok": True, "new_sid": new_sid},
                                      ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_board_add_comment(self, project_id, card_id, body):
        row, card = self._board_owned(project_id, card_id)
        if row is None:
            return
        text = (body.get("text") or "").strip()
        if not text:
            self._respond(400, b'{"error":"text required"}',
                          "application/json; charset=utf-8")
            return
        mid = db.insert_board_comment(card_id, text[:20000])
        row_c = [c for c in db.list_board_comments(row["id"]) if c["id"] == mid][0]
        self._respond(200, json.dumps(board.comment_json(row_c),
                                      ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_board_send_comment(self, project_id, card_id, comment_id, body):
        row, card = self._board_owned(project_id, card_id)
        if row is None:
            return
        target = None
        for c in db.list_board_comments(row["id"]):
            if c["id"] == comment_id and c["card_id"] == card_id:
                target = c
                break
        if target is None:
            self._respond(404, b'{"error":"comment not found"}',
                          "application/json; charset=utf-8")
            return
        try:
            # inject=true 时立即注入运行中的当前轮（dsh 等 steer 能力会话生效）；
            # 项目忙（同项目有单元在跑）时登记统一队列消息单元，返回 queued=true
            #（前端显示「排队中」，注释见 board.deliver_comment）
            rec = board.deliver_comment(row, card, target,
                                        inject=bool(body.get("inject")),
                                        raw=bool(body.get("raw")))
        except dshdriver.DshDriverError as e:
            # 409 = 会话运行中（deliver_comment 的忙拒绝）；其余 code 按 500
            if e.args and e.args[0] == 409:
                self._respond(409, json.dumps(
                    {"error": e.args[1] if len(e.args) > 1 else "会话运行中，稍后重试"},
                    ensure_ascii=False).encode("utf-8"),
                    "application/json; charset=utf-8")
            else:
                self._respond(500, json.dumps({"error": f"agent 调用失败: {e}"},
                                              ensure_ascii=False).encode("utf-8"),
                              "application/json; charset=utf-8")
            return
        except RuntimeError as e:
            self._respond(400, json.dumps({"error": str(e)}, ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        self._respond(200, json.dumps(
            {"ok": True, "queued": bool(rec and rec.get("queued")),
             "msg_id": (rec or {}).get("id") or ""},
            ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _api_board_delete_comment(self, project_id, card_id, comment_id):
        row, card = self._board_owned(project_id, card_id)
        if row is None:
            return
        # 评论归属校验（评论 id 全表自增可枚举，防跨项目删除他人评论）
        target = None
        for c in db.list_board_comments(row["id"]):
            if c["id"] == comment_id and c["card_id"] == card_id:
                target = c
                break
        if target is None:
            self._respond(404, b'{"error":"comment not found"}',
                          "application/json; charset=utf-8")
            return
        db.delete_board_comment(comment_id)
        self._respond(200, b'{"ok":true}', "application/json; charset=utf-8")

    def _api_board_update_settings(self, project_id, body):
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        s = board.settings_of(row["id"])
        # 并行模式白名单（serial/parallel 两档；readonly-parallel 2026-09-17 删档，
        # 旧前端残余值静默忽略不落库）
        if body.get("mode") in board.MODE_VALUES:
            s["mode"] = body["mode"]
        if isinstance(body.get("jira"), dict):
            for k in ("url", "user", "token"):
                if k in body["jira"]:
                    s["jira"][k] = str(body["jira"][k])[:500]
        # sync_sessions 开关（session 自动同步归类，默认开）
        if isinstance(body.get("sync_sessions"), bool):
            s["sync_sessions"] = body["sync_sessions"]
        # 每列排序方案：逐列白名单校验（key∈五列、value∈SORT_MODES、
        # entered_desc 仅 done 列）；逐列合并进现值，非法整份拒绝
        if isinstance(body.get("sort"), dict):
            for col, mode in body["sort"].items():
                if col not in board.COLUMNS or mode not in board.SORT_MODES:
                    self._respond(400, b'{"error":"bad sort"}',
                                  "application/json; charset=utf-8")
                    return
                if mode == "entered_desc" and col != "done":
                    self._respond(400, b'{"error":"bad sort"}',
                                  "application/json; charset=utf-8")
                    return
                s["sort"][col] = mode
        db.set_board_settings(row["id"], s)
        self._respond(200, json.dumps(s, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_board_jira(self, project_id, action, body):
        """Jira：test 用请求体里的配置试连；import 用已保存设置导入。"""
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        if action == "test":
            cfg = {"url": str(body.get("url") or ""), "user": str(body.get("user") or ""),
                   "token": str(body.get("token") or "")}
            result = board.jira_myself(cfg)
        else:
            result = board.jira_import(row["id"])
        code = 200 if result.get("ok") else 400
        self._respond(code, json.dumps(result, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_board_sessions(self, project_id):
        """列出项目工作区已有 agent 会话（绑定已有会话下拉 / 自动同步的数据源）。
        bound=已在任一卡片 sessions 内（前端下拉置灰）。"""
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        family = _sess_family(runner.agent_family(row["agent_path"]))
        items = sessparse.list_sessions(family, row["project_dir"])
        bound = set()
        for c in db.list_board_cards(row["id"]):
            bound |= set(json.loads(c["sessions"] or "[]"))
            if c["session_id"]:
                bound.add(c["session_id"])
        for it in items:
            it["bound"] = it["sid"] in bound
        self._respond(200, json.dumps({"sessions": items}, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_board_session_messages(self, project_id, parsed):
        """看板卡片会话只读查看（sessparse 按 family+sid 直读，不经任务）。"""
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        sid = parsed.get("sid", [""])[0]
        try:
            after = int(parsed.get("after", ["0"])[0] or 0)
        except (TypeError, ValueError):
            self._respond(400, b'{"error":"bad after"}',
                          "application/json; charset=utf-8")
            return
        if not sid:
            self._respond(400, b'{"error":"sid required"}',
                          "application/json; charset=utf-8")
            return
        # sid 必须落在本项目全部卡片的会话并集内（防跨项目读任意会话）；
        # 归属卡片行留用（id → running 判定/队列键，column_key → 标题行「卡片队列」徽标）
        owner = self._board_owns_sid(row, sid)
        if owner is None:
            self._respond(404, b'{"error":"session not found"}',
                          "application/json; charset=utf-8")
            return
        owner_cid = owner["id"]
        family = runner.agent_family(row["agent_path"])
        agent = parsed.get("agent", ["main"])[0] or "main"
        # dsh_plugin 的会话即 dsh 宿主会话，sessparse 调用统一经 _sess_family 归一
        data = sessparse.load(_sess_family(family), sid, agent, after)
        if isinstance(data, dict):
            data["session_id"] = sid  # 前端头部徽标展示用（load 结果不含 sid）
            # 能力声明 + 运行态（前端按 capabilities 渲染输入区，同任务 session 先例）；
            # board 会话无 chat._CHATS 概念，running 即 busy，直接以 running 充当 chat 态；
            # 平台未在管时看会话实况 busy——用户在 dsh 侧直跑的外部会话同步卡也能
            # 点亮「工作中…」（已作答·待送达不算运行：见 _board_session_running，2026-09-14）
            running = _board_session_running(owner_cid, row, sid)
            data["capabilities"] = family_capabilities(family)
            data["running"] = running
            # chat 态 = 卡片会话 busy（含外部直跑）+ 排队/失败消息（统一队列消息单元，
            # 同任务会话先例：chat.state 的 queued/msgs 供前端排队 chip 与失败提示）
            chat_st = chat.state(sid)
            chat_st["running"] = running or bool(chat_st.get("running"))
            data["chat"] = chat_st
            data["project_busy"] = _project_busy(project_id)
            # 统一队列态（会话窗标题「队列」徽标）：本卡片单元此刻排队/运行/空闲
            data["unit_state"] = _unit_state(row["id"], f"c:{owner_cid}")
            # 卡片当前所在列（会话窗标题「卡片队列」徽标，键值同看板列：todo/doing/
            # blocked/review/done；前端转列名展示，随 2s 轮询跟随卡片移列）
            data["card_column"] = owner["column_key"]
            # 卡片是否跑在独立 worktree（2026-10-07 批次）：会话窗「通过」要按
            # 看板同款口径弹「是否交给 agent 合并」（空串=普通卡）
            data["card_worktree"] = str(db.row_opt(owner, "worktree") or "").strip()
            # 已作答·待送达（答案排队，2026-09-14）：前端在输入区上方渲染「待送达」行
            # 与「立即送达」按钮（POST .../cards/<cid>/answer/deliver，不等项目空闲）
            data["answer_pending"] = board.is_answer_pending(owner_cid)
            data["interaction"] = board.interaction_of_sid(sid)
            # 会话归属三态（C 批 T8）：前端按 `owned === false` 出「外部会话」提示条并把
            # 「停止」置灰；`None`=注册表未知按「池内」渲染（判定口径见 _session_owned）
            data["owned"] = _session_owned(sid)
            data["family"] = family
            if family == "dsh_plugin":
                # P6：ctx 圈数据源＝EventHub 的 usage（事件推来，零请求）。
                # dsh 的 TokenUsage 没有窗口上限 ⇒ max 缺省 None（前端不画环）。
                st = dshevents.get(sid)
                if st and st.get("usage"):
                    data["ctx"] = {"used": st["usage"].get("total") or 0, "max": None}
                # 会话级模型（会话窗「模型」展示）：事件流里学到就用它，否则留空
                # 由前端回落「项目默认模型」（既有兜底链）
                sel = (st or {}).get("model") or {}
                if sel.get("model"):
                    data["sessionModel"] = (f"{sel['provider']}/{sel['model']}"
                                            if sel.get("provider") else sel["model"])
                # 会话级权限档（会话窗「权限」控件，2026-10-04 修）：优先事件流里学到的
                # 平台三档 mode；没有时（外部直跑后接管的会话、老插件）按宿主 preset
                # 反查近似档位；两者都没有就不下发 ⇒ 前端保持置灰（不猜）。
                pmode = _session_permission_mode(st)
                if pmode:
                    data["permission"] = pmode
                # 会话级思考等级（会话窗「思考等级」控件，2026-10-04）：事件流里学到的
                # 宿主 reasoningEffort（driver/model 帧带的），没有就不下发——前端
                # 回落「该模型的默认档」展示，不猜。空值语义见 _api_board_session_profile。
                effort = dshevents.session_effort(sid)
                if effort:
                    data["sessionEffort"] = effort
                # 宿主 inbox 排队行（P6 #21）：[{id,text}] 同形，前端据在场判定
                # server_queued（行 chip tag=server）。dsh 的行没有平台 msg_id/
                # prompt_id，故只展示、不提供「立即注入」。
                data["queue"] = [{"id": str(m.get("id") or ""),
                                  "text": str(m.get("text") or "")}
                                 for m in ((st or {}).get("inbox") or [])]
            # 展示派生（P6）：会话级 queue_state（枚举 board.QS_*）；server_queued
            # 由 meta.queue（dsh 宿主 inbox 排队行）在场判定；
            # starting（v2a T4，R6）= c: 行 starting 且未证实运行（启动宽限窗口）；
            # interaction_pending（2026-09-25）= 卡片提问挂起（block_kind=interaction）
            data["queue_state"] = _session_queue_state(
                project_id, data.get("unit_state"), running=running,
                answer_pending=bool(data.get("answer_pending")),
                server_queued=bool(data.get("queue")),
                starting=board.card_starting(owner_cid),
                interaction_pending=owner["block_kind"] == "interaction")
        self._respond(200, json.dumps(data, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_board_session_media(self, project_id, media_id, parsed):
        """看板卡片会话图片字节（board 会话窗无 taskId，图片经 项目+sid 寻址；
        归属口径与 _api_board_session_messages 相同，防跨项目读任意会话）。"""
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        sid = parsed.get("sid", [""])[0]
        if not sid:
            self._respond(400, b'{"error":"sid required"}',
                          "application/json; charset=utf-8")
            return
        if self._board_owns_sid(row, sid) is None:
            self._respond(404, b'{"error":"session not found"}',
                          "application/json; charset=utf-8")
            return
        agent = parsed.get("agent", ["main"])[0] or "main"
        # dsh_plugin 的会话即 dsh 宿主会话，sessparse 调用统一经 _sess_family 归一
        resolved = sessparse.resolve_media(
            _sess_family(runner.agent_family(row["agent_path"])),
            sid, agent, unquote(media_id))
        if resolved is None:
            self._respond(404, b'{"error":"media not found"}',
                          "application/json; charset=utf-8")
            return
        data, ctype = resolved
        self._respond(200, data, ctype)

    def _api_board_session_profile(self, project_id, sid, body):
        """卡片会话级配置（模型/权限档/思考等级）：body={model?, permission_mode?,
        reasoning_effort?}。

        路线 A P3（2026-10-03）：dsh_plugin 支持会话级**模型切换**（驱动 `/model`
        → 宿主 selectModel）与**权限档切换**（驱动 `/permission` →
        宿主 permissionPresets.set），同步直调、即时生效。权限档走
        DSH_PERMISSION_PRESETS 的语义近似映射：manual ↔ workspace-write+approval=ask
        （平台随即接管审批代答，见 board.answer_approval），yolo/auto ↔
        danger-full-access。

        2026-10-04 加**思考等级**（`reasoning_effort`，dsh reasoningEffort）：与模型
        一次下传（驱动 `/model` 的 `reasoning_effort`），空串=不改；非法值 400（白名单
        见 DSH_EFFORT_LEVELS）。**注意**：会话级选择只作用于当前会话，卡片下一次「开始/
        打回续改」会按（会话实时态优先，否则项目默认）重新下发，见 board._start_web。
        越权/非本卡会话 404；已退场族 400；body 三者皆空 400；驱动异常 502。
        """
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        if self._board_owns_sid(row, sid) is None:
            self._respond(404, b'{"error":"session not found"}',
                          "application/json; charset=utf-8")
            return
        fam = runner.agent_family(row["agent_path"])
        model = str(body.get("model") or "")
        pmode = str(body.get("permission_mode") or "")
        effort = normalize_effort(body.get("reasoning_effort")) if "reasoning_effort" in body else ""
        if fam != "dsh_plugin":
            self._respond(400, json.dumps({"error": "该 agent 族不支持会话级配置"},
                                          ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        if effort is None:
            self._respond(400, json.dumps(
                {"error": f"思考等级非法（{'/'.join(DSH_EFFORT_LEVELS)} 或留空）"},
                ensure_ascii=False).encode("utf-8"),
                "application/json; charset=utf-8")
            return
        if not model and not pmode and not effort:
            self._respond(400, b'{"error":"model/permission_mode/reasoning_effort required"}',
                          "application/json; charset=utf-8")
            return
        if pmode and pmode not in DSH_PERMISSION_PRESETS:
            self._respond(400, json.dumps({"error": "权限档非法（manual/yolo/auto）"},
                                          ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        try:
            if pmode:
                # 三档 mode 一并下传：宿主 preset 到三档是多对一（yolo/auto 同 preset），
                # 只靠回读 preset 反推不出是哪一档；驱动记下 mode 并随状态帧回给平台，
                # 会话窗「权限」控件据此显示当前档位（2026-10-04 修恒置灰）。
                dshdriver.set_permission(sid, DSH_PERMISSION_PRESETS[pmode], mode=pmode)
            if model or effort:
                # 只改思考等级时 model 传空串：插件从会话当前模型选择回读 provider/model
                dshdriver.set_model(sid, model, reasoning_effort=effort)
        except dshdriver.DshDriverError as e:
            self._respond(502, json.dumps({"error": str(e)}, ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        self._respond(200, json.dumps({"ok": True, "model": model,
                                       "permission_mode": pmode,
                                       "reasoning_effort": effort or ""},
                                      ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_task_session_profile(self, task_id, body):
        """任务会话级配置（2026-10-04，只开**思考等级**）。

        会话详情页对任务会话也给「思考等级」控件（与看板卡同款）——档位属会话请求
        参数，不影响任务参数与轮次语义。**只接受 reasoning_effort**：
          - `model`：任务模型在每轮起会话时按任务/项目模型下发，会话级切换下一轮即被
            覆盖，开了会骗人，显式拒绝；
          - `permission_mode`：任务会话没有交互面（任务端点不下发 meta.interaction，
            审批卡无人可答），manual(approval=ask) 会让任务永久挂起，同样不开
            （项目权限档只对看板卡会话生效，见 board._start_web 注释）。
        body={reasoning_effort}（空串=恢复宿主/项目默认）；非法值 400；族不符 400；
        会话尚未生成 409；驱动异常 502。
        """
        task, project, family = self._session_context(task_id)
        if task is None:
            self._respond(404, b'{"error":"task not found"}',
                          "application/json; charset=utf-8")
            return
        for unsupported in ("model", "permission_mode"):
            if str(body.get(unsupported) or ""):
                self._respond(400, json.dumps(
                    {"error": f"任务会话不支持 {unsupported}（仅看板卡会话支持）"},
                    ensure_ascii=False).encode("utf-8"),
                    "application/json; charset=utf-8")
                return
        if family != "dsh_plugin":
            self._respond(400, json.dumps({"error": "该 agent 族不支持会话级配置"},
                                          ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        effort = normalize_effort(body.get("reasoning_effort"))
        if effort is None:
            self._respond(400, json.dumps(
                {"error": f"思考等级非法（{'/'.join(DSH_EFFORT_LEVELS)} 或留空）"},
                ensure_ascii=False).encode("utf-8"),
                "application/json; charset=utf-8")
            return
        sid = task["session_id"] or ""
        if not sid:
            self._respond(409, '{"error":"会话尚未生成（首轮执行后才有）"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        # 模型取任务/项目口径（与 runner 起轮一致）：只改思考等级时插件也能自己回读
        # 会话当前模型，这里传上是为了「档位与模型不匹配」时宿主能给出准确报错
        model = (task["model"] or "").strip() or \
            ((project["model"] or "").strip() if project else "")
        provider, mid = dshdriver.split_model(model)
        try:
            dshdriver.set_model(sid, mid, provider=provider, reasoning_effort=effort)
        except dshdriver.DshDriverError as e:
            self._respond(502, json.dumps({"error": str(e)}, ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        self._respond(200, json.dumps({"ok": True, "reasoning_effort": effort},
                                      ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_board_answer_interaction(self, project_id, card_id, body):
        """作答卡片会话的待答交互（dsh_plugin 族）。

        body 按字段分派两种形态（白名单校验见 board.answer_interaction /
        board.answer_approval）：
        - 提问：{qid, answers:[{wire, kind?, option_id?/option_ids?/text?}, ...]}
          （wire=子题 id（questions[].id）；kind ∈ single/multi/other/
          multi_with_other，缺省 single；多子题提问须**一次提交全部子题**——
          提问的 answers 是逐子题 record，缺项即未答）
        - 审批：{approval_id, decision, scope?}（decision ∈ approved/rejected，
          scope=session 表示本会话内批准）
        响应 queued 语义（v2b T1，裁决 R8）：看板卡路径作答/审批**一律入队**
        （闲时直送已删），成功即 queued=true（由 board.is_answer_pending 现读
        表派生）；任务侧端点照旧 queued=false 直送（specQ §5 边界不变）。
        已退场族直接 400。"""
        row, card = self._board_owned(project_id, card_id)
        if row is None:
            return
        fam = runner.agent_family(row["agent_path"])
        # 路线 A 打通（2026-10-03 P1）：作答走插件 `/answer`，审批分支在 dsh 上
        # 由 board 抛 40005（不代答），错误信息由既有错误响应透出。
        if fam != "dsh_plugin":
            self._respond(400, json.dumps({"error": "该 agent 族不支持回答问题"},
                                          ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        if body.get("approval_id"):
            err = board.answer_approval(row, card,
                                        str(body.get("approval_id") or ""),
                                        str(body.get("decision") or ""),
                                        scope=str(body.get("scope") or ""))
        else:
            qid = str(body.get("qid") or "")
            if not qid:
                self._respond(400, b'{"error":"qid/approval_id required"}',
                              "application/json; charset=utf-8")
                return
            err = board.answer_interaction(
                row, card, qid, body.get("answers") or [])
        if err:
            self._respond(400, json.dumps({"error": err}, ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        queued = board.is_answer_pending(card["id"])
        self._respond(200, json.dumps({"ok": True, "queued": queued}).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_board_deliver_answer(self, project_id, card_id):
        """「立即送达」：把已作答·待送达的答案立即交给等待中的会话（不等项目空闲）。

        会话窗「待送达」行与卡片操作行的共用入口；无待送达答案/送达失败 400
        （消息仍在待送达，可重试或等调和器空闲送达）。"""
        row, _card = self._board_owned(project_id, card_id)
        if row is None:
            return
        ok, err = board.deliver_pending_answer_now(card_id)
        if not ok:
            self._respond(400, json.dumps({"error": err}, ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        self._respond(200, b'{"ok":true}', "application/json; charset=utf-8")

    def _api_board_session_inject(self, project_id, sid, body):
        """把卡片会话排队中的平台消息立即注入（不等统一队列；dsh_plugin 族）。

        body={msg_id}；msg_id 必须是本会话（sid）名下的平台排队消息记录
        （白名单，防跨会话/跨项目注入他人消息）。"""
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        if self._board_owns_sid(row, sid) is None:
            self._respond(404, b'{"error":"session not found"}',
                          "application/json; charset=utf-8")
            return
        self._inject_msg(row, sid, body)

    def _api_session_chat_inject(self, task_id, body):
        """把任务会话排队中的平台消息立即注入（不等统一队列；dsh_plugin 族）。"""
        task, project, family = self._session_context(task_id)
        if task is None:
            self._respond(404, b'{"error":"task not found"}',
                          "application/json; charset=utf-8")
            return
        sid = task["session_id"] or ""
        if not sid:
            self._respond(409, '{"error":"会话尚未生成（首轮执行后才有）"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        self._inject_msg(project, sid, body, task_id=task_id)

    def _inject_msg(self, project, sid, body, task_id=None):
        """平台排队消息「立即注入」的共用实现（看板/任务两路；归属与族校验）。

        本端点处理**平台统一队列**里的消息单元（项目忙时排队的消息）——撤销排队
        并立即投递到会话（有运行中的轮次则注入当前轮，空闲则立即起轮），不再等
        项目空闲。投递失败消息退回队列（见 chat.inject_now），响应 502 供前端 toast。
        """
        fam = runner.agent_family(project["agent_path"])
        # 单族世界：`chat.inject_now` 只对 dsh_plugin 开放（运行中注入当前轮 =
        # steer，空闲即起轮）；已退场族 400。
        if fam != "dsh_plugin":
            self._respond(400, json.dumps({"error": "该 agent 族不支持立即注入"},
                                          ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        info = chat.msg_info(str(body.get("msg_id") or ""))
        if info is None or info["sid"] != sid or info["project_id"] != project["id"] \
                or (task_id is not None and info["task_id"] != task_id):
            self._respond(404, json.dumps({"error": "消息不存在或不在该会话下"},
                                          ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        try:
            chat.inject_now(info["id"])
        except chat.InjectRefused as e:
            # 被拒（已被 worker 拾起/不可注入）：消息仍在队列，不改状态
            self._respond(400, json.dumps({"error": str(e)},
                                          ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        except Exception as e:
            # 投递失败：消息已按原位次退回排队（chat.inject_now 内），此处只报错
            self._respond(502, json.dumps({"error": f"注入失败：{e}"},
                                          ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        self._respond(200, b'{"ok":true}', "application/json; charset=utf-8")

    def _api_board_session_rewind(self, project_id, sid, body):
        """把卡片会话回退到某条用户提问之前（dsh_plugin 族）。

        body={mid}；mid 必须存在于该会话当前上下文（dsh 侧按边界 fork 新会话，
        见 _rewind_session_dsh）。"""
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        if self._board_owns_sid(row, sid) is None:
            self._respond(404, b'{"error":"session not found"}',
                          "application/json; charset=utf-8")
            return
        self._rewind_session(row, sid, body)

    def _api_session_rewind(self, task_id, body):
        """把任务会话回退到某条用户提问之前（dsh_plugin 族）。"""
        task, project, family = self._session_context(task_id)
        if task is None:
            self._respond(404, b'{"error":"task not found"}',
                          "application/json; charset=utf-8")
            return
        sid = task["session_id"] or ""
        if not sid:
            self._respond(409, '{"error":"会话尚未生成（首轮执行后才有）"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        self._rewind_session(project, sid, body, task=task)

    def _rewind_session(self, project, sid, body, task=None):
        """会话回退的共用实现（看板/任务两路）。

        单族世界只有 dsh_plugin：宿主没有原地 undo，等价实现＝按边界 fork 出新
        会话（见 `_rewind_session_dsh`），且只**创建**新会话、不改绑定。
        已退场族 400。
        """
        fam = runner.agent_family(project["agent_path"])
        if fam != "dsh_plugin":
            self._respond(400, json.dumps({"error": "该 agent 族不支持会话回退"},
                                          ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        self._rewind_session_dsh(project, sid, body, task=task)

    def _rewind_session_dsh(self, project, sid, body, task=None):
        """dsh 会话回退（P5）：等价实现＝按边界 fork 出新会话（宿主没有原地 undo）。

        只**创建**回退后的新会话并把新 sid 回给调用方，不改动卡片/任务的会话绑定——
        切换主会话（`bind_session` / 任务 `session_id`）是 UI 的显式动作，由会话窗
        「已回退，切换到新会话？」确认后调用既有绑定接口完成。这样后端是纯函数式的
        「造出回退点会话」，不会在用户没看到新会话之前就把后续轮次引到别处。

        响应：200 `{ok, new_session_id, boundary}`；提问已不在上下文 409；驱动失败 502。
        """
        mid = str(body.get("mid") or "")
        boundary = sessparse.dsh_fork_boundary(sid, mid)
        if boundary is None:
            self._respond(409, json.dumps(
                {"error": "该提问已被回退或会话已变化，请刷新后重试"},
                ensure_ascii=False).encode("utf-8"),
                "application/json; charset=utf-8")
            return
        try:
            new_sid = str((dshdriver.fork(sid, at_seq=boundary) or {})
                          .get("new_session_id") or "")
            if not new_sid:
                raise dshdriver.DshDriverError(-2, "fork 未返回新会话 id")
            # 接进驱动池：UI 切过去后可直接续聊（不接池则 /rename、/compact 会 404）
            dshdriver.ensure_session(new_sid, cwd=project["project_dir"],
                                     task=f"rewind-{sid[:8]}")
            # 任务侧：任务只有一个会话位，回退后必须把新会话设为任务会话，否则
            # 后续轮次仍打在旧会话上（等价于原地 undo 的语义）
            if task is not None:
                db.update_task(task["id"], session_id=new_sid)
        except dshdriver.DshDriverError as e:
            self._respond(502, json.dumps({"error": f"回退失败：{e}"},
                                          ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        self._respond(200, json.dumps({"ok": True, "new_session_id": new_sid,
                                       "boundary": boundary,
                                       "rebound": task is not None},
                                      ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_task_answer_interaction(self, task_id, body):
        """作答任务会话的待答交互（dsh_plugin 族；任务侧 probe 后走同一套白名单）。

        body 形态同看板端点（提问 / 审批两路，见 _api_board_answer_interaction）；
        任务会话没有看板 watcher，先 board.interaction_probe 探测刷新缓存再作答。
        """
        task, project, family = self._session_context(task_id)
        if task is None:
            self._respond(404, b'{"error":"task not found"}',
                          "application/json; charset=utf-8")
            return
        # 单族世界：任务侧作答同样走 dsh_plugin——任务侧直送（queued=false），
        # 底层 `board.answer_interaction` 的 dsh 分支已就绪（方案 §2.1 #6）。
        if family != "dsh_plugin":
            self._respond(400, json.dumps({"error": "该 agent 族不支持回答问题"},
                                          ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        sid = task["session_id"] or ""
        if not sid:
            self._respond(409, '{"error":"会话尚未生成（首轮执行后才有）"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        board.interaction_probe(family, project, sid)
        card = {"session_id": sid}
        if body.get("approval_id"):
            err = board.answer_approval(project, card,
                                        str(body.get("approval_id") or ""),
                                        str(body.get("decision") or ""),
                                        scope=str(body.get("scope") or ""))
        else:
            qid = str(body.get("qid") or "")
            if not qid:
                self._respond(400, b'{"error":"qid/approval_id required"}',
                              "application/json; charset=utf-8")
                return
            err = board.answer_interaction(project, card, qid,
                                           body.get("answers") or [])
        if err:
            self._respond(400, json.dumps({"error": err}, ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        self._respond(200, b'{"ok":true,"queued":false}', "application/json; charset=utf-8")

    def _api_get_bug(self, project_id, bug_dir):
        """单枚 bug 报告详情：全文 + 关联 case 的当前状态 + 最近任务。"""
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        bug_dir = unquote(bug_dir)
        dir_path = os.path.join(row["bug_dir"], bug_dir)
        if not os.path.isdir(dir_path):
            self._respond(404, b'{"error":"bug not found"}',
                          "application/json; charset=utf-8")
            return
        content, case_ids = lib.bug_cases(dir_path)
        fields = parse_fields(content)
        m = BUG_DIR_RE.match(bug_dir)
        cases = []
        for cid, d in lib.find_case_dirs(row["cases_root"], case_ids):
            st = parse_status_md(os.path.join(d, "status.md"))
            cases.append({"id": cid,
                          "name": os.path.basename(d)[len(cid) + 1:],
                          "status": st["status"],
                          "last_run": st["last_run"],
                          "fail_reason": st["fail_reason"]})
        tasks = db.list_tasks(row["id"])
        self._respond(200, json.dumps({
            "dir": bug_dir,
            "title": m.group(1) if m else bug_dir,
            "status": fields.get("状态", ""),
            "cases": cases,
            "content": content,
            "last_task": bug_last_task(tasks, bug_dir),
        }, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _api_reject_bug(self, project_id, bug_dir, body):
        """拒绝 bug 报告：标记「已拒绝」+ 追加拒绝记录 + 创建修例任务（reject）。

        修例任务（固定一轮）让 agent 按拒绝理由修正关联用例，并把教训沉淀到
        案例库 PITFALLS.md（测试轮生成用例前必读，避开同类误报）。
        去重：同 bug 已有排队/运行中的修例任务时不重复创建，返回已有任务 id。
        """
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        bug_dir = unquote(bug_dir).strip().strip("/")
        dir_path = os.path.join(row["bug_dir"], bug_dir)
        if not os.path.isdir(dir_path):
            self._respond(404, b'{"error":"bug not found"}',
                          "application/json; charset=utf-8")
            return
        reason = str(body.get("reason") or "").strip()
        if not reason:
            self._respond(400, '{"error":"请填写拒绝理由"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        report_path = os.path.join(dir_path, "bug_report.md")
        # 状态 → 已拒绝；理由追加到「拒绝记录」小节（重复拒绝累加，最新在最上）
        lib.set_md_field(report_path, "状态", "已拒绝")
        self._append_reject_record(report_path, reason)
        tid = None
        for t in db.list_tasks(row["id"]):
            if t["task_type"] != "reject" or t["status"] not in ("queued", "running"):
                continue
            try:
                if json.loads(t["payload"] or "{}").get("bug_dir") == bug_dir:
                    tid = t["id"]
                    break
            except ValueError:
                continue
        if tid is None:
            m = BUG_DIR_RE.match(bug_dir)
            name = "修例 " + (m.group(1) if m else bug_dir)
            try:
                state = self.state_cache.get(row["id"], row["cases_root"],
                                         row["bug_dir"], row["work_dir"])
                cases_base = state["library"]["stats"].get("total", 0)
            except Exception:
                cases_base = 0
            tid = db.insert_task(row["id"], name, 0, "不复测", "rounds", "1", "reject",
                                 json.dumps({"bug_dir": bug_dir, "reason": reason},
                                            ensure_ascii=False),
                                 cases_base=cases_base)
            runner_instance.submit(tid)
        self._respond(200, json.dumps({"ok": True, "task_id": tid},
                                      ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    @staticmethod
    def _append_reject_record(report_path, reason):
        """把拒绝理由追加到 bug_report.md 的「拒绝记录」小节（不存在则在文末新建）。"""
        content = read_text(report_path)
        if not content:
            return
        line = f"- {db.now_str()} {reason}"
        m = re.search(r"(?m)^## 拒绝记录\s*$", content)
        if m:
            rest = content[m.end():].lstrip("\n")
            text = content[:m.end()] + "\n\n" + line + ("\n" + rest if rest else "\n")
        else:
            text = content.rstrip("\n") + "\n\n## 拒绝记录\n\n" + line + "\n"
        try:
            with open(report_path, "w", encoding="utf-8") as f:
                f.write(text)
        except OSError:
            pass

    def _owned_task(self, task_id):
        """当前用户可访问的任务行；任务不存在或归属项目非当前用户返回 None。"""
        row = db.get_task(task_id)
        if row is None:
            return None
        if self._owned_project(row["project_id"]) is None:
            return None
        return row

    def _api_get_task(self, task_id):
        row = self._owned_task(task_id)
        if row is None:
            self._respond(404, b'{"error":"task not found"}',
                          "application/json; charset=utf-8")
            return
        self._respond(200, json.dumps(self._task_json(row), ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_task_action(self, task_id, action):
        row = self._owned_task(task_id)
        if row is None:
            self._respond(404, b'{"error":"task not found"}',
                          "application/json; charset=utf-8")
            return
        if action == "stop":
            runner_instance.stop(task_id)
        elif row["status"] in ("running", "queued"):
            # restart 状态门禁（评审 F2）：运行/排队中不可重启——running 行整程
            # starting（claimed 已被 starting 吸收，v2a T1），restart 的 enqueue
            # 幂等复用该行、旧跑 finally 把行落 done，
            # 任务 queued 且无活跃行=永不拾取的幽灵（对齐 continue 端点同款门禁）
            self._respond(400, '{"error":"任务运行中或排队中，请先停止"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        else:
            runner_instance.restart(task_id)
        self._respond(200, b'{"ok":true}', "application/json; charset=utf-8")

    def _api_continue_task(self, task_id, body):
        """继续任务：修改参数后接着当前 session 续跑（不新建会话、不清轮次）。

        与 restart（清空轮次从第一轮重跑）的区别：保留 session_id / current_round /
        轮次记录，下一轮用完整首轮提示词（fresh_prompt=1，使新参数下达到 agent）。
        停止条件的轮数/bug 数按「再跑 N 轮 / 再增 V 个」理解，折算为从当前进度
        起算的绝对值；deadline/duration 本身即绝对语义，直接透传。
        """
        row = self._owned_task(task_id)
        if row is None:
            self._respond(404, b'{"error":"task not found"}',
                          "application/json; charset=utf-8")
            return
        if (row["task_type"] or "normal") in ("stress", "pipeline"):
            self._respond(400, '{"error":"该任务类型不支持继续（重启可从第一轮重跑）"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        if row["status"] in ("running", "queued"):
            self._respond(400, '{"error":"任务运行中或排队中，请先停止"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        stop_type = body.get("stop_type", row["stop_type"])
        if stop_type not in ("rounds", "bugs", "deadline", "duration"):
            self._respond(400, '{"error":"stop_type 非法"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        stop_value = str(body.get("stop_value", row["stop_value"]) or "").strip()
        try:
            if stop_type == "rounds":
                stop_value = str(int(row["current_round"] or 0) + int(stop_value or "1"))
            elif stop_type == "bugs":
                stop_value = str(int(row["new_bugs"] or 0) + int(stop_value or "1"))
        except ValueError:
            self._respond(400, '{"error":"stop_value 非法"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        name = str(body.get("name", row["name"]) or "").strip() or row["name"]
        db.update_task(task_id, name=name,
                       auto_fix=1 if body.get("auto_fix", row["auto_fix"]) else 0,
                       retest=str(body.get("retest", row["retest"]) or row["retest"]),
                       stop_type=stop_type, stop_value=stop_value,
                       extra=str(body.get("extra", row["extra"]) or ""),
                       fresh_prompt=1)
        runner_instance.resume(task_id)
        self._respond(200, b'{"ok":true}', "application/json; charset=utf-8")

    def _api_delete_task(self, task_id):
        """删除任务：运行中的任务拒绝删除（先停止）；排队中的任务先从队列移除。"""
        row = self._owned_task(task_id)
        if row is None:
            self._respond(404, b'{"error":"task not found"}',
                          "application/json; charset=utf-8")
            return
        if row["status"] == "running":
            self._respond(400, '{"error":"任务运行中，请先停止再删除"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        runner_instance.remove(task_id)
        db.delete_task(task_id)
        self._respond(200, b'{"ok":true}', "application/json; charset=utf-8")

    def _api_update_task(self, task_id, body):
        """更新任务运行参数：model / permission / auto_commit / auto_deploy / extra
        （修改后需重启任务生效；extra=用户附加要求，修复弹窗的意见经此写入）。"""
        row = self._owned_task(task_id)
        if row is None:
            self._respond(404, b'{"error":"task not found"}',
                          "application/json; charset=utf-8")
            return
        fields = {}
        if "model" in body:
            fields["model"] = str(body["model"] or "").strip()
        if "permission" in body:
            fields["permission"] = str(body["permission"] or "").strip()
        if "auto_commit" in body:
            fields["auto_commit"] = 1 if body["auto_commit"] else 0
        if "auto_deploy" in body:
            fields["auto_deploy"] = 1 if body["auto_deploy"] else 0
        if "auto_retest" in body:
            fields["auto_retest"] = 1 if body["auto_retest"] else 0
        if "extra" in body:
            fields["extra"] = str(body["extra"] or "")
        if "start_stage" in body:
            val = str(body["start_stage"] or "").strip()
            if val and val not in STAGES:
                self._respond(400, '{"error":"start_stage 非法"}'.encode("utf-8"),
                              "application/json; charset=utf-8")
                return
            fields["start_stage"] = val
        if "end_stage" in body:
            val = str(body["end_stage"] or "").strip()
            if val and val not in STAGES:
                self._respond(400, '{"error":"end_stage 非法"}'.encode("utf-8"),
                              "application/json; charset=utf-8")
                return
            fields["end_stage"] = val
        if fields:
            db.update_task(task_id, **fields)
        self._respond(200, b'{"ok":true}', "application/json; charset=utf-8")

    def _api_task_dialogue(self, task_id):
        """任务对话流：解析全部轮次日志为结构化条目，供「修复过程」标签渲染。"""
        row = self._owned_task(task_id)
        if row is None:
            self._respond(404, b'{"error":"task not found"}',
                          "application/json; charset=utf-8")
            return
        entries = runner.read_dialogue(db.list_rounds(task_id))
        self._respond(200, json.dumps({
            "task_id": task_id,
            "model": effective_model(task_id, row["model"]),
            "permission": row["permission"],
            "entries": entries,
        }, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _api_list_rounds(self, task_id):
        if self._owned_task(task_id) is None:
            self._respond(404, b'{"error":"task not found"}',
                          "application/json; charset=utf-8")
            return
        rows = db.list_rounds(task_id)
        self._respond(200, json.dumps([dict(r) for r in rows], ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_task_log(self, task_id, parsed):
        """返回某轮日志尾部（tail 行），2s 轮询由 UI 控制。"""
        if self._owned_task(task_id) is None:
            self._respond(404, b'{"error":"task not found"}',
                          "application/json; charset=utf-8")
            return
        round_no = parsed.get("round", ["0"])[0]
        tail = min(int(parsed.get("tail", ["300"])[0]), 5000)
        row = db.get_log_round(task_id, int(round_no) if round_no.isdigit() else 0)
        if row is None:
            self._respond(404, b'{"error":"log not found"}',
                          "application/json; charset=utf-8")
            return
        if row["log_path"] and os.path.isfile(row["log_path"]):
            content = runner.read_log_tail(row["log_path"], tail)
        else:
            content = ""
        self._respond(200, json.dumps({"round": round_no, "log": content},
                                      ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    # ---------- 压测指标 API ----------

    def _load_paths(self, row):
        """按任务行取存量压测产物路径：(旧快照 jsonl, 报告目录)。

        新布局的产物路径按运行键推导（见 _load_run_paths），此处只保留
        「全任务共用」的报告目录与存量快照路径。
        """
        project = db.get_project(row["project_id"])
        web = lib.runtime_dir(project["work_dir"], ".web")
        return (os.path.join(web, f"task_{row['id']}_load.jsonl"),
                os.path.join(project["cases_root"], "load", "report"))

    @staticmethod
    def _load_run_row(row, run=""):
        """解析目标发压运行：返回 rounds 行（sqlite Row）或 None。

        选择次序：显式 run 参数（运行键）→ 正在跑的 load 行 → 最新一条 load 行。
        load 行即 `kind='load'` 的轮次行（2026-10-06 复压批次起）；旧任务的
        发压记录也是 kind='load'（迁移默认值补的是 'agent'，见下）。
        返回 None 表示「该任务没有可识别的运行记录」→ 读侧回落存量单文件路径。
        """
        rows = [r for r in db.list_rounds(row["id"]) if r["kind"] == "load"]
        if run:
            for r in rows:
                if r["run_key"] == run:
                    return r
            return None
        for r in rows:
            if r["status"] == "running":
                return r
        return rows[-1] if rows else None

    @staticmethod
    def _load_run_paths(row, run_row):
        """按运行行推导三处产物路径 + 回落规则（(日志, 指标, 报告主名)）。

        - 运行行存在：日志/指标按该行的运行键取，缺失时回落存量单文件；
        - 无运行行（存量任务）：全部走存量路径，报告取目录里最新一份。
        """
        project = db.get_project(row["project_id"])
        task_id = row["id"]
        work_dir = project["work_dir"]
        rep_dir = loadcase.report_dir(project["cases_root"])
        run_key = run_row["run_key"] if run_row is not None else ""
        log_path = (run_row["log_path"] if run_row is not None and run_row["log_path"]
                    else loadcase.load_log_path(work_dir, task_id, run_key))
        metrics = loadcase.metrics_path(work_dir, task_id, run_key)
        if run_key and not os.path.isfile(metrics):
            legacy = loadcase.metrics_path(work_dir, task_id)
            if os.path.isfile(legacy):
                metrics = legacy
        if run_key:
            stem = loadcase.report_stem(rep_dir, task_id, run_key)
        else:
            newest = None
            for rep in loadcase.list_reports(project["cases_root"], task_id):
                newest = rep["json_path"][:-5]
                break        # list_reports 已按运行键倒序
            stem = newest or loadcase.report_stem(rep_dir, task_id, "")
        return log_path, metrics, stem

    def _load_metrics_source(self, row, run=""):
        """指标读侧数据源：(路径, 是否旧快照)。

        新任务读规范指标通道（按运行键切分）；旧任务回落到旧快照文件
        （task_<id>_load.jsonl），行经 loadcase.normalize_line 归一后口径一致。
        两者都不存在时返回新通道路径（读为空列表）。
        """
        project = db.get_project(row["project_id"])
        run_row = self._load_run_row(row, run)
        if run and run_row is None:
            # 孤儿/未知运行键：按该键推导路径（文件多半不存在 → 空样本），
            # 不回落到「最新一次运行」（否则前端切到历史运行会看到别人的曲线）
            return loadcase.metrics_path(project["work_dir"], row["id"], run), False
        _log, metrics, _stem = self._load_run_paths(row, run_row)
        if os.path.isfile(metrics):
            return metrics, False
        legacy = loadcase.legacy_snapshot_path(project["work_dir"], row["id"])
        if os.path.isfile(legacy):
            return legacy, True
        return metrics, False

    @staticmethod
    def _normalize_raw(raw):
        """指标文件一行（bytes）→ 规范样本列表（坏行/半行返回空列表）。"""
        try:
            obj = json.loads(raw.decode("utf-8", errors="replace"))
        except ValueError:
            return []
        return loadcase.normalize_line(obj)

    @staticmethod
    def _scan_metrics(path, after=0, tail=0):
        """扫指标文件定位回放起点：(起始字节偏移, 起始 0-based 行号)。

        after：跳过前 after 行（断线续传按 Last-Event-ID 定位），返回该行起点；
        tail：只回放最后 tail 行（首次打开面板用，避免长任务全量回放）。
        两者二选一（after 优先），都缺省时返回文件头。
        """
        if not path or (after <= 0 and tail <= 0):
            return 0, 0
        starts = collections.deque(maxlen=tail) if tail else None
        offset, no = 0, 0
        try:
            with open(path, "rb") as f:
                for raw in f:
                    if after and no == after:
                        return offset, no
                    if starts is not None:
                        starts.append((offset, no))
                    offset += len(raw)
                    no += 1
        except OSError:
            return 0, 0
        if starts:
            return starts[0]
        return offset, no

    def _api_load_metrics(self, task_id, parsed):
        """压测指标（增量）：?after=N 返回源行号 > N 的规范样本，?limit= 限条数。

        单次默认上限 20000 条样本（前端按返回的 next 续拉）；坏行/半行跳过
        （指标仅展示用途，容忍丢失）。旧任务快照行经 loadcase 归一后同口径。
        `?run=<运行键>` 指定历史运行，缺省取正在跑 / 最新一次运行。
        """
        row = self._owned_task(task_id)
        if row is None:
            self._respond(404, b'{"error":"task not found"}',
                          "application/json; charset=utf-8")
            return
        try:
            after = max(0, int((parsed.get("after") or ["0"])[0]))
        except (TypeError, ValueError):
            after = 0
        try:
            limit = int((parsed.get("limit") or ["20000"])[0])
        except (TypeError, ValueError):
            limit = 20000
        limit = min(max(1, limit), 50000)
        path, _legacy = self._load_metrics_source(row, (parsed.get("run") or [""])[0])
        samples, last_no = [], after - 1
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                for i, raw in enumerate(f):
                    if i < after:
                        continue
                    line = raw.strip()
                    if line:
                        try:
                            obj = json.loads(line)
                        except ValueError:
                            obj = None  # 半行/坏行：跳过但行号照常推进
                        if obj is not None:
                            samples.extend(loadcase.normalize_line(obj))
                    last_no = i
                    if len(samples) >= limit:
                        break
        except OSError:
            pass  # 文件尚不存在（未进入发压轮）→ 空列表
        self._respond(200, json.dumps({"samples": samples, "next": last_no + 1},
                                      ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_load_case(self, task_id, parsed=None):
        """压测方案包资产：方案文档 / 执行载体源码 / 图表声明（「压测方案」页）。

        资产只从方案包目录读（loadcase.read_assets），不回传本地路径；
        `?meta=1` 只回轻量标记（列表徽标用，不带 plan.md / 源码正文）。
        """
        row = self._owned_task(task_id)
        if row is None:
            self._respond(404, b'{"error":"task not found"}',
                          "application/json; charset=utf-8")
            return
        project = db.get_project(row["project_id"])
        assets = loadcase.read_assets(project["cases_root"], task_id)
        for key in ("case_dir", "html_path"):
            assets.pop(key, None)
        charts = assets.get("charts") or {}
        assets["panels"] = len(charts.get("panels") or [])
        if (parsed or {}).get("meta"):
            assets.pop("plan_md", None)
            assets.pop("script_text", None)
        self._respond(200, json.dumps(assets, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_load_custom_html(self, task_id):
        """逃生舱 panel.html：以不透明源（CSP sandbox）返回，供面板 iframe 加载。

        响应头强制 `sandbox allow-scripts`：即使有人直接在浏览器打开该 URL，文档也在
        不透明源中执行——拿不到站点 cookie（HttpOnly; SameSite=Lax），也读不到 API
        响应（服务端无 CORS 头），实时数据只能经父页 postMessage 推入。
        """
        row = self._owned_task(task_id)
        if row is None:
            self._respond(404, b'{"error":"task not found"}',
                          "application/json; charset=utf-8")
            return
        project = db.get_project(row["project_id"])
        path = loadcase.resolve(project["cases_root"], task_id)["html_path"]
        if not path:
            self._respond(404, b'{"error":"custom view not found"}',
                          "application/json; charset=utf-8")
            return
        try:
            with open(path, "rb") as f:
                body = f.read()
        except OSError:
            self._respond(404, b'{"error":"custom view unreadable"}',
                          "application/json; charset=utf-8")
            return
        self._respond(200, body, "text/html; charset=utf-8",
                      {"X-Content-Type-Options": "nosniff",
                       "Content-Security-Policy": "sandbox allow-scripts"})

    def _api_load_report(self, task_id, parsed=None):
        """压测报告：JSON 结构 + Markdown 全文。

        `?run=<运行键>` 指定历史运行；缺省取正在跑 / 最新一次运行（存量任务回落
        「报告目录里最新一份」）。返回额外带 run_key / file，前端据此显示
        「看的是哪一份」。
        """
        row = self._owned_task(task_id)
        if row is None:
            self._respond(404, b'{"error":"task not found"}',
                          "application/json; charset=utf-8")
            return
        run = ((parsed or {}).get("run") or [""])[0]
        run_row = self._load_run_row(row, run)
        project = db.get_project(row["project_id"])
        rep_dir = loadcase.report_dir(project["cases_root"])
        if run and run_row is None:
            # 孤儿报告（restart 清轮次后的旧报告、存量分钟级报告）：按运行键直接找文件，
            # 找不到才 404——这类运行只读、不参与复压（registered=false）
            stem = loadcase.report_stem(rep_dir, task_id, run)
        else:
            _log, _metrics, stem = self._load_run_paths(row, run_row)
        found = stem + ".json"
        if not os.path.isfile(found) and not run:
            # 存量任务：报告可能仍是分钟级命名，取目录里最新一份
            try:
                cands = [os.path.join(rep_dir, n) for n in os.listdir(rep_dir)
                         if n.startswith(f"task{task_id}_") and n.endswith(".json")]
                found = max(cands, key=os.path.getmtime) if cands else ""
            except OSError:
                found = ""
        if run and not os.path.isfile(found):
            self._respond(404, b'{"error":"run not found"}',
                          "application/json; charset=utf-8")
            return
        if not found or not os.path.isfile(found):
            self._respond(200, b'{"found":false}',
                          "application/json; charset=utf-8")
            return
        try:
            report = json.loads(lib.read_text(found) or "{}")
        except ValueError:
            report = {}
        md = lib.read_text(found[:-5] + ".md")
        self._respond(200, json.dumps(
            {"found": True, "report": report, "md": md,
             "run_key": (run_row["run_key"] if run_row is not None else run),
             "file": os.path.basename(found)},
            ensure_ascii=False).encode("utf-8"),
            "application/json; charset=utf-8")

    def _api_load_runs(self, task_id):
        """压测运行列表（「压测日志」页的运行选择器数据源）。

        权威 = rounds 里 `kind='load'` 的行（每次发压运行一行）；再并上报告目录里
        无对应运行行的**孤儿报告**（restart 清轮次后的旧报告、存量分钟级报告），
        孤儿只读、标记 `registered=false`，不参与复压。按运行键倒序，新的在前。
        """
        row = self._owned_task(task_id)
        if row is None:
            self._respond(404, b'{"error":"task not found"}',
                          "application/json; charset=utf-8")
            return
        project = db.get_project(row["project_id"])
        work_dir = project["work_dir"]
        runs, seen = [], set()
        for r in db.list_rounds(task_id):
            if r["kind"] != "load":
                continue
            seen.add(r["run_key"])
            runs.append(self._run_item(row, project, r))
        for rep in loadcase.list_reports(project["cases_root"], task_id):
            if rep["run_key"] in seen:
                continue
            runs.append({
                "run_key": rep["run_key"], "round_no": None, "status": "unknown",
                "started_at": "", "ended_at": "", "exit_code": None,
                "summary_text": "", "kpi": self._report_kpi(rep["json_path"]),
                "has_report": True, "has_metrics": os.path.isfile(
                    loadcase.metrics_path(work_dir, task_id, rep["run_key"])),
                "registered": False, "legacy": bool(rep["legacy"]),
                "mtime": rep["mtime"],
            })
        runs.sort(key=lambda x: x["run_key"], reverse=True)
        self._respond(200, json.dumps({"runs": runs}, ensure_ascii=False)
                      .encode("utf-8"), "application/json; charset=utf-8")

    @staticmethod
    def _report_kpi(json_path):
        """报告 JSON 的轻量 KPI（前 6 项，选择器预览用）；坏文件返回 {}。"""
        try:
            obj = json.loads(lib.read_text(json_path) or "{}")
        except ValueError:
            return {}
        summary = obj.get("summary") if isinstance(obj, dict) else None
        if not isinstance(summary, dict):
            return {}
        return dict(list(summary.items())[:6])

    def _run_item(self, row, project, round_row):
        """一条已登记运行 → 运行列表项（状态/时间/退出码/KPI/产物存在性）。"""
        run_key = round_row["run_key"]
        rep_dir = loadcase.report_dir(project["cases_root"])
        stem = loadcase.report_stem(rep_dir, row["id"], run_key)
        return {
            "run_key": run_key,
            "round_no": round_row["round_no"],
            "status": round_row["status"],
            "started_at": round_row["started_at"] or "",
            "ended_at": round_row["ended_at"] or "",
            "exit_code": round_row["exit_code"],
            "summary_text": round_row["summary"] or "",
            "kpi": self._report_kpi(stem + ".json"),
            "has_report": os.path.isfile(stem + ".json"),
            "has_metrics": os.path.isfile(
                loadcase.metrics_path(project["work_dir"], row["id"], run_key)),
            "registered": True,
            "legacy": False,
            "mtime": 0.0,
            "is_current": round_row["status"] == "running",
        }

    def _api_load_rerun(self, task_id):
        """复压：跳过 agent 轮，用现有方案包再跑一次发压运行（2026-10-06）。

        门禁与 restart 同款：运行中/排队中拒绝（同一任务同时只允许一个运行）；
        任务类型必须是 stress。是否具备可执行的方案包不在此预检——交给发压轮
        判定（唯一判定处，错误文案沿用「压测方案缺失（…）」）。
        入队走统一队列（同项目串行），响应立刻返回，前端 toast「已入队」。
        """
        row = self._owned_task(task_id)
        if row is None:
            self._respond(404, b'{"error":"task not found"}',
                          "application/json; charset=utf-8")
            return
        if (row["task_type"] or "normal") != "stress":
            self._respond(400, '{"error":"仅压测任务支持复压"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        if row["status"] in ("running", "queued"):
            self._respond(400, '{"error":"任务运行中或排队中，请先停止"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        runner_instance.rerun_load(task_id)
        self._respond(200, b'{"ok":true}', "application/json; charset=utf-8")

    def _api_load_diagnose(self, task_id):
        """诊断：把最近一次运行的执行现场发给该任务的 agent 会话（2026-10-06）。

        现场 = 运行标识/状态/退出码/耗时 + 指标摘要 + 方案包文件清单 + 日志尾若干行。
        投递复用 `POST /api/tasks/<id>/session/chat` 的既有路径（进统一队列的
        `m:` 消息单元，项目忙时排队），所以本方法只负责「组装文本」——调度、
        会话校验、错误文案全部沿用对话接口，零新增调度代码。
        """
        row = self._owned_task(task_id)
        if row is None:
            self._respond(404, b'{"error":"task not found"}',
                          "application/json; charset=utf-8")
            return
        text = self._load_diagnose_text(row)
        self._api_session_chat(task_id, {"message": text})

    def _load_diagnose_text(self, row):
        """组装诊断消息（有长度上限，截断日志尾；供 _api_load_diagnose 使用）。"""
        project = db.get_project(row["project_id"])
        task_id = row["id"]
        run_row = self._load_run_row(row)
        log_path, metrics_path, stem = self._load_run_paths(row, run_row)
        case = loadcase.resolve(project["cases_root"], task_id)
        kpi = loadcase.read_summary(metrics_path)
        kpi_text = "、".join(f"{k}={v}" for k, v in list(kpi.items())[:12]) or "（无收尾 KPI）"
        if run_row is not None:
            head = (f"【压测运行现场】任务 #{task_id}「{row['name']}」\n"
                    f"- 最近一次运行：运行键 {run_row['run_key']}"
                    f"（轮次 {run_row['round_no']}）状态 {run_row['status']}"
                    f" 退出码 {run_row['exit_code'] if run_row['exit_code'] is not None else '—'}\n"
                    f"- 开始 {run_row['started_at'] or '—'} · 结束 {run_row['ended_at'] or '—'}\n")
        else:
            head = (f"【压测运行现场】任务 #{task_id}「{row['name']}」\n"
                    f"- 该任务尚无运行记录（存量任务）\n")
        files = []
        for name, path in (("run.py", case["script_path"]),
                           ("scenario.json", case["scenario_path"]),
                           ("charts.json", case["charts_path"]),
                           ("panel.html", case["html_path"])):
            if path and os.path.isfile(path):
                files.append(f"{name}({os.path.getsize(path)}B)")
        body = (head
                + f"- 方案包：{case['case_dir']}（{ '、'.join(files) or '空' }）\n"
                + f"- 指标摘要：{kpi_text}\n"
                + f"- 日志尾（{os.path.basename(log_path)}）：\n"
                + "```\n"
                + (runner.read_log_tail(log_path, 60) or "（无日志）").strip()[:6000]
                + "\n```\n"
                + "请判断这次发压是否正常、方案包（run.py / charts.json / plan.md）"
                  "是否需要修正；如需修正请直接改方案包文件，改完告诉我「已改好」，"
                  "我会在压测面板点「复压」再跑一次。**不要自己执行压测脚本**"
                  "（发压必须由平台托管，才能被停止/超时保护并留下运行记录）。")
        return body[:chat.MESSAGE_MAX]

    def _api_load_stream(self, task_id, parsed=None):
        """压测指标 SSE：按源行号增量推送规范样本（Last-Event-ID 断线续传）。

        每事件：id: 源行号 / data: 规范样本 JSON（旧快照行经 loadcase 归一，一行
        可出多条样本）；（半行等下轮）；首次连接只回放最后 LOAD_STREAM_REPLAY_MAX
        行——tidy 通道每秒可有几十行，全量回放对长任务既慢又无用。任务不在 running
        且已推完新增内容时补发 {"done":true} 并关闭。
        `?run=<运行键>` 指定历史运行（回放该次运行的曲线），缺省取正在跑/最新一次。
        """
        row = self._owned_task(task_id)
        if row is None:
            self._respond(404, b'{"error":"task not found"}',
                          "application/json; charset=utf-8")
            return
        path, _legacy = self._load_metrics_source(
            row, ((parsed or {}).get("run") or [""])[0])
        # 历史运行（已结束）回放完即关流；只有「正在跑的那次运行」才持续 tail
        run_row = self._load_run_row(row, ((parsed or {}).get("run") or [""])[0])
        live = run_row is not None and run_row["status"] == "running"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            seen = int(self.headers.get("Last-Event-ID", "") or 0)
        except ValueError:
            seen = 0
        # 断线续传：从 seen 行之后续推；首次连接：只回放最后一段
        offset, no = self._scan_metrics(
            path, after=max(0, seen), tail=0 if seen > 0 else LOAD_STREAM_REPLAY_MAX)
        try:
            while True:
                try:
                    if os.path.getsize(path) < offset:  # 文件被轮转/清空 → 从头回放
                        offset, no = 0, 0
                except OSError:
                    pass
                chunk = b""
                try:
                    with open(path, "rb") as f:
                        f.seek(offset)
                        chunk = f.read()
                except OSError:
                    chunk = b""
                if b"\n" in chunk:
                    data, _tail = chunk.rsplit(b"\n", 1)  # 半行留在文件里下轮再读
                    offset += len(data) + 1
                    for line in data.split(b"\n"):
                        if not line.strip():
                            continue
                        no += 1
                        for sample in self._normalize_raw(line):
                            self.wfile.write(
                                b"id: " + str(no).encode() + b"\ndata: "
                                + json.dumps(sample, ensure_ascii=False).encode("utf-8")
                                + b"\n\n")
                    self.wfile.flush()
                task = db.get_task(task_id)
                if task is None or not live or task["status"] != "running":
                    self.wfile.write(b'data: {"done":true}\n\n')
                    self.wfile.flush()
                    return
                time.sleep(1.0)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # ---------- session 对话窗口 API ----------

    def _session_context(self, task_id):
        """session 接口公共上下文：(任务行, 项目行, agent 归族)；越权/不存在返回 (None, None, None)。"""
        task = self._owned_task(task_id)
        if task is None:
            return None, None, None
        project = db.get_project(task["project_id"])
        family = runner.agent_family(project["agent_path"]) if project else "dsh_plugin"
        return task, project, family

    def _task_since(self, task):
        """任务起始时间（epoch 秒，运行中会话探测的时间下界）：started_at 优先，
        回退 created_at；格式异常返回 0（探测将直接放弃）。"""
        for key in ("started_at", "created_at"):
            val = task[key] or ""
            try:
                return time.mktime(time.strptime(val, "%Y-%m-%d %H:%M:%S"))
            except (TypeError, ValueError):
                continue
        return 0.0

    def _session_payload(self, task, project, family, agent, after):
        """组装 session messages 主体（含 found:false 各分支与对话状态）。

        任务行里 session_id 为空（首轮 agent 进程未退出、resume_hint 尚未解析）
        时，按工作区 + 任务起始时间探测正在写的会话（仅展示，见
        sessparse.live_session_id），使弹窗在任务运行期间也能实时显示对话。"""
        sid = task["session_id"] or ""
        # dsh_plugin 的会话即 dsh 宿主会话，sessparse 调用统一经 _sess_family 归一
        sfamily = _sess_family(family)
        if not sid and family == "dsh_plugin":
            # 路线 A：sid 由进程内驱动精确回执（不靠 mtime 猜会话目录）
            sid = _dsh_live_sid(project["project_dir"] if project else "")
        if not sid:
            # project 为 sqlite3.Row（无 .get 方法），取列必须用下标而非 .get
            sid = sessparse.live_session_id(
                sfamily, project["project_dir"] if project else "",
                self._task_since(task))
        base = {"task_id": task["id"], "session_id": sid, "family": family,
                "model": effective_model(task["id"], task["model"]),
                "capabilities": family_capabilities(family),
                "project_busy": _project_busy(project["id"]) if project else False,
                "chat": chat.state(sid)}
        # 会话级思考等级（会话窗「思考等级」控件，2026-10-04）：事件流里学到的宿主
        # reasoningEffort（driver/model 帧）；没有就不下发，前端按「默认」渲染。
        # 任务会话的档位下发见 _api_task_session_profile（只此一项可改）。
        if sid and family == "dsh_plugin":
            effort = dshevents.session_effort(sid)
            if effort:
                base["sessionEffort"] = effort
        # 统一队列态（会话窗标题「队列」徽标）：本任务单元此刻排队/运行/空闲；
        # 探到正在写的会话（sid 未入库）时 task_id 仍是准确的队列键，照常下发
        base["unit_state"] = _unit_state(project["id"] if project else 0,
                                         f"t:{task['id']}")
        # 展示派生（P6）：任务会话无卡——answer_pending/server_queued 不在场，
        # 按 unit_state/外部条目行退化为 running/queued_serial/foreign_busy/idle
        base["queue_state"] = _session_queue_state(
            project["id"] if project else 0, base["unit_state"])
        if sfamily not in sessparse.FAMILIES:
            return {**base, "found": False, "reason": "family"}
        if not sid:
            return {**base, "found": False, "reason": "no_session"}
        data = sessparse.load(sfamily, sid, agent, after)
        if not data.get("found"):
            return {**base, "found": False,
                    "reason": data.get("reason", "missing"),
                    "agents": data.get("agents", []), "agent": data.get("agent", agent)}
        return {**base, **data}

    def _api_session_messages(self, task_id, parsed):
        """session 原始对话内容（一次性拉取；?agent=&after= 增量）。"""
        task, project, family = self._session_context(task_id)
        if task is None:
            self._respond(404, b'{"error":"task not found"}',
                          "application/json; charset=utf-8")
            return
        agent = parsed.get("agent", ["main"])[0]
        after_s = parsed.get("after", ["0"])[0]
        after = int(after_s) if after_s.isdigit() else 0
        payload = self._session_payload(task, project, family, agent, after)
        self._respond(200, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_session_stream(self, task_id, parsed):
        """session SSE：meta（found/agents/totals 等变化）+ entries（增量，id=末条 seq，
        支持 Last-Event-ID 断线续传）+ chat（对话状态变化），空闲 ~15s 心跳。

        循环内每 tick 重读任务行（轮后写入的 session_id 对已打开窗口立即生效，
        无需重开弹窗）；探测出的会话被真实 sid 纠正时增量基点归零、全量重发。"""
        task, project, family = self._session_context(task_id)
        if task is None:
            self._respond(404, b'{"error":"task not found"}',
                          "application/json; charset=utf-8")
            return
        agent = parsed.get("agent", ["main"])[0]
        after_s = parsed.get("after", [""])[0]
        if after_s.isdigit():
            after = int(after_s)
        else:
            # EventSource 自动重连时带 Last-Event-ID（上次末条 seq），从其后继续
            lid = self.headers.get("Last-Event-ID", "")
            after = int(lid) + 1 if lid.isdigit() else 0
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        cur_sid = ""
        last_meta = None
        last_chat = None
        idle_ticks = 0
        try:
            while True:
                # 重读任务行：轮次结束把 session_id 写库后，本连接立刻感知
                fresh = self._owned_task(task_id)
                if fresh is not None:
                    task = fresh
                payload = self._session_payload(task, project, family, agent, after)
                entries = payload.get("entries") or []
                sid_now = payload.get("session_id") or ""
                # found=false（会话存储缺失/未落盘/被删/归档、尚未探到会话）路径
                # payload **没有 total 键**（见 _session_payload 三个提前返回）：
                # 该路径按「无增量」安全处理——entries 恒空、不参与 total 回退比较，
                # 循环照常发 meta/心跳、客户端断开时正常收尾。原 `payload["total"]`
                # 直接下标会在第二拍（sid 稳定后）KeyError，SSE 处理线程异常断开
                # （P7a 缺陷 E）。
                total_now = payload.get("total")
                if sid_now != cur_sid:
                    # 会话对象切换（探测 sid 出现/被真实 sid 纠正）：增量基点归零，
                    # 重取全量；客户端凭 meta 里的 session_id 变化重置本地增量
                    cur_sid = sid_now
                    after = 0
                    payload = self._session_payload(task, project, family, agent, 0)
                    entries = payload.get("entries") or []
                elif total_now is not None and total_now < after:
                    # 会话被回退/截断（entries 变短，total 回退）：增量基点归零
                    # 重发全量，否则游标卡在旧长度、后续新条目永远发不出去；
                    # 客户端凭 meta.total 回退重置本地增量（已乐观截断的客户端
                    # 按 seq 过滤不会重复追加）
                    after = 0
                    payload = self._session_payload(task, project, family, agent, 0)
                    entries = payload.get("entries") or []
                if entries:
                    after = payload["total"]
                # meta：entries/chat 之外的展示信息（found/agents/totals/model 等）
                meta = {k: v for k, v in payload.items() if k not in ("entries", "chat")}
                meta_s = json.dumps(meta, ensure_ascii=False, sort_keys=True)
                pushed = False
                if meta_s != last_meta:
                    last_meta = meta_s
                    self.wfile.write(b"event: meta\ndata: " + meta_s.encode("utf-8")
                                     + b"\n\n")
                    self.wfile.flush()
                    pushed = True
                if entries:
                    body = json.dumps({"entries": entries, "total": payload["total"]},
                                      ensure_ascii=False).encode("utf-8")
                    self.wfile.write(b"id: %d\nevent: entries\ndata: " % (after - 1)
                                     + body + b"\n\n")
                    self.wfile.flush()
                    pushed = True
                chat_s = json.dumps(payload.get("chat") or {}, sort_keys=True)
                if chat_s != last_chat:
                    last_chat = chat_s
                    self.wfile.write(b"event: chat\ndata: " + chat_s.encode("utf-8")
                                     + b"\n\n")
                    self.wfile.flush()
                    pushed = True
                idle_ticks = 0 if pushed else idle_ticks + 1
                if idle_ticks >= 20:  # ~15s 一次心跳，防中间层断连
                    idle_ticks = 0
                    self.wfile.write(b": hb\n\n")
                    self.wfile.flush()
                time.sleep(0.75)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _api_session_media(self, task_id, media_id, parsed):
        """session 图片字节（dsh 附件 id → 驱动 /media 取字节，见 sessparse.resolve_media）。"""
        task, _project, family = self._session_context(task_id)
        if task is None:
            self._respond(404, b'{"error":"task not found"}',
                          "application/json; charset=utf-8")
            return
        agent = parsed.get("agent", ["main"])[0]
        resolved = sessparse.resolve_media(_sess_family(family), task["session_id"] or "", agent,
                                           unquote(media_id))
        if resolved is None:
            self._respond(404, b'{"error":"media not found"}',
                          "application/json; charset=utf-8")
            return
        data, ctype = resolved
        self._respond(200, data, ctype)

    def _api_session_chat(self, task_id, body):
        """向 session 续发一条消息（登记统一队列消息单元，由 runner 按项目串行执行）。

        2026-09-10：项目忙（同项目有任务/卡片会话在跑）时不再 409 拒绝，改为排队——
        消息作为统一队列第三类单元（"m:<msg_id>"），项目空闲才真正发送；执行期间
        持有项目占用（同项目任务/卡片等它结束）。响应 queued=true 表示
        本次消息未立即执行（前端据此显示「排队中」）。
        """
        task, project, family = self._session_context(task_id)
        if task is None:
            self._respond(404, b'{"error":"task not found"}',
                          "application/json; charset=utf-8")
            return
        message = str(body.get("message") or "").strip()
        if not message:
            self._respond(400, '{"error":"message 不能为空"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        if len(message) > chat.MESSAGE_MAX:
            self._respond(400, '{"error":"message 过长"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        if family not in chat.CHAT_FAMILIES:
            self._respond(409, '{"error":"该 agent 暂不支持对话"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        sid = task["session_id"] or ""
        if not sid:
            self._respond(409, '{"error":"会话尚未生成（首轮执行后才有）"}'.encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        try:
            rec = chat.start(task, project, message, inject=bool(body.get("inject")))
        except dshdriver.DshDriverError as e:
            # 409 = 会话运行中（chat.start 的忙拒绝，竞态兜底）；其余按 500
            if e.args and e.args[0] == 409:
                self._respond(409, json.dumps(
                    {"error": e.args[1] if len(e.args) > 1 else "会话运行中，稍后重试"},
                    ensure_ascii=False).encode("utf-8"),
                    "application/json; charset=utf-8")
            else:
                self._respond(500, json.dumps({"error": f"agent 调用失败: {e}"},
                                              ensure_ascii=False).encode("utf-8"),
                              "application/json; charset=utf-8")
            return
        except OSError as e:
            self._respond(500, json.dumps({"error": f"agent 调用失败: {e}"},
                                          ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        except RuntimeError as e:
            # 投递前置闸拒投（chat.DeliveryRefused：外部会话前提不成立，C 批 T5/T8）——
            # 消息未入队、未落行，回 400 + 闸的中文文案（口径同 _api_board_session_comment）。
            # 必须排在 dshdriver.DshDriverError 之后：它也是 RuntimeError 子类，先命中 409/500；
            # 裸 RuntimeError 若逃逸，do_POST 无兜底 ⇒ 用户拿到连接重置而不是要求的明确文案。
            self._respond(400, json.dumps({"error": str(e)}, ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        self._respond(200, json.dumps(
            {"ok": True, "queued": bool(rec.get("queued")),
             "msg_id": rec.get("id") or "", "state": rec.get("state") or "",
             "prompt_id": rec.get("prompt_id") or ""},
            ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _api_session_chat_stop(self, task_id):
        """停止进行中的对话进程（同时取消该会话排队中的消息）。"""
        task, _project, _family = self._session_context(task_id)
        if task is None:
            self._respond(404, b'{"error":"task not found"}',
                          "application/json; charset=utf-8")
            return
        chat.stop(task["session_id"] or "")
        self._respond(200, b'{"ok":true}', "application/json; charset=utf-8")

    # ---------- 监控 state / stream ----------

    def _resolve_project(self, parsed):
        """按 ?project=<id> 取当前用户的项目；缺省取当前用户第一个项目。"""
        pid = parsed.get("project", [""])[0]
        if pid.isdigit():
            row = self._owned_project(int(pid))
            if row:
                return row
        user = self._current_user()
        rows = db.list_projects(user["id"])
        return rows[0] if rows else None

    def _api_state(self, parsed):
        project = self._resolve_project(parsed)
        if project is None:
            self._respond(200, json.dumps({"error": "no project"}, ensure_ascii=False).encode("utf-8"),
                          "application/json; charset=utf-8")
            return
        state = self.state_cache.get(project["id"], project["cases_root"],
                                     project["bug_dir"], project["work_dir"])
        state["project"] = self._project_json(project)
        self._respond(200, json.dumps(state, ensure_ascii=False).encode("utf-8"),
                      "application/json; charset=utf-8")

    def _api_board_stream(self, project_id):
        """看板变更事件流（SSE，P4 事件化）：把前端 5s 轮询换成事件唤醒。

        帧语义（只发信号、不带载荷——客户端收到就重取一次看板 payload）：

        - `hello`   连接就绪（前端据此立即做一次全量拉取，替代首帧轮询）；
        - `refresh` 值得重取：① 本项目卡片的写路径（db 层统一发信号）；
          ② 本项目绑定会话的 dsh 状态帧（agent/status、turn/*、interaction 等，
          由 `dshevents` 转发——会话忙闲/交互变化会带动卡片列流转与 busy 徽标）。

        无变化时每 15s 发注释帧 keepalive（顺带探测死连接）；客户端断线由浏览器
        EventSource 自动重连（重连后照常先收 hello）。异常一律静默收尾——SSE
        断连不是业务错误。
        """
        project = self._owned_project(project_id)
        if project is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        topic = localbus.board_topic(project_id)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        def _write(event, payload):
            body = ("event: " + event + "\ndata: "
                    + json.dumps(payload, ensure_ascii=False) + "\n\n")
            self.wfile.write(body.encode("utf-8"))
            self.wfile.flush()

        def _sids():
            """本项目卡片绑定的会话 id 集合（dsh 帧按它过滤；新卡会话最多滞后 30s）。"""
            out = set()
            for card in db.list_board_cards(project_id):
                if card["session_id"]:
                    out.add(str(card["session_id"]))
                try:
                    out.update(str(v) for v in json.loads(card["sessions"] or "[]"))
                except (ValueError, TypeError):
                    pass
            return out

        bound = _sids()
        bound_at = time.time()

        def on_dsh_frame(frame):
            """dsh 状态帧 → 本项目看板信号（跑在消费线程，只做集合判断 + 计数）。"""
            sid = str(frame.get("session_id") or "")
            if sid and sid in bound:
                localbus.publish(topic)

        dshevents.subscribe(on_dsh_frame)
        since = localbus.seq(topic)
        try:
            _write("hello", {"project_id": project_id})
            while True:
                new = localbus.wait(topic, since, 15.0)
                if new != since:
                    since = new
                    _write("refresh", {"project_id": project_id})
                else:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                if time.time() - bound_at > 30:      # 新绑定的会话要能被事件覆盖
                    bound = _sids()
                    bound_at = time.time()
        except (BrokenPipeError, ConnectionResetError, OSError, ValueError):
            pass                                     # 客户端断开：正常收尾
        finally:
            dshevents.unsubscribe(on_dsh_frame)

    def _api_board_session_stream(self, project_id, sid):
        """会话实时事件流（SSE，P4）：会话窗口的 2s 轮询 → 事件唤醒。

        单族世界（P7b）只有 `dsh_plugin` 有事件源：该会话的任一状态帧（`transcript`
        逐条消息、`turn/start|end`、`agent/status`、`driver/interaction`）到达即发一次
        `refresh`——前端收到就做一次**增量拉取**（`after=last_seq+1`），服务端在这里
        只做「鉴权 + 信号」，不做解析与格式化（内容仍由会话存储读）。
        """
        row = self._owned_project(project_id)
        if row is None:
            self._respond(404, b'{"error":"project not found"}',
                          "application/json; charset=utf-8")
            return
        card = self._board_owns_sid(row, sid)
        if card is None:
            self._respond(404, b'{"error":"session not found"}',
                          "application/json; charset=utf-8")
            return
        topic = localbus.session_topic(sid)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        def _write(event, payload):
            body = ("event: " + event + "\ndata: "
                    + json.dumps(payload, ensure_ascii=False) + "\n\n")
            self.wfile.write(body.encode("utf-8"))
            self.wfile.flush()

        def on_dsh_frame(frame):
            """该会话的状态帧 → 信号（跑在消费线程，只做字符串比较 + 计数）。"""
            if str(frame.get("session_id") or "") == sid:
                localbus.publish(topic)

        dshevents.subscribe(on_dsh_frame)
        since = localbus.seq(topic)
        try:
            _write("hello", {"project_id": project_id, "session_id": sid,
                             "events": True})
            while True:
                new = localbus.wait(topic, since, 15.0)
                if new != since:
                    since = new
                    _write("refresh", {"session_id": sid})
                else:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError, ValueError):
            pass                                     # 客户端断开：正常收尾
        finally:
            dshevents.unsubscribe(on_dsh_frame)

    def _stream(self, parsed):
        """SSE 长连接：每 0.5s 检查聚合状态，有变化才推送，空闲每 ~15s 发心跳。"""
        project = self._resolve_project(parsed)
        if project is None:
            self._stream_note(200, b'data: {"error":"no project"}\n\n')
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        last_fingerprint = None
        idle_ticks = 0
        try:
            while True:
                state = self.state_cache.get(project["id"], project["cases_root"],
                                             project["bug_dir"], project["work_dir"])
                state["project"] = self._project_json(project)
                # 指纹主体在 StateCache 构建时算好(剔除 generated_at); project 段很小,
                # 每拍序列化一次即可, 语义与原先"全量 dumps 剔除 generated_at"一致
                fingerprint = (self.state_cache.fingerprint(project["id"]) or "") \
                    + "|" + json.dumps(state["project"], ensure_ascii=False, sort_keys=True)
                if fingerprint != last_fingerprint:
                    last_fingerprint = fingerprint
                    payload = json.dumps(state, ensure_ascii=False).encode("utf-8")
                    self.wfile.write(b"data: " + payload + b"\n\n")
                    self.wfile.flush()
                    idle_ticks = 0
                else:
                    idle_ticks += 1
                    if idle_ticks >= 30:  # ~15s 一次心跳，防中间层断连
                        idle_ticks = 0
                        self.wfile.write(b": hb\n\n")
                        self.wfile.flush()
                time.sleep(0.5)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _stream_note(self, code, payload):
        self.send_response(code)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)
        self.wfile.flush()

    # ---------- 基础工具 ----------

    def _must_change_pw_blocked(self, user, path):
        """强制改密闸：持一次性初始口令的账号在改密前只放行白名单端点。

        返回 True 表示已回 403、调用方直接 return。前端据 /api/auth/me 的
        must_change_password 渲染改密门；此处是服务端兜底（防绕过前端直调 API）。

        例外（2026-10-08，插件形态死锁修复）：免登信任头路径整体跳过此闸。
        插件形态下用户拿不到随机一次性口令（薄壳曾把横幅整段丢弃），拦在这里只会
        把面板锁死——而信任头本已等价 admin（见 _current_user），跳过不降安全等级；
        存量库 must_change_pw=1 在插件形态亦据此不再锁死，用户进面板后可在设置页设密码。
        """
        if not user or not user["must_change_pw"]:
            return False
        if self._trusted_admin_request():
            return False
        if path in MUST_CHANGE_PW_ALLOW:
            return False
        self._respond(403, '{"error":"请先修改初始口令"}'.encode("utf-8"),
                      "application/json; charset=utf-8")
        return True

    def _trusted_admin_request(self):
        """本次请求是否由薄壳反代注入的免登信任头判为 admin（--trust-internal-user）。

        仅回环监听 + 显式开关时才可能为真（main() 已限制）；该头等价 admin 全权，
        故以此为据的放行（跳过强制改密门、免原口令改密）不新增任何权限面。
        """
        return bool(TRUST_INTERNAL_USER
                    and self.headers.get(TRUST_USER_HEADER) == "admin")

    def _current_user(self):
        """按 cookie 取会话用户，无效返回 None。"""
        # dsh 插件形态免登：--trust-internal-user 时反代注入的信任头视为 admin 登录
        # （main() 已限制仅回环监听可开启）；后续 _owned_project 等隔离逻辑不变
        if self._trusted_admin_request():
            admin = db.get_user_by_name("admin")
            if admin is not None:
                return admin
        token = self._cookie_token()
        if not token:
            return None
        row = db.get_session(token)
        if row is None:
            return None
        return db.get_user_by_id(row["user_id"])

    def _cookie_token(self):
        for part in self.headers.get("Cookie", "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == auth.COOKIE_NAME:
                return value
        return None

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0:
            return {}
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return {}
        # 合法 JSON 但非对象（数组/字符串/数字）时按空对象处理：
        # 各接口对 data.get(...) 无类型防护，非 dict 会抛 AttributeError 断连
        return data if isinstance(data, dict) else {}

    def _respond(self, code, body, content_type, extra_headers=None):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # 客户端提前断开属常态(页面刷新/关闭), 静默处理

    def _send_file(self, path, content_type):
        try:
            with open(path, "rb") as f:
                self._respond(200, f.read(), content_type)
        except OSError:
            self._respond(404, b"not found", "text/plain; charset=utf-8")

    def _serve_static(self, path):
        """服务 webui/dist 构建产物(js/css/字体等), 防路径穿越; 目录请求回退 index.html。"""
        rel = path.lstrip("/")
        if not rel:
            rel = "index.html"
        full = os.path.normpath(os.path.join(WEB_DIR, rel))
        if not full.startswith(WEB_DIR + os.sep) and full != WEB_DIR:
            self._respond(403, b"forbidden", "text/plain; charset=utf-8")
            return
        if os.path.isdir(full) or not os.path.isfile(full):
            full = os.path.join(WEB_DIR, "index.html")
        ext = os.path.splitext(full)[1].lower()
        ctype = {".html": "text/html; charset=utf-8",
                 ".js": "application/javascript; charset=utf-8",
                 ".mjs": "application/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8",
                 ".svg": "image/svg+xml",
                 ".png": "image/png",
                 ".ico": "image/x-icon",
                 ".woff": "font/woff",
                 ".woff2": "font/woff2",
                 ".ttf": "font/ttf",
                 ".json": "application/json; charset=utf-8",
                 ".map": "application/json; charset=utf-8"}.get(ext, "application/octet-stream")
        self._send_file(full, ctype)

    def _redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, fmt, *args):
        pass


# 建表先于 runner 全局实例：worker 线程构造即开始轮询 wait_items（_pick_locked
# 直读表），启动竞态下撞「no such table」会让 worker 线程成批死亡、队列静默瘫痪
# （e2e_board_continue 重启演练实测踩中）。init_db 幂等，main 内的调用保留。
# 导入期这次 init_db 就可能完成 admin 种子（python server.py 的主路径），其返回值
# 必须传给 main 的横幅判断——main 里那次幂等重跑只会拿到 False（see _seed_hint）。
_MODULE_SEEDED = db.init_db()

# runner 全局实例（线程内再 import，避免命令行的时序问题）。
# 启动闸（P7a 缺陷 F）：worker 线程**构造即就绪**，而启动对账
# （runner.recover → board.recover → reconcile_units）在 main 里跑——不加闸时，
# 库里上一实例遗留的 waiting `a:`/`t:` 行会被 worker 先 claim（state→starting），
# recover 的 return_to_waiting 随即清掉在途投递的 not_before 退避并与之竞态（同一
# 失败两条「第 1 次」日志、retries 双增；存活横幅也因 n_alive=0 随机消失）。
# boot_gate=True ⇒ worker 停在闸后，等 main 对账跑完 release_boot_gate() 放行。
# 顺带覆盖：第二实例 —— 单实例锁判负 exit 3 的进程不会再抢走共享库里的行。
runner_instance = runner.Runner(boot_gate=True)
runner.INSTANCE = runner_instance  # board 统一队列经此访问单例（None 时 board 退化直起）


def _lan_ip():
    """探测本机局域网 IP（UDP connect 不发包，仅查路由表），失败返回 None。

    仅供监听信息展示：host=0.0.0.0 时 0.0.0.0 本身不可直接访问，
    另给本机回环与局域网两个可点的地址。"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
        finally:
            s.close()
    except OSError:
        return None


def _write_port_file(port):
    """实际监听端口落盘 .run/server.port（touchstone.py / touchstone.sh 探活与展示读取）。

    写失败不阻断启动（只读目录等场景下启动器回退按 TS_PORT 端口探测）。"""
    try:
        os.makedirs(RUN_DIR, exist_ok=True)
        with open(PORT_FILE, "w", encoding="utf-8") as f:
            f.write(str(port))
    except OSError:
        pass


def _build_arg_parser():
    """构造命令行参数解析器（模块级以便单测直接断言默认值，见 tests/test_server_host.py）。

    默认监听 127.0.0.1（安全默认，仅本机可访问）；对外提供服务须显式 --host 0.0.0.0，
    启动器（touchstone.sh / touchstone.py）经 TS_HOST 环境变量等价传递。"""
    import argparse
    parser = argparse.ArgumentParser(description="Touchstone 站点（登录+项目+任务+监控）")
    parser.add_argument("--port", type=int, default=4601, help="监听端口（默认 4601）")
    parser.add_argument("--host", default="127.0.0.1",
                        help="监听地址（默认 127.0.0.1 仅本机；对外监听显式传 0.0.0.0）")
    parser.add_argument("--web-dir", default=None, help="静态页面目录（默认 webui/dist）")
    parser.add_argument("--trust-internal-user", action="store_true",
                        help="信任 X-TS-Internal-User 头（dsh 插件薄壳免登；仅限 --host 127.0.0.1）")
    parser.add_argument("--parent-watch", action="store_true",
                        help="父死感知（dsh 插件形态）：stdin 管道 EOF / Linux PDEATHSIG "
                             "触发自主退出，避免宿主崩溃后留下孤儿后端（2026-10-03 P2）")
    parser.add_argument("--allow-shared-db", action="store_true",
                        help="显式关闭「同库单实例」闸（多实例共用一个 SQLite，自担双写风险）")
    return parser


def _seed_hint(seeded, initial_pw=""):
    """启动横幅的默认账号提示：仅本次实际种子时返回文案，日常启动为空串。

    2026-10-02 起默认口令不再是固定值：未设 TS_ADMIN_PASSWORD 时随机生成一次性
    初始口令（initial_pw，由 db.take_seed_password() 取走），横幅打印这一次即清，
    且该账号带 must_change_pw=1，首次登录必须先改密；设了 TS_ADMIN_PASSWORD 时
    只提示变量名、不回显口令值。
    """
    if not seeded:
        return ""
    if initial_pw:
        return (f"  （首次启动已创建默认账号 admin，一次性初始口令：{initial_pw}"
                "，首次登录须修改；仅本次显示，请立即记录）")
    if os.environ.get("TS_ADMIN_PASSWORD"):
        return "  （首次启动已创建默认账号 admin，初始口令取自 TS_ADMIN_PASSWORD，请尽快登录修改）"
    return "  （首次启动已创建默认账号 admin，其一次性口令已在上一次启动时打印，本次不再显示）"


def main():
    # 中文 Windows 控制台默认 GBK：统一 stdout/stderr 为 UTF-8（print 中文与
    # agent 输出转写不再依赖终端代码页；重定向到日志文件时同样生效）。
    # line_buffering：重定向到 .run/server.log 时 print 逐行落盘（默认块缓冲会让
    # 「已启动/监听」等启动信息滞留缓冲区，探活成功后日志里看不到）
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
        except (AttributeError, OSError):
            pass  # 非 TextIOBase（如被替换对象）不支持 reconfigure，忽略
    parser = _build_arg_parser()
    args = parser.parse_args()
    global WEB_DIR, TRUST_INTERNAL_USER
    if args.trust_internal_user:
        # 安全阀: 信任头等价 admin 登录, 对外网开放时任何局域网请求都将获得 admin
        if args.host not in ("127.0.0.1", "localhost"):
            print("错误: --trust-internal-user 仅允许 --host 127.0.0.1/localhost", file=sys.stderr)
            sys.exit(1)
        TRUST_INTERNAL_USER = True
    if args.web_dir:
        WEB_DIR = args.web_dir
    if not os.path.isdir(WEB_DIR):
        print(f"错误: 静态页面目录不存在: {WEB_DIR}（请先执行 webui 下的 vite build）", file=sys.stderr)
        sys.exit(1)

    # ---- 生命周期治理（路线 A P2，2026-10-03）---------------------------------
    # ① 同库单实例锁：同一 SQLite 只允许一个后端实例（双写会让任务重复执行、
    #    队列行被抢）。锁被占时读 pid 记录——若占用者由父死感知托管且其父已死，
    #    判为存量孤儿（升级前的强杀残留）SIGTERM 收口后接手；否则明确报错退出。
    #    --allow-shared-db 为逃生口（自担风险）。
    # ② 父死感知：仅 --parent-watch（插件 spawn 时显式传）启用——dsh 宿主退出/
    #    崩溃/被 kill -9 时后端自行退出，不留孤儿。独立启动不传，行为不变。
    instance = lifecycle.SingleInstance(
        db.db_path(), repo_dir=BASE_DIR, parent_watch=bool(args.parent_watch),
        allow_shared=bool(args.allow_shared_db))
    if not instance.acquire():
        print(f"错误: {instance.reason}", file=sys.stderr)
        sys.exit(3)

    def _cleanup(reason=""):
        """退出前统一收尾（信号路径与父死路径共用，幂等）。"""
        try:
            dshevents.stop()                     # 断开状态流订阅（P4）
        except Exception:                        # noqa: BLE001 —— 退出路径不抛
            pass
        try:
            lifecycle.kill_children()
        except Exception:                        # noqa: BLE001 —— 退出路径不抛
            pass
        try:
            os.remove(PORT_FILE)                 # 端口标记随退出清理
        except OSError:
            pass
        try:
            instance.release()
        except Exception:                        # noqa: BLE001
            pass

    def _on_parent_gone():
        """父死看门狗线程回调：线程内不能把 SystemExit 抛给主线程，收尾后硬退出。"""
        print("[lifecycle] 确认父进程已消失，后端退出", file=sys.stderr, flush=True)
        _cleanup()
        os._exit(0)

    if args.parent_watch:
        _watch = lifecycle.arm_parent_watch(_on_parent_gone)
        print(f"[lifecycle] 父死感知已启用（stdin EOF 看门狗 + PDEATHSIG="
              f"{_watch['pdeathsig']}）", flush=True)

    seeded = _MODULE_SEEDED or db.init_db()
    db.purge_expired_sessions()
    runner.set_liveness_probe(board.unit_liveness)  # 行判活探针（web 族卡三态映射）
    runner_instance.recover()
    board.recover()
    # 顺序硬约束（行口径沿用）：启动对账必须在 runner.recover →
    # board.recover 之后——busy web 卡的行已由 board.recover 置 running 并重建
    # _RUNS，余下活跃行按证据裁活（活→保留、可证死→行收口）；
    # 对账提前会把 busy web 卡误杀
    runner.reconcile_units()
    # 启动闸放行（P7a 缺陷 F）：init_db → runner.recover → board.recover → 对账
    # 全部跑完后 worker 才允许拾取（见 Runner.release_boot_gate 的竞态说明）。
    # 放行点在对账之后而非 recover 之后：recover 与 board.recover 之间仍有 c: 行
    # 映射（board.recover 独占），对账前拾取则可能被 reconcile_units 按证据误裁。
    runner_instance.release_boot_gate()
    board.start_scheduler()
    # P4 事件化（2026-10-03）：dsh 状态事件中枢先起（单条 SSE 订阅插件的全局
    # 状态流），再起调和器——调和器改为等它的事件唤醒，不再固定 5s 轮询 dsh。
    # 独立形态（未下发驱动地址）下 start() 直接返回 False，不起线程。
    dshevents.start()
    # 启动补跑（2026-10-07 僵尸 ext 行实障修复）：上面 board.recover() 里的 ext 行
    # 对账执行时中枢尚未连接 ⇒ 探测「不可用」、一律保行；上一进程留下的僵尸占用行
    # （会话已结束、行仍 running）会继续堵死该项目补位，重启也救不回来。这里等首连
    # 就绪后补跑一次对账（后台线程，不阻塞启动与端口绑定；未就绪直接结束）。
    board.start_ext_recover_after_connect()
    board.start_interaction_watcher()
    runner.start_unit_selfcheck()  # 等待项周期自检线程（首轮宽限+年龄豁免），替代已退场的影子比对线程
    feishu.start_notifier()  # 飞书 outbox 投递线程（未配置时空转）
    feishu.start_inbound_all()  # 飞书入站长连接：按用户各自拉起（凭据齐全才连接；用户保存配置时也会即时拉起）

    # 端口绑定：被占用（10048/errno 98）或被系统保留段拒绝（Windows 10013——
    # Hyper-V/WSL/WinNAT 动态保留、Docker Desktop 端口映射等）时自动 port+1
    # 顺延重试，最多 PORT_RETRY 次；连续失败才退出并给排障指引
    server = None
    port = args.port
    last_bind_err = None
    for _ in range(PORT_RETRY):
        try:
            server = ThreadingHTTPServer((args.host, port), Handler)
            break
        except OSError as e:
            last_bind_err = e
            reason = "系统保留段/拒绝访问" if isinstance(e, PermissionError) else "被占用"
            print(f"警告: {args.host}:{port} 绑定失败（{reason}: {e}），尝试 {port + 1}...",
                  file=sys.stderr)
            port += 1
    if server is None:
        # 连续 PORT_RETRY 个端口均失败：环境异常（大面积保留段/防火墙），给可执行指引
        print(f"错误: {args.host} 自 {args.port} 起连续 {PORT_RETRY} 个端口绑定失败"
              f"（最后错误: {last_bind_err}）", file=sys.stderr)
        print("  Windows 保留段查看: netsh interface ipv4 show excludedportrange protocol=tcp（管理员）",
              file=sys.stderr)
        print(f"  占用检查: Windows netstat -ano | findstr :{args.port}"
              f"（Docker 映射 netstat 查不到，用 docker ps）；Linux: ss -ltnp | grep {args.port}",
              file=sys.stderr)
        print("  或显式指定空闲端口启动: --port 参数 / TS_PORT 环境变量", file=sys.stderr)
        sys.exit(1)
    # 实际绑定端口（--port 0 时由 OS 分配, 回写供 banner/端口文件/插件薄壳使用）
    port = server.server_address[1]
    if port != args.port and args.port != 0:
        print(f"提示: 端口 {args.port} 不可用，已自动顺延为 {port}")
    # SIGTERM/SIGINT 优雅退出：收尾统一走 _cleanup（子进程树 + 托管实例 + 端口
    # 标记 + 单实例记录；无托管则各自 no-op，try/except 互不阻断）。
    # touchstone.sh stop 用 SIGTERM，Python 默认不执行 atexit，必须显式注册 handler。
    def _graceful_exit(signum, frame):
        _cleanup(f"signal-{signum}")
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, _graceful_exit)
    signal.signal(signal.SIGINT, _graceful_exit)
    _write_port_file(port)
    # 监听信息：前台运行直接上控制台；经 touchstone.py / touchstone.sh 后台启动时落 .run/server.log。
    # 0.0.0.0 / :: 本身不可直接访问，另给本机回环与局域网 IP 的可点地址
    visit_host = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
    visit_line = f"访问: http://{visit_host}:{port}/"
    if args.host in ("0.0.0.0", "::"):
        lan = _lan_ip()
        if lan and lan != visit_host:
            visit_line += f"  （局域网: http://{lan}:{port}/）"
    print(f"Touchstone 站点已启动，监听 {args.host}:{port}"
          f"{_seed_hint(seeded, db.take_seed_password())}")
    print(visit_line)
    print(f"数据库: {db.db_path()}")
    # 机器可读监听行: dsh 插件薄壳按此解析实际端口（与各驱动的 banner 端口策略一致）
    print(f"TOUCHSTONE_LISTEN {port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

