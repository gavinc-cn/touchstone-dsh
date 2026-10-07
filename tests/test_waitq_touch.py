# 行证据与心跳单测（v3c：证据 / 心跳迁到行——waitq.touch_unit / mark_evidence /
# evidence_pid；v3d 起行是唯一证据面）。
# conftest 临时库；不触网络。
import json

import pytest

import db
import waitq


@pytest.fixture(autouse=True)
def _clean_tables():
    def _clean():
        with db.connect() as conn:
            for t in ("wait_items", "chat_msgs"):
                conn.execute(f"DELETE FROM {t}")
    _clean()
    yield
    _clean()


def _mk_card(title="心跳卡"):
    return db.insert_board_card(1, title)


# ---------- 行心跳（v3c 权威） ----------

def test_touch_unit_updates_last_seen_and_evidence():
    """行心跳：活跃行 last_seen 刷新 + evidence JSON 合入
    {evidence, evidence_at}。"""
    cid = _mk_card()
    rid, _ = waitq.insert_card_force_start(cid, 1)
    waitq.mark_running(waitq.KIND_CARD, cid)
    assert waitq.touch_unit(waitq.KIND_CARD, cid, "busy=1(poll)") is True
    row = waitq.get_item(rid)
    assert row["last_seen"] > 0
    ev = json.loads(row["evidence"])
    assert ev["evidence"] == "busy=1(poll)" and ev["evidence_at"] > 0
    # 二次打点：last_seen 单调不减、证据覆盖为最新
    first = row["last_seen"]
    assert waitq.touch_unit(waitq.KIND_CARD, cid, "busy=0(poll)") is True
    row = waitq.get_item(rid)
    assert row["last_seen"] >= first
    assert json.loads(row["evidence"])["evidence"] == "busy=0(poll)"


def test_touch_unit_merges_registration_evidence():
    """心跳与登记证据共处一行：mark_evidence 写的 desc/pid 不被心跳覆盖
    （JSON 合并不是整体改写）。"""
    cid = _mk_card()
    rid, _ = waitq.insert_card_force_start(cid, 1)
    waitq.mark_running(waitq.KIND_CARD, cid)
    assert waitq.mark_evidence(waitq.KIND_CARD, cid,
                               {"desc": "卡片会话占用", "pid": 4242}) is True
    assert waitq.touch_unit(waitq.KIND_CARD, cid, "busy=1(sse)") is True
    ev = json.loads(waitq.get_item(rid)["evidence"])
    assert ev["desc"] == "卡片会话占用" and ev["pid"] == 4242
    assert ev["evidence"] == "busy=1(sse)"


def test_touch_unit_missing_row_returns_false():
    """无活跃行不打点（不抛）：心跳只对在场条目有意义。"""
    assert waitq.touch_unit(waitq.KIND_CARD, 404) is False
    assert waitq.touch_unit(waitq.KIND_CARD, 404, "busy=1(poll)") is False


def test_touch_unit_terminal_row_not_touched():
    """终态行不打点：收口后的行不复活（活跃态守卫）。"""
    cid = _mk_card()
    rid = waitq.enqueue_card(cid, 1)
    waitq.mark_done(rid)
    assert waitq.touch_unit(waitq.KIND_CARD, cid, "x") is False
    assert waitq.get_item(rid)["last_seen"] == 0


def test_touch_unit_tolerates_bad_evidence_json():
    """坏 evidence JSON 按空对象处理（不炸，心跳照常落）——活跃行两态同判据：
    waiting 行（排队单元）与 running 行（跨轮存活的运行行）各验一遍，
    并钉 evidence_at 时间戳落盘。"""
    cid = _mk_card()
    rid = waitq.enqueue_card(cid, 1)                      # waiting 活跃行
    with db.connect() as conn:
        conn.execute("UPDATE wait_items SET evidence='not json' WHERE id=?", (rid,))
    assert waitq.touch_unit(waitq.KIND_CARD, cid, "busy=1(poll)") is True
    ev = json.loads(waitq.get_item(rid)["evidence"])
    assert ev["evidence"] == "busy=1(poll)" and ev["evidence_at"] > 0
    cid2 = _mk_card("运行心跳卡")
    rid2, _ = waitq.insert_card_force_start(cid2, 1)      # running 活跃行
    waitq.mark_running(waitq.KIND_CARD, cid2)
    with db.connect() as conn:
        conn.execute("UPDATE wait_items SET evidence='not json' WHERE id=?", (rid2,))
    assert waitq.touch_unit(waitq.KIND_CARD, cid2, "x") is True
    assert json.loads(waitq.get_item(rid2)["evidence"])["evidence"] == "x"


def test_mark_evidence_no_active_row_returns_false():
    """登记证据只写活跃行（终态行无意义）；空 patch 不写。"""
    cid = _mk_card()
    rid = waitq.enqueue_card(cid, 1)
    waitq.mark_done(rid)
    assert waitq.mark_evidence(waitq.KIND_CARD, cid, {"pid": 1}) is False
    cid2 = _mk_card("活跃卡")
    rid2 = waitq.enqueue_card(cid2, 1)
    assert waitq.mark_evidence(waitq.KIND_CARD, cid2, {}) is False
    assert waitq.get_item(rid2)["evidence"] == ""


def test_evidence_pid_reads_row_evidence():
    """行 evidence 的 pid 读取口（R11④）：有 pid 返回、坏 JSON/缺键/bool → None。"""
    cid = _mk_card()
    rid = waitq.enqueue_card(cid, 1)
    assert waitq.evidence_pid(waitq.get_item(rid)) is None       # 无证据
    waitq.mark_evidence(waitq.KIND_CARD, cid, {"pid": 99})
    assert waitq.evidence_pid(waitq.get_item(rid)) == 99
    waitq.mark_evidence(waitq.KIND_CARD, cid, {"pid": True})     # bool 不算 pid
    assert waitq.evidence_pid(waitq.get_item(rid)) is None
    with db.connect() as conn:
        conn.execute("UPDATE wait_items SET evidence='not json' WHERE id=?", (rid,))
    assert waitq.evidence_pid(waitq.get_item(rid)) is None
    assert waitq.evidence_pid(None) is None


def test_enter_running_reopen_clears_evidence():
    """终态行重开=新生命周期：evidence/last_seen 清零（旧会话 pid 不得残留——
    陈旧进程证据会误判活）；活跃行续持不动证据（由 mark_evidence 续写）。"""
    cid = _mk_card()
    rid, _ = waitq.insert_card_force_start(cid, 1)
    waitq.mark_running(waitq.KIND_CARD, cid)
    waitq.mark_evidence(waitq.KIND_CARD, cid, {"pid": 1234, "desc": "卡片会话占用"})
    waitq.touch_unit(waitq.KIND_CARD, cid, "busy=1(poll)")
    assert waitq.enter_running(waitq.KIND_CARD, cid, 1) is True   # 活跃行：证据不动
    assert waitq.evidence_pid(waitq.get_item(rid)) == 1234
    waitq.finish_by_target(waitq.KIND_CARD, cid)                  # 会话结束收口
    assert waitq.enter_running(waitq.KIND_CARD, cid, 1) is True   # 重开同一行
    row = waitq.get_item(rid)
    assert row["id"] == rid and row["state"] == "running"
    assert row["evidence"] == "" and row["last_seen"] == 0


# ---------- 行心跳的边界面（v3d：租约镜像心跳用例随镜像删除；
# 坏 JSON 边界合并到上方同名用例，本文件不再有重名定义） ----------
