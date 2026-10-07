#!/usr/bin/env python3
"""dsh 状态事件中枢（路线 A P4：全链路事件化）。

一个 daemon 线程持**单条** SSE 连接订阅插件的全局状态流
（`GET /touchstone-agent/events?scope=state`），把状态帧折进进程内的实时态
注册表，并用条件变量唤醒订阅者（看板调和器、server 的 SSE 广播等）。

**目标（方案 §三）**：静置期对 dsh 的请求数为 0——不再逐卡 `/status`、不再
周期性 `/live`；一切状态来自 `agent/status`（dsh 只在状态**变化**时 emit）、
`turn/start|end`、`session/created|disposed`、`driver/attached|detached`、
`driver/interaction`、`driver/archived` 这些**推**出来的事件。

**不变量（方案 §3.4，写死在这里，改前必读）**：

1. **断连 = 未知**：链路断开时 `connected()` 为 False，`get()` 一律返回 None——
   绝不把「读不到」推断成 `idle`。调用方（看板调和器）按「未知则保持现状」
   处置，避免掉线被误判成「会话已结束」而错误收口占用行。归档集同理：
   `archived(sid)` 断连返回 None，看板不得据此搬列。
2. **重连只做一次对齐**：重连带 `since=<last_seq>` 续传环内帧，补发结束后再做
   **一次** `/live` 快照对齐（补「断连期间的会话创建/销毁」）+ **一次** `/archived`
   归档集对齐（补「断连期间的归档/取消归档」），此后纯事件驱动。
   重连退避 1s→10s 封顶，退避等待本身不产生任何请求。
3. **注册表是缓存不是权威**：权威仍是 dsh 会话本身与平台 DB；这里只服务
   「实时态」读口，丢帧/漂移由下一次对齐兜底。
"""

import threading
import time

import dshdriver

# 重连退避（秒）：首次 1s，翻倍到 10s 封顶；退避等待不发请求
RECONNECT_MIN = 1.0
RECONNECT_MAX = 10.0
# 读空闲上限：插件每 15s 发一次 keepalive 注释帧，这里放宽到 4 倍留出抖动余量
STREAM_IDLE = 60.0


def _merge_permission(live, old):
    """权限折叠（`/live` 对齐用）：preset 以宿主实况为准，mode 以平台记下的为准。

    两者缺一都可能：mode 只有平台切过才有（外部会话无），preset 由插件进程内回读
    （老版本插件或服务缺席时为空）——任一有值就保留一项，都空返回 None（＝未知）。
    """
    row = live if isinstance(live, dict) else {}
    prev = old if isinstance(old, dict) else {}
    preset = str(row.get("preset") or prev.get("preset") or "")
    mode = str(row.get("mode") or prev.get("mode") or "")
    if not preset and not mode:
        return None
    return {"mode": mode, "preset": preset}


class EventHub:
    """dsh 全局状态流的单连接消费器 + 进程内实时态注册表。"""

    def __init__(self):
        self._cond = threading.Condition(threading.Lock())
        self._sessions = {}          # sid -> 实时态 dict（见 _on_frame 的字段）
        # 宿主归档集（看板「已完成」双向同步）：None=未知（断连/未对齐），set=已知整表。
        # 与 `_sessions` 同样遵守「断连=未知」不变量——None 时调用方一律不动作。
        self._archived = None
        self._connected = False
        self._last_seq = 0
        self._frames = 0
        self._reconnects = 0
        self._changed = 0            # 变更计数（测试/诊断用；每次变更 +1）
        self._subscribers = []
        self._thread = None
        self._stop = False

    # ---------- 生命周期 ----------

    def start(self):
        """启动消费线程（幂等）。未配置驱动（独立形态）时不起线程，返回 False。"""
        if not dshdriver.configured():
            return False
        with self._cond:
            if self._thread is not None and self._thread.is_alive():
                return False
            self._stop = False
            self._thread = threading.Thread(target=self._run, name="dsh-events",
                                            daemon=True)
            self._thread.start()
            return True

    def stop(self, timeout=2.0):
        """停订阅线程（退出/测试用）：置标志 + 唤醒等待者，最多等 timeout 秒。"""
        with self._cond:
            self._stop = True
            self._cond.notify_all()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=timeout)
        self._thread = None

    # ---------- 读口（全部无锁外调用、无网络） ----------

    def connected(self):
        """链路是否在线（False ⇒ 所有状态读口返回 None＝未知）。"""
        with self._cond:
            return self._connected

    def get(self, sid):
        """单会话实时态；未连接或未知会话返回 None（＝未知，不是空闲）。

        字段：`session_id/status/cwd/task/owned/origin/interaction/
        last_turn_reason/updated_at`——与 `dshdriver.status()` 同形，供 board 直接
        替换读口。`origin`（2026-10-07 增）：`"subagent"` = dsh 子代理会话，
        `""` = 未知（旧插件未上报，board 侧另有磁盘兜底判据）。
        """
        if not sid:
            return None
        with self._cond:
            if not self._connected:
                return None
            item = self._sessions.get(str(sid))
            return dict(item) if item else None

    def snapshot(self):
        """全部已知会话的实时态快照（未连接时返回 {}）。"""
        with self._cond:
            if not self._connected:
                return {}
            return {sid: dict(item) for sid, item in self._sessions.items()}

    def archived(self, sid):
        """会话是否被宿主归档（看板卡片进/出「已完成」的判定口）。

        返回 True/False；**未知返回 None**（未连接、尚未对齐、sid 为空）——
        调用方按「未知不动作」处置，绝不把读不到当成「未归档」。
        """
        if not sid:
            return None
        with self._cond:
            if self._archived is None:
                return None
            return str(sid) in self._archived

    def archived_set(self):
        """归档集副本（未知返回 None）；整表口径，供批量对账（如「done 卡绑定会话」扫描）。"""
        with self._cond:
            return None if self._archived is None else set(self._archived)

    def stats(self):
        """诊断信息（/api 健康与测试断言用）。"""
        with self._cond:
            return {"connected": self._connected, "sessions": len(self._sessions),
                    "last_seq": self._last_seq, "frames": self._frames,
                    "reconnects": self._reconnects, "changed": self._changed,
                    "archived": None if self._archived is None else len(self._archived),
                    "thread": bool(self._thread and self._thread.is_alive())}

    # ---------- 订阅（推变更；回调在消费线程里跑，必须短小） ----------

    def subscribe(self, callback):
        with self._cond:
            self._subscribers.append(callback)
        return callback

    def unsubscribe(self, callback):
        with self._cond:
            try:
                self._subscribers.remove(callback)
            except ValueError:
                pass

    def wait(self, timeout):
        """等一次变更（返回 True）或超时（False）。

        看板调和器的驱动口：事件到达即醒，超时只作为**对账兜底**（不是轮询
        远端状态——醒后读的是本地注册表）。
        """
        with self._cond:
            before = self._changed
            self._cond.wait(timeout)
            return self._changed != before

    def wait_connected(self, timeout):
        """等（首）次连接就绪：就绪返回 True，超时返回 False。

        启动补跑用（server 在 `dshevents.start()` 之后等它就绪，再对账 ext 行
        ——2026-10-07 僵尸占用修复）：`board.recover()` 执行时中枢尚未 start，
        那次 ext 对账必然「探测不可用」而保行，需要一次连接就绪后的补跑。
        未配置驱动/宿主不可达时至多等满 timeout；绝不把「未连接」当成就绪
        （不变量 1「断连=未知」）。
        """
        deadline = time.monotonic() + max(0.0, float(timeout))
        with self._cond:
            while not self._connected:
                remain = deadline - time.monotonic()
                if remain <= 0:
                    return False
                self._cond.wait(remain)
            return True

    # ---------- 内部：连接与折叠 ----------

    def _run(self):
        backoff = RECONNECT_MIN
        while not self._stop:
            try:
                # 每次（重）连前做一次对齐：既是首连的初始快照，也补断连期间的增删
                self._align()
                self._set_connected(True)
                dshdriver.state_stream(self._on_frame, since=self._last_seq,
                                       stop=lambda: self._stop, idle_timeout=STREAM_IDLE)
                if self._stop:
                    break
                raise dshdriver.DshDriverError(-2, "状态流结束（对端关闭）")
            except Exception:                      # noqa: BLE001 — 一切异常都走重连
                self._set_connected(False)
                if self._stop:
                    break
                time.sleep(backoff)
                backoff = min(backoff * 2, RECONNECT_MAX)
                continue
            finally:
                backoff = RECONNECT_MIN
        self._set_connected(False)

    def _align(self):
        """一次性 `/live` + `/archived` 快照对齐：以插件视角覆盖注册表（权威快照）。

        只在（重）连时调用——静置期不产生任何请求（两条各一次），符合「不得引入
        新的状态轮询」。归档集取不到时保持「未知」（None），调用方一律不动作。
        """
        try:
            rows = (dshdriver.live() or {}).get("sessions") or []
        except Exception:                          # noqa: BLE001 — 对齐失败不阻断重连
            return
        try:
            archived = {str(s) for s in (dshdriver.archived() or []) if s}
        except Exception:                          # noqa: BLE001 — 归档集缺省=未知
            archived = None
        now = time.time()
        with self._cond:
            fresh = {}
            for row in rows:
                sid = str((row or {}).get("session_id") or "")
                if not sid:
                    continue
                old = self._sessions.get(sid) or {}
                fresh[sid] = {
                    "session_id": sid,
                    "status": str(row.get("status") or old.get("status") or ""),
                    "cwd": row.get("cwd") or old.get("cwd") or "",
                    "task": row.get("task") or old.get("task") or "",
                    "owned": bool(row.get("owned", old.get("owned", False))),
                    # origin 是会话固有属性（subagent / 空＝未知）：快照没带就保留
                    # 事件里学到的值，别把已认出的子代理会话在重连对齐时又变成未知
                    "origin": str(row.get("origin") or old.get("origin") or ""),
                    # /live 的 interaction 可能为 None（此刻无等待）；已挂起的
                    # interaction 若快照里没带，保留事件里学到的值，避免抖动
                    "interaction": row.get("interaction", old.get("interaction")),
                    "permission": _merge_permission(row.get("permission"),
                                                    old.get("permission")),
                    "last_turn_reason": row.get("last_turn_reason",
                                                old.get("last_turn_reason")),
                    "last_seq": int(row.get("last_seq")
                                    if row.get("last_seq") is not None
                                    else old.get("last_seq") or 0),
                    "usage": old.get("usage"),
                    "model": old.get("model"),
                    "inbox": old.get("inbox") or [],
                    "updated_at": now,
                }
            self._sessions = fresh
            if archived is not None:
                self._archived = archived
            self._changed += 1
            self._cond.notify_all()

    def _set_connected(self, value):
        with self._cond:
            if self._connected != value:
                self._connected = bool(value)
                if value:
                    self._reconnects += 1
                else:
                    # 断连=未知（不变量 1）：归档集同样作废，绝不让陈旧快照驱动卡片搬列
                    self._archived = None
                self._changed += 1
                self._cond.notify_all()

    def _on_frame(self, frame):
        """折叠一帧状态帧进注册表并唤醒订阅者（跑在消费线程）。"""
        typ = str(frame.get("type") or "")
        sid = str(frame.get("session_id") or "")
        data = frame.get("data") or {}
        seq = frame.get("seq")
        if typ == "driver/archived":
            # 归档集整表快照（无 session_id 的全局帧）：整表覆盖，不做增量合并——
            # 插件侧每次变化都发全量，平台按「最后一次」为准，丢帧由重连对齐兜底。
            # 单独成支：帧不带 sid，折不进下面按会话分发的注册表；订阅者回调照旧
            # 在锁外调用（消费者线程里必须短小，见 subscribe 契约）。
            with self._cond:
                if isinstance(seq, int) and seq > self._last_seq:
                    self._last_seq = seq
                self._frames += 1
                self._archived = {str(s) for s in (data.get("archived") or []) if s}
                self._changed += 1
                self._cond.notify_all()
                subscribers = list(self._subscribers)
            for callback in subscribers:
                try:
                    callback(frame)
                except Exception:                  # noqa: BLE001 — 订阅者异常不影响消费
                    pass
            return
        with self._cond:
            if isinstance(seq, int) and seq > self._last_seq:
                self._last_seq = seq
            self._frames += 1
            if sid:
                item = self._sessions.get(sid)
                if item is None:
                    item = {"session_id": sid, "status": "", "cwd": "", "task": "",
                            "owned": False, "origin": "",
                            "interaction": None,
                            "last_turn_reason": None, "last_seq": 0,
                            "usage": None, "permission": None, "inbox": [],
                            "updated_at": time.time()}
                    self._sessions[sid] = item
                item["updated_at"] = time.time()
                if typ == "agent/status":
                    item["status"] = str(data.get("status") or "")
                elif typ == "turn/start":
                    # 起轮即忙：agent/status 随后到达也会给 running，两者一致
                    item["status"] = "running"
                    if isinstance(data.get("event_seq"), int):
                        item["last_seq"] = data["event_seq"]
                elif typ == "turn/end":
                    item["last_turn_reason"] = data.get("reason")
                    if isinstance(data.get("event_seq"), int):
                        item["last_seq"] = data["event_seq"]
                    # 轮次收口即闲（排队项会再发 turn/start；agent/status 亦会纠正）
                    if item.get("status") == "running":
                        item["status"] = "idle"
                elif typ == "driver/attached":
                    item["owned"] = True
                    item["cwd"] = data.get("cwd") or item["cwd"]
                    item["task"] = data.get("task") or item["task"]
                    if data.get("model"):
                        item["model"] = data["model"]
                elif typ == "driver/model":
                    item["model"] = data
                elif typ == "driver/permission":
                    # 会话级权限（P7b 后补，2026-10-04）：{mode: 平台三档, preset: 宿主实况}。
                    # 会话窗「权限」控件据此从置灰变可交互（此前 meta 无值恒 disabled）。
                    item["permission"] = {"mode": str(data.get("mode") or ""),
                                          "preset": str(data.get("preset") or "")}
                elif typ == "driver/inbox":
                    # 宿主 inbox 快照（P6 #21）：整表覆盖，平台会话窗据此渲染排队行
                    item["inbox"] = list(data.get("items") or [])
                elif typ == "driver/detached":
                    item["owned"] = False
                elif typ == "driver/interaction":
                    if str(data.get("state") or "") == "asked":
                        item["interaction"] = data.get("interaction")
                    else:
                        item["interaction"] = None
                elif typ == "usage":
                    # 上下文用量（P6）：assistant/message 的 TokenUsage 累积；
                    # dsh 没有窗口上限，故只有 used（前端按「无 max 不画环」消费）
                    item["usage"] = {"input": int(data.get("input") or 0),
                                     "output": int(data.get("output") or 0),
                                     "total": int(data.get("total") or 0),
                                     "cache_read": int(data.get("cache_read") or 0)}
                elif typ == "session/created":
                    item["cwd"] = data.get("cwd") or item["cwd"]
                    # 子代理会话标记（2026-10-07）：插件在 `session/created` 里上报
                    # 会话头行的 origin。缺字段保持旧值/空串＝未知，绝不推断。
                    item["origin"] = str(data.get("origin") or item.get("origin") or "")
                elif typ == "session/disposed":
                    self._sessions.pop(sid, None)
            self._changed += 1
            self._cond.notify_all()
            subscribers = list(self._subscribers)
        for callback in subscribers:
            try:
                callback(frame)
            except Exception:                      # noqa: BLE001 — 订阅者异常不影响消费
                pass


# 模块级单例：进程内唯一订阅（server.py 启动时 start()，退出时 stop()）
HUB = EventHub()


def start():
    """启动全局中枢（幂等；独立形态下不启线程）。"""
    return HUB.start()


def stop(timeout=2.0):
    return HUB.stop(timeout=timeout)


def connected():
    return HUB.connected()


def get(sid):
    return HUB.get(sid)


def session_effort(sid):
    """会话当前**思考等级**（宿主 reasoningEffort，取不到返回 ''）。

    数据源＝注册表里 `model` 项（`driver/model` / `driver/attached` 帧折入，
    2026-10-04 起插件把 reasoningEffort 一并放进该字典）。用途：
      1. 会话窗「思考等级」控件回显（server 会话 meta 的 sessionEffort）；
      2. 起会话/续轮时决定默认值——会话已有等级则保持（用户在会话窗里改过的
         选择跨轮存活），没有才回落项目默认（board._start_web / runner）。
    读不到（未连接/未见过该会话）返回 ''，调用方按「未知」处理，不猜。
    """
    st = get(sid) or {}
    model = st.get("model") or {}
    return str(model.get("reasoningEffort") or "")


def session_permission_mode(sid):
    """会话当前**权限档**（平台三档 manual/yolo/auto，取不到返回 ''）。

    取值优先级与 server._session_permission_mode 同源：平台切过的 `mode` 优先
    （宿主 preset 到三档是多对一，只有 mode 能区分 yolo/auto）；没有 mode 时按宿主
    preset 反查近似档位（外部直跑后接管的会话）。两者皆无返回 ''。
    """
    st = get(sid) or {}
    perm = st.get("permission") or {}
    mode = str(perm.get("mode") or "")
    if mode:
        return mode
    return dshdriver.PRESET_MODES.get(str(perm.get("preset") or ""), "")


def snapshot():
    return HUB.snapshot()


def archived(sid):
    """会话是否被宿主归档（True/False；未知=None）。见 `EventHub.archived`。"""
    return HUB.archived(sid)


def archived_set():
    """归档集副本（未知=None）。见 `EventHub.archived_set`。"""
    return HUB.archived_set()


def stats():
    return HUB.stats()


def wait(timeout):
    return HUB.wait(timeout)


def wait_connected(timeout):
    """等中枢（首）次连接就绪（单例薄壳）：就绪 True / 超时 False。"""
    return HUB.wait_connected(timeout)


def subscribe(callback):
    return HUB.subscribe(callback)


def unsubscribe(callback):
    return HUB.unsubscribe(callback)
