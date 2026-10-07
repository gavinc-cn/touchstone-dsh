# 行证据（v3c 起：证据源在 wait_items 行——desc/reason/pid 由
# runner.card_started 写行 evidence，心跳 evidence/evidence_at 由 waitq.touch_unit
# 写）与占位者明细读口（v3d 起行口径：明细 = 项目运行前缀成员行，不再有第二表征）。
import json
import os
import sys
import threading
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import db
import runner
import waitq


def _inst():
    """裸实例（不启线程、不碰调度）：沿用既有 runner 单测的 __new__ 用法
    （内存簿记退场，只装配读口所需的 _cond）。"""
    r = runner.Runner.__new__(runner.Runner)
    r._cond = threading.Condition()
    return r


def setup_function(_fn):
    """每例清等待项/消息表（conftest 临时库）。"""
    with db.connect() as conn:
        for t in ("wait_items", "chat_msgs"):
            conn.execute(f"DELETE FROM {t}")


def _mk_project():
    uid = uuid.uuid4().hex[:8]
    return db.insert_project(0, f"wc-{uid}", f"/tmp/wc-{uid}", "/bin/true",
                             f"/tmp/wc-{uid}/work")


def _prefix_row(kind, target, pid, desc):
    """种一条运行前缀行（拾取 → starting）并落登记证据，返回成员键。"""
    waitq.enqueue(kind, target, pid)
    assert waitq.claim_by_target(kind, target, "worker") is True
    waitq.mark_evidence(kind, target, {"desc": desc})
    return waitq.member_key(kind, target)


def test_holder_details_reports_prefix_rows():
    """占位者明细（行口径）：key=前缀成员键、since=行创建时间（epoch）、
    evidence=行登记证据（desc 回落）；排序=seq 升序（即队列位次序）。"""
    pid = _mk_project()
    _prefix_row(waitq.KIND_MSG, "m1", pid, "消息投递")
    _prefix_row(waitq.KIND_CARD, 7, pid, "卡片会话占用")
    d = _inst().project_holder_details(pid)
    assert [x["key"] for x in d] == ["m:m1", "c:7"]        # seq 升序=队序
    assert d[0]["evidence"] == "消息投递" and d[0]["since"] > 0
    assert d[1]["evidence"] == "卡片会话占用"


def test_holder_details_evidence_prefers_heartbeat():
    """心跳证据优先于登记 desc（回落链：evidence → desc）；等待行不计——
    明细只覆盖运行前缀成员（等待区不在「前面还有几个」的运行位）。"""
    pid = _mk_project()
    _prefix_row(waitq.KIND_CARD, 7, pid, "卡片会话占用")
    waitq.enqueue(waitq.KIND_CARD, 8, pid)                 # 等待行：不进明细
    assert waitq.touch_unit(waitq.KIND_CARD, 7, "busy=1(poll)") is True
    d = _inst().project_holder_details(pid)
    assert [x["key"] for x in d] == ["c:7"]
    assert d[0]["evidence"] == "busy=1(poll)"


def test_card_started_writes_row_evidence():
    """card_started 的 payload（desc 原文 + 调用方 reason/pid）写入**行 evidence**
    （判活读口 = waitq.evidence_pid/`_unit_verdict`）；card_finished 收口行。"""
    r = _inst()
    pid = _mk_project()
    cid = db.insert_board_card(pid, "证据卡")
    assert r.card_started(cid, pid, ext={"reason": "force 直起", "pid": 4321}) is True
    row = waitq.get_active(waitq.KIND_CARD, cid)
    assert row is not None and row["state"] == "running"     # 行即条目（v3a）
    assert waitq.evidence_pid(row) == 4321                   # 行 evidence 的 pid
    payload = json.loads(row["evidence"])
    assert payload["desc"] == "卡片会话占用" and payload["reason"] == "force 直起"
    r.card_finished(cid)
    assert waitq.get_active(waitq.KIND_CARD, cid) is None     # 行收口（会话结束即出队）


def test_card_started_idempotent_and_finish_closes():
    """card_started：六条起跑路径共用入口，幂等（重复调用行态/证据不动）；
    card_finished 收口后明细随之清空（无活跃行即无占位者）。"""
    r = _inst()
    pid = _mk_project()
    assert r.card_started(7, pid) is True
    assert r.card_started(7, pid) is True                  # 幂等续持（worker 拾取已置行）
    d = r.project_holder_details(pid)
    assert [x["key"] for x in d] == ["c:7"]
    assert d[0]["evidence"] == "卡片会话占用"
    r.card_finished(7)
    assert r.project_holder_details(pid) == []
    assert waitq.get_active(waitq.KIND_CARD, 7) is None
