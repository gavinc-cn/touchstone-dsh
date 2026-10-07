"""waitq 底座单测：两表 + 等待项状态机 + 自检（行即条目，v3d 去占用后）。"""
import json
import os
import sqlite3
import subprocess
import sys
import time
import uuid

import pytest

import db


@pytest.fixture(autouse=True)
def _clean_waitq_tables():
    """每例前后清空 waitq 两表：target 跨用例复用不串味。"""
    def _clean():
        with db.connect() as conn:
            for t in ("wait_items", "chat_msgs"):
                conn.execute(f"DELETE FROM {t}")
    _clean()
    yield
    _clean()


def test_schema_tables_exist():
    with db.connect() as conn:
        names = {r["name"] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"wait_items", "chat_msgs"} <= names
    assert "leases" not in names        # v3d：租约表随占用概念退场（迁移 DROP）


def test_wait_items_active_unique_index():
    """同类同目标至多一条活跃行；终态后可再插。"""
    with db.connect() as conn:
        conn.execute("INSERT INTO wait_items (project_id, kind, target_id, state, seq,"
                     " created_at) VALUES (1,'card','901','waiting',1,'2026-01-01 00:00:00')")
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO wait_items (project_id, kind, target_id, state, seq,"
                         " created_at) VALUES (1,'card','901','starting',2,'2026-01-01 00:00:00')")
        conn.execute("UPDATE wait_items SET state='done'"
                     " WHERE kind='card' AND target_id='901'")
        conn.execute("INSERT INTO wait_items (project_id, kind, target_id, state, seq,"
                     " created_at) VALUES (1,'card','901','waiting',3,'2026-01-01 00:00:00')")


import waitq


def test_enqueue_idempotent_and_get_active():
    i = waitq.enqueue(waitq.KIND_CARD, 901, project_id=1)
    assert isinstance(i, int)
    assert waitq.enqueue(waitq.KIND_CARD, 901, project_id=1) == i      # 幂等复用
    row = waitq.get_active(waitq.KIND_CARD, 901)
    assert row["state"] == "waiting" and row["project_id"] == 1


def test_enqueue_rejects_unknown_kind():
    with pytest.raises(ValueError):
        waitq.enqueue("bogus", 1, project_id=1)


def test_claim_only_once_then_done_then_reenqueue():
    i = waitq.enqueue(waitq.KIND_TASK, 902, 1)
    assert waitq.claim(i, "worker-1") is True
    assert waitq.claim(i, "worker-2") is False                          # 已 starting
    assert waitq.mark_done(i) is True
    assert waitq.get_active(waitq.KIND_TASK, 902) is None               # 终态后无活跃行
    assert waitq.enqueue(waitq.KIND_TASK, 902, 1) != i                  # 可再入队（新行）


def test_position_counts_same_project_only():
    """v2a T4 归一（裁决 R7，位次含运行前缀；v3a 读口切行）：pos=前缀成员数（项目内
    starting/running/finishing **行**）+ waiting 中 seq 更小者
    + 1；total=项目成员总数（行）；非 waiting 行自身返回 (0,0)；他项目不计位次。
    种子行 not_before 钉远期：套件遗留野 worker（M5 独立清理任务）抢走种子会让
    断言漂移——钉远期即免疫（位次判定不读 not_before，断言口径不变）。"""
    a = waitq.enqueue(waitq.KIND_MSG, "m1", 1, not_before=time.time() + 3600)
    b = waitq.enqueue(waitq.KIND_MSG, "m2", 1, not_before=time.time() + 3600)
    waitq.enqueue(waitq.KIND_MSG, "m3", 2, not_before=time.time() + 3600)  # 他项目不计位次
    assert waitq.position(b) == (2, 2)
    waitq.claim_by_target(waitq.KIND_MSG, "m1", "worker")               # m1 进前缀
    assert waitq.position(b) == (2, 2)      # 含前缀口径：前缀 1 + 等待区排号 1
    assert waitq.cancel(waitq.KIND_MSG, "m1", reason="用户取消") is True
    assert waitq.position(b) == (1, 1)
    assert "用户取消" in waitq.get_item(a)["meta"]                     # reason 落 meta
    assert waitq.claim_by_target(waitq.KIND_MSG, "m2", "worker") is True
    assert waitq.position(b) == (0, 0)      # 非 waiting 行自身返回 (0,0)


def test_position_counts_running_row_prefix():
    """v3a 位次读口切行（与 runner.unit_state 同口径）：running 行占前缀位——
    起跑证实后跨轮存活的 c: 行形态下 waiting 卡 pos=2/total=2（行是唯一来源，
    v3d 起无第二表征可对拍）。"""
    waitq.enqueue(waitq.KIND_MSG, "m1", 1)
    waitq.claim_by_target(waitq.KIND_MSG, "m1", "worker")   # 拾取 → starting
    waitq.mark_running(waitq.KIND_MSG, "m1")                # 证实 → running（跨轮存活）
    b = waitq.enqueue(waitq.KIND_MSG, "m2", 1, not_before=time.time() + 3600)
    assert waitq.position(b) == (2, 2)
    waitq.enqueue(waitq.KIND_MSG, "m3", 1, not_before=time.time() + 3600)
    assert waitq.position(b) == (2, 3)                  # 等待行与前缀行分属不同单元


def test_return_to_waiting_bumps_retry_and_not_before():
    i = waitq.enqueue(waitq.KIND_ANSWER, 903, 1)
    assert waitq.claim(i) is True
    assert waitq.return_to_waiting(i, not_before=123.0, bump_retry=True) is True
    row = waitq.get_item(i)
    assert row["state"] == "waiting" and row["retries"] == 1
    assert row["not_before"] == 123.0 and row["claimed_at"] is None


def test_finish_by_target_and_claim_by_target():
    waitq.enqueue(waitq.KIND_CARD, 904, 1)
    assert waitq.claim_by_target(waitq.KIND_CARD, 904, "worker") is True
    assert waitq.finish_by_target(waitq.KIND_CARD, 904) is True
    assert waitq.finish_by_target(waitq.KIND_CARD, 904) is False        # 已终态
    assert waitq.claim_by_target(waitq.KIND_CARD, 999) is False         # 无活跃行


def test_cancel_all_active_and_shadow_shell():
    waitq.enqueue(waitq.KIND_TASK, 905, 1)
    waitq.enqueue(waitq.KIND_CARD, 906, 1)
    assert waitq.cancel_all_active("服务重启（影子期）") == 2
    assert waitq.cancel_all_active("再清一次") == 0
    assert not hasattr(waitq, "shadow")     # P5 R7：影子壳全面退场（负向门禁）


def test_return_to_waiting_rejects_terminal_row():
    """终态行不可复活：状态守卫落在 UPDATE 上（并发下也不撞唯一索引）。"""
    i = waitq.enqueue(waitq.KIND_ANSWER, 907, 1)
    assert waitq.claim(i) is True
    assert waitq.mark_done(i) is True
    assert waitq.return_to_waiting(i) is False
    assert waitq.get_item(i)["state"] == "done"


def test_enqueue_after_claim_still_idempotent():
    """starting 仍属活跃态：再 enqueue 同 target 复用同一行（不插新行）。"""
    i = waitq.enqueue(waitq.KIND_CARD, 908, 1)
    assert waitq.claim(i, "worker") is True
    assert waitq.enqueue(waitq.KIND_CARD, 908, 1) == i


def test_lease_api_retired():
    """v3d 负向门禁：租约 API 全面退场（占用 = 该单元在队列里有活跃行），
    任何一件回来都说明「占用」概念又有了第二表征。"""
    for name in ("acquire", "release", "release_all", "leases_of", "has_lease",
                 "lease_of", "holder", "holders", "lease_rows", "touch"):
        assert not hasattr(waitq, name), f"租约 API 未退场: waitq.{name}"


def test_selfcheck_clean_and_detects_stale_claim():
    """超龄判据改行口径（v3c/R12）：claimed_at 越过 CLAIM_STALE_S 且无可证明
    证据（判活非 alive ∧ 无新鲜心跳）→ 报告；纯报告不改行。"""
    assert waitq.selfcheck() == []
    i = waitq.enqueue(waitq.KIND_CARD, 911, 1)
    waitq.claim(i, "worker-1")
    with db.connect() as conn:                                # 人为做旧 claimed_at
        conn.execute("UPDATE wait_items SET claimed_at='2000-01-01 00:00:00' WHERE id=?",
                     (i,))
    problems = waitq.selfcheck()
    assert any("starting 超龄无证据" in p for p in problems)
    # 新鲜心跳=活性佐证：不再报告（行证据即唯一佐证源；I1 违约面另算）
    assert waitq.touch_unit(waitq.KIND_CARD, 911, "busy=1(poll)") is True
    assert not any("超龄无证据" in p and "target=911 " in p
                   for p in waitq.selfcheck())
    # 报告不改行：行仍 starting（可证死才收口，见 selfcheck_units）
    assert waitq.get_item(i)["state"] == "starting"


def test_cancel_terminal_row_returns_false():
    """终态行不可取消：状态守卫落在 UPDATE 上（与 _set_terminal 同型竞态加固）。"""
    i = waitq.enqueue(waitq.KIND_CARD, 912, 1)
    assert waitq.claim(i, "worker") is True
    assert waitq.mark_done(i) is True
    assert waitq.cancel(waitq.KIND_CARD, 912) is False                 # 已终态
    assert waitq.get_item(i)["state"] == "done"


def test_cancel_all_active_exclude_kind():
    """exclude_kind（P2 recover 用）：只清 task/card/msg，answer 行保留。"""
    waitq.enqueue(waitq.KIND_TASK, 960, 1)
    waitq.enqueue(waitq.KIND_CARD, 961, 1)
    waitq.enqueue(waitq.KIND_ANSWER, 962, 1)
    n = waitq.cancel_all_active("服务重启（影子期）", exclude_kind=waitq.KIND_ANSWER)
    assert n == 2
    assert waitq.get_active(waitq.KIND_ANSWER, 962)["state"] == "waiting"
    assert waitq.get_active(waitq.KIND_TASK, 960) is None


def test_selfcheck_answer_stale_claim_evidence_is_row_only():
    """answer 的 starting 超龄佐证=行口径（v3c）：该 a: 行自身的证据列
    （心跳/判活）为唯一佐证源——无第二佐证面可查（v3d 起租约读口已删）。"""
    i = waitq.enqueue(waitq.KIND_ANSWER, 950, 1)
    waitq.claim(i, "worker")
    with db.connect() as conn:    # 人为做旧 claimed_at
        conn.execute("UPDATE wait_items SET claimed_at='2000-01-01 00:00:00' WHERE id=?",
                     (i,))
    assert any("starting 超龄无证据" in p and "answer" in p for p in waitq.selfcheck())
    waitq.touch_unit(waitq.KIND_ANSWER, 950, "送达中")  # 行自身证据即不误报
    assert waitq.selfcheck() == []


def test_prune_finished_recycles_old_terminal_only():
    """R14 终态行回收：done/failed/cancelled 且 ended_at 超窗才删；
    活跃行（waiting/starting 等四活跃态）与窗内终态行不动。"""
    old = waitq.enqueue(waitq.KIND_TASK, 970, 1)
    waitq.mark_done(old)
    fresh = waitq.enqueue(waitq.KIND_TASK, 971, 1)
    waitq.mark_failed(fresh, "x")
    live = waitq.enqueue(waitq.KIND_CARD, 972, 1)     # waiting 活跃行
    with db.connect() as conn:                        # 人为做旧终态时间
        conn.execute("UPDATE wait_items SET ended_at='2000-01-01 00:00:00' WHERE id=?",
                     (old,))
    assert waitq.prune_finished(keep_sec=600) == 1    # 仅超窗终态行回收
    assert waitq.get_item(old) is None
    assert waitq.get_item(fresh)["state"] == "failed"      # 窗内终态保留
    assert waitq.get_item(live)["state"] == "waiting"      # 活跃行不动
    assert waitq.prune_finished(keep_sec=600) == 0         # 幂等


# ---------- chat_msgs 读写（P3 消息持久化） ----------

def test_msg_enqueue_writes_row_and_wait_item():
    """msg_enqueue 一事务双写：chat_msgs 行（queued）+ msg 等待项（meta 载荷）。"""
    waitq.msg_enqueue("m1", 9, "s-1", "你好", task_id=3,
                      meta={"family": "kimi", "model": "glm"})
    row = waitq.msg_get("m1")
    assert row["state"] == "queued" and row["task_id"] == 3 and row["inject"] == 0
    assert row["sid"] == "s-1" and row["message"] == "你好"
    wrow = waitq.get_active(waitq.KIND_MSG, "m1")
    assert wrow is not None and wrow["state"] == "waiting" and wrow["project_id"] == 9
    assert json.loads(wrow["meta"]) == {"family": "kimi", "model": "glm"}


def test_msg_lifecycle_transitions():
    """claim/requeue/finish/cancel 的状态守卫逐一如 rowcount 仲裁（终态不可复活）。"""
    waitq.msg_enqueue("m1", 9, "s-1", "hi")
    assert waitq.msg_requeue("m1") is False               # 非 running 不可退回
    assert waitq.msg_claim("m1") is True                  # queued→running
    assert waitq.msg_claim("m1") is False                 # 已 running（幂等拒绝）
    assert waitq.msg_cancel("m1") is False                # 非 queued 不可取消
    assert waitq.msg_requeue("m1") is True                # running→queued（注入失败退回）
    assert waitq.msg_get("m1")["started_at"] is None
    assert waitq.msg_claim("m1") is True
    assert waitq.msg_finish("m1", "error", "boom") is True
    assert waitq.msg_finish("m1", "done") is False        # 终态不可再改
    assert waitq.msg_get("m1")["error"] == "boom"


def test_msg_rows_filters_and_queued_card_ids():
    """读侧：sid/card_id/states 过滤 + created_at 升序；queued_card_ids 仅 queued 且带卡。"""
    waitq.msg_enqueue("m1", 9, "s-1", "a", card_id=5)
    waitq.msg_enqueue("m2", 9, "s-1", "b")
    waitq.msg_enqueue("m3", 9, "s-2", "c", card_id=6)
    waitq.msg_claim("m2")
    assert [r["id"] for r in waitq.msg_rows(sid="s-1")] == ["m1", "m2"]
    assert [r["id"] for r in waitq.msg_rows(sid="s-1", states=("queued",))] == ["m1"]
    assert waitq.msg_queued_card_ids() == {5, 6}
    waitq.msg_finish("m2", "done")
    assert waitq.msg_queued_card_ids() == {5, 6}          # m2 无卡、终态不计
    waitq.msg_claim("m1")                                 # finish 只认 running（简报漏 claim，补上）
    waitq.msg_finish("m1", "done")
    assert waitq.msg_queued_card_ids() == {6}


def test_msg_cancel_and_recover_fail():
    """cancel 幂等（queued 守卫）；recover_fail 把 queued/running 记 error。"""
    waitq.msg_enqueue("m1", 9, "s-1", "hi")
    assert waitq.msg_cancel("m1", "已取消") is True
    assert waitq.msg_cancel("m1") is False
    row = waitq.msg_get("m1")
    assert row["state"] == "cancelled" and row["error"] == "已取消"
    waitq.msg_enqueue("m2", 9, "s-2", "hi")
    waitq.msg_claim("m2")
    assert waitq.msg_recover_fail("m2") is True           # 服务重启中断
    assert waitq.msg_get("m2")["state"] == "error"
    assert "服务重启中断" in waitq.msg_get("m2")["error"]


def test_msg_prune_keeps_active_and_recycles_old_terminal():
    """prune 等价迁移：终态超期回收、活跃行不回收、总数上限删最旧终态。"""
    waitq.msg_enqueue("m1", 9, "s-1", "hi")
    waitq.msg_claim("m1")
    waitq.msg_finish("m1", "done")
    with db.connect() as conn:                            # 人为把终态做旧
        conn.execute("UPDATE chat_msgs SET ended_at=? WHERE id=?",
                     (int(time.time() * 1000) - 601_000, "m1"))
    assert waitq.msg_prune(keep_sec=600, max_rows=200) == 1
    assert waitq.msg_get("m1") is None
    waitq.msg_enqueue("m2", 9, "s-2", "hi")
    assert waitq.msg_prune(keep_sec=600, max_rows=200) == 0
    assert waitq.msg_get("m2")["state"] == "queued"       # 活跃行不回收


def test_cancel_all_active_exclude_kind_tuple():
    """exclude_kind 接受元组（P3 recover：answer+msg 双存活；字符串单参兼容）。"""
    waitq.enqueue(waitq.KIND_TASK, 971, 1)
    waitq.enqueue(waitq.KIND_ANSWER, 972, 1)
    waitq.msg_enqueue("m1", 1, "s", "hi")
    n = waitq.cancel_all_active("服务重启（影子期）",
                                exclude_kind=(waitq.KIND_ANSWER, waitq.KIND_MSG))
    assert n == 1
    assert waitq.get_active(waitq.KIND_ANSWER, 972) is not None
    assert waitq.get_active(waitq.KIND_MSG, "m1") is not None
    assert waitq.cancel_all_active("清理", exclude_kind=waitq.KIND_MSG) == 1  # str 兼容（answer 清、msg 留）


def _mk_card(pid=9):
    """真实卡片行（enqueue_card 的投影写需要）。"""
    return db.insert_board_card(pid, f"排队卡-{uuid.uuid4().hex[:6]}")


def test_enqueue_card_atomic_row_and_placeholder():
    """enqueue_card 一事务写等待项+占位投影；幂等复用行且条件写不覆盖占位文案。"""
    pid = 9
    cid = _mk_card(pid)
    waitq.enqueue_card(cid, pid, extra="改一下", from_column="review")
    row = waitq.get_active(waitq.KIND_CARD, cid)
    assert row["state"] == "waiting" and row["project_id"] == pid
    assert json.loads(row["meta"]) == {"extra": "改一下", "from_column": "review"}
    card = db.get_board_card(cid)
    assert (card["column_key"], card["block_kind"]) == ("doing", "queue")
    assert card["block_text"] == "排队等待：统一队列" and card["scheduled_at"] is None
    wid = row["id"]
    assert waitq.enqueue_card(cid, pid) == wid            # 幂等复用（位次不动）
    waitq.set_card_wait_placeholder(cid, block_text="")   # answer 排队路径占位
    waitq.enqueue_card(cid, pid)                          # 条件写：不覆盖空文案
    assert db.get_board_card(cid)["block_text"] == ""


def test_insert_card_after_prefix_geometry_and_atomic():
    """insert_card_after_prefix（v2b T2，v2a 终审契约原子变体）：续跑/手动恢复
    专用写入口——一个事务内写等待项行（位次=前缀后/等待区最前，与
    insert_after_prefix 同几何）+ 占位投影（P4 单写原子红线：行+占位同事务，
    崩溃窗不留「行无占位」被占位失效摘除）；meta/幂等复用/占位条件写语义与
    enqueue_card 逐字一致，仅位次不同（幂等复用不重新提前）。"""
    pid = 9
    cid_running, cid_wait, cid = _mk_card(pid), _mk_card(pid), _mk_card(pid)
    with db.connect() as conn:                       # 运行前缀行（seq=1.0）
        conn.execute(
            "INSERT INTO wait_items (project_id, kind, target_id, state, seq,"
            " created_at, meta) VALUES (?,'card',?,'running',1.0,?,'{}')",
            (pid, str(cid_running), db.now_str()))
    waitq.enqueue_card(cid_wait, pid)                # 等待区既有行（seq=2.0）
    waitq.insert_card_after_prefix(cid, pid, extra="续改", from_column="review")
    row = waitq.get_active(waitq.KIND_CARD, cid)
    assert row["state"] == "waiting"
    assert 1.0 < row["seq"] < waitq.get_active(
        waitq.KIND_CARD, cid_wait)["seq"]            # 前缀后、等待区最前
    assert json.loads(row["meta"]) == {"extra": "续改", "from_column": "review"}
    card = db.get_board_card(cid)                    # 占位投影同事务在场
    assert (card["column_key"], card["block_kind"]) == ("doing", "queue")
    assert card["block_text"] == "排队等待：统一队列"
    wid = row["id"]
    assert waitq.insert_card_after_prefix(cid, pid) == wid   # 幂等复用（位次不动）
    assert waitq.get_item(wid)["seq"] == row["seq"]
    waitq.set_card_wait_placeholder(cid, block_text="")      # answer 路径空文案
    waitq.insert_card_after_prefix(cid, pid)                 # 条件写：不覆盖
    assert db.get_board_card(cid)["block_text"] == ""


def test_insert_card_after_prefix_rollback_keeps_both_sides():
    """原子变体崩溃窗双方向钉：事务内任一写入失败整体回滚——既不留等待项行
    （无占位行会被「占位失效」摘除路径误伤合法行），也不留占位投影。
    反 mock 在**第二次** db.now_str（占位投影 UPDATE 的 updated_at）失败
    （v2b T3 携带项）：行 INSERT（第一次 now_str）已执行——分段两事务实现
    此处会留下已提交的行，单事务实现则整体回滚，据此真正区分。"""
    pid = 9
    cid = _mk_card(pid)
    real_now = waitq.db.now_str
    calls = {"n": 0}

    def _boom():
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("占位投影写入中崩")
        return real_now()

    waitq.db.now_str = _boom
    try:
        with pytest.raises(RuntimeError):
            waitq.insert_card_after_prefix(cid, pid)
    finally:
        waitq.db.now_str = real_now
    assert calls["n"] == 2                                   # 行 INSERT 已发生
    assert waitq.get_active(waitq.KIND_CARD, cid) is None    # 方向一：行随事务回滚
    card = db.get_board_card(cid)
    assert card["column_key"] == "todo" and card["block_kind"] is None  # 方向二：无占位
    # 恢复后正常写入：行+占位同时在场（单事务双写再确认）
    waitq.insert_card_after_prefix(cid, pid)
    assert waitq.get_active(waitq.KIND_CARD, cid) is not None
    assert db.get_board_card(cid)["block_kind"] == "queue"


def test_cancel_card_wait_guards_both_sides():
    """cancel_card_wait：行取消+占位清除；行已终态/占位已改则各自 no-op。"""
    cid = _mk_card()
    waitq.enqueue_card(cid, 9)
    assert waitq.cancel_card_wait(cid, "卡片出队") is True
    assert waitq.get_active(waitq.KIND_CARD, cid) is None   # cancelled 终态
    assert db.get_board_card(cid)["block_kind"] is None
    assert waitq.cancel_card_wait(cid, "再取消") is False   # 幂等
    cid2 = _mk_card()
    waitq.enqueue_card(cid2, 9)
    db.update_board_card(cid2, block_kind="manual", block_text="手动")  # 调用方已改占位
    assert waitq.cancel_card_wait(cid2, "拖离") is True
    assert db.get_board_card(cid2)["block_kind"] == "manual"  # 占位守卫：不覆盖


def test_card_enqueue_gate_keeps_running_row():
    """v3a 入队幂等门禁（I5：同一卡同一时刻至多一条活跃 c: 行）：已有
    running/starting 行（起跑证实后跨轮存活）时 enqueue_card /
    insert_card_after_prefix 不得插第二行、不得把 running 打回 waiting、也不得
    写「排队等待」占位（卡在跑而非排队——写占位会让展示与事实相反）。"""
    pid = 9
    cid = _mk_card(pid)
    waitq.enqueue_card(cid, pid)
    rid = waitq.get_active(waitq.KIND_CARD, cid)["id"]
    assert waitq.claim(rid, "worker") is True
    waitq.mark_running(waitq.KIND_CARD, cid)               # 起跑证实 → 跨轮 running
    seq0 = waitq.get_item(rid)["seq"]
    db.update_board_card(cid, column_key="review", block_kind=None,
                         block_text="")                    # 用户视角的当前列
    assert waitq.enqueue_card(cid, pid, extra="再点一次",
                              from_column="review") == rid
    row = waitq.get_item(rid)
    assert row["state"] == "running" and row["seq"] == seq0   # 行态/位次都不动
    card = db.get_board_card(cid)
    assert (card["column_key"], card["block_kind"]) == ("review", None)   # 无排队占位
    assert waitq.insert_card_after_prefix(cid, pid) == rid    # 原子变体同门禁
    assert waitq.get_item(rid)["state"] == "running"
    with db.connect() as conn:                                # 表里没有第二行
        n = conn.execute("SELECT COUNT(*) n FROM wait_items WHERE kind='card'"
                         " AND target_id=?", (str(cid),)).fetchone()["n"]
    assert n == 1
    # 反面对照：waiting 行维持现状语义（复用 + 占位投影照常）
    cid2 = _mk_card(pid)
    wid = waitq.enqueue_card(cid2, pid)
    assert waitq.enqueue_card(cid2, pid) == wid
    assert waitq.get_active(waitq.KIND_CARD, cid2)["state"] == "waiting"
    assert db.get_board_card(cid2)["block_kind"] == "queue"


def test_force_start_reuses_active_row():
    """v3a 落表门禁：insert_card_force_start 撞活跃行改**幂等复用**（旧口径
    按编程错误上抛）——不插第二行、不改行态（force 前调用方已 cancel_card_wait
    清残留；再撞=并发 force / 起跑证实后的跨轮存活行，把行打回 starting 会破坏
    行即条目语义）。"""
    pid = 9
    cid = _mk_card(pid)
    wid = waitq.enqueue_card(cid, pid)
    assert waitq.claim(wid, "worker") is True
    waitq.mark_running(waitq.KIND_CARD, cid)               # 跨轮 running 行在场
    rid, seq = waitq.insert_card_force_start(cid, pid, meta={"extra": "force"})
    assert rid == wid and waitq.get_item(wid)["state"] == "running"
    assert waitq.get_item(wid)["seq"] == seq
    with db.connect() as conn:
        n = conn.execute("SELECT COUNT(*) n FROM wait_items WHERE kind='card'"
                         " AND target_id=?", (str(cid),)).fetchone()["n"]
    assert n == 1
    # waiting 行同样复用（不再撞活跃唯一索引上抛）
    cid2 = _mk_card(pid)
    wid2 = waitq.enqueue_card(cid2, pid)
    rid2, _ = waitq.insert_card_force_start(cid2, pid)
    assert rid2 == wid2
    assert waitq.get_item(wid2)["state"] == "waiting"


def test_msg_rows_order_tiebreak():
    """同毫秒消息按 id 升序（必带⑥）。"""
    waitq.msg_enqueue("mb", 9, "s", "b")
    waitq.msg_enqueue("ma", 9, "s", "a")
    # 同毫秒前提无法靠两次自然写入保证（msg_enqueue 每次独立连接+事务提交，
    # 实测相隔约 7ms，跨毫秒时按 created_at 本就 mb 在前），显式钉成同一毫秒
    # 再验证 tie-break，同时消除时钟两向抖动。
    with db.connect() as conn:
        conn.execute("UPDATE chat_msgs SET created_at=1789862872274 WHERE sid='s'")
    assert [r["id"] for r in waitq.msg_rows(sid="s")] == ["ma", "mb"]


# ---------- P5 面已随 v3d 收口：租约 API/表退场（对账与处置用例见下段） ----------

def test_reconcile_units_evidence_verdicts():
    """行版对账（v3c）：任务/消息行状态=内建 DB 证据；卡行删=死；web busy=活；
    未知=保留；可证死 → 行收口（标签「启动对账：可证明失效」）。"""
    tid = db.insert_task(1, "rc", 0, "不复测", "rounds", 1)
    db.update_task(tid, status="interrupted")   # 终态（queued=新生窗口不证死，见下例）
    waitq.enqueue(waitq.KIND_TASK, tid, 1)
    waitq.enqueue(waitq.KIND_MSG, "m-x", 2)                     # chat_msgs 无该行
    waitq.enqueue(waitq.KIND_CARD, 987654, 3)                   # 卡行不存在
    cid = db.insert_board_card(4, "在跑卡")
    rid_live = waitq.enqueue(waitq.KIND_CARD, cid, 4)
    out = waitq.reconcile_units(
        probe=lambda r: "alive" if r["target_id"] == str(cid) else None)
    v = {d["key"]: (d["verdict"], d["closed"]) for d in out}
    assert v[f"c:{cid}"] == ("alive", False) and waitq.get_item(rid_live) is not None
    assert v["c:987654"] == ("dead", True)
    assert v["m:m-x"] == ("dead", True)                         # 消息行缺失
    assert v[f"t:{tid}"] == ("dead", True)                      # 任务终态（非 queued/running）
    assert waitq.get_active(waitq.KIND_CARD, 987654) is None    # 行已收口
    assert any(k.startswith("t:") for k in v)                   # 键为成员键（行键空间）


def test_reconcile_units_close_out_split_by_state():
    """可证死行收口分流（与 runner.recover 同行口径）：起步前（waiting/starting）
    → cancelled（reason 落 meta.cancel_reason）；起步后（running/finishing）→
    failed（reason 落 meta.error）。"""
    w = waitq.enqueue(waitq.KIND_CARD, 970001, 1)               # waiting 行
    s = waitq.enqueue(waitq.KIND_CARD, 970002, 1)
    assert waitq.claim(s, "worker") is True                     # starting 行
    r = waitq.enqueue(waitq.KIND_CARD, 970003, 1)
    assert waitq.claim(r, "worker") is True
    assert waitq.mark_running(waitq.KIND_CARD, 970003) is True   # running 行
    waitq.reconcile_units()
    assert waitq.get_item(w)["state"] == "cancelled"
    assert waitq.get_item(s)["state"] == "cancelled"
    assert waitq.get_item(r)["state"] == "failed"
    assert json.loads(waitq.get_item(w)["meta"])["cancel_reason"] == "启动对账：可证明失效"
    assert json.loads(waitq.get_item(s)["meta"])["cancel_reason"] == "启动对账：可证明失效"
    assert json.loads(waitq.get_item(r)["meta"])["error"] == "启动对账：可证明失效"


def test_selfcheck_units_provable_dead_only():
    """处置（行版）：可证明失效自动收口；unknown（探测失败/web idle）只告警不动。
    告警面只覆盖**已认领的在跑行**（v3c 修复轮 Important-1）：waiting 行不告警
    （其静默面见 `test_selfcheck_units_silent_on_healthy_backlog`）。"""
    waitq.enqueue(waitq.KIND_CARD, 980001, 1)                   # 卡行已删
    cid = db.insert_board_card(2, "idle 卡")
    rid_idle = waitq.enqueue(waitq.KIND_CARD, cid, 2)
    assert waitq.claim(rid_idle, "worker") is True              # starting（在跑行）
    problems = waitq.selfcheck_units(
        probe=lambda r: "dead" if r["target_id"] == str(cid) else "unknown")
    assert waitq.get_active(waitq.KIND_CARD, 980001) is None    # 可证死 → 收口
    assert waitq.get_active(waitq.KIND_CARD, cid) is not None   # unknown → 保留
    assert any(f"c:{cid}" in p and "状态不明" in p for p in problems)   # 告警行存在
    assert any("c:980001" in p for p in problems)               # 收口清单行存在
    row = waitq.get_item(rid_idle)                              # 告警不改行
    assert row["state"] == "starting"


def test_selfcheck_units_silent_on_healthy_backlog(monkeypatch):
    """Important-1 回归（修复轮）：健康积压必须静默——waiting 行（排队卡/排队
    消息/排队答案）天然无证据、ext: 行生灭归调和器，均不属「状态不明」告警面
    （排队行不在跑，无告警面可言）。此前逐条遍历会把 N 条积压变成每
    60s N 行日志（违背「健康时静默」并淹没 R12 报告）。
    同时钉住：waiting 行**免探针**（无会话可探，省 N 次 REST）。
    min_age=0 关掉年龄豁免，让用例直接打在告警闸上（严格形态）。"""
    cid = db.insert_board_card(1, "排队卡")
    waitq.enqueue_card(cid, 1)                                  # 排队卡（waiting c:）
    waitq.msg_enqueue("m-backlog", 1, "s-1", "排队消息")         # 排队消息（waiting m:）
    waitq.enqueue(waitq.KIND_ANSWER, cid, 1)                    # 待送达答案（waiting a:）
    tid = db.insert_task(1, "排队任务", 0, "不复测", "rounds", 1)  # queued 任务
    waitq.enqueue(waitq.KIND_TASK, tid, 1)
    ext_card = db.insert_board_card(1, "外部会话卡")             # ext: 行（running 入场）
    waitq.insert_ext(1, ext_card, "s-ext")
    probes = []

    def _probe(row):
        probes.append((row["kind"], row["state"]))
        return "unknown"

    assert waitq.selfcheck_units(probe=_probe, min_age=0) == []  # 零告警行
    # waiting 行免探针；唯一被探的是 running 的 ext 行（其告警面归调和器）
    assert probes == [(waitq.KIND_EXT, "running")]
    # 积压仍健康：行态不动
    assert waitq.get_active(waitq.KIND_CARD, cid)["state"] == "waiting"
    assert waitq.get_active(waitq.KIND_MSG, "m-backlog")["state"] == "waiting"
    assert waitq.get_active(waitq.KIND_TASK, tid)["state"] == "waiting"
    # dead 收口面不受告警闸影响：waiting 泄漏行（目标已删）照常收口
    waitq.enqueue(waitq.KIND_MSG, "m-ghost", 1)                 # chat_msgs 无此行
    problems = waitq.selfcheck_units(probe=_probe, min_age=0)
    assert any("自检收口可证死行: m:m-ghost" in p for p in problems)
    assert waitq.get_active(waitq.KIND_MSG, "m-ghost") is None


def test_reconcile_units_pid_evidence_from_row():
    """R11④ 进程证据迁行（v3c）：卡行 evidence.pid 已退 → 可证死收口；pid 存活
    → 确活保留。两卡行均存在——排除「卡行已删」判据，钉 pid 一支的决定性
    （重启对账收口 CLI 卡残留运行行的主路径）。"""
    dead = subprocess.Popen([sys.executable, "-c", "pass"])
    dead.wait()                                        # 已退出并回收的 pid
    c_dead = db.insert_board_card(1, "pid死卡")
    c_live = db.insert_board_card(2, "pid活卡")
    d = waitq.enqueue(waitq.KIND_CARD, c_dead, 1)
    assert waitq.claim(d, "worker") is True
    assert waitq.mark_running(waitq.KIND_CARD, c_dead) is True
    waitq.mark_evidence(waitq.KIND_CARD, c_dead, {"pid": dead.pid})
    lv = waitq.enqueue(waitq.KIND_CARD, c_live, 2)
    assert waitq.claim(lv, "worker") is True
    assert waitq.mark_running(waitq.KIND_CARD, c_live) is True
    waitq.mark_evidence(waitq.KIND_CARD, c_live, {"pid": os.getpid()})
    out = waitq.reconcile_units()
    v = {d["key"]: (d["verdict"], d["closed"]) for d in out}
    assert v[f"c:{c_dead}"] == ("dead", True)          # 进程已退 → 对账收口
    assert v[f"c:{c_live}"] == ("alive", False)        # 进程存活 → 保留
    assert waitq.get_item(d)["state"] == "failed"      # 起步后收口：failed
    assert waitq.get_item(d)["state"] != "cancelled"
    assert waitq.get_active(waitq.KIND_CARD, c_live) is not None


def test_reconcile_units_starting_window_exemption():
    """评审 Important-1 回归（行版）：t:/m: 对应任务/消息行 **queued** = 拾取→
    行置 running 的新生窗口（worker import 期即起，recover→reconcile 期间可拾取），
    判 unknown 保留——宁多等不误杀，且与行龄无关；**终态行/缺行无论行龄照常裁死**
    （重启收口语义不退化，顺带钉住「不得改成 blanket 行龄豁免」——年轻+终态也裁）。"""
    # 新生窗口：worker 已拾取，msg_claim 置 running 之前（chat_msgs 仍 queued）
    waitq.msg_enqueue("m-new", 1, "s1", "新生窗口")
    waitq.enqueue(waitq.KIND_MSG, "m-new", 1)
    # 做旧同形态（queued 行 + 老时间戳=崩溃残留）：同口径保留
    waitq.msg_enqueue("m-old", 2, "s2", "做旧queued")
    waitq.enqueue(waitq.KIND_MSG, "m-old", 2)
    # 年轻 + 终态（recover 已记 error）：照常裁死
    waitq.msg_enqueue("m-err", 3, "s3", "已记败")
    waitq.msg_recover_fail("m-err")
    waitq.enqueue(waitq.KIND_MSG, "m-err", 3)
    # 任务两形态：queued（做旧）保留 / interrupted（做旧）裁死
    tid_q = db.insert_task(4, "queued任", 0, "不复测", "rounds", 1)      # 默认 queued
    waitq.enqueue(waitq.KIND_TASK, tid_q, 4)
    tid_t = db.insert_task(5, "被打断", 0, "不复测", "rounds", 1)
    db.update_task(tid_t, status="interrupted")
    waitq.enqueue(waitq.KIND_TASK, tid_t, 5)
    with db.connect() as conn:                         # 把 m-old/t 两条做旧
        conn.execute("UPDATE wait_items SET created_at='2020-01-01 00:00:00'"
                     " WHERE target_id IN (?,?,?)",
                     ("m-old", str(tid_q), str(tid_t)))
    out = waitq.reconcile_units()
    v = {d["key"]: (d["verdict"], d["closed"]) for d in out}
    assert v["m:m-new"] == ("unknown", False)          # 新生窗口：不裁
    assert v["m:m-old"] == ("unknown", False)          # 做旧 queued 同口径不裁
    assert v["m:m-err"] == ("dead", True)              # 终态：年轻也裁
    assert v[f"t:{tid_q}"] == ("unknown", False)       # 任务 queued 同口径
    assert v[f"t:{tid_t}"] == ("dead", True)           # 任务终态照裁
    assert waitq.get_active(waitq.KIND_MSG, "m-new") is not None
    assert waitq.get_active(waitq.KIND_MSG, "m-old") is not None
    assert waitq.get_active(waitq.KIND_TASK, tid_q) is not None
    assert waitq.get_active(waitq.KIND_MSG, "m-err") is None
    assert waitq.get_active(waitq.KIND_TASK, tid_t) is None


def test_selfcheck_units_min_age_exemption():
    """行年龄豁免（v3c）：行自最近一次活动（last_seen 心跳回落 claimed_at/
    created_at）不足 min_age 的跳过处置与告警；做旧后照常按证据裁活。缺省
    min_age=0 保持纯函数旧语义。注：t:/m: 对应行 queued 的新生窗口另由判据
    豁免（评审 Important-1，与行龄无关），本例用终态行钉 min_age 一支
    （两者互补防御）。"""
    tid = db.insert_task(1, "young", 0, "不复测", "rounds", 1)
    db.update_task(tid, status="interrupted")          # 终态=可证死证据面
    rid = waitq.enqueue(waitq.KIND_TASK, tid, 1)
    assert waitq.selfcheck_units(min_age=30) == []     # 新生豁免：不处置不告警
    assert waitq.get_active(waitq.KIND_TASK, tid) is not None
    with db.connect() as conn:                         # 人为做旧越过豁免窗
        conn.execute("UPDATE wait_items SET created_at='2020-01-01 00:00:00'"
                     " WHERE id=?", (rid,))
    problems = waitq.selfcheck_units(min_age=30)
    assert waitq.get_active(waitq.KIND_TASK, tid) is None     # 做旧后照常裁死收口
    assert any("自检收口可证死行" in p for p in problems)
    # waiting 行走取消分支（起步前）：reason 落 meta.cancel_reason
    assert json.loads(waitq.get_item(rid)["meta"])["cancel_reason"] == "周期自检：可证明失效"
    # 新鲜心跳=活性佐证：即便 created_at 做旧也不裁（行证据优先）
    rid2 = waitq.enqueue(waitq.KIND_TASK, tid, 1)
    waitq.touch_unit(waitq.KIND_TASK, tid, "任务在跑心跳")
    assert waitq.selfcheck_units(min_age=30) == []             # 心跳新鲜 → 年龄豁免
    assert waitq.get_active(waitq.KIND_TASK, tid) is not None
    # last_seen 做旧后：心跳不再豁免 → 终态证据照裁
    with db.connect() as conn:
        conn.execute("UPDATE wait_items SET last_seen=? WHERE id=?",
                     (time.time() - 3600, rid2))
    assert any("自检收口可证死行" in p for p in waitq.selfcheck_units(min_age=30))
    assert waitq.get_active(waitq.KIND_TASK, tid) is None


def test_selfcheck_i1_violation_report():
    """R12 新增 I1 违约报告（纯报告只告警不改行）：卡不在「正在开发」容器却有
    活跃 c: 行 → 报告；doing 卡不报；卡行已删同列报告。"""
    cid = db.insert_board_card(1, "待在审核卡")
    rid = waitq.enqueue_card(cid, 1)
    db.update_board_card(cid, column_key="review")              # 卡已离开开发容器
    problems = waitq.selfcheck()
    assert any("I1 违约" in p and f"卡 {cid} " in p for p in problems)
    assert waitq.get_item(rid)["state"] == "waiting"            # 只告警不改行
    db.update_board_card(cid, column_key="doing")               # 归位开发容器
    assert not any("I1 违约" in p for p in waitq.selfcheck())
    db.update_board_card(cid, column_key="blocked", block_kind="manual")
    waitq.cancel_card_wait(cid, "出队")                          # 出队后无活跃 c: 行
    assert not any("I1 违约" in p for p in waitq.selfcheck())
    # 卡行已删：同样报告（行无主）
    waitq.enqueue_card(987655, 1)
    assert any("卡行已删" in p for p in waitq.selfcheck())


def test_wait_items_evidence_columns_migrate_and_idempotent():
    """v3c 迁移（db.migrate）：wait_items 补 last_seen/evidence 两列——旧形态表
    （无两列）加列后存量行取列默认值（0 / 空串）；重复 migrate 幂等（列已在即
    跳过、不重复加列）。手法同库形态迁移用例：造旧形态再 migrate；真表暂存为
    _bak 并在用例尾部还原（含其索引），避免污染后续用例。"""
    with db.connect() as conn:
        conn.execute("ALTER TABLE wait_items RENAME TO wait_items_v3c_bak")
        conn.execute(
            "CREATE TABLE wait_items ("
            " id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL,"
            " kind TEXT NOT NULL, target_id TEXT NOT NULL, state TEXT NOT NULL"
            " DEFAULT 'waiting', seq INTEGER NOT NULL, created_at TEXT NOT NULL,"
            " claimed_at TEXT, claimed_by TEXT, ended_at TEXT,"
            " not_before REAL NOT NULL DEFAULT 0,"
            " retries INTEGER NOT NULL DEFAULT 0, meta TEXT NOT NULL DEFAULT '{}')")
        conn.execute("INSERT INTO wait_items (project_id, kind, target_id, state,"
                     " seq, created_at) VALUES (7,'card','901','waiting',1,"
                     " '2026-01-01 00:00:00')")
    try:
        db.migrate()                                    # 守卫式加列（旧库路径）
        with db.connect() as conn:
            row = conn.execute("SELECT last_seen, evidence FROM wait_items"
                               " WHERE target_id='901'").fetchone()
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(wait_items)")}
        assert {"last_seen", "evidence"} <= cols
        assert row["last_seen"] == 0 and row["evidence"] == ""     # 存量行默认值
        db.migrate()                                    # 幂等：再跑不炸、列集不变
        with db.connect() as conn:
            cols2 = {r["name"] for r in conn.execute("PRAGMA table_info(wait_items)")}
        assert cols2 == cols
    finally:
        with db.connect() as conn:                      # 还原真表（索引随表回位）
            conn.execute("DROP TABLE wait_items")
            conn.execute("ALTER TABLE wait_items_v3c_bak RENAME TO wait_items")


def test_leases_table_dropped_migration_and_idempotent():
    """v3d 迁移（db.migrate）：存量库的 `leases` 表（含 P5 旧主键形态）被
    幂等 DROP——租约层删除后无任何读口，历史行直接丢弃；重复 migrate 不炸。"""
    with db.connect() as conn:                          # 造旧形态表 + 存量行
        conn.execute("CREATE TABLE leases (project_id INTEGER PRIMARY KEY,"
                     " owner_kind TEXT NOT NULL, owner_ref TEXT NOT NULL,"
                     " since REAL NOT NULL, last_seen REAL NOT NULL,"
                     " ext TEXT NOT NULL DEFAULT '{}')")
        conn.execute("CREATE INDEX idx_leases_project ON leases(project_id)")
        conn.execute("INSERT INTO leases VALUES (7,'card','c:old',1.0,1.0,'{\"pid\": 9}')")
        conn.execute("INSERT INTO leases VALUES (8,'msg','m:old',2.0,2.0,'{}')")
    db.migrate()                                        # 幂等 DROP（表 + 索引）
    with db.connect() as conn:
        names = {r["name"] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='leases'")}
        idx = {r["name"] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%lease%'")}
    assert names == set() and idx == set()
    db.migrate()                                        # 再跑一次：表已不在，零改写不炸
    with db.connect() as conn:
        assert conn.execute(
            "SELECT COUNT(*) n FROM sqlite_master WHERE name='leases'").fetchone()["n"] == 0
