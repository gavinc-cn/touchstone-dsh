"""waitq 分数序插入单测（v2a T2，裁决 R4）：seq REAL 中点插入
（insert_after_prefix=「最后一个运行中条目之后」=等待区最前 / reposition=拖拽
落点改序）+ 间隙挤压等距再平衡（行 id 稳定）；enqueue 落尾 MAX+1 兼容不变。"""
import pytest

import db
import waitq


@pytest.fixture(autouse=True)
def _clean_waitq_tables():
    """每例前后清空 waitq 两表：全局 seq 轴跨用例不串味。"""
    def _clean():
        with db.connect() as conn:
            for t in ("wait_items", "chat_msgs"):
                conn.execute(f"DELETE FROM {t}")
    _clean()
    yield
    _clean()


def _seqs(project_id):
    """项目全部行（含终态）按 seq 升序的 [(id, kind, target_id, seq, state)]。"""
    with db.connect() as conn:
        return [(r["id"], r["kind"], r["target_id"], r["seq"], r["state"])
                for r in conn.execute(
                    "SELECT id, kind, target_id, seq, state FROM wait_items"
                    " WHERE project_id=? ORDER BY seq, id", (project_id,))]


def test_insert_after_prefix_lands_before_first_waiting():
    """前缀 1 行 + 等待 2 行：新行 seq 落在前缀尾与等待首之间（保项目内
    「前缀全在等待前」不变量）；starting/running 两前缀态同认。"""
    p0 = waitq.enqueue(waitq.KIND_CARD, 101, 1)              # 前缀行（→starting）
    waitq.claim(p0, "worker")
    w1 = waitq.enqueue(waitq.KIND_CARD, 102, 1)
    w2 = waitq.enqueue(waitq.KIND_CARD, 103, 1)
    s_p = waitq.get_item(p0)["seq"]
    s_w1 = waitq.get_item(w1)["seq"]
    rid, seq_new = waitq.insert_after_prefix(waitq.KIND_ANSWER, 102, 1)
    assert s_p < seq_new < s_w1                              # 前缀尾与等待首之间
    row = waitq.get_item(rid)
    assert row["state"] == "waiting" and row["seq"] == seq_new
    assert [r[0] for r in _seqs(1)] == [p0, rid, w1, w2]     # 等待区最前
    # running 前缀成员同口径（PREFIX_STATES 两态）：再插一行落在前缀尾与新等待首之间
    assert waitq.mark_running(waitq.KIND_CARD, 101) is True
    rid2, seq2 = waitq.insert_after_prefix(waitq.KIND_ANSWER, 103, 1)
    assert s_p < seq2 < seq_new
    assert [r[0] for r in _seqs(1)] == [p0, rid2, rid, w1, w2]


def test_insert_after_prefix_without_prefix_lands_front():
    """无前缀：落在项目等待区最前（全局前驱之后、等待首之前）。"""
    other = waitq.enqueue(waitq.KIND_TASK, 301, 9)           # 他项目行=全局前驱
    w1 = waitq.enqueue(waitq.KIND_CARD, 302, 1)
    w2 = waitq.enqueue(waitq.KIND_CARD, 303, 1)
    rid, seq_new = waitq.insert_after_prefix(waitq.KIND_CARD, 304, 1)
    assert waitq.get_item(other)["seq"] < seq_new < waitq.get_item(w1)["seq"]
    assert [r[0] for r in _seqs(1)] == [rid, w1, w2]         # 项目等待区最前


def test_insert_tail_unchanged():
    """enqueue 落尾仍 MAX+1 整数位（兼容断言）；insert_after_prefix 在项目无
    等待行时同语义落全局尾。"""
    a = waitq.enqueue(waitq.KIND_TASK, 401, 1)
    b = waitq.enqueue(waitq.KIND_TASK, 402, 1)
    assert (waitq.get_item(a)["seq"], waitq.get_item(b)["seq"]) == (1, 2)
    waitq.claim(a, "worker")                                 # 两行皆 starting（无等待区）
    waitq.claim(b, "worker")
    rid, seq_new = waitq.insert_after_prefix(waitq.KIND_CARD, 403, 1)
    assert seq_new == 3                                      # MAX(2)+1，与 enqueue 兼容
    assert [r[0] for r in _seqs(1)] == [a, b, rid]           # 全局落尾


def test_reposition_midpoint_keeps_row_id():
    """reposition 只改 seq、行 id 不变（R4 行 id 稳定）；落点=邻行中点；
    None=区首/区尾取界外一步；行不存在 False；两界皆空/倒置 ValueError。"""
    a = waitq.enqueue(waitq.KIND_CARD, 501, 1)               # seq 1
    b = waitq.enqueue(waitq.KIND_CARD, 502, 1)               # seq 2
    c = waitq.enqueue(waitq.KIND_CARD, 503, 1)               # seq 3
    assert waitq.reposition(c, 1, 2) is True                 # C 落到 A、B 之间
    assert waitq.get_item(c)["seq"] == 1.5
    assert [r[0] for r in _seqs(1)] == [a, c, b]
    assert waitq.reposition(c, None, 1) is True              # C 移到区首（界外一步 0）
    assert waitq.get_item(c)["seq"] == 0.5
    assert [r[0] for r in _seqs(1)] == [c, a, b]
    s_b = waitq.get_item(b)["seq"]
    assert waitq.reposition(a, s_b, None) is True            # A 移到区尾
    assert waitq.get_item(a)["seq"] == (s_b + s_b + 1) / 2
    assert [r[0] for r in _seqs(1)] == [c, b, a]
    assert waitq.reposition(999999, 1, 2) is False           # 行不存在
    with pytest.raises(ValueError):
        waitq.reposition(b, None, None)                      # 两界皆空非法
    with pytest.raises(ValueError):
        waitq.reposition(b, 2, 1)                            # 区间倒置非法


def test_rebalance_preserves_order_under_gap_squeeze(monkeypatch):
    """循环「前缀后插入」60 次：新行向前缀尾收敛、间隙 < 1e-9 必触发再平衡；
    再平衡只重排 seq 不改行序（逐次比对重排前后相对序）；行 id 稳定；
    「前缀全在等待前」不变量保持；区间外的等待锚点行 seq 不被重写。"""
    p0 = waitq.enqueue(waitq.KIND_CARD, 601, 1)              # 前缀行（→starting）
    waitq.claim(p0, "worker")
    w = waitq.enqueue(waitq.KIND_CARD, 602, 1)               # 等待锚点（在插入区之外）
    s_w = waitq.get_item(w)["seq"]
    calls = []
    real = waitq._rebalance_interval

    def _spy(conn, pid, hi):
        before = [r["id"] for r in conn.execute(
            "SELECT id FROM wait_items WHERE project_id=? ORDER BY seq, id", (pid,))]
        real(conn, pid, hi)
        after = [r["id"] for r in conn.execute(
            "SELECT id FROM wait_items WHERE project_id=? AND seq <= ?"
            " ORDER BY seq, id", (pid, hi))]
        calls.append(([i for i in before if i in set(after)], after))

    monkeypatch.setattr(waitq, "_rebalance_interval", _spy)
    ids = []
    for i in range(60):
        rid, _ = waitq.insert_after_prefix(waitq.KIND_CARD, f"ins-{i}", 1)
        ids.append(rid)
    assert calls                                             # 再平衡确已触发
    for before, after in calls:
        assert before == after                             # 重排前后相对序不变
    rows = _seqs(1)
    assert {r[0] for r in rows} == {p0, w} | set(ids)        # 行 id 稳定无增删
    seqs = [r[3] for r in rows]
    assert len(set(seqs)) == 62 and seqs == sorted(seqs)     # 严格全序无碰撞
    assert rows[0][0] == p0                                  # 前缀仍在最前（不变量）
    assert waitq.get_item(w)["seq"] == s_w                   # 锚点 seq 未被重写


def test_cross_project_rows_untouched():
    """插入/重排只动本项目区间行：他项目行 seq 不变（全局轴前后各一行钉死）。"""
    o1 = waitq.enqueue(waitq.KIND_TASK, 701, 9)              # 他项目前行（seq 1）
    w1 = waitq.enqueue(waitq.KIND_CARD, 702, 1)              # 本项目等待区（seq 2,3）
    w2 = waitq.enqueue(waitq.KIND_CARD, 703, 1)
    o2 = waitq.enqueue(waitq.KIND_TASK, 704, 9)              # 他项目后行（seq 4）
    rid, seq_new = waitq.insert_after_prefix(waitq.KIND_CARD, 705, 1)
    assert 1 < seq_new < 2
    assert waitq.reposition(w2, 2, None) is True             # 本项目内落尾移动
    assert waitq.get_item(o1)["seq"] == 1                    # 他项目行纹丝不动
    assert waitq.get_item(o2)["seq"] == 4
    assert [r[0] for r in _seqs(1)] == [rid, w1, w2]         # 本项目序如预期
    assert [r[2] for r in _seqs(9)] == ["701", "704"]        # 他项目序不变


def test_rebalance_never_rewrites_foreign_project_rows(monkeypatch):
    """终审 Important-1 钉死：间隙挤压再平衡只重写本项目行——交错在重排窗口内
    （seq ≤ hi）的他项目行 seq 逐字节不动，且再平衡确已触发（spy）。
    RED 路径：拔掉 _rebalance_interval 的 project_id=? 过滤 → 他项目行被重排
    改写 → 本例断言失败。"""
    o1 = waitq.enqueue(waitq.KIND_TASK, "f-a", 9)        # 他项目行 seq 1（窗口下界）
    p0 = waitq.enqueue(waitq.KIND_CARD, "p0", 1)         # 本项目前缀行 seq 2
    waitq.claim(p0, "worker")
    o2 = waitq.enqueue(waitq.KIND_TASK, "f-b", 9)        # 他项目行 seq 3（交错窗口内）
    w = waitq.enqueue(waitq.KIND_CARD, "w", 1)           # 本项目等待锚点 seq 4（窗口上方）
    o3 = waitq.enqueue(waitq.KIND_TASK, "f-c", 9)        # 他项目行 seq 5（窗口上方）
    calls = []
    real = waitq._rebalance_interval
    monkeypatch.setattr(waitq, "_rebalance_interval",
                        lambda conn, pid, hi: calls.append(hi) or real(conn, pid, hi))
    for i in range(60):                                  # 向前缀尾收敛挤压（同测试 5 几何）
        waitq.insert_after_prefix(waitq.KIND_CARD, f"ins-{i}", 1)
    assert calls                                         # 再平衡确已触发
    assert waitq.get_item(o1)["seq"] == 1                # 他项目行逐字节不动
    assert waitq.get_item(o2)["seq"] == 3                # （交错窗口内的也不动）
    assert waitq.get_item(o3)["seq"] == 5
    assert waitq.get_item(w)["seq"] == 4                 # 区间外锚点不动


def test_mid_seq_fallback_lands_inside_interval():
    """终审 Minor-1 钉死：_mid_seq 兜底（重排后本项目 hi 前无行）必须落在
    (lo, hi) 区间内——亚 eps 间隙下旧 hi-1.0 兜底会跌出下界（静默坏序）。"""
    o = waitq.enqueue(waitq.KIND_TASK, "f9", 9)          # 他项目行 seq 1（对照不动）
    a = waitq.enqueue(waitq.KIND_CARD, "a1", 1)          # 本项目行（当前 seq 2）
    hi = 2.0 + 1e-12                                     # 亚 eps 间隙落点 (2.0, 2.0+1e-12)
    assert waitq.reposition(a, 2.0, hi) is True
    seq_a = waitq.get_item(a)["seq"]
    assert 2.0 < seq_a < hi                              # 兜底跌出下界则此处失败
    assert waitq.get_item(o)["seq"] == 1                 # 他项目行不动


def test_msg_enqueue_lands_after_prefix_keeps_user_action_fifo():
    """会话消息落点对齐 v2 §2.2 插入规则（2026-09-25「待对齐项」收口）：
    落「最后一个运行中条目之后」、等待区卡片之前；且排在同项目已排队用户动作
    行（waiting m:/a:）之后——同项目消息保持到达序 FIFO（不反转）。"""
    p0 = waitq.enqueue(waitq.KIND_CARD, "c0", 1)              # 前缀行（→starting）
    waitq.claim(p0, "worker")
    w1 = waitq.enqueue(waitq.KIND_CARD, "c1", 1)              # 等待区卡片两张
    w2 = waitq.enqueue(waitq.KIND_CARD, "c2", 1)
    s_p = waitq.get_item(p0)["seq"]
    s_w1 = waitq.get_item(w1)["seq"]
    # 消息 1：前缀尾与等待首之间（不再落全局队尾）
    m1 = waitq.msg_enqueue("m1", 1, "s-1", "第一句")
    seq_m1 = waitq.get_item(m1)["seq"]
    assert s_p < seq_m1 < s_w1
    assert [r[0] for r in _seqs(1)] == [p0, m1, w1, w2]
    # 消息 2：排在消息 1 之后（FIFO 不反转），仍在等待卡之前
    m2 = waitq.msg_enqueue("m2", 1, "s-1", "第二句")
    seq_m2 = waitq.get_item(m2)["seq"]
    assert seq_m1 < seq_m2 < s_w1
    # 作答行维持既有几何（前缀后）：落在前缀尾与消息 1 之间
    a1, seq_a1 = waitq.insert_after_prefix(waitq.KIND_ANSWER, "c1", 1)
    assert s_p < seq_a1 < seq_m1
    # 消息 3：base=用户动作块最大 seq（m2），落 m2 之后、等待首之前
    m3 = waitq.msg_enqueue("m3", 1, "s-2", "第三句")
    assert seq_m2 < waitq.get_item(m3)["seq"] < s_w1
    assert [r[0] for r in _seqs(1)] == [p0, a1, m1, m2, m3, w1, w2]


def test_msg_insert_seq_fallbacks():
    """_msg_insert_seq 退化形：无前缀无用户动作块 → 等待区最前；
    本项目无等待行 → 全局尾（与 enqueue 兼容）。"""
    w1 = waitq.enqueue(waitq.KIND_CARD, "d1", 2)              # 仅等待区（无前缀）
    m1 = waitq.msg_enqueue("m1", 2, "s-1", "hi")
    assert waitq.get_item(m1)["seq"] < waitq.get_item(w1)["seq"]   # 等待区最前
    p0 = waitq.enqueue(waitq.KIND_CARD, "e0", 3)              # 仅前缀行（无等待区）
    waitq.claim(p0, "worker")
    m2 = waitq.msg_enqueue("m2", 3, "s-1", "hi")
    assert waitq.get_item(m2)["seq"] > waitq.get_item(p0)["seq"]   # 全局尾=前缀之后
