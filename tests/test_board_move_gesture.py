# doing→doing 同列拖放手势映射（v2c T1，裁决 R10；v2 §2.4）：
#   ① 等待卡跨过运行位往上拖（before 运行卡）= force 强制运行（落哪算哪）；
#   ② 运行卡拖到等待卡后面（落点上方有等待卡）= 停止当前任务 → 落待审核
#      （确认框是前端 T3 的事，服务端幂等执行）；
#   ③ 等待区内部互拖 = waitq.reposition 调序改队序（仅 UPDATE seq，行 id 稳定；
#      拾取/展示单轨接线在 T2）；
#   ④ 运行位内部互拖 = no-op（200，位次/状态零变化）。
# 开路断言：doing 目标 before_id 不再被丢弃、doing→doing 不再直接返回；
# 跨列移动（doing↔其他列）现行语义零回归。
# 收口轮 C1 补钉：「运行位」判据=行态 ∪ 在管条目（行即持有者，v3d 起唯一判据；
# 正常起跑稳态卡的 c: 行 running 跨轮存活、行态单看即可认运行位；起跑/收尾毫秒
# 窗口由在管条目兜底——单看行态会把卡判成非队列卡，
# 手势静默 no-op 而前端照弹确认框=确认框说谎）。
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import threading
import time
import uuid

import pytest

import board
import db
import runner
import waitq


@pytest.fixture(autouse=True)
def _clean_waitq_tables():
    """每例前后清 waitq 两表（本文件种子真实等待/运行行；conftest 临时库）。"""
    def _clean():
        with db.connect() as conn:
            for t in ("wait_items", "chat_msgs"):
                conn.execute(f"DELETE FROM {t}")
    _clean()
    yield
    _clean()


def _project():
    """真实项目行（agent_path 空串=非 web 族，_ext_refresh 直接 False 不触 REST）。"""
    uid = uuid.uuid4().hex[:8]
    return db.insert_project(0, f"gest-{uid}", f"/tmp/gest-{uid}", "",
                             f"/tmp/gest-{uid}/work")


def _bare_instance():
    """真实 submit_card/unit_state/card_finished 的裸 runner 单例（无 worker 线程）。"""
    r = runner.Runner.__new__(runner.Runner)
    r._cond = threading.Condition()
    return r


def _seed_running_card(pid, title, seq):
    """种子一张运行位卡：doing 列 + c: running 行（行即成员=运行前缀，行即占位）。"""
    cid = db.insert_board_card(pid, title)
    db.update_board_card(cid, column_key="doing")
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO wait_items (project_id, kind, target_id, state, seq,"
            " created_at, meta) VALUES (?,'card',?,'running',?,?,'{}')",
            (pid, str(cid), float(seq), db.now_str()))
    return cid


def _seed_waiting_card(pid, title):
    """种子一张等待区卡：waitq.enqueue_card = waiting 行 + doing/queue 占位。"""
    cid = db.insert_board_card(pid, title)
    waitq.enqueue_card(cid, pid)
    return cid


def _seed_armored_wait_card(pid, title):
    """等待区卡 + not_before 钉远期（C1 补钉专用）：防套件遗留野 worker（M5 独立
    清理任务）抢走本用例的种子行——v2c T1 台账既有手法（test_runner_pick_prefix
    同款）；手势判定不读 not_before，断言口径不变。"""
    cid = db.insert_board_card(pid, title)
    waitq.enqueue(waitq.KIND_CARD, cid, pid, not_before=time.time() + 3600)
    waitq.set_card_wait_placeholder(cid, "排队等待：统一队列")
    return cid


def _seed_rowless_running_card(pid, title):
    """种子一张**无活跃行**的「正常起跑稳态」卡（C1 形态）：doing 列、仅剩
    在管条目（`_RUNS`）表征——旧码手势静默 no-op 的根因形态（行已终态化）。
    v3b 起持有面=活跃 c: 行 ∨ 在管条目：本形态单独不再是运行位
    （见 test_rowless_landing_card_not_run_position），保留为「在管条目分支」
    回归的底板（停止手势经 _RUNS 判据照常成立）。"""
    cid = db.insert_board_card(pid, title)
    db.update_board_card(cid, column_key="doing")
    waitq.enqueue(waitq.KIND_CARD, cid, pid)
    waitq.finish_by_target(waitq.KIND_CARD, cid)      # 起跑路径：行终态化
    return cid


def _row(cid):
    return waitq.get_active(waitq.KIND_CARD, cid)


def test_wait_card_above_prefix_is_force(monkeypatch):
    """手势①：等待卡拖到运行位内/前（before_id=运行卡）→ force 语义起跑——
    v2b T4 落表机制（前缀尾+直入 starting，起跑证实 running）+ at=落点 seq
    区间（reposition 到目标运行行之前）；其余卡不动。"""
    pid = _project()
    rid = _seed_running_card(pid, "在跑卡", 1.0)
    w1 = _seed_waiting_card(pid, "等待卡1")
    w2 = _seed_waiting_card(pid, "等待卡2")
    inst = _bare_instance()
    monkeypatch.setattr(board.runner, "INSTANCE", inst)
    calls = []
    monkeypatch.setattr(board, "start_card",
                        lambda p, c, extra="": calls.append(c["id"]))
    monkeypatch.setattr(board, "run_pid", lambda c: 4321)
    card, err = board.move_card({"id": pid, "agent_path": ""}, w2, "doing",
                                before_id=rid)
    assert err is None
    assert calls == [w2]                              # force 直起会话
    row = _row(w2)
    assert row is not None and row["state"] == "running"   # 落表+证实运行
    assert row["seq"] < _row(rid)["seq"]              # at=落点：挪到在跑卡行之前
    assert row["evidence"] and _row(rid)["state"] == "running"   # 落表行带证据
    c = db.get_board_card(w2)
    assert c["column_key"] == "doing" and c["block_kind"] is None   # 占位清除
    assert _row(rid)["state"] == "running"            # 在跑卡不受影响
    assert _row(w1)["state"] == "waiting"             # 另一等待卡不动


def test_running_card_below_wait_card_stops(monkeypatch):
    """手势②：运行卡拖到等待卡后面（before_id=等待卡且其上方另有等待卡）→
    停止当前任务（复用既有离开 doing 路径）+ 落待审核；
    c: 运行行终态化（出队）；等待卡行不动。"""
    pid = _project()
    rid = _seed_running_card(pid, "在跑卡", 1.0)
    w1 = _seed_waiting_card(pid, "等待卡1")
    w2 = _seed_waiting_card(pid, "等待卡2")
    inst = _bare_instance()
    monkeypatch.setattr(board.runner, "INSTANCE", inst)
    calls = {"kill": []}

    class Proc:
        pid = 123
        def poll(self):
            return None

    monkeypatch.setattr(board, "_RUNS", {rid: {"proc": Proc()}})
    monkeypatch.setattr(board.platcompat, "kill_tree",
                        lambda p, s: calls["kill"].append(p))
    card, err = board.move_card({"id": pid, "agent_path": ""}, rid, "doing",
                                before_id=w2)
    assert err is None
    assert calls["kill"] == [123]                     # 先停会话
    c = db.get_board_card(rid)
    assert c["column_key"] == "review" and c["block_kind"] is None  # 落待审核
    assert _row(rid) is None                          # 运行行终态化（出队）
    assert _row(w1)["state"] == "waiting"             # 等待卡不动
    assert _row(w2)["state"] == "waiting"


def test_running_card_above_first_wait_card_noop(monkeypatch):
    """手势②边界：运行卡落在等待区最前（before_id=首等待卡，落点上方无等待
    卡）= 仍在运行位尾 → no-op（不停会话、不改列、队序零变化）——防同位
    拖放误停运行中会话。"""
    pid = _project()
    rid = _seed_running_card(pid, "在跑卡", 1.0)
    w1 = _seed_waiting_card(pid, "等待卡1")
    monkeypatch.setattr(board.runner, "INSTANCE", _bare_instance())
    calls = {"kill": []}

    class Proc:
        pid = 123
        def poll(self):
            return None

    monkeypatch.setattr(board, "_RUNS", {rid: {"proc": Proc()}})
    monkeypatch.setattr(board.platcompat, "kill_tree",
                        lambda p, s: calls["kill"].append(p))
    before = [(r["target_id"], r["seq"], r["state"])
              for r in waitq.active_items(pid)]
    card, err = board.move_card({"id": pid, "agent_path": ""}, rid, "doing",
                                before_id=w1)
    assert err is None
    assert calls["kill"] == []                        # 未停会话
    assert db.get_board_card(rid)["column_key"] == "doing"
    after = [(r["target_id"], r["seq"], r["state"])
             for r in waitq.active_items(pid)]
    assert after == before                            # 位次/状态零变化


def test_wait_zone_reorder_repositions(monkeypatch):
    """手势③：等待区内部互拖 → waitq.reposition 改队序（仅 UPDATE seq，行 id
    稳定）：等待卡3 拖到 等待卡1 前 → 队序 在跑卡, 卡3, 卡1, 卡2；行状态不动、
    不起会话；位次口径含前缀（pos=前缀长度+排号）。"""
    pid = _project()
    rid = _seed_running_card(pid, "在跑卡", 1.0)
    w1 = _seed_waiting_card(pid, "等待卡1")
    w2 = _seed_waiting_card(pid, "等待卡2")
    w3 = _seed_waiting_card(pid, "等待卡3")
    row3_id = _row(w3)["id"]
    monkeypatch.setattr(board.runner, "INSTANCE", _bare_instance())
    calls = []
    monkeypatch.setattr(board, "start_card",
                        lambda p, c, extra="": calls.append(c["id"]))
    card, err = board.move_card({"id": pid, "agent_path": ""}, w3, "doing",
                                before_id=w1)
    assert err is None
    assert calls == []                                # 调序不起会话
    order = [int(r["target_id"]) for r in waitq.active_items(pid)
             if r["kind"] == "card"]
    assert order == [rid, w3, w1, w2]                 # 队序已改
    assert _row(w3)["id"] == row3_id                  # 行 id 稳定
    assert _row(w1)["state"] == "waiting" and _row(w3)["state"] == "waiting"
    assert _row(rid)["state"] == "running"
    pos, total = waitq.position(_row(w3)["id"])
    assert (pos, total) == (2, 4)                     # pos=前缀(1)+等待区排号(1)


def test_running_zone_shuffle_noop(monkeypatch):
    """手势④：运行位内部互拖（before_id=运行卡）→ 200 且位次/状态零变化
    （v2 §2.4「允许、无实际效果」）。"""
    pid = _project()
    r1 = _seed_running_card(pid, "在跑卡1", 1.0)
    r2 = _seed_running_card(pid, "在跑卡2", 2.0)
    _seed_waiting_card(pid, "等待卡")
    monkeypatch.setattr(board.runner, "INSTANCE", _bare_instance())
    before = [(r["target_id"], r["seq"], r["state"])
              for r in waitq.active_items(pid)]
    card, err = board.move_card({"id": pid, "agent_path": ""}, r2, "doing",
                                before_id=r1)
    assert err is None
    after = [(r["target_id"], r["seq"], r["state"])
             for r in waitq.active_items(pid)]
    assert after == before                            # 位次/状态零变化
    assert db.get_board_card(r2)["column_key"] == "doing"


def test_rowless_run_card_below_wait_card_stops(monkeypatch):
    """C1 手势②（正常起跑稳态）：c: 行已终态化、仅剩在管条目的卡拖到等待卡
    后面，必须真走「先停后出队」落待审核——前端该手势必弹「停止当前任务」
    确认框，服务端若按行态早退 200 no-op，用户点确认后卡原地不动=确认框说谎。
    持有面判据=活跃 c: 行 ∨ 在管条目（`_RUNS`，本用例钉的分支）。"""
    pid = _project()
    rid = _seed_rowless_running_card(pid, "正常起跑卡")
    w1 = _seed_armored_wait_card(pid, "等待卡1")
    w2 = _seed_armored_wait_card(pid, "等待卡2")
    monkeypatch.setattr(board.runner, "INSTANCE", _bare_instance())
    calls = {"kill": []}

    class Proc:
        pid = 123
        def poll(self):
            return None

    monkeypatch.setattr(board, "_RUNS", {rid: {"proc": Proc()}})
    monkeypatch.setattr(board.platcompat, "kill_tree",
                        lambda p, s: calls["kill"].append(p))
    card, err = board.move_card({"id": pid, "agent_path": ""}, rid, "doing",
                                before_id=w2)
    assert err is None
    assert calls["kill"] == [123]                     # 先停会话
    c = db.get_board_card(rid)
    assert c["column_key"] == "review" and c["block_kind"] is None
    assert _row(rid) is None                          # 行早已终态化（不在活跃面）
    assert _row(w1)["state"] == "waiting"             # 等待卡不动
    assert _row(w2)["state"] == "waiting"


def test_rowless_landing_card_not_run_position(monkeypatch):
    """v3b 收窄（翻转自旧「持有面并集」用例）：落点卡无活跃 c: 行且在管条目不在场
    时不再算运行位——行即持有者；等待卡拖到它上方按「落点非队列成员」原样返回
    200：不起会话、队序零变化（旧 C1 口径按并集判为运行位而 force 起跑）。"""
    pid = _project()
    rid = _seed_rowless_running_card(pid, "正常起跑卡")
    w1 = _seed_armored_wait_card(pid, "等待卡1")
    inst = _bare_instance()
    monkeypatch.setattr(board.runner, "INSTANCE", inst)
    calls = []
    monkeypatch.setattr(board, "start_card",
                        lambda p, c, extra="": calls.append(c["id"]))
    monkeypatch.setattr(board, "run_pid", lambda c: 4321)
    before = [(r["target_id"], r["seq"], r["state"])
              for r in waitq.active_items(pid)]
    card, err = board.move_card({"id": pid, "agent_path": ""}, w1, "doing",
                                before_id=rid)
    assert err is None
    assert calls == []                                # 无手势：不起会话
    assert _row(w1)["state"] == "waiting"             # 等待卡原位
    after = [(r["target_id"], r["seq"], r["state"])
             for r in waitq.active_items(pid)]
    assert after == before                            # 队序零变化


def test_before_id_same_column_honored():
    """开路断言（board.py:233-238 改）：doing→doing 同列不再直接返回、doing
    目标 before_id 不再被丢弃——等待卡2 拖到 等待卡1 前，队序真实交换
    （旧行为：早退零变化）。"""
    pid = _project()
    w1 = _seed_waiting_card(pid, "等待卡1")
    w2 = _seed_waiting_card(pid, "等待卡2")
    card, err = board.move_card({"id": pid, "agent_path": ""}, w2, "doing",
                                before_id=w1)
    assert err is None
    assert _row(w2)["seq"] < _row(w1)["seq"]          # before_id 生效


def test_cross_column_moves_unchanged(monkeypatch):
    """跨列移动现行语义零回归：①todo→doing 仍走 _enter_doing 入队（落等待区
    末尾，before_id 不改变入队规则）；②doing→review 运行卡先停后释放；
    ③doing→todo 拒绝；④非 doing 同列早退不变。"""
    pid = _project()
    inst = _bare_instance()
    monkeypatch.setattr(board.runner, "INSTANCE", inst)
    w0 = _seed_waiting_card(pid, "先排卡")
    # ① todo→doing：入队落尾（queue 占位），before_id 不改变入队落点
    c1 = db.insert_board_card(pid, "新卡")
    card, err = board.move_card({"id": pid, "agent_path": ""}, c1, "doing",
                                before_id=w0)
    assert err is None
    row = _row(c1)
    assert row is not None and row["state"] == "waiting"
    assert row["seq"] > _row(w0)["seq"]               # 落等待区末尾不变
    c1d = db.get_board_card(c1)
    assert c1d["column_key"] == "doing" and c1d["block_kind"] == "queue"
    # ② doing→review：运行卡先停后释放（既有路径）
    rid = _seed_running_card(pid, "在跑卡", 100.0)
    calls = {"kill": []}

    class Proc:
        pid = 321
        def poll(self):
            return None

    monkeypatch.setattr(board, "_RUNS", {rid: {"proc": Proc()}})
    monkeypatch.setattr(board.platcompat, "kill_tree",
                        lambda p, s: calls["kill"].append(p))
    card, err = board.move_card({"id": pid, "agent_path": ""}, rid, "review")
    assert err is None
    assert calls["kill"] == [321]
    assert db.get_board_card(rid)["column_key"] == "review"
    # ③ doing→todo 拒绝
    c2 = db.insert_board_card(pid, "doing卡")
    db.update_board_card(c2, column_key="doing")
    card, err = board.move_card({"id": pid, "agent_path": ""}, c2, "todo")
    assert err == {"error": "doing 不可直接拖回 todo"}
    assert db.get_board_card(c2)["column_key"] == "doing"
    # ④ 非 doing 同列早退不变
    c3 = db.insert_board_card(pid, "todo卡")
    card, err = board.move_card({"id": pid, "agent_path": ""}, c3, "todo")
    assert err is None
    assert db.get_board_card(c3)["column_key"] == "todo"


def test_board_payload_doing_order_follows_queue():
    """展示序=队序（v2c T2，裁决 R11 小口径）：board_payload 对 doing 列按
    wait_items seq 下发——运行位区按 seq、无活跃行的卡（sync 外部卡/idle）
    落运行位区尾（sort_order 相对序）、等待区按 seq；sort_order 与队序唱
    反调也不影响下发序（单轨：展示序=队序）。"""
    pid = _project()
    rid = _seed_running_card(pid, "在跑卡", 1.0)
    idle = db.insert_board_card(pid, "idle卡")
    db.update_board_card(idle, column_key="doing")     # 无活跃行（sync/idle 形态）
    w1 = _seed_waiting_card(pid, "等待卡1")
    w2 = _seed_waiting_card(pid, "等待卡2")
    # sort_order 与队序唱反调：w2 < w1 < 在跑卡 < idle
    db.update_board_card(w2, sort_order=1)
    db.update_board_card(w1, sort_order=2)
    db.update_board_card(rid, sort_order=3)
    db.update_board_card(idle, sort_order=4)
    payload = board.board_payload(pid)
    doing_ids = [c["id"] for c in payload["cards"] if c["column"] == "doing"]
    assert doing_ids == [rid, idle, w1, w2]
    # 调序后下发序随队序即时变化（单轨：展示序=队序一致）
    assert board.reorder_card(pid, w2, w1) is None
    payload = board.board_payload(pid)
    doing_ids = [c["id"] for c in payload["cards"] if c["column"] == "doing"]
    assert doing_ids == [rid, idle, w2, w1]
