#!/usr/bin/env python3
"""任务上列三列（v2c T4，裁决 R16；v2 §2.1【已定】列映射）：

board_payload 的 active_tasks 任务条目从 doing 单列扩为三列上映——
doing：queued/running（现状不回归，运行中在前、排队按创建先后≈统一队列 FIFO）；
review：failed/interrupted/stopped；done：done（终态两列按结束时间新→旧）。
列统计口径不变（board_counts_many 只数卡片，db.py:863-883——任务不计数）；
任务徽标读 DB status（specQ §7 注记保留）；条目只读。
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import uuid

import board
import db


def _project():
    """真实项目行（agent_path 空串=非 web 族，web_busy_map 直接 {} 不触 REST）。"""
    uid = uuid.uuid4().hex[:8]
    return db.insert_project(0, f"tcol-{uid}", f"/tmp/tcol-{uid}", "",
                             f"/tmp/tcol-{uid}/work")


def _mk_task(pid, name, status, created="2026-09-20 10:00:00", ended=None):
    """种子任务行（status/ended_at 走白名单 update；created_at 不在白名单走 SQL）。"""
    tid = db.insert_task(pid, name, 0, "不复测", "rounds", 1)
    fields = {"status": status}
    if ended is not None:
        fields["ended_at"] = ended
    db.update_task(tid, **fields)
    with db.connect() as conn:
        conn.execute("UPDATE tasks SET created_at=? WHERE id=?", (created, tid))
    return tid


def test_task_entries_three_columns():
    """列映射全格（R16）：queued/running→doing、failed/interrupted/stopped→
    review、done→done；条目标 column 字段；doing 序=运行中在前+创建先后，
    review/done 序=结束时间新→旧；字段形状现状保留。"""
    pid = _project()
    tq = _mk_task(pid, "排队任务", "queued", created="2026-09-20 10:01:00")
    tr = _mk_task(pid, "在跑任务", "running", created="2026-09-20 10:02:00")
    tf = _mk_task(pid, "失败任务", "failed", ended="2026-09-20 11:00:00")
    ti = _mk_task(pid, "中断任务", "interrupted", ended="2026-09-20 11:01:00")
    ts = _mk_task(pid, "停止任务", "stopped", ended="2026-09-20 11:02:00")
    td = _mk_task(pid, "完成任务", "done", ended="2026-09-20 12:00:00")
    td2 = _mk_task(pid, "完成任务2", "done", ended="2026-09-20 12:30:00")
    payload = board.board_payload(pid)
    tasks = payload["active_tasks"]
    by_col = {}
    for t in tasks:
        by_col.setdefault(t["column"], []).append(t["id"])
    assert by_col["doing"] == [tr, tq]          # 运行中在前、排队按创建先后（现状不回归）
    assert by_col["review"] == [ts, ti, tf]     # →review，结束时间新→旧
    assert by_col["done"] == [td2, td]          # →done，结束时间新→旧
    # 全量枚举齐（无遗漏/无多余——六态全上映）
    assert sorted(t["id"] for t in tasks) == sorted([tq, tr, tf, ti, ts, td, td2])
    # 字段形状现状保留（specQ §7 注记：任务徽标读 DB status；条目只读数据源）
    entry = next(t for t in tasks if t["id"] == tq)
    assert entry["status"] == "queued" and entry["task_type"] == "normal"
    assert "session_id" in entry and "error" in entry \
        and "current_round" in entry and "ended_at" in entry


def test_board_counts_exclude_tasks():
    """列统计口径不变（R16：board_counts_many 只数卡片）——任务三列上映后
    计数不受任务影响（卡片才计入；排队/终态任务一律不数）。"""
    pid = _project()
    cid = db.insert_board_card(pid, "卡片1")
    db.insert_board_card(pid, "卡片2")          # todo 卡本就不计数
    db.update_board_card(cid, column_key="doing")
    _mk_task(pid, "在跑任务", "running")
    _mk_task(pid, "排队任务", "queued")
    _mk_task(pid, "失败任务", "failed", ended="2026-09-20 11:00:00")
    _mk_task(pid, "完成任务", "done", ended="2026-09-20 12:00:00")
    counts = db.board_counts_many([pid])[pid]
    assert counts == {"doing": 1, "blocked": 0, "review": 0}   # 只数卡片（doing 卡 1 张）
