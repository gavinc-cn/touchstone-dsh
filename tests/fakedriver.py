#!/usr/bin/env python3
"""假 dsh agent 驱动（隔离测试替身；路线 A P7a，2026-10-03）。

为什么需要它：`dsh_plugin` 族不起本地子进程，平台经 HTTP 驱动 dsh 宿主进程内的
agent（契约见 `dshdriver.py` 与 `dsh-plugin/lib/agent-driver.js`）。因此「假 CLI
agent」在单族世界里失效——隔离 e2e 需要替身退到**驱动边界**：一个真的 HTTP
服务，实现 `/touchstone-agent` 前缀下的同一份契约，让平台侧代码（runner/board/
chat/dshevents）走**原路径**跑起来。

替身实现的口径（与真插件的差异如实记）：
- **不做 LLM**：一轮 = 可配置时长的睡眠（`turn_ms`）后产出一条 assistant 文本，
  帧序列与真插件一致（turn/start → agent/status running → assistant/message →
  turn/end + agent/status idle）；
- **不落会话存储**：不写 `~/.dsh/sessions/**`，故会话窗的**消息内容**在替身下
  为空（本仓的隔离 e2e 断言的是队列/状态/徽标，不依赖消息正文）；
- 忙时 `/prompt` 进 inbox（对齐宿主 followup 的排队语义），轮末自动取下一项；
- `/_ctl/*` 是对照控制面（测试脚本用它制造提问/审批/错误/计数），真插件没有；
  `/_ctl/ask` 制造的挂起提问会**保持会话 running 并暂停轮计时**，直到 `/answer` 或
  `/_ctl/end_interaction` 放行——对齐真插件「等作答时 agent 保持 busy」的实况
  （平台 `_iw_interaction` 的 pending 判定要求 busy=True）；`/_ctl/ask` 传
  `questions`（dsh 题目列表）时原样进 mark，平台阻塞徽标才能取到真题干。

状态流帧（`?scope=state`）与真插件同形：`{seq, time, type, session_id, data}`，
`dshevents.EventHub` 直接折叠（字段口径见该模块 `_on_frame`）。

**外部会话与看管（C 批 T5，2026-10-10）**：替身另持一张 `external` 表，模拟
「用户在 dsh GUI 里直跑/接管」的会话——它们**不在** `sessions`（驱动池）里，
只在 `/live` 里以 `owned:false` 行出现（真插件 `observed` 表同形）；平台要投递/
作答必须先 `POST /watch` 声明看管（`watched` 集合），否则 `/prompt`·`/steer` 404。
三个控制面端点供测试造场景：`/_ctl/external`（建外部会话）、`/_ctl/external_state`
（改实况：`status='unknown'` 即「宿主无活 agent」）、`/_ctl/external` + `watch_fail`
（模拟旧插件没有 `/watch` 端点）。`FakeDriver.ctl()` 是这些控制面的客户端便捷口。
"""

import json
import os
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# 一轮的默认时长（毫秒）：与旧「假 CLI agent」的 TS_E2E_SLEEP 语义对齐，由夹具覆盖
DEFAULT_TURN_MS = 4000
# SSE keepalive 间隔（秒）：真插件 15s；替身短一点，测试更快发现链路问题
KEEPALIVE = 5.0

# 一张 1x1 PNG（媒体预览端点用；id 非法时 404）
PNG_1PX = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082")


class _Session:
    """一个替身会话的实时态（字段对齐 `dshdriver.status()` 与插件 `/live`）。"""

    def __init__(self, sid, cwd, task, model="", provider="", origin=""):
        self.sid = sid
        self.cwd = cwd
        self.task = task
        self.model = model
        self.provider = provider
        # 会话头行 origin（真插件口径）：'subagent' = dsh 子代理会话（平台据此不建卡、
        # 不算项目占用）；'' = 主会话/旧插件未上报（平台回落会话头判定）。
        self.origin = origin
        self.effort = ""               # 思考等级（reasoningEffort；真插件 entry.model.reasoningEffort）
        self.status = "idle"           # idle | running
        self.last_seq = 0              # 会话事件 seq（单调；状态帧的 event_seq 取它）
        self.last_turn_reason = None   # 最近一次 turn/end 的 reason.kind
        self.cancelled = False         # 最近一次 turn 是否由 /cancel 结束
        self.interaction = None        # 挂起等待的人工输入（提问/审批）
        self.inbox = []                # 忙时排队的 prompt（对齐宿主 inbox）
        self.held_approvals = False    # 是否已由平台接管审批（/permission 后）
        self.turn = 0
        self.ring = []                 # 会话流帧环（since 续传）
        self.inbox_seq = 0
        self.started_at = int(time.time() * 1000)   # /live 的 started_at 口径
        self.await_answer = threading.Event()   # 挂起等待作答（作答即提前收轮）
        self.turn_cancel = threading.Event()    # /cancel 唤醒睡眠
        self.turn_thread = None
        self.lock = threading.RLock()


class FakeDriver:
    """假驱动实例：进程内 HTTP 服务 + 状态环 + 轮次引擎。

    用法（测试夹具）::

        drv = FakeDriver(mark=mark_path, turn_ms=4000)
        drv.start()
        env["TS_AGENT_DRIVER_URL"] = drv.url
        env["TS_AGENT_DRIVER_TOKEN"] = drv.token
        ...
        drv.stop()

    `ctl(path, body=None)` 走控制面（`/_ctl/*`），`stats()` 取请求计数（验收用）。
    """

    def __init__(self, mark="", turn_ms=None, token="", on_prompt=None):
        self.mark = mark
        self.turn_ms = int(turn_ms if turn_ms is not None
                           else os.environ.get("TS_FAKE_DRIVER_TURN_MS", DEFAULT_TURN_MS))
        self.token = token or ("tsfake-" + os.urandom(6).hex())
        # 测试注入的「本轮产出」钩子：callable(sess, prompt)。替身自己不做任何
        # 文件产出（真 agent 会写案例/方案），需要产出的场景（如压测方案包）由
        # 夹具在这里同步落盘，保证轮次结束前文件已就绪。
        self.on_prompt = on_prompt
        self.lock = threading.RLock()
        self.sessions = {}
        # 外部会话表（C 批 T5）：{sid: {sid, cwd, status, interaction}}。模拟
        # 「用户在 dsh GUI 里直跑/接管」的会话——它们不在 `sessions`（驱动池）里，
        # 只经 `/live` 以 `owned:false` 行露出（真插件 `observed` 表同形）。
        # `status='unknown'` = 宿主里没有活 agent（会话已结束），与真插件
        # `live ? live.status : 'unknown'` 同口径。
        self.external = {}
        # 平台已声明的看管集（真插件 `this.watched` 同形）：外部会话能被
        # `/prompt`·`/steer`·`/answer`·`/approval` 触达的**唯一**闸（设计 §3.1）。
        self.watched = set()
        # 看管端点硬失败开关（测试用，同 `archive_fail` 口径）：置字符串后
        # `/watch` 一律 404——模拟**旧插件**没有该端点，平台据此降级为拒投。
        self.watch_fail = None
        # `/rename` 的「宿主接受值」钩子（测试用，可调用则用它规范化标题）：
        # 真宿主 `sessionController.rename` 会走 `normalizeSessionTitle` 的
        # UTF-8 字节预算并回**接受值**，平台据此把卡面回写成同一串（2026-10-10）。
        self.rename_accept = None
        # 建/恢复会话硬失败开关（测试用，同 `watch_fail` 口径）：置字符串后
        # `/session` 一律 500——模拟「会话已不存在 / 恢复失败」，供卡片会话投递
        # 自愈（2026-10-10）用例断言「接不回时给明确文案、不再白投一次」。
        self.session_fail = None
        self.state_seq = 0
        self.state_ring = []
        self.subs = []                  # 状态流订阅者队列（queue.Queue）
        self.sid_seq = 0
        self.counts = {}                # path -> 请求次数（验收：静置期请求数）
        # 宿主归档集（与真插件的 workspaceRegistry.archivedSessionIds 同语义：
        # 整表、有序；归档只影响分组面，不删会话）
        self.archived = []
        # 归档硬失败开关（测试用）：置字符串后 /archive 一律 409（非「会话不存在」，
        # 平台按硬失败回滚移列并 400 报错）
        self.archive_fail = None
        # `/live` 的**完整声明**（A 批 2026-10-08 真插件契约）：真插件在枚举完宿主已有
        # 会话后回 `complete: true`，Python 侧只有见到它才敢把空快照当成「宿主里确实
        # 没有会话」（见 dshevents._align）。替身自己就是唯一会话源 ⇒ 默认 True；
        # 置 **None** 即省略该字段，模拟**旧插件**（平台按「未对齐」处理：空表不写列）。
        self.live_complete = True
        self.httpd = None
        self.port = 0
        self._mark_lock = threading.Lock()

    # ---------- 生命周期 ----------

    def start(self):
        """起服务线程（幂等），返回 self。"""
        if self.httpd is not None:
            return self
        handler = _make_handler(self)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, name="fake-driver",
                         daemon=True).start()
        return self

    def stop(self):
        """停服务并唤醒订阅者（幂等）。"""
        for q in list(self.subs):
            try:
                q.put(None)
            except Exception:           # noqa: BLE001 — 收尾尽力而为
                pass
        if self.httpd is not None:
            self.httpd.shutdown()
            self.httpd.server_close()
            self.httpd = None

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}"

    # ---------- 控制面客户端（测试便捷口） ----------

    def ctl(self, path, body=None):
        """走控制面发一条请求（`/_ctl/*`），返回解析后的响应 dict。

        测试脚本用它制造场景（建外部会话 / 改实况 / 造提问），真插件没有控制面。
        `body=None` 走 GET，给了 body 走 POST（JSON）。HTTP 非 2xx 也把响应体
        返回给调用方自行断言（与 `serverfixture.Api` 同口径）。
        """
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            self.url + path, data=data, method="GET" if data is None else "POST",
            headers={"content-type": "application/json; charset=utf-8"})
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:      # 非 2xx：正文照常返回（调用方断言）
            raw = e.read().decode("utf-8", errors="replace")
        try:
            return json.loads(raw or "{}")
        except ValueError:
            return {"raw": raw}

    # ---------- 记号与统计（测试断言面） ----------

    def note(self, payload):
        """把一次驱动调用记入标记文件（`CALL {json}` 行）。

        行首保留 `CALL ` 前缀：既有夹具的 `call_mark().count("CALL")` 计数口径不变；
        正文中的 prompt 原文以 ensure_ascii=False 落盘，`<文本> in call_mark()` 这类
        断言继续可用。解析方去掉前缀后按 JSON 读。
        """
        if not self.mark:
            return
        with self._mark_lock:
            try:
                with open(self.mark, "a", encoding="utf-8") as f:
                    f.write("CALL " + json.dumps(payload, ensure_ascii=False) + "\n")
            except OSError:
                pass

    def stats(self):
        """请求计数快照（`{path: 次数}`）——「静置期请求 = 0」的验收读口。"""
        with self.lock:
            return dict(self.counts)

    def fire_prompt_hook(self, sess, prompt):
        """跑一次注入的 on_prompt 钩子（异常只记账，不影响替身本身）。"""
        if self.on_prompt is None:
            return
        try:
            self.on_prompt(sess, prompt)
        except Exception as exc:            # noqa: BLE001 — 钩子失败必须可见
            self.note({"call": "on_prompt_error", "sid": sess.sid, "error": repr(exc)})

    def bump(self, path):
        with self.lock:
            self.counts[path] = self.counts.get(path, 0) + 1

    # ---------- 状态流 ----------

    def publish_state(self, typ, sid, data):
        """发一帧全局状态帧（单调 seq + 环 + 广播）。"""
        with self.lock:
            self.state_seq += 1
            frame = {"seq": self.state_seq, "time": int(time.time() * 1000),
                     "type": typ, "session_id": sid, "data": data}
            self.state_ring.append(frame)
            if len(self.state_ring) > 2000:
                self.state_ring = self.state_ring[-2000:]
            subs = list(self.subs)
        for q in subs:
            try:
                q.put(frame)
            except Exception:           # noqa: BLE001
                pass

    # ---------- 会话归档（看板「已完成」同步，2026-10-05） ----------

    def publish_archived(self):
        """发 `driver/archived` 整表快照帧（与真插件同形：空 session_id 的全局帧）。"""
        with self.lock:
            ids = list(self.archived)
        self.publish_state("driver/archived", "", {"archived": ids})

    def set_archived(self, sid, want):
        """置归档态（幂等）；有变化才发帧。返回是否变化。"""
        with self.lock:
            if want:
                if sid in self.archived:
                    return False
                self.archived.append(sid)
            else:
                if sid not in self.archived:
                    return False
                self.archived.remove(sid)
        self.publish_archived()
        return True

    def publish_session(self, sess, typ, data):
        """发一帧会话事件（会话内 seq 单调；`event_seq` 供状态帧引用）。

        订阅者是**多路**（对齐真插件 `entry.clients = new Set()`）：同一会话可能
        同时被 runner 轮次流与 chat 补位流订阅，单槽实现会被后到者覆盖、先退者
        误删（2026-10-03 P7a 实测踩中：排队消息补位后永久收不到 turn/end）。
        """
        with sess.lock:
            sess.last_seq += 1
            frame = {"seq": sess.last_seq, "time": int(time.time() * 1000),
                     "type": typ, "session_id": sess.sid, "data": data}
            sess.ring.append(frame)
            if len(sess.ring) > 2000:
                sess.ring = sess.ring[-2000:]
            subs = list(sess.__dict__.get("_subs") or [])
        for q in subs:
            try:
                q.put(frame)
            except Exception:           # noqa: BLE001
                pass
        return sess.last_seq

    # ---------- 会话与轮次引擎 ----------

    def create(self, sid="", cwd="", task="", model="", provider="", origin=""):
        """建/恢复会话（sid 为空则生成），发 session/created + driver/attached。

        `origin` 对齐真插件：真 dsh 子代理会话头行带 `origin=subagent`，插件在
        `session/created` 状态帧与 `/live` 行里上报（见 agent-driver._sessionOrigin）。
        """
        with self.lock:
            if not sid:
                self.sid_seq += 1
                sid = f"fake-drv-{self.sid_seq}"
            sess = self.sessions.get(sid)
            if sess is None:
                sess = _Session(sid, cwd, task, model, provider, origin)
                self.sessions[sid] = sess
                self.publish_state("session/created", sid,
                                   {"cwd": cwd, "task": task, "session_id": sid,
                                    "origin": origin})
                self.publish_state("driver/attached", sid,
                                   {"cwd": cwd, "task": task,
                                    "model": {"provider": provider, "model": model}})
            else:
                sess.cwd = cwd or sess.cwd
                sess.task = task or sess.task
                sess.model = model or sess.model
                sess.provider = provider or sess.provider
        return sess

    def start_turn(self, sess, prompt, steered=False):
        """投一轮：忙则进 inbox（对齐宿主 followup 排队），空闲则起线程跑。"""
        with sess.lock:
            if sess.status == "running":
                sess.inbox_seq += 1
                sess.inbox.append({"id": f"ib-{sess.inbox_seq}", "text": prompt})
                items = list(sess.inbox)
                self.publish_state("driver/inbox", sess.sid, {"items": items})
                return False
            sess.status = "running"
            sess.cancelled = False
            sess.turn_cancel.clear()
            sess.await_answer.clear()
            sess.turn += 1
            turn = sess.turn
            sess.turn_thread = threading.Thread(
                target=self._run_turn, args=(sess, prompt, turn, steered), daemon=True)
        self.publish_state("turn/start", sess.sid,
                           {"turn": turn, "event_seq": self.publish_session(
                               sess, "turn/start", {"turn": turn})})
        self.publish_state("agent/status", sess.sid, {"agent": "dsh", "status": "running"})
        sess.turn_thread.start()
        return True

    def _run_turn(self, sess, prompt, turn, steered):
        """轮次体：等时长/取消/作答，然后收口（可继续消费 inbox）。"""
        try:
            self.publish_session(sess, "user/message",
                                 {"message": {"role": "user", "content": prompt}})
            waited = 0.0
            step = 0.05
            while waited * 1000 < self.turn_ms:
                if sess.turn_cancel.wait(step):
                    break
                # 挂起提问/审批期间**不计入轮时长**（对齐真插件：agent 等作答时保持
                # busy，平台 `_iw_interaction` 的 pending 判定要求 busy=True）。
                # 作答（`/answer`）与 `/_ctl/end_interaction` 都会 set 该事件。
                with sess.lock:
                    held = sess.interaction is not None
                if held:
                    sess.await_answer.wait(step)
                    continue
                waited += step
            reason = "aborted" if sess.turn_cancel.is_set() else "completed"
            text = "" if reason == "aborted" else (
                f"FAKE-DRIVER 完成一轮（turn {turn}）")
            if text:
                seq = self.publish_session(sess, "assistant/message", {
                    "message": {"role": "assistant",
                                "content": [{"type": "text", "text": text}],
                                "usage": {"input": 10, "output": 5, "total": 15}}})
                self.publish_state("usage", sess.sid,
                                   {"input": 10, "output": 5, "total": 15,
                                    "cache_read": 0})
            else:
                seq = self.publish_session(sess, "assistant/message", {
                    "message": {"role": "assistant",
                                "content": [{"type": "text", "text": "（已中断）"}]},
                    "interrupted": True})
            with sess.lock:
                sess.status = "idle"
                sess.last_turn_reason = reason
                sess.cancelled = reason == "aborted"
                nxt = ""
                if sess.inbox and reason == "completed":
                    nxt = sess.inbox.pop(0)["text"]
                    items = list(sess.inbox)
                else:
                    items = None
            end_seq = self.publish_session(sess, "turn/end",
                                           {"turn": turn, "reason": {"kind": reason}})
            self.publish_state("turn/end", sess.sid,
                               {"turn": turn, "reason": reason, "event_seq": end_seq})
            self.publish_state("agent/status", sess.sid, {"agent": "dsh", "status": "idle"})
            if items is not None:
                self.publish_state("driver/inbox", sess.sid, {"items": items})
            if nxt:
                self.start_turn(sess, nxt)      # 轮末自动处理排队项（宿主 inbox 语义）
        except Exception as exc:                # noqa: BLE001 — 替身不应把线程炸掉
            self.note({"call": "turn_error", "sid": sess.sid, "error": repr(exc)})

    def cancel(self, sess):
        """中断当前 turn（turn/end.reason=aborted，对齐真实 cancel 落盘形态）。"""
        sess.turn_cancel.set()
        return True

    def status(self, sess):
        """单会话状态 dict（字段与插件 `/status` 同形）。

        `owned`/`started_at` 也对齐真插件 `/live`（P7a 补）：EventHub `_align`
        用 `row.get("owned", old)` 覆盖注册表，缺字段会让 `server._dsh_live_sid`
        之类按 owned 过滤的读口筛空。
        """
        with sess.lock:
            model = {"provider": sess.provider, "model": sess.model,
                     **({"reasoningEffort": sess.effort} if sess.effort else {})}
            return {"session_id": sess.sid, "status": sess.status,
                    "last_seq": sess.last_seq,
                    "last_turn_reason": sess.last_turn_reason,
                    "cancelled": sess.cancelled,
                    "interaction": sess.interaction, "cwd": sess.cwd,
                    "task": sess.task, "model": model,
                    "origin": sess.origin,
                    "inbox": list(sess.inbox),
                    "owned": True,
                    "started_at": sess.started_at,
                    "approval_held": sess.held_approvals}


class _Handler(BaseHTTPRequestHandler):
    """驱动端点路由（`/_ctl/*` = 控制面，其余 = 契约面）。"""

    protocol_version = "HTTP/1.0"        # SSE 靠连接关闭收尾：客户端 read1 逐段读
    server_version = "fake-dsh-driver/1.0"

    # 注入的 FakeDriver 实例（由 _make_handler 动态挂载）
    driver = None

    def log_message(self, *args):        # 静音：测试日志只看断言
        pass

    # ---------- 基础应答 ----------

    def _json(self, code, body):
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _read_body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except ValueError:
            return {}

    def _authed(self, path):
        """控制面不走令牌；契约面必须带 `x-ts-driver-token`。"""
        if path.startswith("/_ctl/"):
            return True
        token = self.driver.token
        return (self.headers.get("x-ts-driver-token") or "") == token

    def _session_of(self, body):
        """按 body.session_id 取会话；不存在返回 None（调用方回 404）。"""
        sid = str(body.get("session_id") or "")
        return self.driver.sessions.get(sid)

    # ---------- 外部会话回落（C 批 T5；与真驱动阶梯同序，设计 §3.2/§4.2） ----------

    def _external_fallback(self, sid):
        """池外会话的准入判定：返回 `(row, None)` 可触达；`(None, (code, error))` 拒绝。

        阶梯（与真驱动一致）：① 未声明看管 ⇒ 404「未声明看管」；② 已看管但宿主
        没有活 agent（`status='unknown'`）⇒ 404「会话已结束」；③ 已看管 + 有活
        agent ⇒ 放行（返回外部会话行）。**未看管的会话一律不可触达**——这是平台
        「不打扰宿主里与 TS 无关的会话」的硬闸。
        """
        drv = self.driver
        if sid not in drv.watched:
            return None, (404, f"会话不在驱动池中且未声明看管: {sid}")
        row = drv.external.get(sid)
        if row is None or str(row.get("status") or "") == "unknown":
            return None, (404, f"会话已结束（宿主无活动 agent）: {sid}")
        return row, None

    def _external_prompt(self, body, steer=False):
        """池外会话的投递回落（`/prompt`·`/steer`）。

        替身不做 LLM，故只记一笔 `external:True` 的调用记号并回
        `{ok:true, external:true}`（平台半的断言面就是「驱动确实收到这次投递、
        且知道它是外部会话」）；真插件在此让宿主 `agent.followup()/steer()` 真跑一轮。
        """
        sid = str(body.get("session_id") or "")
        text = str(body.get("prompt") or "")
        row, err = self._external_fallback(sid)
        if err is not None:
            return self._json(err[0], {"error": err[1]})
        self.driver.note({"call": "/steer" if steer else "/prompt", "sid": sid,
                          "prompt": text, "external": True})
        return self._json(200, {"ok": True, "session_id": sid, "external": True})

    def _external_answer(self, body):
        """池外会话作答（提问）：按替身内部 `interaction` 兑现（call_id 匹配才接受）。"""
        sid = str(body.get("session_id") or "")
        row, err = self._external_fallback(sid)
        if err is not None:
            return self._json(err[0], {"error": err[1]})
        drv = self.driver
        with drv.lock:
            cur = dict(row.get("interaction") or {})
        if not cur or str(cur.get("call_id")) != str(body.get("call_id")):
            # 与池内同口径：认领表里没有该 callId ⇒ 未接受（平台按 40405 放弃）
            return self._json(200, {"accepted": False})
        with drv.lock:
            row["interaction"] = None
        drv.note({"call": "/answer", "sid": sid, "call_id": body.get("call_id"),
                  "answers": body.get("answers"), "external": True})
        return self._json(200, {"accepted": True, "external": True})

    def _external_approval(self, body):
        """池外会话审批：按替身内部 `interaction`（kind=approval）兑现 `outcome`。"""
        sid = str(body.get("session_id") or "")
        row, err = self._external_fallback(sid)
        if err is not None:
            return self._json(err[0], {"error": err[1]})
        drv = self.driver
        with drv.lock:
            cur = dict(row.get("interaction") or {})
        if str(cur.get("kind") or "") != "approval":
            return self._json(409, {"error": "无待决审批"})
        with drv.lock:
            row["interaction"] = None
        drv.note({"call": "/approval", "sid": sid,
                  "approval_id": body.get("approval_id"),
                  "decision": body.get("decision"), "external": True})
        return self._json(200, {"outcome": body.get("decision"), "external": True})

    # ---------- 路由 ----------

    def do_GET(self):
        parsed = urlparse(self.path)
        path, q = parsed.path, parse_qs(parsed.query)
        drv = self.driver
        if path.startswith("/_ctl/"):
            drv.bump(path)
            return self._ctl_get(path)
        drv.bump(path)
        if not self._authed(path):
            return self._json(401, {"error": "bad token"})
        if path == "/health":
            with drv.lock:
                n = len([s for s in drv.sessions.values() if s.status == "running"])
            return self._json(200, {"ok": True, "live": n,
                                    "sessions": len(drv.sessions)})
        if path == "/live":
            rows = [drv.status(s) for s in list(drv.sessions.values())]
            # 外部会话并进同一张表、**owned:false**（与真插件 `live()` 同形）：
            # 真插件外部行只有 session_id/task/cwd/status/owned/origin/interaction/
            # last_turn_reason，**不带** last_seq/permission/started_at 等池内字段
            # ——平台读侧必须容忍这些字段缺失（`dshevents._align` 用 row.get 兜底）。
            with drv.lock:
                ext = [dict(r) for r in drv.external.values()]
            for r in ext:
                rows.append({"session_id": r["sid"], "task": "",
                             "cwd": r.get("cwd") or "",
                             "status": r.get("status") or "unknown",
                             "owned": False, "origin": "",
                             "interaction": r.get("interaction"),
                             "last_turn_reason": None})
            body = {"sessions": rows}
            # 完整声明（A 批）：真插件在 apply 时枚举完宿主已有会话才回 true；
            # None = 模拟旧插件（字段缺省 ⇒ 平台把空表按未知处理）。
            if drv.live_complete is not None:
                body["complete"] = bool(drv.live_complete)
            return self._json(200, body)
        if path == "/status":
            sid = (q.get("session_id") or [""])[0]
            sess = drv.sessions.get(sid)
            if sess is None:
                # 外部会话仍**不在驱动池**：与真插件同文案（`/status` 的池外回落
                # 由 T2 提供，本替身按 T5 口径只回 404）——平台据此把投递基线
                # 回落走 `dshevents`（T6）。
                if sid in drv.external:
                    return self._json(404, {"error": f"会话不在驱动池中: {sid}"})
                return self._json(404, {"error": "session not found"})
            return self._json(200, drv.status(sess))
        if path == "/models":
            # 思考等级（2026-10-04）：每模型的 efforts/default_effort 与真插件同形，
            # 供「项目/会话思考等级」下拉的档位来源断言（flash 支持四档、v4-pro 两档）
            flash_efforts = [{"id": "minimal", "name": "Minimal"},
                             {"id": "low", "name": "Low"},
                             {"id": "medium", "name": "Medium"},
                             {"id": "high", "name": "High"},
                             {"id": "xhigh", "name": "Xhigh"},
                             {"id": "max", "name": "Max"}]
            return self._json(200, {
                "default": {"provider": "deepseek-official", "model": "deepseek-flash"},
                "groups": [{"id": "deepseek-official", "name": "DeepSeek 官方",
                            "models": [
                                {"id": "deepseek-flash", "name": "DeepSeek-Flash",
                                 "reasoning": True, "efforts": flash_efforts,
                                 "default_effort": "max"},
                                {"id": "deepseek-v4-pro", "name": "DeepSeek-V4-Pro",
                                 "reasoning": True,
                                 "efforts": [{"id": "low", "name": "Low"},
                                             {"id": "high", "name": "High"}],
                                 "default_effort": ""}]}],
                "routable_providers": ["deepseek-official"], "failures": []})
        if path == "/presets":
            return self._json(200, {
                "current": "workspace-write",
                "default": "workspace-write",
                "options": [{"value": "read-only", "name": "只读", "approval": "never"},
                            {"value": "workspace-write", "name": "工作区可写",
                             "approval": "ask"},
                            {"value": "danger-full-access", "name": "完全访问",
                             "approval": "never"}]})
        if path == "/media":
            mid = (q.get("id") or [""])[0]
            if mid == "missing":
                return self._json(404, {"error": "attachment not found"})
            import base64
            return self._json(200, {"content_type": "image/png", "bytes": len(PNG_1PX),
                                    "data": base64.b64encode(PNG_1PX).decode("ascii")})
        if path == "/archived":
            with drv.lock:
                return self._json(200, {"archived": list(drv.archived)})
        if path == "/events":
            return self._events(q)
        return self._json(404, {"error": "unknown endpoint"})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        drv = self.driver
        if path.startswith("/_ctl/"):
            drv.bump(path)
            return self._ctl_post(path)
        drv.bump(path)
        if not self._authed(path):
            return self._json(401, {"error": "bad token"})
        body = self._read_body()
        if path == "/session":
            if drv.session_fail:
                return self._json(500, {"error": drv.session_fail})
            sid = str(body.get("session_id") or "")
            sess = drv.create(sid, cwd=str(body.get("cwd") or ""),
                              task=str(body.get("task") or ""),
                              model=str(body.get("model") or ""),
                              provider=str(body.get("provider") or ""))
            drv.note({"call": "/session", "sid": sess.sid, "resume": bool(sid),
                      "cwd": sess.cwd, "task": sess.task, "model": sess.model})
            return self._json(200, {"session_id": sess.sid})
        if path == "/prompt":
            sess = self._session_of(body)
            if sess is None:
                return self._external_prompt(body, steer=False)
            text = str(body.get("prompt") or "")
            drv.note({"call": "/prompt", "sid": sess.sid, "prompt": text})
            drv.fire_prompt_hook(sess, text)
            drv.start_turn(sess, text)
            return self._json(200, {"ok": True})
        if path == "/steer":
            sess = self._session_of(body)
            if sess is None:
                return self._external_prompt(body, steer=True)
            text = str(body.get("prompt") or "")
            drv.note({"call": "/steer", "sid": sess.sid, "prompt": text})
            drv.fire_prompt_hook(sess, text)
            drv.start_turn(sess, text, steered=True)
            return self._json(200, {"ok": True})
        if path == "/watch":
            # 看管声明（C 批 T5；真插件 `_watch` 同形）：幂等 add/delete，
            # 回执 `watched` 给**当前实际状态**（平台据此核对，而不是假设）。
            # 只写内存表、不碰会话，故未知 sid 也 200（「声明意图」不是「建会话」）。
            if drv.watch_fail:
                return self._json(404, {"error": drv.watch_fail})
            sid = str(body.get("session_id") or "")
            if not sid:
                return self._json(400, {"error": "session_id 不能为空"})
            on = body.get("on") is not False
            with drv.lock:
                if on:
                    drv.watched.add(sid)
                else:
                    drv.watched.discard(sid)
                watched = sid in drv.watched
            drv.note({"call": "/watch", "sid": sid, "on": bool(on),
                      "watched": watched})
            return self._json(200, {"ok": True, "session_id": sid,
                                    "watched": watched})
        if path == "/cancel":
            sess = self._session_of(body)
            if sess is None:
                return self._json(404, {"error": "session not found"})
            drv.note({"call": "/cancel", "sid": sess.sid,
                      "keep_inbox": bool(body.get("keep_inbox"))})
            drv.cancel(sess)
            return self._json(200, {"ok": True})
        if path == "/dispose":
            sess = self._session_of(body)
            if sess is None:
                return self._json(404, {"error": "session not found"})
            with drv.lock:
                drv.sessions.pop(sess.sid, None)
            drv.publish_state("driver/detached", sess.sid, {})
            drv.publish_state("session/disposed", sess.sid, {})
            return self._json(200, {"ok": True})
        if path == "/archive":
            # 归档/取消归档（真插件同形）：会话不存在 → 410（平台跳过该 sid 放行）
            sid = str(body.get("session_id") or "")
            want = body.get("archived") is not False
            if not sid:
                return self._json(400, {"error": "session_id required"})
            if drv.archive_fail:
                return self._json(409, {"error": drv.archive_fail})
            if sid not in drv.sessions:
                return self._json(410, {"error": f"会话不存在，无法归档: {sid}"})
            drv.note({"call": "/archive", "sid": sid, "archived": bool(want)})
            drv.set_archived(sid, bool(want))
            return self._json(200, {"session_id": sid, "archived": bool(want)})
        if path == "/compact":
            # `/compact` 池外回落（2026-10-10，与真驱动**同序**）：池内走既有路径；
            # 池外走 `_external_fallback` 的看管闸（未看管 / 看管但无活 agent 各自
            # 404 分档）；放行即记一笔 `external:True` 并回 `{started, external}`——
            # 真插件在此对宿主活 agent 触发 `/compact` 命令，**不接管**会话。
            sid = str(body.get("session_id") or "")
            sess = self._session_of(body)
            external = False
            if sess is None:
                row, err = self._external_fallback(sid)
                if err is not None:
                    return self._json(err[0], {"error": err[1]})
                external = True
            drv.note({"call": "/compact", "sid": sid,
                      **({"external": True} if external else {})})
            return self._json(200, {"started": True,
                                    **({"external": True} if external else {})})
        if path == "/fork":
            sess = self._session_of(body)
            if sess is None:
                return self._json(404, {"error": "session not found"})
            at_seq = body.get("at_seq")
            drv.note({"call": "/fork", "sid": sess.sid, "at_seq": at_seq})
            new = drv.create("", cwd=sess.cwd, task=sess.task, model=sess.model,
                             provider=sess.provider)
            if at_seq:
                with new.lock:
                    new.last_seq = int(at_seq)
            return self._json(200, {"new_session_id": new.sid})
        if path == "/rename":
            # 卡面改名 → DSH 会话名（2026-10-10 B 档）：与真驱动**同序**——池内走原
            # 路径；池外走 `_external_fallback` 的看管闸（未看管 / 看管但无活 agent
            # 各自 404 分档）；空标题在**定档之后**才 400（真驱动同款判定顺序）。
            sid = str(body.get("session_id") or "")
            sess = self._session_of(body)
            external = False
            if sess is None:
                row, err = self._external_fallback(sid)
                if err is not None:
                    return self._json(err[0], {"error": err[1]})
                external = True
            title = str(body.get("title") or "").strip()
            if not title:
                return self._json(400, {"error": "title required"})
            # 宿主规范化/截断后回**接受值**（`rename_accept` 由用例注入），
            # 平台据此回写卡面保证两侧逐字一致。
            accepted = drv.rename_accept(title) if callable(drv.rename_accept) else title
            drv.note({"call": "/rename", "sid": sid, "title": title,
                      "accepted": accepted, "external": external})
            return self._json(200, {"ok": True, "session_id": sid, "title": accepted,
                                    **({"external": True} if external else {})})
        if path == "/model":
            sess = self._session_of(body)
            if sess is None:
                return self._json(404, {"error": "session not found"})
            model = str(body.get("model") or "")
            provider = str(body.get("provider") or "")
            effort = str(body.get("reasoning_effort") or "")
            # 2026-10-04：model 可留空而只改思考等级（真插件从会话当前模型回读）；
            # 值可带 provider/ 前缀（平台会话窗直传）或裸 id + provider 分传（起会话路径）
            if not model and not effort:
                return self._json(400, {"error": "model 与 reasoning_effort 不能同时为空"})
            if "/" in model:
                head, _, tail = model.partition("/")
                if head and not provider:
                    provider = head
                if tail:
                    model = tail
            with sess.lock:
                if model:
                    sess.model = model
                if provider:
                    sess.provider = provider
                if effort:
                    sess.effort = effort
                selected = {"provider": sess.provider, "model": sess.model,
                            **({"reasoningEffort": sess.effort} if sess.effort else {})}
            drv.note({"call": "/model", "sid": sess.sid, "model": model,
                      "provider": provider, "reasoning_effort": effort})
            # 与真插件同形：切换结果进状态流（`driver/model`，会话窗控件据此即时刷新）
            drv.publish_state("driver/model", sess.sid, selected)
            return self._json(200, {"selected": selected})
        if path == "/permission":
            sess = self._session_of(body)
            if sess is None:
                return self._json(404, {"error": "session not found"})
            preset = str(body.get("preset") or "")
            mode = str(body.get("mode") or "")
            approval = "ask" if preset == "workspace-write" else "never"
            with sess.lock:
                sess.held_approvals = approval == "ask"
            drv.note({"call": "/permission", "sid": sess.sid, "preset": preset,
                      "mode": mode})
            # 与真插件同形：权限实况进状态流（`driver/permission`，含平台三档 mode）
            drv.publish_state("driver/permission", sess.sid,
                              {"mode": mode, "preset": preset})
            return self._json(200, {"preset": preset, "approval": approval,
                                    "hold_approvals": sess.held_approvals})
        if path == "/approval":
            sess = self._session_of(body)
            if sess is None:
                return self._external_approval(body)
            if not sess.held_approvals:
                return self._json(409, {"error": "approval not held by platform"})
            with sess.lock:
                sess.interaction = None
            drv.note({"call": "/approval", "sid": sess.sid,
                      "approval_id": body.get("approval_id"),
                      "decision": body.get("decision")})
            drv.publish_state("driver/interaction", sess.sid,
                              {"state": "resolved", "interaction": None})
            return self._json(200, {"outcome": body.get("decision")})
        if path == "/answer":
            sess = self._session_of(body)
            if sess is None:
                return self._external_answer(body)
            with sess.lock:
                cur = sess.interaction or {}
            if not cur or str(cur.get("call_id")) != str(body.get("call_id")):
                return self._json(200, {"accepted": False})
            with sess.lock:
                sess.interaction = None
            drv.note({"call": "/answer", "sid": sess.sid,
                      "call_id": body.get("call_id"), "answers": body.get("answers")})
            drv.publish_state("driver/interaction", sess.sid,
                              {"state": "resolved", "interaction": None})
            sess.await_answer.set()
            return self._json(200, {"accepted": True})
        return self._json(404, {"error": "unknown endpoint"})

    # ---------- 控制面（仅测试脚本使用） ----------

    def _ctl_get(self, path):
        drv = self.driver
        if path == "/_ctl/stats":
            return self._json(200, {"counts": drv.stats(),
                                    "sessions": [drv.status(s)
                                                 for s in drv.sessions.values()]})
        return self._json(404, {"error": "unknown ctl"})

    def _ctl_post(self, path):
        drv = self.driver
        body = self._read_body()
        if path == "/_ctl/external":
            # 登记一个**外部会话**（用户在 dsh GUI 里直跑/接管的会话）：只进
            # `drv.external`，不进驱动池——故 `/live` 里 `owned:false`、
            # `/status` 404、投递必须先在 `/watch` 声明看管。
            # body: {sid, cwd?, status?}（status 缺省 'idle' = 宿主有活 agent）。
            sid = str(body.get("sid") or body.get("session_id") or "")
            if not sid:
                return self._json(400, {"error": "sid required"})
            with drv.lock:
                row = drv.external.get(sid)
                if row is None:
                    row = {"sid": sid, "cwd": "", "status": "idle",
                           "interaction": None}
                    drv.external[sid] = row
                if body.get("cwd"):
                    row["cwd"] = str(body.get("cwd"))
                if body.get("status"):
                    row["status"] = str(body.get("status"))
                snap = dict(row)
            return self._json(200, {"ok": True, "external": snap})
        if path == "/_ctl/external_state":
            # 改外部会话实况：body {sid, status?, interaction?}。键**在不在** body
            # 里决定改不改（`interaction: null` 即清空挂起），与「缺省不改」区分。
            sid = str(body.get("sid") or body.get("session_id") or "")
            with drv.lock:
                row = drv.external.get(sid)
                if row is None:
                    return self._json(404, {"error": "external session not found"})
                if "status" in body:
                    row["status"] = str(body.get("status") or "")
                if "interaction" in body:
                    row["interaction"] = body.get("interaction")
                snap = dict(row)
            return self._json(200, {"ok": True, "external": snap})
        if path == "/_ctl/ask":
            sess = self._session_of(body)
            if sess is None:
                return self._json(404, {"error": "session not found"})
            kind = str(body.get("kind") or "question")
            questions = body.get("questions")
            if kind == "approval":
                mark = {"kind": "approval", "answerable": bool(sess.held_approvals),
                        "id": "ap-1", "tool": "bash", "action": "执行命令"}
            elif isinstance(questions, list) and questions:
                # dsh 真形态：driver/interaction 帧里的题目列表**原样透传**——平台
                # `_iw_interaction` 的 dsh 分支只认 `mark["questions"]`（真题干取
                # q0.question 前 80 字进卡片阻塞徽标），平面 `question` 字段它读不到。
                mark = {"kind": "question", "answerable": True,
                        "call_id": str(body.get("call_id") or "call-1"),
                        "questions": questions}
            else:
                mark = {"kind": "question", "answerable": True, "call_id": "call-1",
                        "qid": "q-1", "question": str(body.get("question") or "继续吗？"),
                        "options": [{"id": "o1", "label": "通过"},
                                    {"id": "o2", "label": "拒绝"}],
                        "multi_select": False, "allow_other": True}
            with sess.lock:
                sess.interaction = mark
            drv.publish_state("driver/interaction", sess.sid,
                              {"state": "asked", "interaction": mark})
            drv.note({"call": "/_ctl/ask", "sid": sess.sid, "kind": kind})
            return self._json(200, {"ok": True, "interaction": mark})
        if path == "/_ctl/end_interaction":
            sess = self._session_of(body)
            if sess is None:
                return self._json(404, {"error": "session not found"})
            with sess.lock:
                sess.interaction = None
            sess.await_answer.set()      # 放行 `_run_turn` 的挂起等待（继续计轮时长）
            drv.publish_state("driver/interaction", sess.sid,
                              {"state": "resolved", "interaction": None})
            return self._json(200, {"ok": True})
        if path == "/_ctl/archive":
            # 模拟「用户在 dsh GUI 里归档/取消归档」：不要求会话在驱动池里
            # （宿主按会话持久化判定存在性），只改归档集并推帧。
            sid = str(body.get("session_id") or "")
            if not sid:
                return self._json(400, {"error": "session_id required"})
            want = body.get("archived") is not False
            changed = drv.set_archived(sid, bool(want))
            return self._json(200, {"ok": True, "session_id": sid,
                                    "archived": bool(want), "changed": changed})
        return self._json(404, {"error": "unknown ctl"})

    # ---------- SSE ----------

    def _events(self, q):
        """`?session_id=`（会话流）或 `?scope=state`（全局状态流）。"""
        import queue as _q
        drv = self.driver
        since = 0
        try:
            since = int((q.get("since") or ["0"])[0])
        except ValueError:
            since = 0
        scope = (q.get("scope") or [""])[0]
        sid = (q.get("session_id") or [""])[0]
        box = _q.Queue()
        if scope == "state":
            with drv.lock:
                backlog = [f for f in drv.state_ring if f["seq"] > since]
                drv.subs.append(box)
        else:
            sess = drv.sessions.get(sid)
            if sess is None:
                return self._json(404, {"error": "session not found"})
            with sess.lock:
                backlog = [f for f in sess.ring if f["seq"] > since]
                sess.__dict__.setdefault("_subs", []).append(box)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            for frame in backlog:
                self._write_frame(frame)
            while True:
                try:
                    frame = box.get(timeout=KEEPALIVE)
                except _q.Empty:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    continue
                if frame is None:
                    break
                self._write_frame(frame)
        except (BrokenPipeError, ConnectionResetError, OSError, ValueError):
            pass
        finally:
            if scope == "state":
                try:
                    drv.subs.remove(box)
                except ValueError:
                    pass
            else:
                sess = drv.sessions.get(sid)
                if sess is not None:
                    try:
                        sess.__dict__.get("_subs", []).remove(box)
                    except ValueError:
                        pass

    def _write_frame(self, frame):
        body = json.dumps(frame, ensure_ascii=False).encode("utf-8")
        self.wfile.write(b"data: " + body + b"\n\n")
        self.wfile.flush()


def _make_handler(driver):
    """生成绑定到指定 FakeDriver 的 handler 类（避免全局可变状态）。"""
    return type("BoundHandler", (_Handler,), {"driver": driver})
