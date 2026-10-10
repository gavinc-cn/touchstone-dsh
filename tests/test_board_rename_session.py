# 卡面改名 → DSH 会话名同步（2026-10-10 用户需求，B 档）
#
# 语义：看板卡改名（`PATCH /board/cards/<cid>` 带 title）时把新标题同步给卡的**主会话**，
# 覆盖两档：
#   ① 池内（平台建/接过的会话）⇒ `dshdriver.rename` 原路径；
#   ② 池外但**平台看管**（`/watch`，只声明不接管）+ 宿主仍有活 agent（用户在 dsh GUI
#      直跑的会话）⇒ 先声明看管再重试，驱动侧 `/rename` 的池外回落分支（node 半同批）。
# 失败**不阻断卡面**（用户的编辑永远生效）：响应带 `session_rename.ok=false` + 原因；
# 成功时若宿主规范化/截断了标题（真机 `normalizeSessionTitle` 的 UTF-8 字节预算）⇒
# 以驱动回执的**接受值**回写卡面，保证两侧逐字一致。
#
# 姿势：单元段用**真 dshdriver 打真 HTTP 替身**（tests/fakedriver.py，先例
# tests/test_external_channel.py）；端点段用隔离实例（真实 HTTP + 真实库 + 同一替身）。
import json
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

import board
import db
from fakedriver import FakeDriver
from serverfixture import isolated_server  # noqa: F401 —— fixture 经 import 注入

SID = "session-rename-pool-0001"
EXT = "session-rename-ext-0001"


@pytest.fixture(autouse=True)
def _clean_watch():
    """每例前后清看管记账与代次指针（进程内共享态，跨例会串味）。"""
    def _clean():
        board._WATCHED.clear()
        board._WATCH_GEN = None
    _clean()
    yield
    _clean()


@pytest.fixture()
def drv(monkeypatch, tmp_path):
    """真 dshdriver → 真 HTTP 替身（零真实网络、零 LLM）。"""
    d = FakeDriver(mark=str(tmp_path / "calls.log")).start()
    monkeypatch.setenv("TS_AGENT_DRIVER_URL", d.url)
    monkeypatch.setenv("TS_AGENT_DRIVER_TOKEN", d.token)
    try:
        yield d
    finally:
        d.stop()


def _calls(drv):
    """替身记号文件读回（`CALL {json}` 行）。"""
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


def _external(drv, sid=EXT, status="idle"):
    """登记一个池外会话（真插件 `observed`/`external` 同形）。"""
    drv.external[sid] = {"sid": sid, "cwd": "/tmp/ext", "status": status,
                         "interaction": None}


# ---------------- 单元：board.rename_card_session ----------------

def test_pool_session_rename_ok(drv):
    """池内会话：直接改名成功，回执接受值 = 提交值；不发 `/watch`。"""
    drv.create(sid=SID, cwd="/tmp/x", task="card-1")
    assert board.rename_card_session(SID, "新标题") == (True, "", "新标题")
    marks = _calls(drv)
    assert [m["call"] for m in marks] == ["/rename"]
    assert marks[0]["sid"] == SID and marks[0]["title"] == "新标题"
    assert marks[0]["external"] is False


def test_external_unwatched_404_then_watch_retry(drv):
    """池外未看管：首跳 404 ⇒ 平台声明看管（幂等、只声明不接管）⇒ 重试成功。

    这正是「用户在 dsh GUI 直跑的会话，从 TS 改卡名也能改名」的那条路。
    """
    _external(drv)
    assert board.rename_card_session(EXT, "外部标题") == (True, "", "外部标题")
    marks = _calls(drv)
    assert [m["call"] for m in marks] == ["/watch", "/rename"]   # 首跳 404 不留记号
    assert marks[0]["sid"] == EXT and marks[0]["watched"] is True
    assert marks[1]["external"] is True and marks[1]["title"] == "外部标题"


def test_external_dead_session_reports_reason(drv):
    """看管但宿主已无活 agent（`status='unknown'`）：不冒充成功，如实回原因。"""
    _external(drv, status="unknown")
    ok, err, accepted = board.rename_card_session(EXT, "外部标题")
    assert ok is False and accepted == ""
    assert "会话已结束" in err, err


def test_stale_watch_cache_does_not_block_retry(drv):
    """**真机实录的回归钉子**：平台 `_WATCHED` 是进程内记账，可能与驱动侧脱节
    （带外 `POST /watch {on:false}`、驱动在 `session/disposed` 时自清看管表）——
    此时缓存命中不能让 404 重试原地打转，必须**强制重发**一次 `/watch`。"""
    _external(drv)                      # 驱动侧：未看管
    board._WATCHED.add(EXT)             # 平台侧：陈旧的「已看管」记账
    assert board.rename_card_session(EXT, "外部标题") == (True, "", "外部标题")
    marks = _calls(drv)
    assert [m["call"] for m in marks] == ["/watch", "/rename"], marks
    assert marks[0]["watched"] is True and marks[1]["external"] is True


def test_non_404_failure_does_not_watch(drv, monkeypatch):
    """非 404 失败（如 `sessionController` 不可用 → 503）：不声明看管、不重试。"""
    calls = []

    def boom(sid, title, timeout=None):
        calls.append((sid, title))
        raise board.dshdriver.DshDriverError(503, "sessionController 服务不可用，无法改名")

    monkeypatch.setattr(board.dshdriver, "rename", boom)
    watched = []
    monkeypatch.setattr(board, "_ensure_watch", lambda sid: watched.append(sid) or True)
    ok, err, accepted = board.rename_card_session(EXT, "标题")
    assert ok is False and accepted == "" and "服务不可用" in err
    assert calls == [(EXT, "标题")] and watched == []


def test_driver_not_configured_reports_reason(monkeypatch):
    """独立形态（无驱动地址）：改名失败但不抛，卡面照常由端点更新。"""
    monkeypatch.delenv("TS_AGENT_DRIVER_URL", raising=False)
    monkeypatch.delenv("TS_AGENT_DRIVER_TOKEN", raising=False)
    ok, err, accepted = board.rename_card_session(SID, "标题")
    assert ok is False and accepted == "" and "未配置" in err, err


def test_empty_inputs_rejected(monkeypatch):
    """空 sid / 空标题：直接拒绝，不打驱动。"""
    called = []
    monkeypatch.setattr(board.dshdriver, "rename",
                        lambda *a, **k: called.append(a) or {})
    assert board.rename_card_session("", "标题")[0] is False
    assert board.rename_card_session(SID, "   ")[0] is False
    assert called == []


def test_accepted_title_returned(drv):
    """宿主规范化/截断 ⇒ 返回**接受值**（平台据此回写卡面）。"""
    drv.create(sid=SID, cwd="/tmp/x", task="card-1")
    drv.rename_accept = lambda t: t[:4]
    try:
        assert board.rename_card_session(SID, "很长很长的标题") == (True, "", "很长很长")
    finally:
        drv.rename_accept = None


# ---------------- 端点：PATCH 卡面触发改名 ----------------

@pytest.fixture(scope="module")
def srv(isolated_server):
    """隔离实例 + 一个基础项目。"""
    isolated_server.pid = isolated_server.create_project(
        isolated_server.admin, "改名契约项目")
    return isolated_server


def _mk_card(srv, title, sid=""):
    """建卡；给 sid 时同时绑定为主会话。"""
    code, d = srv.admin.json(f"/api/projects/{srv.pid}/board/cards", "POST",
                             {"title": title})
    assert code == 200, d
    cid = d["id"]
    if sid:
        code, _ = srv.admin.json(f"/api/projects/{srv.pid}/board/cards/{cid}", "PATCH",
                                 {"bind_session": sid})
        assert code == 200
    return cid


def _patch_title(srv, cid, title):
    return srv.admin.json(f"/api/projects/{srv.pid}/board/cards/{cid}", "PATCH",
                          {"title": title})


def test_endpoint_rename_pool_session(srv):
    """卡面改名 → 主会话在池 ⇒ 驱动真收到 `/rename`，响应带 session_rename.ok。"""
    sid = "session-ep-pool-1"
    srv.driver.create(sid=sid, cwd=srv.work_dir, task="card-ep-1")
    cid = _mk_card(srv, "端点池内卡", sid=sid)
    before = srv.call_mark().count('"call": "/rename"')
    code, d = _patch_title(srv, cid, "端点改名后")
    assert code == 200 and d["title"] == "端点改名后", d
    assert d.get("session_rename", {}).get("ok") is True, d
    assert d["session_rename"]["session_id"] == sid
    assert srv.call_mark().count('"call": "/rename"') == before + 1


def test_endpoint_rename_external_session_via_watch(srv):
    """卡面改名 → 主会话为**池外**会话（宿主有活 agent）⇒ 看管声明后改名成功。"""
    ext = "session-ep-ext-1"
    srv.driver_ctl("/_ctl/external", {"sid": ext, "status": "idle"})
    cid = _mk_card(srv, "端点外部卡", sid=ext)
    code, d = _patch_title(srv, cid, "外部改名后")
    assert code == 200 and d.get("session_rename", {}).get("ok") is True, d
    assert ext in srv.driver.watched            # 平台确实声明了看管（只声明不接管）
    mark = srv.call_mark()
    assert f'"sid": "{ext}"' in mark and '"external": true' in mark


def test_endpoint_dead_external_reports_reason_but_keeps_card(srv):
    """池外会话已结束：卡面照改（用户编辑生效），响应如实带失败原因。"""
    dead = "session-ep-dead-1"
    srv.driver_ctl("/_ctl/external", {"sid": dead, "status": "unknown"})
    cid = _mk_card(srv, "端点已结束卡", sid=dead)
    code, d = _patch_title(srv, cid, "已结束改名")
    assert code == 200 and d["title"] == "已结束改名", d
    info = d.get("session_rename") or {}
    assert info.get("ok") is False and "会话已结束" in (info.get("error") or ""), d
    code, bd = srv.admin.json(f"/api/projects/{srv.pid}/board")
    cur = next((c for c in bd.get("cards", []) if c["id"] == cid), None)
    assert code == 200 and cur and cur["title"] == "已结束改名"


def test_endpoint_accepted_title_reported_not_written_back(srv):
    """宿主截断标题 ⇒ **卡面保留用户原文**，只在响应里如实上报 `accepted_title`。

    真机教训（2026-10-10）：一度把接受值回写卡面 ⇒ 用户的长标题被静默截断（实测宿主
    预算约 80 字节）。卡面是用户输入，平台不替用户缩短内容；前端据 accepted_title 提示
    「DSH 侧标题被截断为…（卡面保留原文）」，是否缩短由用户自己决定。
    """
    sid = "session-ep-trunc-1"
    srv.driver.create(sid=sid, cwd=srv.work_dir, task="card-ep-2")
    cid = _mk_card(srv, "端点截断卡", sid=sid)
    srv.driver.rename_accept = lambda t: t[:4]
    try:
        code, d = _patch_title(srv, cid, "很长很长的标题文本")
    finally:
        srv.driver.rename_accept = None
    assert code == 200, d
    assert d["title"] == "很长很长的标题文本", d          # 卡面 = 用户原文，未被截断
    assert (d.get("session_rename") or {}).get("accepted_title") == "很长很长", d
    code, bd = srv.admin.json(f"/api/projects/{srv.pid}/board")
    cur = next((c for c in bd.get("cards", []) if c["id"] == cid), None)
    assert code == 200 and cur and cur["title"] == "很长很长的标题文本"


def test_endpoint_no_session_no_rename(srv):
    """无主会话的卡：改标题不触发任何驱动调用，响应不带 session_rename。"""
    cid = _mk_card(srv, "无会话卡")
    before = srv.call_mark().count('"call": "/rename"')
    code, d = _patch_title(srv, cid, "无会话卡改名")
    assert code == 200 and d["title"] == "无会话卡改名"
    assert "session_rename" not in d, d
    assert srv.call_mark().count('"call": "/rename"') == before


def test_endpoint_non_title_patch_no_rename(srv):
    """只改描述：不触发改名（触发条件是 title 变化）。"""
    sid = "session-ep-pool-3"
    srv.driver.create(sid=sid, cwd=srv.work_dir, task="card-ep-3")
    cid = _mk_card(srv, "只改描述卡", sid=sid)
    before = srv.call_mark().count('"call": "/rename"')
    code, _d = srv.admin.json(f"/api/projects/{srv.pid}/board/cards/{cid}", "PATCH",
                              {"description": "换一段描述"})
    assert code == 200
    assert srv.call_mark().count('"call": "/rename"') == before


def test_endpoint_same_title_no_rename(srv):
    """标题未变（提交同值）：不触发改名。"""
    sid = "session-ep-pool-4"
    srv.driver.create(sid=sid, cwd=srv.work_dir, task="card-ep-4")
    cid = _mk_card(srv, "同名卡", sid=sid)
    before = srv.call_mark().count('"call": "/rename"')
    code, d = _patch_title(srv, cid, "同名卡")
    assert code == 200 and d["title"] == "同名卡"
    assert "session_rename" not in d, d
    assert srv.call_mark().count('"call": "/rename"') == before
