# 外部会话（sync 卡）投递通道单测（C 批 T5，2026-10-10）：
#   ① 看管声明 `board._ensure_watch`/`dshdriver.watch_session`（幂等，只 POST 一次；
#      中枢重连边沿清空记账 ⇒ 重新声明）；
#   ② 投递前置闸 `chat._external_preflight`——外部会话在**入队前**判定
#      「宿主有活 agent ∧ 看管声明成功」，不满足即抛 `chat.DeliveryRefused`
#      （消息**不落 chat_msgs/wait_items 行**：把「必然失败的静默排队」变成
#      「发送即明确文案」，见设计 §5.2）；
#   ③ `_iw_once` 逐卡挂钩：对 owned=false 的**有卡**会话声明看管；
#   ④ `_watch_prune`：无卡引用**且**无在途消息才撤（在途 m: 行是前置闸放行后
#      的看管依据，撤了送达必 404）；
#   ⑤ 回滚阀 `TS_EXTERNAL_DELIVER=0` ⇒ 外部会话一律拒投。
#   ⑥（T6，2026-10-10）投递基线回落 `dshevents` + 事件流等轮次
#      `chat.dsh_wait_turn_via_events`/分流口 `chat.wait_turn`。
#   ⑨（终审 I1，2026-10-10）steer 注入「已在跑的 turn」按已在跑播种 `started`
#      （两个条件缺一不可），以及 followup 安全阀（旧 turn/end 不得当本轮结束）。
#   ⑩（终审 I2，2026-10-10）卡片评论**推送腿**（`board._deliver_now`）送达前补声明看管。
#   ⑪（终审 I3，2026-10-10）`board._watch_prune` 扫卡节流（代次检查不节流）。
#
# 姿势沿用 tests/test_session_visibility.py：**真客户端 dshdriver 打真 HTTP 替身**
# （tests/fakedriver.py 的外部会话/看管面），全程零真实网络、零 LLM、零子进程。
# 不变量（本文件是它的守卫）：owned=true（平台自持）、注册表未对齐/未知三种情况
# **一律放行且不发 `/watch`**——未看管路径行为一个字节不变。
import json
import os
import sys
import tempfile
import threading
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

import board
import chat
import db
import dshevents
import dshdriver
import runner
import waitq
from fakedriver import FakeDriver


@pytest.fixture(autouse=True)
def _clean_queue_and_watch():
    """每例前后清等待项/消息表 + 看管集合 + 看管代次/扫卡节流 + 投递前预订阅（都是进程内/表级共享态，跨例会串味）。"""
    def _clean():
        with db.connect() as conn:
            for t in ("wait_items", "chat_msgs"):
                conn.execute(f"DELETE FROM {t}")
        board._WATCHED.clear()
        board._WATCH_GEN = None      # 代次指针同样复位：否则用例结果依赖执行顺序
        board._WATCH_PRUNE_AT = 0.0  # 扫卡节流窗口（I3）同样复位：视作「本拍该扫」
        # 投递前预订阅旁表（缺陷 A）：出表 + 真退订（订阅回调常驻中枢列表，泄漏会串味）
        with chat._DSH_SUB_LOCK:
            subs = list(chat._DSH_SUB.values())
            chat._DSH_SUB.clear()
        for sub in subs:
            sub.close()
    _clean()
    yield
    _clean()


# ---------- 测试本地辅助（T6/T7 复用；名称见 SDD 预检表） ----------

def _real_driver(monkeypatch, mark=""):
    """真客户端 dshdriver → 真 HTTP 替身（先例：tests/test_session_visibility.py）。

    `mark` 给定时替身把每次驱动调用记进该文件（`CALL {json}` 行），供 `_calls` 读回。
    """
    drv = FakeDriver(mark=mark).start()
    monkeypatch.setenv("TS_AGENT_DRIVER_URL", drv.url)
    monkeypatch.setenv("TS_AGENT_DRIVER_TOKEN", drv.token)
    return drv


def _hub(monkeypatch, rows, aligned=True):
    """进程内注册表：按 rows 建 `{sid: {owned,status,interaction,last_seq}}` 并置可信。

    `aligned=False` 模拟「快照不可信」（热重载后 /live 空表）——此时 get() 仍能
    返回行，但 `aligned()` 为假，前置闸必须放行（未知 ≠ 外部）。
    """
    h = dshevents.EventHub()
    h._set_connected(True)
    for sid, row in rows.items():
        h._sessions[sid] = {"session_id": sid, "status": "", "cwd": "", "task": "",
                            "owned": False, "origin": "", "interaction": None,
                            "last_turn_reason": None, "last_seq": 0, "usage": None,
                            "permission": None, "inbox": [], "updated_at": 0, **row}
    h._set_aligned(bool(aligned))
    monkeypatch.setattr(dshevents, "HUB", h)
    return h


def _proj():
    """建一个项目行并返回（submit 的真投递要读项目行 + 写对话日志，故不能凭空造）。"""
    uid = uuid.uuid4().hex[:8]
    root = tempfile.mkdtemp(prefix=f"ts-ext-{uid}-")
    pid = db.insert_project(0, f"ext-{uid}", root, "dsh-plugin:/usr/bin/dsh",
                            os.path.join(root, "work"))
    return db.get_project(pid)


def _make_sync_card(proj, sid, column="doing"):
    """建一张绑定外部会话的卡（origin='sync' = 「你在 dsh 里直跑」的看板卡）。

    落 `doing` 列：调和器对 todo/done 卡直接跳过（不探测），挂钩也就不会跑。
    """
    cid = db.insert_board_card(proj["id"], "外部会话卡")
    db.update_board_card(cid, column_key=column, session_id=sid, origin="sync",
                         sessions=json.dumps([sid]))
    return cid


def _calls(drv):
    """把替身记号文件读回成载荷列表（`CALL {json}` 行；先例 serverfixture.call_mark）。"""
    if not drv.mark or not os.path.exists(drv.mark):
        return []
    out = []
    with open(drv.mark, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line.startswith("CALL "):
                try:
                    out.append(json.loads(line[5:]))
                except ValueError:
                    continue
    return out


class _FakeRunner:
    """假 runner 单例：submit 走「有统一队列」分支（只登记不投递）。

    前置闸放行类用例要断言「正常入队」，用它可以不真投递（真投递要跑 SSE 等轮次）。
    """

    def __init__(self):
        self.submitted = []

    def unit_busy(self, project_id):
        return False

    def submit_msg(self, msg_id, project_id, sid=""):
        self.submitted.append((msg_id, project_id, sid))

    def remove_msg(self, msg_id):
        pass


# ---------- ① 看管声明（dshdriver.watch_session + board._ensure_watch） ----------

def test_watch_declared_once(monkeypatch):
    """看管声明幂等：同一 sid 只 POST 一次。"""
    drv = _real_driver(monkeypatch)
    try:
        drv.ctl("/_ctl/external", {"sid": "session-ext-a", "cwd": "/tmp/ext"})
        board._WATCHED.clear()
        assert board._ensure_watch("session-ext-a") is True
        assert board._ensure_watch("session-ext-a") is True
        assert drv.stats().get("/watch") == 1 and "session-ext-a" in drv.watched
    finally:
        drv.stop()


def test_ensure_watch_redeclares_after_hub_reconnect(monkeypatch):
    """中枢重连边沿 ⇒ 清空 `_WATCHED` ⇒ 下一次 `_ensure_watch` 真的重新 POST /watch。

    现场（bug_report/20261008_1935 的宿主侧重载）：驱动侧 `watched` 是插件进程内的
    易失状态（`dispose()` / 插件重新 apply 即清空），重连后宿主还会把已有会话重新
    上报成 `owned:false`；平台缓存若不清就一直命中「已声明过」不再 POST，投递撞驱动
    404 落 error，且卡还在时 prune 不撤 ⇒ 不自愈到平台重启。设计 §5.1 要求以中枢
    重连边沿为失效信号（`dshevents.stats()["reconnects"]`，本地零请求读口）。
    """
    drv = _real_driver(monkeypatch)
    try:
        drv.ctl("/_ctl/external", {"sid": "session-ext-j", "cwd": "/tmp/ext"})
        hub = _hub(monkeypatch, {"session-ext-j": {"owned": False, "status": "idle"}})
        board._WATCHED.clear()
        assert board._ensure_watch("session-ext-j") is True
        assert drv.stats().get("/watch") == 1
        with drv.lock:                                  # 插件重载：驱动侧看管表清空
            drv.watched.discard("session-ext-j")
        hub._set_connected(False)                       # 中枢断连…
        hub._set_connected(True)                        # …再连上 = 一次重连边沿
        assert board._ensure_watch("session-ext-j") is True
        assert drv.stats().get("/watch") == 2           # 缓存失效 ⇒ 真的重新 POST
        assert "session-ext-j" in drv.watched           # 驱动侧重声明成功（不再 404）
    finally:
        drv.stop()


# ---------- ② 投递前置闸（chat._external_preflight） ----------

def test_preflight_refuses_external_without_live_agent(monkeypatch):
    """owned=false 且宿主无活 agent ⇒ 不入队、抛 DeliveryRefused（发送即报错）。"""
    drv = _real_driver(monkeypatch)
    try:
        drv.ctl("/_ctl/external", {"sid": "session-ext-b", "cwd": "/tmp/ext",
                                   "status": "unknown"})
        _hub(monkeypatch, {"session-ext-b": {"owned": False, "status": "unknown"}})
        board._WATCHED.clear()
        with pytest.raises(chat.DeliveryRefused) as e:
            chat.submit(1, "session-ext-b", "hi")
        assert "会话已结束" in str(e.value)
        assert waitq.msg_rows(sid="session-ext-b") == []        # 没有落行
    finally:
        drv.stop()


def test_preflight_allows_watched_live_external(monkeypatch, tmp_path):
    """owned=false 但宿主有活 agent 且看管成功 ⇒ 放行（真投到替身的 external 会话）。"""
    # 外部会话按会话流仍 404（T6 才换事件流等待器）：把等轮次总时限压到 1s，
    # 用例不必依赖「链路失败即刻收口」这一个实现细节。
    monkeypatch.setenv("TS_DSH_WAIT_TURN_TIMEOUT", "1")
    drv = _real_driver(monkeypatch, mark=str(tmp_path / "calls.log"))
    try:
        drv.ctl("/_ctl/external", {"sid": "session-ext-c", "cwd": "/tmp/ext"})
        proj = _proj()
        _make_sync_card(proj, "session-ext-c")
        _hub(monkeypatch, {"session-ext-c": {"owned": False, "status": "idle"}})
        board._WATCHED.clear()
        rec = chat.submit(proj["id"], "session-ext-c", "hi", family="dsh_plugin")
        assert rec["id"]                                   # 返回消息 id（已入队并投递）
        assert "session-ext-c" in drv.watched              # 前置闸真声明了看管
        prompts = [c for c in _calls(drv) if c.get("call") == "/prompt"]
        assert prompts and prompts[-1].get("external") is True
        assert prompts[-1].get("prompt") == "hi"
    finally:
        drv.stop()


def test_preflight_refuses_when_watch_declaration_fails(monkeypatch):
    """宿主有活 agent 但看管声明失败（旧插件没有 /watch 端点）⇒ 拒投并给分类文案。"""
    drv = _real_driver(monkeypatch)
    try:
        drv.ctl("/_ctl/external", {"sid": "session-ext-d", "cwd": "/tmp/ext"})
        drv.watch_fail = "unknown endpoint"          # 模拟旧插件：/watch 404
        _hub(monkeypatch, {"session-ext-d": {"owned": False, "status": "idle"}})
        board._WATCHED.clear()
        with pytest.raises(chat.DeliveryRefused) as e:
            chat.submit(1, "session-ext-d", "hi")
        assert "未获投递许可" in str(e.value)
        assert waitq.msg_rows(sid="session-ext-d") == []        # 没有落行
        assert "session-ext-d" not in board._WATCHED            # 失败不进缓存（不重试）
    finally:
        drv.stop()


def test_preflight_skips_platform_owned_and_unaligned(monkeypatch):
    """owned=true 或注册表未对齐 ⇒ 放行且不声明看管（现状不变）。"""
    drv = _real_driver(monkeypatch)
    try:
        # ① 平台自持会话（owned=true）：放行走池内原路，绝不发 /watch
        _hub(monkeypatch, {"session-owned": {"owned": True, "status": "idle"}})
        board._WATCHED.clear()
        fake = _FakeRunner()
        monkeypatch.setattr(chat.runner, "INSTANCE", fake)
        rec = chat.submit(9, "session-owned", "hi")
        assert rec["id"] and len(fake.submitted) == 1        # 正常入队
        assert len(waitq.msg_rows(sid="session-owned")) == 1
        # ② 注册表未对齐（快照不可信）：外部行照旧放行——未知 ≠ 外部，不据它拒投
        _hub(monkeypatch, {"session-untrusted": {"owned": False, "status": "unknown"}},
             aligned=False)
        board._WATCHED.clear()
        fake2 = _FakeRunner()
        monkeypatch.setattr(chat.runner, "INSTANCE", fake2)
        rec2 = chat.submit(9, "session-untrusted", "hi")
        assert rec2["id"] and len(fake2.submitted) == 1
        assert drv.stats().get("/watch") is None
    finally:
        drv.stop()


def test_preflight_refuses_when_delivery_disabled(monkeypatch):
    """回滚阀 TS_EXTERNAL_DELIVER=0：外部会话一律拒投（连看管都不声明）。"""
    drv = _real_driver(monkeypatch)
    try:
        drv.ctl("/_ctl/external", {"sid": "session-ext-e", "cwd": "/tmp/ext"})
        _hub(monkeypatch, {"session-ext-e": {"owned": False, "status": "idle"}})
        monkeypatch.setenv("TS_EXTERNAL_DELIVER", "0")
        board._WATCHED.clear()
        with pytest.raises(chat.DeliveryRefused) as e:
            chat.submit(1, "session-ext-e", "hi")
        assert "已关闭外部会话投递" in str(e.value)
        assert drv.stats().get("/watch") is None
        assert waitq.msg_rows(sid="session-ext-e") == []
    finally:
        drv.stop()


# ---------- ③ 调和器挂钩（_iw_once 逐卡循环内声明看管） ----------

def test_iw_once_declares_watch_for_external_card(monkeypatch):
    """owned=false 的**有卡**会话：调和器扫描即声明看管（覆盖「卡刚建」的窗口）。"""
    drv = _real_driver(monkeypatch)
    try:
        drv.ctl("/_ctl/external", {"sid": "session-ext-f", "cwd": "/tmp/ext"})
        proj = _proj()
        _make_sync_card(proj, "session-ext-f")
        _hub(monkeypatch, {"session-ext-f": {"owned": False, "status": "idle"}})
        board._WATCHED.clear()
        monkeypatch.setattr(board.db, "list_projects_all", lambda: [proj])
        monkeypatch.setattr(board, "_iw_interaction",
                            lambda *a, **k: {"pending": False, "busy": False})
        monkeypatch.setattr(board.dshevents, "archived", lambda sid: None)
        board._iw_once()
        assert drv.stats().get("/watch") == 1
        assert "session-ext-f" in drv.watched
    finally:
        drv.stop()


# ---------- ④ 看管回收（_watch_prune：无卡引用**且**无在途消息才撤销） ----------

def test_watch_prune_revokes_unreferenced_and_keeps_referenced(monkeypatch):
    """卡删除后撤销看管；仍被卡引用的看管保留（看管集合不无界增长）。"""
    drv = _real_driver(monkeypatch)
    try:
        drv.ctl("/_ctl/external", {"sid": "session-ext-g", "cwd": "/tmp/ext"})
        drv.ctl("/_ctl/external", {"sid": "session-ext-h", "cwd": "/tmp/ext"})
        proj = _proj()
        _make_sync_card(proj, "session-ext-g")
        _hub(monkeypatch, {"session-ext-g": {"owned": False, "status": "idle"},
                           "session-ext-h": {"owned": False, "status": "idle"}})
        board._WATCHED.clear()
        assert board._ensure_watch("session-ext-g") is True
        assert board._ensure_watch("session-ext-h") is True
        monkeypatch.setattr(board.db, "list_projects_all", lambda: [proj])
        assert board._watch_prune() == 1                    # 只撤 h（g 仍有卡引用）
        assert "session-ext-h" not in drv.watched
        assert "session-ext-g" in drv.watched
    finally:
        drv.stop()


def test_watch_prune_keeps_sid_with_inflight_message(monkeypatch):
    """无卡外部 sid 仍有活跃 `m:` 行 ⇒ prune **不撤**；行收口后才撤。

    前置闸会为**无卡**外部会话声明看管（飞书绑定会话、任务会话重载后变外部态等
    `card_id/task_id` 皆空的 submit 路径）。此时「无卡引用」≠「无人需要看管」：
    已被放行、尚在 `m:` 行里排队的消息一旦被撤看管，送达时 `/prompt` 404 就是
    T5 要消灭的「放行后静默失败」。判据第二条 = 该 sid 无在途消息（活跃 m: 行）。
    """
    drv = _real_driver(monkeypatch)
    try:
        drv.ctl("/_ctl/external", {"sid": "session-ext-k", "cwd": "/tmp/ext"})
        proj = _proj()
        _hub(monkeypatch, {"session-ext-k": {"owned": False, "status": "idle"}})
        fake = _FakeRunner()
        monkeypatch.setattr(chat.runner, "INSTANCE", fake)
        board._WATCHED.clear()
        rec = chat.submit(proj["id"], "session-ext-k", "hi", family="dsh_plugin")
        assert rec["id"] and len(fake.submitted) == 1
        assert "session-ext-k" in board._WATCHED and "session-ext-k" in drv.watched
        monkeypatch.setattr(board.db, "list_projects_all", lambda: [proj])   # 无卡引用
        assert board._watch_prune() == 0                    # 有在途 m: 行 ⇒ 不撤
        assert "session-ext-k" in drv.watched               # 驱动侧仍看管
        # 行收口（queued→running→done：本会话不再有在途消息）⇒ 判据转为「可撤」
        assert waitq.msg_claim(rec["id"]) is True
        assert waitq.msg_finish(rec["id"], chat.STATE_DONE) is True
        board._WATCH_PRUNE_AT = 0.0            # 窗口过去（I3 节流：等价下一兜底拍到来）
        assert board._watch_prune() == 1
        assert "session-ext-k" not in drv.watched
    finally:
        drv.stop()


def test_watch_prune_redeclares_on_concurrent_declaration(monkeypatch):
    """撤销窗口内并发落下的重新声明 ⇒ prune 补偿重声明（不留「驱动无、缓存有」）。

    TOCTOU 面：prune 的快照之后、`on:false` 之前，前置闸可能刚为同一 sid 重新
    声明（入 `_WATCHED` 并 POST `on:true`）。按陈旧快照撤会把这次新声明连同驱动侧
    `watched` 一起抹掉，而在途消息送达时并无第二次前置闸可依赖。故撤销动作必须
    在锁内复核，并在撤销后复核补偿。
    """
    drv = _real_driver(monkeypatch)
    try:
        drv.ctl("/_ctl/external", {"sid": "session-ext-l", "cwd": "/tmp/ext"})
        _hub(monkeypatch, {"session-ext-l": {"owned": False, "status": "idle"}})
        board._WATCHED.clear()
        assert board._ensure_watch("session-ext-l") is True
        calls = []
        real_watch = dshdriver.watch_session

        def _watch_and_redeclare(sid, on=True):
            """撤销调用进行中模拟并发声明：把 sid 放回平台缓存。"""
            calls.append(bool(on))
            if not on:
                board._WATCHED.add(sid)
            return real_watch(sid, on=on)

        monkeypatch.setattr(dshdriver, "watch_session", _watch_and_redeclare)
        monkeypatch.setattr(board.db, "list_projects_all", lambda: [])
        assert board._watch_prune() == 0                    # 补偿重声明：不计撤销
        assert calls == [False, True]                       # on:false 后补 on:true
        assert "session-ext-l" in board._WATCHED
        assert "session-ext-l" in drv.watched
    finally:
        drv.stop()


# ---------- ⑥ 事件流等轮次（T6：外部会话没有按会话 SSE 通道） ----------
#
# 为什么不能用按会话 SSE（`/events?session_id=`）：外部会话不在驱动池中，该端点
# 与 `/status` 同属**池内门禁**（真驱动 404、替身同）。所以外部会话的「等一轮
# 结束」只能订阅**全局状态流**（`dshevents`：插件对该会话同样发
# `turn/start`/`turn/end`/`driver/interaction`，且平台侧零请求）。
#
# 本段是三条不变量的守卫：
#   ① 零远端轮询——等轮次只读中枢已折好的帧（本地）；
#   ② 断连 = 未知——链路断开时按超时口径收口并留痕，**绝不判「正常结束」**，
#      也绝不把项目运行位钉死；
#   ③ owned=true（平台自持）/注册表未知 ⇒ 走既有按会话 SSE 路，一个字节不变。

EXT_SID = "session-ext-turn"


def _capture_subscribe(monkeypatch, frames):
    """把中枢订阅换成手工喂帧口（不启消费线程、不打网络）；返回 unsubscribe 记录表。"""
    unsub = []
    monkeypatch.setattr(chat.dshevents, "subscribe",
                        lambda cb: frames.setdefault("cb", cb))
    monkeypatch.setattr(chat.dshevents, "unsubscribe", lambda cb: unsub.append(cb))
    return unsub


def _feed_after(frames, delay, *payloads):
    """后台线程延时喂帧（先等订阅就绪，再按序投喂）；返回线程供 join。

    不用固定长睡（brief 口径 0.05s；测试总时长可控）：等 `subscribe` 捕获到回调
    才投喂，避免与主线程的订阅动作赛跑。
    """
    def _run():
        time.sleep(delay)
        for _ in range(200):                    # 等订阅就绪（上限 2s，正常即刻）
            if "cb" in frames:
                break
            time.sleep(0.01)
        cb = frames.get("cb")
        if cb is None:
            return
        for payload in payloads:
            cb(payload)

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return t


def _feed_timeline(frames, *steps):
    """按序延时喂帧：`steps` = (延时秒, 标签, 帧载荷)；返回 (线程, {标签: 投喂时刻})。

    与 `_feed_after` 的差别：**同一线程内按序投喂**（帧间相对顺序确定），并给每帧记
    本地投喂时刻——「收口发生在哪一帧之后」这类断言需要它（I1 安全阀用例把「旧
    turn/end 未被认成本轮结束」钉在「返回时刻 ≥ 本轮 turn/start 时刻」上）。
    """
    marks = {}

    def _run():
        for delay, label, payload in steps:
            time.sleep(delay)
            for _ in range(200):                # 等订阅就绪（上限 2s，正常即刻）
                if "cb" in frames:
                    break
                time.sleep(0.01)
            cb = frames.get("cb")
            if cb is None:
                return
            marks[label] = time.time()
            cb(payload)

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return t, marks


def test_wait_turn_via_events_ends_on_turn_end(monkeypatch):
    """turn/start(seq>since) 之后收到 turn/end ⇒ 返回 None（本轮结束）。"""
    _hub(monkeypatch, {EXT_SID: {"owned": False}})
    frames = {}
    unsub = _capture_subscribe(monkeypatch, frames)
    t = _feed_after(frames, 0.05,
                    {"type": "turn/start", "session_id": EXT_SID,
                     "data": {"event_seq": 11}},
                    {"type": "turn/end", "session_id": EXT_SID,
                     "data": {"reason": {"kind": "completed"}, "event_seq": 20}})
    assert chat.dsh_wait_turn_via_events(EXT_SID, 10,
                                        yield_on_interaction=False) is None
    t.join(timeout=5)
    assert unsub and unsub[0] is frames["cb"]   # finally 真的退订（不泄漏订阅者）


def test_wait_turn_via_events_yields_on_interaction(monkeypatch):
    """挂起作答帧 ⇒ STATE_YIELDED（让位，不占运行位）。"""
    _hub(monkeypatch, {EXT_SID: {"owned": False}})
    frames = {}
    unsub = _capture_subscribe(monkeypatch, frames)
    t = _feed_after(frames, 0.05,
                    {"type": "turn/start", "session_id": EXT_SID,
                     "data": {"event_seq": 11}},
                    {"type": "driver/interaction", "session_id": EXT_SID,
                     "data": {"state": "asked",
                              "interaction": {"call_id": "c1"}}})
    assert chat.dsh_wait_turn_via_events(EXT_SID, 10) == chat.STATE_YIELDED
    t.join(timeout=5)
    assert unsub and unsub[0] is frames["cb"]


def test_wait_turn_via_events_keeps_waiting_when_not_yielding(monkeypatch):
    """yield_on_interaction=False：挂起帧不换结论，仍以 turn/end 收口。"""
    _hub(monkeypatch, {EXT_SID: {"owned": False}})
    frames = {}
    _capture_subscribe(monkeypatch, frames)
    t = _feed_after(frames, 0.05,
                    {"type": "driver/interaction", "session_id": EXT_SID,
                     "data": {"state": "asked"}},
                    {"type": "turn/start", "session_id": EXT_SID,
                     "data": {"event_seq": 11}},
                    {"type": "turn/end", "session_id": EXT_SID,
                     "data": {"event_seq": 20}})
    assert chat.dsh_wait_turn_via_events(EXT_SID, 10,
                                        yield_on_interaction=False) is None
    t.join(timeout=5)


def test_wait_turn_via_events_disconnect_not_success(monkeypatch, tmp_path):
    """断连（connected=False）⇒ 超时口径收口 + 日志留痕，绝不判「正常结束」。

    断连 = 未知（dshevents 不变量 1）：既不能推断「会话空闲」，更不能把「读不到
    turn/end」当成本轮正常结束——只能按超时口径收口并把原因写进会话日志。
    """
    hub = _hub(monkeypatch, {EXT_SID: {"owned": False}})
    log_path = tmp_path / "chat_dsh_ext.log"
    frames = {}
    _capture_subscribe(monkeypatch, frames)
    hub._set_connected(False)                   # 链路断开（get() 从此返回 None）
    t0 = time.time()
    assert chat.dsh_wait_turn_via_events(EXT_SID, 10, log_path=str(log_path)) is None
    assert time.time() - t0 < 5.0               # 断连即收口，不等满总时限
    text = log_path.read_text(encoding="utf-8")
    assert "### 会话等待 turn 结束超时" in text
    assert "无 turn/end" in text


def test_wait_turn_via_events_unstarted_grace_closes(monkeypatch, tmp_path):
    """turn 压根没起来（无任何帧）：TURN_START_GRACE 到点收口，不占项目位。

    外部会话投递后宿主可能根本没起轮（消息被 inbox 吞掉/会话刚结束）：此时不能
    把 `m:` 行永远钉在执行态，宽限期到点按「本轮结束」返回（不写超时行——
    这与「总时限兜底」不是同一类收口，legacy `dsh_wait_turn` 同口径）。
    """
    _hub(monkeypatch, {EXT_SID: {"owned": False}})
    frames = {}
    _capture_subscribe(monkeypatch, frames)
    monkeypatch.setattr(chat, "TURN_START_GRACE", 0.3)
    log_path = tmp_path / "chat_dsh_ext_grace.log"
    t0 = time.time()
    assert chat.dsh_wait_turn_via_events(EXT_SID, 10, log_path=str(log_path)) is None
    assert time.time() - t0 < 5.0


def test_dsh_send_baseline_falls_back_to_events(monkeypatch):
    """驱动 /status 拿不到 last_seq（外部会话 404）⇒ 基线取 dshevents 的 last_seq。

    替身按 T5 口径对外部会话 `/status` 回 404（真驱动 `_externalTarget` 干跑后
    回 200 但**响应里没有 last_seq**，见下一条用例）：两条路都必须回落到中枢
    注册表的 `last_seq`（本地零请求读口），否则 `since` 恒 0，等轮次会被更早的
    历史帧误判。
    """
    drv = _real_driver(monkeypatch)
    try:
        drv.ctl("/_ctl/external", {"sid": EXT_SID, "cwd": "/tmp/ext"})
        _hub(monkeypatch, {EXT_SID: {"owned": False, "last_seq": 7}})
        board._WATCHED.clear()
        assert board._ensure_watch(EXT_SID) is True      # 外部会话投递许可（T5 闸）
        assert chat.dsh_send(EXT_SID, "hi") == 7
        assert chat._DSH_BASELINE[EXT_SID] == 7
    finally:
        chat._DSH_BASELINE.pop(EXT_SID, None)
        drv.stop()


def test_dsh_send_baseline_falls_back_when_status_has_no_last_seq(monkeypatch):
    """真机形态：/status 回 200 但外部形状不含 last_seq ⇒ 基线仍取 dshevents。

    T2 落地后，watched + 活 agent 的外部会话 `/status` **不再 404**（池外回落
    直投），响应按外部形状给（刻意没有 `last_seq`）。旧写法
    `int(status().get("last_seq") or 0)` 会静默取 0 ⇒ `since` 恒 0、回落分支
    永不触发（首轮评审在 T2 上发现的问题）；判据必须是「拿不到 last_seq 就回落」。
    """
    _hub(monkeypatch, {EXT_SID: {"owned": False, "last_seq": 9}})
    monkeypatch.setattr(chat.dshdriver, "status",
                        lambda sid: {"session_id": sid, "status": "idle",
                                     "owned": False})
    sent = []
    monkeypatch.setattr(chat.dshdriver, "prompt",
                        lambda sid, text: sent.append(text))
    try:
        assert chat.dsh_send(EXT_SID, "hi") == 9
        assert sent == ["hi"]                   # 投递照旧发生（只换基线来源）
        assert chat._DSH_BASELINE[EXT_SID] == 9
    finally:
        chat._DSH_BASELINE.pop(EXT_SID, None)


def test_wait_turn_dispatches_by_owned(monkeypatch):
    """分流口：owned=true / 注册表未知 ⇒ 既有按会话 SSE 路；owned=false ⇒ 事件流路。

    「未知」必须落在既有路（不变式③）：中枢断连或没见过该 sid 时无法判定「外部」，
    若改走事件流路，池内会话在链路降级期会立刻被按超时收口（运行位提前释放）——
    与 T5 前置闸「未知 ≠ 外部」同一判定阶梯。
    """
    calls = []
    monkeypatch.setattr(chat, "wait_web_busy",
                        lambda pdir, sid, fam: calls.append(("legacy", sid)) or "LEGACY")
    monkeypatch.setattr(chat, "dsh_wait_turn_via_events",
                        lambda sid, since=None, log_path="", yield_on_interaction=True:
                        calls.append(("events", sid)) or None)
    _hub(monkeypatch, {EXT_SID: {"owned": True, "status": "running"}})
    assert chat.wait_turn("/tmp/p", EXT_SID, "dsh_plugin") == "LEGACY"
    _hub(monkeypatch, {})                       # 注册表未知该 sid（未连接/没上报过）
    assert chat.wait_turn("/tmp/p", EXT_SID, "dsh_plugin") == "LEGACY"
    _hub(monkeypatch, {EXT_SID: {"owned": False}})
    assert chat.wait_turn("/tmp/p", EXT_SID, "dsh_plugin") is None
    assert calls == [("legacy", EXT_SID), ("legacy", EXT_SID), ("events", EXT_SID)]


# ---------- ⑥b `_dsh_send_now` 也走分流口（Ruling B，T6 收口） ----------
#
# 覆盖面漏项：brief 只点名 `board._deliver_unit`，但「card_id/task_id 皆空」的消息
# 路径（飞书绑定会话、平台重启后变 owned:false 的任务会话）走的是
# `chat._dsh_send_now` → 直接 `dsh_wait_turn`（按会话 SSE）——外部会话在这条路上
# 仍会「池内门禁 404 ⇒ 误判本轮结束」。下面两条钉子把它接到分流口上，并逐字钉住
# `since`（本轮基线）/`log_path`（缺陷 G 原因行落点）的透传（Ruling B 硬约束 1/3）。


def _record_waits(monkeypatch, calls):
    """把两条等待通道都换成记录桩（不订阅、不喂帧、不打网络）；返回记录表。

    记录形状：`("legacy", sid, since, log_path)` = 按会话 SSE 路（`dsh_wait_turn`）；
    `("events", sid, since, log_path)` = 全局状态流路（`dsh_wait_turn_via_events`）。
    """
    monkeypatch.setattr(
        chat, "dsh_wait_turn",
        lambda sid, since=None, yield_on_interaction=True, log_path="":
        calls.append(("legacy", sid, since, log_path)) or chat.STATE_YIELDED)
    monkeypatch.setattr(
        chat, "dsh_wait_turn_via_events",
        lambda sid, since=None, log_path="", yield_on_interaction=True:
        calls.append(("events", sid, since, log_path)) or None)
    return calls


def test_send_now_external_goes_events_with_baseline_and_log(monkeypatch):
    """消息路径（card_id/task_id 皆空）：owned=false ⇒ 走事件流路，since/log_path 原样。

    `_dsh_send_now` 是「飞书绑定会话 / 无卡任务会话」的投递体，原先直接调
    `dsh_wait_turn`（按会话 SSE）；外部会话在那条路上收不到任何帧 ⇒ 误判本轮结束。
    分流后必须与 `board._deliver_unit` 同源：外部会话订阅全局状态流，且本轮基线
    （`since`）与对话日志落点（`log_path`）一个字都不能丢。
    """
    proj = _proj()
    _hub(monkeypatch, {EXT_SID: {"owned": False}})
    monkeypatch.setattr(chat, "dsh_send", lambda sid, message, inject=False: 7)
    calls = _record_waits(monkeypatch, [])
    try:
        assert chat._dsh_send_now(proj, EXT_SID, "你好", False) is None
        assert [c[0] for c in calls] == ["events"]       # 只走事件流路，不碰按会话 SSE
        _, sid, since, log_path = calls[0]
        assert (sid, since) == (EXT_SID, 7)              # 本轮基线原样（不是 None/0）
        assert log_path and os.path.exists(log_path)     # 缺陷 G 的原因行落点原样
        assert os.path.abspath(log_path).startswith(os.path.abspath(proj["work_dir"]))
    finally:
        chat._CHATS.pop(EXT_SID, None)                   # 进程内会话登记表复位（防串味）


def test_send_now_owned_and_unknown_keep_baseline_and_log(monkeypatch):
    """owned=true / 注册表未知 ⇒ 仍走按会话 SSE 路，且 since/log_path 逐字保留。

    Ruling B 硬约束 1：池内/未知路径必须保持 `dsh_wait_turn(sid, since,
    log_path=log_path)` 这一调用形状——`since` 是本轮基线（丢了会被历史帧误判）、
    `log_path` 是缺陷 G 总时限原因行的落点（丢了留痕落错日志）；换成不带这两个
    参数的 `wait_web_busy(...)` 就是净回归，故这里连「没走 wait_web_busy」一并钉住。
    注册表未知（断连 / 没见过该 sid）与 owned=true 同路：未知 ≠ 外部。
    """
    proj = _proj()
    monkeypatch.setattr(chat, "dsh_send", lambda sid, message, inject=False: 11)
    calls = _record_waits(monkeypatch, [])
    monkeypatch.setattr(chat, "wait_web_busy",
                        lambda *a, **kw: calls.append(("busy",) + a))
    try:
        # ① 平台自持会话（owned=true）；② 注册表未知该 sid（断连 / 没见过）
        for label, rows in (("owned", {EXT_SID: {"owned": True, "status": "running"}}),
                            ("unknown", {})):
            _hub(monkeypatch, rows)
            calls.clear()
            assert chat._dsh_send_now(proj, EXT_SID, f"你好-{label}", False) == \
                chat.STATE_YIELDED                        # 返回值照旧透传（让位语义）
            assert [c[0] for c in calls] == ["legacy"], label
            _, sid, since, log_path = calls[0]
            assert (sid, since) == (EXT_SID, 11), label    # 基线原样（不是 None/0）
            assert log_path and os.path.exists(log_path), label
    finally:
        chat._CHATS.pop(EXT_SID, None)


# ---------- ⑨ I1（终审，2026-10-10）：steer 注入「已在跑的 turn」按已在跑播种 started ----------
#
# 根因（终审 I1 原文）：投递进**已在跑的 turn** 时，`since` 取自 `_dsh_baseline_since`
# （外部会话 = 中枢 `last_seq`，其值 ≥ 本 turn `turn/start` 的 `event_seq`），于是
# `seq > since` 的过滤永远滤掉本轮 `turn/start` ⇒ `started` 恒假 ⇒ 本轮 `turn/end`
# 被 `if started else None` 丢弃 ⇒ 只能等满 `TURN_START_GRACE`(60s) 收口。而 `ext:`
# 行只在「busy **且无平台持有者**」时建，平台自己刚投递的 turn 有 `m:` 行持有者 ⇒
# 60s 后 `m:` 落 done、项目运行位释放，外部 turn 仍在跑 ⇒ 下一个排队单元（任务轮 /
# 另一卡会话）与它**并发写同一工作区**，正是「任务按项目串行」红线要防的场景。
#
# 修法（控制器裁定）：投递侧把「本次是 steer 注入」记进模块级旁表 `_DSH_INJECT`
# （与 `_DSH_BASELINE` 同款「投递时记、等待时取走即弃」），等待器**仅当**两个条件
# 同时成立才把 `started` 初值置真：
#   ① 本次投递是 steer 注入；
#   ② 入口本地读一次 `dshevents.get(sid)["status"] == "running"`（零请求）。
# **不采用**「无条件读 status=='running' 当初值」：followup 排在正在跑的**旧** turn
# 之后时，旧 turn 的 `turn/end` 会被误判成本轮结束（T6 修掉的那类误判会复活）——
# 故本段三条用例＝正例一条 + 两个条件各一条反例。

STEER_SID = "session-ext-steer"


def _seed_delivery(monkeypatch, sid, inject, status="running", last_seq=10):
    """造「刚投递过一条消息、正在等本轮」的现场：中枢行 + 投递基线 + inject 旁表。

    三个进程内共享态都按 `dsh_send` 的真实写法落：`_DSH_BASELINE[sid]`（本轮起点）与
    `_DSH_INJECT[sid]`（本次是否 steer）。`status` 是入口本地读到的实况。
    """
    _hub(monkeypatch, {sid: {"owned": False, "status": status,
                             "last_seq": last_seq}})
    chat._DSH_BASELINE[sid] = last_seq
    chat._DSH_INJECT[sid] = inject


def _drop_delivery(sid):
    """清旁表残留（用例 finally 用；防跨例串味）。"""
    chat._DSH_BASELINE.pop(sid, None)
    chat._DSH_INJECT.pop(sid, None)


def test_steer_into_running_turn_closed_by_real_turn_end(monkeypatch, tmp_path):
    """steer 注入进已在跑的 turn：由**真 turn/end 帧**收口，不等满宽限（正例）。

    宽限放大到 6s（远大于观测值）并断言收口 < 2s：只有「真 turn/end 帧收口」能过
    ——宽限收口必 ≥ 6s。同时钉住两张旁表都「取走即弃」（基线语义不变）。
    """
    _seed_delivery(monkeypatch, STEER_SID, inject=True)
    frames = {}
    unsub = _capture_subscribe(monkeypatch, frames)
    monkeypatch.setattr(chat, "TURN_START_GRACE", 6.0)   # 宽限远大于观测值
    log_path = tmp_path / "chat_dsh_steer.log"
    t = _feed_after(frames, 0.05,
                    {"type": "turn/end", "session_id": STEER_SID,
                     "data": {"reason": {"kind": "completed"}, "event_seq": 20}})
    t0 = time.time()
    try:
        assert chat.dsh_wait_turn_via_events(STEER_SID, log_path=str(log_path)) is None
        assert time.time() - t0 < 2.0            # 真 turn/end 收口（宽限 6s 没到）
        assert STEER_SID not in chat._DSH_BASELINE    # 基线取走即弃（语义不变）
        assert STEER_SID not in chat._DSH_INJECT      # 旁表同样取走即弃
        assert not log_path.exists()                  # 非超时收口（不写超时行）
    finally:
        _drop_delivery(STEER_SID)
        t.join(timeout=5)
    assert unsub and unsub[0] is frames["cb"]


def test_steer_seed_requires_running_status(monkeypatch, tmp_path):
    """条件②的必要性：steer 投递但入口实况非 running ⇒ **不播种**（遗留 turn/end 不收口）。

    现场＝steer 起轮前的窗口（上一轮的 turn/end 可能仍在途）：若无条件按
    `status=='running'` 播种（错误修法），这条遗留帧会立刻把本轮判成结束、运行位提前
    释放。宽限压到 0.4s：播种则 ~0.05s 收口、不播种则走宽限 ~0.4s——断言下界把它钉住。
    """
    _seed_delivery(monkeypatch, STEER_SID, inject=True, status="idle")
    frames = {}
    _capture_subscribe(monkeypatch, frames)
    monkeypatch.setattr(chat, "TURN_START_GRACE", 0.4)
    t = _feed_after(frames, 0.05,
                    {"type": "turn/end", "session_id": STEER_SID,
                     "data": {"reason": {"kind": "completed"}, "event_seq": 15}})
    t0 = time.time()
    try:
        assert chat.dsh_wait_turn_via_events(STEER_SID) is None
        assert time.time() - t0 >= 0.3           # 走宽限收口，没认那条遗留 turn/end
    finally:
        _drop_delivery(STEER_SID)
        t.join(timeout=5)


def test_followup_behind_running_turn_ignores_stale_turn_end(monkeypatch):
    """安全阀（反向回归）：followup 排在正在跑的**旧** turn 之后 ⇒ 旧 turn 的
    `turn/end` 不得被当成本轮结束；必须等「turn/start(seq > since) 之后的 turn/end」。

    这条钉住 I1 修法不许写宽（例如无条件读 `status=='running'` 当初值）：此时中枢
    实况确实是 running（旧 turn 在跑），只要播种就会把 0.1s 到达的旧 `turn/end` 认成
    本轮结束。断言「返回时刻 ≥ 本轮 turn/start 投喂时刻」＋「返回时刻 ≥ 本轮
    turn/end 投喂时刻」＋「< 2s（宽限 10s 没到）」三者合起来把正确收口钉死。
    """
    _seed_delivery(monkeypatch, STEER_SID, inject=False)   # followup（非 steer）
    frames = {}
    _capture_subscribe(monkeypatch, frames)
    monkeypatch.setattr(chat, "TURN_START_GRACE", 10.0)    # 宽限远大于观测
    t, marks = _feed_timeline(
        frames,
        (0.10, "old_end", {"type": "turn/end", "session_id": STEER_SID,
                           "data": {"reason": {"kind": "completed"}, "event_seq": 15}}),
        (0.50, "new_start", {"type": "turn/start", "session_id": STEER_SID,
                             "data": {"event_seq": 25}}),
        (0.90, "new_end", {"type": "turn/end", "session_id": STEER_SID,
                           "data": {"reason": {"kind": "completed"}, "event_seq": 30}}),
    )
    t0 = time.time()
    try:
        assert chat.dsh_wait_turn_via_events(STEER_SID) is None
        t_ret = time.time()
        # 先钉「没在本轮 turn/start 之前收口」——否则就是认了旧 turn/end（I1 写宽）
        assert "new_start" in marks, \
            "在本轮 turn/start 之前就收口了（把旧 turn/end 当成本轮结束）"
        assert "new_end" in marks, "在本轮 turn/end 之前就收口了"
        assert t_ret >= marks["new_start"]       # 旧 turn/end（0.1s）没被认成本轮结束
        assert t_ret >= marks["new_end"]         # 由本轮 turn/end 收口（不是宽限 10s）
        assert t_ret - t0 < 2.0
    finally:
        _drop_delivery(STEER_SID)
        t.join(timeout=5)


def test_dsh_send_records_inject_fact(monkeypatch, tmp_path):
    """投递侧登记：`dsh_send` 每次都写 `_DSH_INJECT`（True/False 都写，旧值被覆盖）。

    等待器的播种全靠这张旁表的第一手事实；若投递侧漏记（或只在 `inject=True` 时记），
    steer 场景又退回 60s 宽限收口，且上一次 steer 的残留 True 会毒化下一次 followup
    的等待——两个方向都在本用例里钉住（真投递打替身，记号读回 `/steer`·`/prompt`）。
    """
    drv = _real_driver(monkeypatch, mark=str(tmp_path / "calls.log"))
    try:
        sid = "session-ext-inject-log"
        drv.ctl("/_ctl/external", {"sid": sid, "cwd": "/tmp/ext"})
        _hub(monkeypatch, {sid: {"owned": False, "status": "idle", "last_seq": 10}})
        board._WATCHED.clear()
        assert board._ensure_watch(sid) is True          # 外部会话投递许可（T5 闸）
        assert chat.dsh_send(sid, "立即注入", inject=True) == 10
        assert chat._DSH_INJECT[sid] is True             # steer ⇒ True
        assert [c["call"] for c in _calls(drv)][-1] == "/steer"
        assert chat.dsh_send(sid, "普通发送") == 10
        assert chat._DSH_INJECT[sid] is False            # followup ⇒ False（覆盖旧值）
        assert [c["call"] for c in _calls(drv)][-1] == "/prompt"
    finally:
        _drop_delivery("session-ext-inject-log")
        drv.stop()


# ---------- ⑦ 外部会话提问「可答 + 可送达」（T7：送达前对非池内会话重声明看管） ----------
#
# 洞（T5 评审 × T4 评审叠加出的真实失败类）：`_watch_prune` 的撤销判据是
# 「无卡引用 ∧ 无在途 `m:` 行」——**不含活跃 `a:`（作答）行**；驱动的
# `/watch {on:false}` 也不会主动收口在途认领（要等 abort/disposed/dispose）。
# 两者叠加：作答已排队未送达、或会话正挂起等作答（用户刚点了作答）时，prune 可能
# 已把该 sid 的看管撤掉 ⇒ 送达 `/answer`·`/approval` 撞驱动「未看管」404 ⇒ `a:` 行
# 落 error。故送达路径（`_answer_deliver` 是提问/审批两条路的唯一出口）在真正调驱动
# 前对**非池内**会话补一次幂等声明（命中 `_WATCHED` 缓存时纯本地判断、零请求）；
# 判据用既有读口 `dshevents.get(sid)` 的 `owned`——owned=true（平台自持）与
# 未知（None，断连/没见过）一律不碰，未看管与池内路径行为一个字节不变。

# 替身与注册表共用的「提问挂起」实况（call_id 非空 = dsh 已挂起等作答）
EXT_ANS_MARK = {"kind": "question", "call_id": "c1", "qid": "c1",
                "questions": [{"id": "q_0", "question": "Q?",
                               "options": [{"id": "A", "label": "A"}]}]}
EXT_ANS_PICK = [{"wire": "q_0", "kind": "single", "option_id": "A"}]
# 审批挂起实况（approval_id 取自标记的 id，与 dsh 插件同形）
EXT_APR_MARK = {"kind": "approval", "id": "ap-1", "tool": "bash",
                "answerable": True}


def _ext_pending_interaction(monkeypatch, drv, sid, mark):
    """造「外部会话挂起交互」现场：替身外部会话 + 注册表行 + 有卡 + watcher 缓存。

    mark 是挂起标记（提问 `EXT_ANS_MARK` / 审批 `EXT_APR_MARK`），替身与注册表两侧
    同值（前者管送达兑现，后者管平台实况读口）。卡落 doing 列（`_make_sync_card`
    口径：todo/done 卡被调和器跳过，挂钩不跑）。`runner.INSTANCE` 钉成 None：
    入队/送达里的 `submit_answer`/`card_started` 是统一队列的内存唤醒动作，本段只
    验证「可答 → 入队 → 送达 → 行收口」这条链，不唤起真 runner（否则用例依赖外部
    调度线程的时序）。
    """
    drv.ctl("/_ctl/external", {"sid": sid, "cwd": "/tmp/ext"})
    drv.ctl("/_ctl/external_state", {"sid": sid, "status": "running",
                                     "interaction": mark})
    _hub(monkeypatch, {sid: {"owned": False, "status": "running",
                             "interaction": mark}})
    board._WATCHED.clear()
    monkeypatch.setattr(board.runner, "INSTANCE", None)
    proj = _proj()
    card = db.get_board_card(_make_sync_card(proj, sid))
    board.interaction_probe("dsh_plugin", proj, sid)   # 会话端点/调和器同款读口，填缓存
    return proj, card


def test_external_answerable_and_delivered(monkeypatch, tmp_path):
    """外部会话提问（call_id 非空）⇒ answerable=True ⇒ 作答入队 a: 行 ⇒ 真送达 /answer。"""
    drv = _real_driver(monkeypatch, mark=str(tmp_path / "calls.log"))
    try:
        sid = "session-ext-ans-a"
        proj, card = _ext_pending_interaction(monkeypatch, drv, sid,
                                               EXT_ANS_MARK)
        assert board.interaction_of_sid(sid)["answerable"] is True
        assert board.answer_interaction(proj, card, "c1", EXT_ANS_PICK) is None
        assert waitq.get_active(waitq.KIND_ANSWER, card["id"]) is not None  # 已入队 a: 行
        board._deliver_answer_unit(card["id"])          # 直接驱动执行体（worker 同路）
        ans = [c for c in _calls(drv) if c.get("call") == "/answer"]
        assert ans and ans[-1]["call_id"] == "c1"       # 真打到替身的 /answer
        assert ans[-1]["external"] is True              # 走的是池外分支（已看管）
        assert waitq.get_active(waitq.KIND_ANSWER, card["id"]) is None      # 行收口
    finally:
        drv.stop()


def test_answer_delivery_redeclares_watch_after_prune(monkeypatch, tmp_path):
    """看管被 prune 撤掉后送达仍成功（送达前重声明）——a: 行不在 prune 判据内。

    先按现状让 prune 撤掉看管（无卡引用 ∧ 无在途 `m:` 行；活跃 `a:` 行不被计数），
    再走送达：不重声明则 `/answer` 撞驱动「未看管」404、a: 行落 error；重声明后真
    打到替身、行收口，并留下「撤销之后紧接一次 on:true」的请求痕迹。
    """
    drv = _real_driver(monkeypatch, mark=str(tmp_path / "calls.log"))
    try:
        sid = "session-ext-ans-b"
        proj, card = _ext_pending_interaction(monkeypatch, drv, sid,
                                               EXT_ANS_MARK)
        cid = card["id"]
        assert board._ensure_watch(sid) is True         # 常态：调和器/前置闸已声明
        assert board.answer_interaction(proj, card, "c1", EXT_ANS_PICK) is None
        assert waitq.get_active(waitq.KIND_ANSWER, cid) is not None
        # —— prune 撤掉看管：无卡引用（改读口）∧ 无在途 m: 行 ⇒ 判据成立 ——
        monkeypatch.setattr(board.db, "list_projects_all", lambda: [])
        assert board._watch_prune() == 1
        assert sid not in drv.watched                   # 驱动侧确已撤销
        board._deliver_answer_unit(cid)                 # 送达前重声明 ⇒ 仍送达
        watches = [c for c in _calls(drv) if c.get("call") == "/watch"]
        assert watches[-1]["on"] is True and watches[-1]["watched"] is True
        ans = [c for c in _calls(drv) if c.get("call") == "/answer"]
        assert ans and ans[-1]["call_id"] == "c1"       # 真打到替身
        assert waitq.get_active(waitq.KIND_ANSWER, cid) is None             # a: 行收口
    finally:
        drv.stop()


def test_external_approval_delivered_after_prune(monkeypatch, tmp_path):
    """外部会话审批同路：prune 撤看管后送达仍成功（/approval 真打到替身、行收口）。

    提问与审批共用 `_answer_deliver` 这一个送达出口，本条钉住审批分支同样被重声明
    覆盖——防日后把挂钩挪进提问分支、审批腿悄悄退回「未看管」404。
    """
    drv = _real_driver(monkeypatch, mark=str(tmp_path / "calls.log"))
    try:
        sid = "session-ext-apr"
        proj, card = _ext_pending_interaction(monkeypatch, drv, sid, EXT_APR_MARK)
        cid = card["id"]
        assert board.interaction_of_sid(sid)["answerable"] is True
        assert board._ensure_watch(sid) is True         # 常态：调和器/前置闸已声明
        assert board.answer_approval(proj, card, "ap-1", "approved") is None
        assert waitq.get_active(waitq.KIND_ANSWER, cid) is not None
        # —— prune 撤掉看管：无卡引用（改读口）∧ 无在途 m: 行 ⇒ 判据成立 ——
        monkeypatch.setattr(board.db, "list_projects_all", lambda: [])
        assert board._watch_prune() == 1
        assert sid not in drv.watched
        board._deliver_answer_unit(cid)                 # 送达前重声明 ⇒ 仍送达
        apr = [c for c in _calls(drv) if c.get("call") == "/approval"]
        assert apr and apr[-1]["approval_id"] == "ap-1"
        assert apr[-1]["decision"] == "allowed-once"    # 平台两态 → 宿主 outcome
        assert waitq.get_active(waitq.KIND_ANSWER, cid) is None             # a: 行收口
    finally:
        drv.stop()


# ---------- ⑧ 任务侧直送作答同样补声明看管（T7 评审 Important + 控制器裁定，2026-10-10） ----------
#
# 洞（评审原文）：`answer_interaction` / `answer_approval` 的 `card_id is None` 分支
# （任务会话伪卡，`server._api_task_answer_interaction` 生产走这条）是**直送**，不经
# `_answer_deliver` ⇒ 不补声明看管。任务会话在宿主重载后会被驱动以 `owned:false`
# 上报（正是 `_watch_prune` docstring 点名的场景），此时作答撞「未看管」404、用户
# 看到「回答失败：…」，且没有别的路径替它补声明（`_iw_once` 只扫有卡会话、
# `chat._external_preflight` 只管消息）。控制器裁定：两处直送分支在真正调驱动前各补
# 一次 `_watch_before_delivery(sid)`——与 `_answer_deliver` 同源同判据。
#
# 本节守卫：① 任务侧直送对**外部**会话（owned:false）在 prune 撤看管后仍真送达；
# ② 池内（owned:true）与未知（注册表无行）走直送路径**零 `/watch`**（判据阶梯不动）。


def _ext_pending_task_session(monkeypatch, drv, sid, mark):
    """造「外部**任务侧**会话挂起交互」现场：无看板卡，其余与 `_ext_pending_interaction` 同源。

    任务会话没有卡，`answer_interaction` 拿到的伪卡没有 `id` 键 ⇒ 走
    `card_id is None` 直送分支（`server._api_task_answer_interaction` 生产同路）。
    返回项目行；伪卡由调用方自造——不建卡正是「无卡引用」的真实形态（prune 判据
    的第一条天然成立），但要断言 prune 真撤销，调用方仍需钉住卡片读口（见用例）。
    """
    drv.ctl("/_ctl/external", {"sid": sid, "cwd": "/tmp/ext"})
    drv.ctl("/_ctl/external_state", {"sid": sid, "status": "running",
                                     "interaction": mark})
    _hub(monkeypatch, {sid: {"owned": False, "status": "running",
                             "interaction": mark}})
    board._WATCHED.clear()
    monkeypatch.setattr(board.runner, "INSTANCE", None)
    proj = _proj()
    board.interaction_probe("dsh_plugin", proj, sid)   # 任务会话端点同款读口，填缓存
    return proj


def test_task_side_direct_answer_redeclares_watch_after_prune(monkeypatch, tmp_path):
    """任务侧直送（card_id=None）对**外部**会话：看管被 prune 撤掉后仍真送达 /answer。

    直送分支不做修复时：`dshdriver.answer_question` 撞替身「未看管」404（与真驱动同
    阶梯）⇒ 前端拿「回答失败：…」。修复后送达前补一次幂等声明 ⇒ call_id 命中。
    """
    drv = _real_driver(monkeypatch, mark=str(tmp_path / "calls.log"))
    try:
        sid = "session-ext-task-a"
        proj = _ext_pending_task_session(monkeypatch, drv, sid, EXT_ANS_MARK)
        assert board._ensure_watch(sid) is True          # 常态：消息前置闸已声明过
        # —— prune 撤掉看管：无卡引用 ∧ 无在途 m: 行 ⇒ 判据成立（同 ⑦ 段造法）——
        monkeypatch.setattr(board.db, "list_projects_all", lambda: [])
        assert board._watch_prune() == 1
        assert sid not in drv.watched                    # 驱动侧确已撤销
        # 任务侧伪卡：无 id 键 ⇒ card_id is None ⇒ 直送分支（生产 server 同路）
        assert board.answer_interaction(proj, {"session_id": sid}, "c1",
                                        EXT_ANS_PICK) is None
        # 直送 = 不入队（统一队列语义不变）：真 waitq 表里没有该作答的 a: 行
        with db.connect() as conn:
            n = conn.execute("SELECT COUNT(*) FROM wait_items WHERE kind=?",
                             (waitq.KIND_ANSWER,)).fetchone()[0]
        assert n == 0
        ans = [c for c in _calls(drv) if c.get("call") == "/answer"]
        assert ans and ans[-1]["call_id"] == "c1"        # 真打到替身（不修复则 404）
        assert ans[-1]["external"] is True               # 走池外分支（已重新看管）
        watches = [c for c in _calls(drv) if c.get("call") == "/watch"]
        assert watches[-1]["on"] is True                 # 撤销之后紧接一次补声明
    finally:
        drv.stop()


def test_task_side_direct_approval_redeclares_watch_after_prune(monkeypatch, tmp_path):
    """任务侧直送审批（`answer_approval` 的 card_id=None 分支）同样补声明看管。

    第二处挂钩的专钉用例（与 ⑦ 段审批腿同思路）：未看管的 404 会被审批分支映射成
    「审批已不存在（可能已由 dsh GUI 作答）」⇒ 静默失败，用户以为 GUI 抢答了。
    """
    drv = _real_driver(monkeypatch, mark=str(tmp_path / "calls.log"))
    try:
        sid = "session-ext-task-apr"
        proj = _ext_pending_task_session(monkeypatch, drv, sid, EXT_APR_MARK)
        assert board.interaction_of_sid(sid)["answerable"] is True
        assert board._ensure_watch(sid) is True
        monkeypatch.setattr(board.db, "list_projects_all", lambda: [])
        assert board._watch_prune() == 1
        assert sid not in drv.watched
        assert board.answer_approval(proj, {"session_id": sid}, "ap-1",
                                     "approved") is None
        apr = [c for c in _calls(drv) if c.get("call") == "/approval"]
        assert apr and apr[-1]["approval_id"] == "ap-1"
        assert apr[-1]["decision"] == "allowed-once"     # 平台两态 → 宿主 outcome
    finally:
        drv.stop()


def test_task_side_direct_answer_skips_watch_for_owned_and_unknown(monkeypatch, tmp_path):
    """池内（owned:true）与未知（注册表无行）走直送路径**零 `/watch`**——判据阶梯不动。

    评审点名的缺失回归：修复若是「无脑声明看管」而非「只对 owned:false 声明」，平台
    就会向宿主里与 TS 无关的会话乱发 `/watch`（驱动侧看管集无界增长），池内会话也多
    一次无谓请求。用替身 `stats()` 直接数请求，不靠 mock 自证。
    """
    drv = _real_driver(monkeypatch, mark=str(tmp_path / "calls.log"))
    try:
        # —— ① 池内会话（owned:true）：直送照常成功，全程零 /watch ——
        sid_pool = "session-ext-task-pool"
        sess = drv.create(sid_pool, cwd="/tmp/ext")
        sess.interaction = dict(EXT_ANS_MARK)
        _hub(monkeypatch, {sid_pool: {"owned": True, "status": "running",
                                      "interaction": EXT_ANS_MARK}})
        board._WATCHED.clear()
        monkeypatch.setattr(board.runner, "INSTANCE", None)
        proj = _proj()
        board.interaction_probe("dsh_plugin", proj, sid_pool)
        assert board.answer_interaction(proj, {"session_id": sid_pool}, "c1",
                                        EXT_ANS_PICK) is None
        ans = [c for c in _calls(drv) if c.get("call") == "/answer"]
        assert ans and ans[-1]["call_id"] == "c1"        # 池内直送行为不变
        assert "external" not in ans[-1]                 # 走的不是池外分支
        assert drv.stats().get("/watch", 0) == 0         # 池内：一次也不声明

        # —— ② 未知会话（中枢已不认识它，st is None）：缓存里的挂起仍在，直送照旧失败 ——
        sid_unk = "session-ext-task-unk"
        _hub(monkeypatch, {sid_unk: {"owned": False, "status": "running",
                                     "interaction": EXT_ANS_MARK}})
        board.interaction_probe("dsh_plugin", proj, sid_unk)
        assert board.interaction_of_sid(sid_unk)["pending"] is True
        dshevents.HUB._sessions.pop(sid_unk)             # 中枢不再认识 ⇒ get() 返回 None
        assert dshevents.get(sid_unk) is None
        assert board.answer_interaction(proj, {"session_id": sid_unk}, "c1",
                                        EXT_ANS_PICK)        # 照旧「回答失败：…」
        assert drv.stats().get("/watch", 0) == 0         # 未知 ≠ 外部：一次也不声明
    finally:
        drv.stop()


# ---------- ⑩ I2（终审，2026-10-10）：卡片评论**推送腿**同样补声明看管 ----------
#
# 洞（终审 I2 原文）：`board._deliver_now` → `_web_send` → `chat.dsh_send` 是评论推送
# 腿，**不**经 `_answer_deliver`（作答/审批腿有 `_watch_before_delivery` 兜住），而
# `_watch_prune` 的撤销判据只看活跃 `m:` 行（不含推送腿本身）。真实入口：平台重启后
# `_rebuild_run → _deliver_unit → _deliver_now` 直投未声明 sid（`_WATCHED` 随进程清空，
# 驱动侧 `watched` 也可能随插件重载清空）⇒ 驱动回「未看管」404 ⇒ `m:` 行落 error。
# 修法：`_deliver_now` 在 `_web_send` 前加一行 `_watch_before_delivery(sid)`
# （幂等、命中缓存零请求，与 `_answer_deliver` 同源）；判据阶梯不动——池内/未知零请求。


def test_comment_push_redeclares_watch_after_prune(monkeypatch, tmp_path):
    """推送腿在看管被 prune 撤掉后仍能送达（与 T7 作答腿同一「先 prune 再送达」姿势）。"""
    drv = _real_driver(monkeypatch, mark=str(tmp_path / "calls.log"))
    try:
        sid = "session-ext-push"
        drv.ctl("/_ctl/external", {"sid": sid, "cwd": "/tmp/ext"})
        _hub(monkeypatch, {sid: {"owned": False, "status": "idle"}})
        board._WATCHED.clear()
        assert board._ensure_watch(sid) is True          # 常态：调和器/前置闸已声明
        # —— prune 撤掉看管：无卡引用（改读口）∧ 无在途 m: 行 ⇒ 判据成立 ——
        monkeypatch.setattr(board.db, "list_projects_all", lambda: [])
        assert board._watch_prune() == 1
        assert sid not in drv.watched                    # 驱动侧确已撤销
        # 推送腿（平台重启后 `_rebuild_run → _deliver_unit → _deliver_now` 同路）
        proj = _proj()
        board._deliver_now(proj, {"id": 1, "session_id": sid, "model": ""},
                           {"id": 0}, "评论正文")
        prompts = [c for c in _calls(drv) if c.get("call") == "/prompt"]
        assert prompts and prompts[-1].get("prompt") == "评论正文"
        assert prompts[-1].get("external") is True       # 走池外分支（已重新看管）
        watches = [c for c in _calls(drv) if c.get("call") == "/watch"]
        assert watches[-1]["on"] is True and watches[-1]["watched"] is True
    finally:
        drv.stop()


def test_comment_push_skips_watch_for_pool_session(monkeypatch, tmp_path):
    """池内会话（owned:true）走推送腿 **零 `/watch`**——判据阶梯不动（不打扰宿主会话）。"""
    drv = _real_driver(monkeypatch, mark=str(tmp_path / "calls.log"))
    try:
        sid = "session-ext-push-pool"
        drv.create(sid, cwd="/tmp/ext")
        _hub(monkeypatch, {sid: {"owned": True, "status": "idle"}})
        board._WATCHED.clear()
        proj = _proj()
        board._deliver_now(proj, {"id": 1, "session_id": sid, "model": ""},
                           {"id": 0}, "池内评论")
        prompts = [c for c in _calls(drv) if c.get("call") == "/prompt"]
        assert prompts and prompts[-1].get("prompt") == "池内评论"
        assert "external" not in prompts[-1]             # 池内原路（行为不变）
        assert drv.stats().get("/watch", 0) == 0         # 池内：一次也不声明
    finally:
        drv.stop()


# ---------- ⑪ I3（终审，2026-10-10）：`_watch_prune` 扫卡节流（代次检查不节流） ----------
#
# 洞（终审 I3 原文）：`_iw_once` 由 `dshevents.wait` 事件唤醒（每个状态帧一次，仅
# `IW_MIN_INTERVAL` 限速），节拍尾部每轮都调 `_watch_prune()`；`_WATCHED` 非空（有任
# 何一个外部会话）就 `_watch_card_refs()` = `list_projects_all()` 一次连接 + **每项目
# 一次** `list_board_cards()`，`_watch_msg_inflight` 还在 `_watch_lock` **内**做 SQLite
# 查询。修法：扫卡 + 撤销节流到 `WATCH_PRUNE_INTERVAL`(=60s，调和器兜底拍同量级)。
# 控制器补充约束：节流只能影响**回收的及时性**；`_watch_generation_sync`（中枢重连
# 代次失效）是正确性路径，必须每次进入都做——两条用例分别钉住这两半。


def test_watch_prune_scan_throttled_within_window(monkeypatch):
    """同一窗口内多轮 prune 只扫一次卡；窗口过后（下一兜底拍）恢复扫卡。

    观测面＝`_watch_card_refs` 的调用次数（调一次 = 一次「全项目扫卡」）。被看管 sid
    仍被卡引用（`refs` 含它）⇒ 无撤销，`_WATCHED` 保持非空，节流判据可持续观测。
    """
    drv = _real_driver(monkeypatch)
    try:
        sid = "session-ext-thr"
        drv.ctl("/_ctl/external", {"sid": sid, "cwd": "/tmp/ext"})
        _hub(monkeypatch, {sid: {"owned": False, "status": "idle"}})
        board._WATCHED.clear()
        board._WATCH_PRUNE_AT = 0.0                      # 本拍该扫
        assert board._ensure_watch(sid) is True
        scans = []
        monkeypatch.setattr(board, "_watch_card_refs",
                            lambda: scans.append(time.monotonic()) or {sid})
        board._watch_prune()                             # 第一次：扫（窗口开启）
        board._watch_prune()                             # 同窗口内：节流，不扫
        board._watch_prune()
        assert len(scans) == 1
        board._WATCH_PRUNE_AT = 0.0                      # 窗口过去（下一兜底拍到来）
        board._watch_prune()
        assert len(scans) == 2                           # 恢复扫卡（回收只是被推迟）
        assert board._WATCHED == {sid}                   # refs 仍引用 ⇒ 不撤（判据不动）
    finally:
        drv.stop()


def test_watch_prune_generation_sync_not_throttled(monkeypatch):
    """节流只作用于「扫卡 + 撤销」：窗口内发生中枢重连边沿，陈旧记账照旧清空。

    这是 I3 的硬约束（代次检查＝正确性路径）：若把节流写成「函数开头就 early return」，
    重连后 `_WATCHED` 不会被清 ⇒ 下一次声明一直命中陈旧缓存 ⇒ 投递撞驱动 404 且
    不自愈（`bug_report/20261008_1935` 的宿主侧重载场景会复活）。
    """
    drv = _real_driver(monkeypatch)
    try:
        sid = "session-ext-gen"
        drv.ctl("/_ctl/external", {"sid": sid, "cwd": "/tmp/ext"})
        hub = _hub(monkeypatch, {sid: {"owned": False, "status": "idle"}})
        board._WATCHED.clear()
        board._WATCH_PRUNE_AT = 0.0
        assert board._ensure_watch(sid) is True          # 记下代次基准
        monkeypatch.setattr(board, "_watch_card_refs", lambda: {sid})
        assert board._watch_prune() == 0                 # 扫一次（无需撤销），窗口用掉
        assert board._WATCHED == {sid}
        hub._set_connected(False)                        # 中枢断连…
        hub._set_connected(True)                         # …再连上 = 一次重连边沿
        assert board._watch_prune() == 0                 # 仍在窗口内：不扫卡
        assert board._WATCHED == set()                   # 但代次失效照常清空（不被节流）
    finally:
        drv.stop()


# ---------- ⑫ 缺陷 A（T9b 真机复跑发现，2026-10-10）：投递前预订阅 ----------
#
# 真机现象（run1–run7，6/6 命中）：「投递返回 → 等待器订阅」的订阅竞态。外部会话的
# 普通 followup 投递里，`turn/start` 帧到中枢在 +0.072~0.143s，而等待器的
# `dshevents.subscribe` 在 +0.084~0.152s ⇒ **帧早到 9~13ms**；全局状态流对进程内
# 订阅者**无回放** ⇒ `started` 恒假 ⇒ 本轮 `turn/end` 被丢弃 ⇒ 只能等满
# `TURN_START_GRACE`(60s) 收口（`m:` 行在 turn/end 帧后 56~57s 才落 done）。
# 有卡路由 `ext:` 行兜住占用（无实害，状态滞后 60s）；**无卡路（任务侧直送 / 飞书
# 绑定会话）会真的提前释放项目运行位**，与仍在跑的外部 turn 并发改同一工作区 ⇒ 违
# 「任务按项目串行」红线。
#
# 修法：把「订阅 + 帧队列」从等待器里抽成 `_TurnSubscription`，`chat.dsh_send` 在
# **投递之前**先建订阅并放进模块级旁表 `chat._DSH_SUB`（与 `_DSH_BASELINE`/
# `_DSH_INJECT` 同款「投递时记、等待时取走即弃」）；`dsh_wait_turn_via_events` 优先
# 取走预订阅，取不到再退回「现订阅」（老行为，覆盖预订阅与等待之间的窗口）。
# 本节守卫四件事：① 订阅确实早于投递（结构判据）；② 投递返回后**立刻**到的帧仍被
# 真 `turn/end` 收口（行为判据，修复前必红）；③ 不等待的投递不留悬挂订阅（条数上限
# + TTL 惰性过期，均真退订）；④ 池内/未知会话**不建**预订阅（池内路径零改动）。

PRESUB_SID = "session-ext-presub"


def test_dsh_send_subscribes_before_delivery(monkeypatch):
    """预订阅早于投递：`/prompt` 之前回调已注册（缺陷 A 的结构判据）。"""
    drv = _real_driver(monkeypatch)
    try:
        sid = PRESUB_SID
        drv.ctl("/_ctl/external", {"sid": sid, "cwd": "/tmp/ext"})
        _hub(monkeypatch, {sid: {"owned": False, "status": "idle", "last_seq": 3}})
        board._WATCHED.clear()
        assert board._ensure_watch(sid) is True          # 外部会话投递许可（T5 闸）
        order = []
        real_sub = dshevents.subscribe
        real_prompt = dshdriver.prompt

        def spy_sub(cb):
            order.append("subscribe")
            return real_sub(cb)

        def spy_prompt(s, text):
            order.append("prompt")
            return real_prompt(s, text)

        monkeypatch.setattr(chat.dshevents, "subscribe", spy_sub)
        monkeypatch.setattr(chat.dshdriver, "prompt", spy_prompt)
        try:
            assert chat.dsh_send(sid, "hi") == 3
        finally:
            _drop_delivery(sid)
        assert order[:2] == ["subscribe", "prompt"]      # 订阅先于投递（修复前恒 prompt 先）
        assert chat._DSH_SUB.get(sid) is not None        # 预订阅留在旁表等等待器取走
    finally:
        drv.stop()


def test_pre_subscription_catches_frame_before_waiter(monkeypatch):
    """投递返回后立刻到的帧不再漏：等待器取走预订阅 ⇒ 由真 `turn/end` 收口。

    确定性造法（不靠赛跑）：真投递（`dsh_send` 打替身 `/prompt`）⇒ 预订阅已建立；
    投递返回后**同步**喂 `turn/start` + `turn/end`（等价于「帧在投递返回后、等待器
    开工前到达」）⇒ 才调等待器。修复前等待器此刻才订阅，两帧都不在队列里 ⇒
    `started` 恒假 ⇒ 只能走 `TURN_START_GRACE`；本用例把宽限放大到 3s 并断言返回
    < 1s，宽限收口（≥3s）必被击落。
    """
    drv = _real_driver(monkeypatch)
    sid = PRESUB_SID + "-frame"
    frames = {}
    unsub = _capture_subscribe(monkeypatch, frames)
    try:
        drv.ctl("/_ctl/external", {"sid": sid, "cwd": "/tmp/ext"})
        _hub(monkeypatch, {sid: {"owned": False, "status": "idle", "last_seq": 5}})
        board._WATCHED.clear()
        assert board._ensure_watch(sid) is True      # 外部会话投递许可（T5 闸）
        assert chat.dsh_send(sid, "hi") == 5         # 真投递 ⇒ 预订阅在旁表
        cb = frames.get("cb")
        assert cb is not None, "投递前没有建立订阅（缺陷 A 未修）"
        cb({"type": "turn/start", "session_id": sid, "data": {"event_seq": 6}})
        cb({"type": "turn/end", "session_id": sid,
            "data": {"reason": {"kind": "completed"}, "event_seq": 9}})
        monkeypatch.setattr(chat, "TURN_START_GRACE", 3.0)     # 宽限远大于观测
        t0 = time.time()
        assert chat.dsh_wait_turn_via_events(sid) is None
        assert time.time() - t0 < 1.0                # 真 turn/end 收口（宽限 3s 没到）
        assert sid not in chat._DSH_SUB              # 取走即弃
        assert unsub and unsub[0] is cb              # finally 真退订（不泄漏回调）
    finally:
        _drop_delivery(sid)
        with chat._DSH_SUB_LOCK:
            stale = chat._DSH_SUB.pop(sid, None)
        if stale is not None:
            stale.close()
        drv.stop()


def test_pre_subscription_bounded_and_reclaimed(monkeypatch):
    """不等待的投递不留悬挂订阅：超条数上限 / 超 TTL 的预订阅出表并真退订。

    `chat._inject_send`、`board._deliver_now(inject=True)` 这类**不等待**的投递也会
    先订阅（投递前建），若无人取走必须回收——订阅回调常驻中枢消费者列表，泄漏会污染
    全局回调（每次状态帧都被调一次）。
    """
    _real_driver(monkeypatch)
    _hub(monkeypatch, {})
    unsub = []
    monkeypatch.setattr(chat.dshevents, "subscribe", lambda cb: cb)
    monkeypatch.setattr(chat.dshevents, "unsubscribe", lambda cb: unsub.append(cb))
    monkeypatch.setattr(chat, "DSH_SUB_MAX", 2)
    monkeypatch.setattr(chat, "DSH_SUB_TTL", 300.0)
    subs = [chat._dsh_sub_open(f"session-ext-cap-{i}") for i in range(4)]
    assert len(chat._DSH_SUB) <= 2                   # 旁表有界（条数上限）
    assert subs[0]._closed and subs[1]._closed       # 最旧两条被回收…
    assert len(unsub) == 2                           # …且真退订
    # TTL 惰性过期：把在场的一条改成超龄，再开一条 ⇒ 它出表并退订
    chat._DSH_SUB["session-ext-cap-2"].created -= 1000
    chat._dsh_sub_open("session-ext-cap-ttl")
    assert "session-ext-cap-2" not in chat._DSH_SUB
    assert subs[2]._closed


def test_dsh_send_skips_pre_subscription_for_pool_and_unknown(monkeypatch):
    """池内（owned:true）/ 注册表未知的投递**不建**预订阅（池内等待器用不上它）。

    硬约束「池内路径行为一个字节不变」：`dsh_wait_turn`（按会话 SSE）从不读旁表，
    给它建订阅只是白搭一个中枢回调 ⇒ 只有会走事件流路的那一档（`owned is False`）
    才建。
    """
    drv = _real_driver(monkeypatch)
    try:
        sid_pool = PRESUB_SID + "-pool"
        drv.create(sid_pool, cwd="/tmp/ext")
        _hub(monkeypatch, {sid_pool: {"owned": True, "status": "idle"}})
        try:
            chat.dsh_send(sid_pool, "hi")
        finally:
            _drop_delivery(sid_pool)
        assert chat._DSH_SUB == {}                   # 池内：不建
        sid_unk = PRESUB_SID + "-unknown"
        _hub(monkeypatch, {})                        # 注册表未知（断连 / 没见过该 sid）
        monkeypatch.setattr(chat.dshdriver, "prompt", lambda s, t: None)
        try:
            chat.dsh_send(sid_unk, "hi")
        finally:
            _drop_delivery(sid_unk)
        assert chat._DSH_SUB == {}                   # 未知 ≠ 外部：同样不建
    finally:
        drv.stop()


# ---------- ⑬ 缺陷 B（T9b 真机发现，2026-10-10）：作答送达的孤儿 c: 行 vs 本卡排队消息 ----------
#
# 真机现象（6 轮 5 轮命中，观测 ≥180s 不自愈）：外部会话卡作答 ⇒ 真送达成功
# （`_deliver_answer_unit`）⇒ 卡回 doing + `card_started` 补回一条**没有 `_RUNS`
# 背书**的「送达恢复」`c:` 行（外部会话不由平台拥有，`_RUNS` 里没有它）；紧接着该卡
# 再入队一条消息（`m:` 行 queued）⇒ 调和器把 `live_msg`（本卡有排队/执行中的消息）
# 算作「在跑」⇒ doing 分支恒 `None`（不收行）⇒ 而那条 `c:` 行就在运行前缀里，serial
# 项目里把这条消息**永久挡在队外**（`_prefix_window_blocked`）⇒ 该卡与项目后续投递
# 全被挡住，周期自检只打 `[waitq-selfcheck] 行状态不明（仅告警）: c:N`。
#
# 机制定位（是否外部卡特有）：**孤儿行**（活跃 `c:` 行 ∧ 无 `_RUNS` 背书）的生产
# 产生面只有一处——作答/立即送达送达成功时的 `card_started`（`_deliver_answer_unit` /
# `deliver_pending_answer_now`）。池内卡的同一形态带 `_RUNS` 条目（`has_run=True`）⇒
# 调和器早退不碰、由巡视线程 `_finish_run` 在会话空闲时收口该行 ⇒ **生产上只有外部/
# 接管卡（`owned:false`，has_run=False）能命中互等**；但互等规则本身是通用的（任何
# 「孤儿行 + live_msg」都成立），只是池内卡走不到。
#
# 修法（控制者裁定方向）：这类孤儿运行行只认**实况 busy**——行若已空闲（中枢可信地
# 报 idle），调和器必须收口它（`to_review`）让排队消息按队序起跑；`live_msg` 不能再
# 把它按「在跑」保住（行恰恰是消息起不来的原因）。**不采用**「无条件按
# `status == 'running'` 播种」那类放宽，也不动 `_prefix_window_blocked`（队列窗口闸
# 三处同口径是硬约束）。

DEADLOCK_SID = "session-ext-deadlock"


def test_orphan_hold_only_applies_without_run_entry():
    """纯函数判据：孤儿行（无 `_RUNS` 背书）只认实况 busy；其余形态照旧不动。

    同一个「doing + 会话空闲 + 本卡有排队消息」形态，四种输入四种结论——后两条是
    「既有语义一个字节不变」的守卫：
      ① 池内（has_run=True）⇒ `None`（列流转归 `_finish_run`，调和器不碰）；
      ② 普通卡（无活跃 `c:` 行，orphan_hold=False）⇒ `None`（**live_msg 照旧算
         「在跑」**：消息即将驱动会话，阻塞列卡片回开发列靠的正是它）；
      ③ 孤儿行（活跃 `c:` 行无 `_RUNS` 背书，生产上＝外部卡的送达恢复行）⇒
         `to_review`（收行放行队列——消息被这条行挡着，live_msg 不能再当「在跑」）；
      ④ 孤儿行但会话确实在跑（busy=True）⇒ `None`（行继续占位，等本轮结束）。
    """
    card = {"column_key": "doing", "block_kind": None}
    r = {"pending": False, "busy": False}
    assert board._reconcile_action_for("dsh_plugin", card, r, True, True) is None
    assert board._reconcile_action_for("dsh_plugin", card, r, False, True) is None
    assert board._reconcile_action_for("dsh_plugin", card, r, False, True,
                                       orphan_hold=True) == "to_review"
    assert board._reconcile_action_for("dsh_plugin", card,
                                       {"pending": False, "busy": True},
                                       False, True, orphan_hold=True) is None


def test_answer_recovery_row_releases_queued_message(monkeypatch, tmp_path):
    """真 waitq + 真调和 + 真补位器：孤儿 `c:` 行 + 本卡排队消息 ⇒ 调和器收行、消息可拾取。

    现场全走真路径：真替身驱动 → `answer_interaction` 真入队 `a:` 行 →
    `_deliver_answer_unit` 真送达（打替身 `/answer`）⇒ 卡回 doing + 孤儿行 running；
    会话实况换成空闲（恢复的那一轮结束了）⇒ `chat.submit` 真入队一条消息。断言：
    修复前 `_pick_locked()` 拾不到（行挡着）且调和器不收行；修复后调和器收口该行、
    卡片归位待审核、消息仍在队且真补位器能拾起它。
    """
    drv = _real_driver(monkeypatch)
    try:
        sid = DEADLOCK_SID
        drv.ctl("/_ctl/external", {"sid": sid, "cwd": "/tmp/ext"})
        drv.ctl("/_ctl/external_state", {"sid": sid, "status": "running",
                                         "interaction": EXT_ANS_MARK})
        _hub(monkeypatch, {sid: {"owned": False, "status": "running",
                                 "interaction": EXT_ANS_MARK}})
        board._WATCHED.clear()
        inst = runner.Runner(boot_gate=True)      # 真 runner：worker 停在启动闸，不抢行
        runner.INSTANCE = inst
        proj = _proj()
        cid = _make_sync_card(proj, sid, column="doing")
        card = db.get_board_card(cid)
        board.interaction_probe("dsh_plugin", proj, sid)   # 会话端点/调和器同款读口
        assert board.answer_interaction(proj, card, "c1", EXT_ANS_PICK) is None
        board._deliver_answer_unit(cid)           # 真送达（替身 /answer）⇒ 补回孤儿行
        row = waitq.get_active(waitq.KIND_CARD, cid)
        assert row is not None and row["state"] == waitq.RUNNING
        assert not board._has_active_run(cid)     # 孤儿：无 `_RUNS` 背书（外部会话）
        # 恢复的那一轮结束（真机：作答后会话续跑完本轮）⇒ 会话实况空闲
        _hub(monkeypatch, {sid: {"owned": False, "status": "idle"}})
        # 该卡紧接着再入队一条消息（真机 ③ 组形态：作答送达后 ~1.4s 又发一条）
        msg = chat.submit(proj["id"], sid, "后续排队消息", card_id=cid,
                          family="dsh_plugin")
        mid = msg["id"]
        assert waitq.get_active(waitq.KIND_MSG, mid) is not None    # m: 行在场（排队）
        assert chat.live_of_sid(sid) is True
        # —— 互等现场自证：孤儿行占着运行前缀 ⇒ 真补位器拾不到这条消息 ——
        with inst._cond:
            assert inst._pick_locked() is None, "现场没复现互等（消息没被孤儿行挡住）"
        # —— 调和器一轮：孤儿行（会话可信空闲）必须收口 ⇒ 消息重新可拾取 ——
        board._iw_once()
        assert waitq.get_active(waitq.KIND_CARD, cid) is None      # c: 行已收口
        assert db.get_board_card(cid)["column_key"] == "review"    # 卡归位待审核
        assert chat.live_of_sid(sid) is True                       # 消息没被丢
        with inst._cond:
            assert inst._pick_locked() == f"m:{mid}"               # 真补位器能拾起（不再被挡）
    finally:
        _drop_delivery(DEADLOCK_SID)
        drv.stop()
