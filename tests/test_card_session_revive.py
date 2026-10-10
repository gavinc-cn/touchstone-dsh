# 卡片会话「宿主已失去」时的投递自愈单测（修卡 934，2026-10-10）：
#   ① 报障现场——卡 934 的会话在 2026-10-10 01:06:48 被插件热重载 dispose
#      （`turn/end {kind:aborted, reason:{kind:disposed}}`），宿主里从此没有活 agent；
#      用户再发评论 / 点「立即注入」时，驱动回 404「会话不在驱动池中」，
#      前端 toast 只看到驱动原文案；
#   ② 修法——投递前若「中枢可信 ∧ 注册表无此 sid」（与调和器
#      `_iw_once` 的「会话确已结束」同一判据）⇒ 平台自建卡会话按 `_start_web`
#      同源的 resume 语义接回宿主再投递；sync 卡（用户在 dsh 直跑的会话）维持
#      C 批「只投递不接管」，不 resume、给明确文案；
#   ③ 不变量——会话在场（owned=true）、中枢未对齐/未知一律**零 `/session` 请求**，
#      pool 内外既有行为一个字节不变。
#
# 姿势沿用 tests/test_external_channel.py：真客户端 dshdriver 打真 HTTP 替身
# （tests/fakedriver.py），全程零真实网络、零 LLM、零子进程。
import json
import os
import sys
import tempfile
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

import board
import chat
import db
import dshevents
import runner
import waitq
from fakedriver import FakeDriver


@pytest.fixture(autouse=True)
def _clean_shared_state():
    """每例前后清等待项/消息表 + 看管集合 + 投递前预订阅（进程内/表级共享态）。"""
    def _clean():
        with db.connect() as conn:
            for t in ("wait_items", "chat_msgs"):
                conn.execute(f"DELETE FROM {t}")
        board._WATCHED.clear()
        board._WATCH_GEN = None
        board._WATCH_PRUNE_AT = 0.0
        with chat._DSH_SUB_LOCK:
            subs = list(chat._DSH_SUB.values())
            chat._DSH_SUB.clear()
        for sub in subs:
            sub.close()
    _clean()
    yield
    _clean()


# ---------- 测试本地辅助 ----------

def _real_driver(monkeypatch, mark=""):
    """真客户端 dshdriver → 真 HTTP 替身（先例：tests/test_external_channel.py）。"""
    drv = FakeDriver(mark=mark).start()
    monkeypatch.setenv("TS_AGENT_DRIVER_URL", drv.url)
    monkeypatch.setenv("TS_AGENT_DRIVER_TOKEN", drv.token)
    return drv


def _hub(monkeypatch, rows, aligned=True):
    """进程内注册表（真 `dshevents.EventHub`）：`aligned()` 是「快照可信」的唯一判据。"""
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
    """真项目行（投递要读项目行写对话日志，不能凭空造）。"""
    uid = uuid.uuid4().hex[:8]
    root = tempfile.mkdtemp(prefix=f"ts-revive-{uid}-")
    pid = db.insert_project(0, f"revive-{uid}", root, "dsh-plugin:/usr/bin/dsh",
                            os.path.join(root, "work"))
    return db.get_project(pid)


def _card(proj, sid, origin=None, column="review"):
    """真卡片行：平台卡（origin=None）/ sync 卡（origin='sync'）。"""
    cid = db.insert_board_card(proj["id"], "卡片会话自愈")
    db.update_board_card(cid, column_key=column, session_id=sid,
                         sessions=json.dumps([sid]), origin=origin)
    return dict(db.get_board_card(cid))


def _comment(cid, text):
    mid = db.insert_board_comment(cid, text)
    return {"id": mid, "text": text}


def _calls(drv):
    """替身记号文件读回（`CALL {json}` 行；先例 tests/test_external_channel.py）。"""
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


def _call_names(drv):
    return [c.get("call") for c in _calls(drv)]


def _comment_row(proj, mid):
    return [dict(r) for r in db.list_board_comments(proj["id"]) if r["id"] == mid][0]


class _FakeRunner:
    """假 runner 单例：`chat.submit` 走「有统一队列」分支（只登记不投递）。"""

    def __init__(self):
        self.submitted = []

    def unit_busy(self, project_id):
        return False

    def submit_msg(self, msg_id, project_id, sid=""):
        self.submitted.append((msg_id, project_id, sid))

    def remove_msg(self, msg_id):
        pass


# ---------- ①② 平台卡：宿主已失去会话 ⇒ 先接回再投递 ----------

def test_deliver_inject_revives_lost_session_then_steers(monkeypatch):
    """「立即注入」腿：宿主已失去该会话时先 resume 接回，再 steer 投递（修卡 934 现场）。"""
    mark = os.path.join(tempfile.mkdtemp(prefix="ts-revive-mk-"), "calls.log")
    drv = _real_driver(monkeypatch, mark=mark)
    try:
        _hub(monkeypatch, {})                       # 可信快照：宿主里已经没有这个会话
        proj = _proj()
        sid = "session-lost-inject"
        card = _card(proj, sid)
        cmt = _comment(card["id"], "提问中断了, 重新提问")
        board._deliver_now(proj, card, cmt, cmt["text"], inject=True)
        assert _call_names(drv) == ["/session", "/steer"]      # 先接回、再注入
        first = _calls(drv)[0]
        assert first["sid"] == sid and first["resume"] is True
        assert _calls(drv)[1]["prompt"] == cmt["text"]
        assert sid in drv.sessions                             # 已回到驱动池
        assert _comment_row(proj, cmt["id"])["sent"] == 1      # 评论落「已送达」
    finally:
        drv.stop()


def test_deliver_followup_revives_lost_session(monkeypatch):
    """普通发送腿（统一队列单元执行体）：同样先接回再 followup。"""
    mark = os.path.join(tempfile.mkdtemp(prefix="ts-revive-mk-"), "calls.log")
    drv = _real_driver(monkeypatch, mark=mark)
    try:
        _hub(monkeypatch, {})
        proj = _proj()
        sid = "session-lost-follow"
        card = _card(proj, sid)
        cmt = _comment(card["id"], "继续改")
        monkeypatch.setattr(chat, "wait_turn", lambda *a, **k: None)   # 不等轮次
        board._deliver_unit(proj, card, cmt, cmt["text"], False)
        assert _call_names(drv) == ["/session", "/prompt"]
        assert _calls(drv)[1]["prompt"] == cmt["text"]
        assert _comment_row(proj, cmt["id"])["sent"] == 1
    finally:
        drv.stop()


def test_inject_now_on_lost_session_revives(monkeypatch):
    """整条链：排队消息「立即注入」（chat.inject_now）也不撞驱动 404。"""
    mark = os.path.join(tempfile.mkdtemp(prefix="ts-revive-mk-"), "calls.log")
    drv = _real_driver(monkeypatch, mark=mark)
    try:
        _hub(monkeypatch, {})
        proj = _proj()
        sid = "session-lost-queue"
        card = _card(proj, sid)
        comment_id = db.insert_board_comment(card["id"], "提问中断了, 重新提问")
        runner.INSTANCE = _FakeRunner()
        try:
            res = board.deliver_comment(proj, db.get_board_card(card["id"]),
                                        {"id": comment_id, "text": "提问中断了, 重新提问"})
            assert res["queued"] is False                      # 项目空闲：登记即执行体
            chat.inject_now(res["id"])
        finally:
            runner.INSTANCE = None
        assert _call_names(drv) == ["/session", "/steer"]
        assert waitq.msg_get(res["id"])["state"] == chat.STATE_DONE
    finally:
        drv.stop()


# ---------- ③ 不变量：会话在场 / 未知一律零 resume 请求 ----------

def test_live_session_never_revives(monkeypatch):
    """注册表可信且会话在场（owned=true）⇒ 一个 `/session` 都不发。"""
    mark = os.path.join(tempfile.mkdtemp(prefix="ts-revive-mk-"), "calls.log")
    drv = _real_driver(monkeypatch, mark=mark)
    try:
        proj = _proj()
        sid = "session-alive"
        card = _card(proj, sid)
        drv.create(sid, cwd=proj["project_dir"])               # 驱动池里已有它
        _hub(monkeypatch, {sid: {"owned": True, "status": "idle"}})
        cmt = _comment(card["id"], "在跑就别动我")
        board._deliver_now(proj, card, cmt, cmt["text"], inject=True)
        assert _call_names(drv) == ["/steer"]                  # 直投，无 resume
        assert drv.stats().get("/session", 0) == 0             # 零接回请求
    finally:
        drv.stop()


def test_unaligned_hub_never_revives(monkeypatch):
    """中枢未对齐（快照不可信）⇒ 未知 ≠ 已失去：不 resume，保持既有 404 语义。"""
    mark = os.path.join(tempfile.mkdtemp(prefix="ts-revive-mk-"), "calls.log")
    drv = _real_driver(monkeypatch, mark=mark)
    try:
        _hub(monkeypatch, {}, aligned=False)
        proj = _proj()
        sid = "session-unaligned"
        card = _card(proj, sid)
        cmt = _comment(card["id"], "未知态别乱动")
        with pytest.raises(RuntimeError) as ei:
            board._deliver_now(proj, card, cmt, cmt["text"], inject=True)
        assert "评论投递失败" in str(ei.value)               # 既有 404 语义不变
        stats = drv.stats()
        assert stats.get("/session", 0) == 0                # 不接回
        assert stats.get("/steer", 0) == 1                  # 驱动确实被投了一次（然后 404）
    finally:
        drv.stop()


# ---------- ② 接不回 / sync 卡：明确文案 ----------

def test_revive_failure_reports_clear_text(monkeypatch):
    """resume 失败（会话文件缺失等）⇒ 明确中文文案，不再抛驱动原文案。"""
    mark = os.path.join(tempfile.mkdtemp(prefix="ts-revive-mk-"), "calls.log")
    drv = _real_driver(monkeypatch, mark=mark)
    try:
        drv.session_fail = "会话恢复失败: 会话不存在"
        _hub(monkeypatch, {})
        proj = _proj()
        sid = "session-gone-forever"
        card = _card(proj, sid)
        cmt = _comment(card["id"], "还能收到吗")
        with pytest.raises(RuntimeError) as ei:
            board._deliver_now(proj, card, cmt, cmt["text"], inject=True)
        msg = str(ei.value)
        assert "会话已结束" in msg and "开始" in msg            # 可执行指引
        assert "不在驱动池中" not in msg                        # 不再透出内部链路文案
        assert drv.stats() == {"/session": 1}                  # 只试了一次接回，没白投
    finally:
        drv.stop()


def test_sync_card_lost_session_not_adopted(monkeypatch):
    """sync 卡（用户在 dsh 直跑的会话）宿主已失去 ⇒ 不 resume 收养，给明确文案。"""
    mark = os.path.join(tempfile.mkdtemp(prefix="ts-revive-mk-"), "calls.log")
    drv = _real_driver(monkeypatch, mark=mark)
    try:
        _hub(monkeypatch, {})
        proj = _proj()
        sid = "session-sync-lost"
        card = _card(proj, sid, origin="sync")
        cmt = _comment(card["id"], "外部会话的评论")
        with pytest.raises(RuntimeError) as ei:
            board._deliver_now(proj, card, cmt, cmt["text"], inject=True)
        assert "会话已结束" in str(ei.value)
        assert drv.stats() == {}                               # 一个请求都不发（不收养）
    finally:
        drv.stop()


def test_revive_valve_off_keeps_old_behaviour(monkeypatch):
    """回滚阀 `TS_HOST_SESSION_REVIVE=0` ⇒ 不 resume，退回修复前行为。"""
    mark = os.path.join(tempfile.mkdtemp(prefix="ts-revive-mk-"), "calls.log")
    drv = _real_driver(monkeypatch, mark=mark)
    try:
        monkeypatch.setenv("TS_HOST_SESSION_REVIVE", "0")
        _hub(monkeypatch, {})
        proj = _proj()
        sid = "session-valve-off"
        card = _card(proj, sid)
        cmt = _comment(card["id"], "阀关了就照旧")
        with pytest.raises(RuntimeError):
            board._deliver_now(proj, card, cmt, cmt["text"], inject=True)
        stats = drv.stats()
        assert stats.get("/session", 0) == 0                   # 阀关：不接回
        assert stats.get("/steer", 0) == 1                     # 退回修复前行为
    finally:
        drv.stop()
