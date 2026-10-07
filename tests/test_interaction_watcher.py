# 统一调和器状态机单测：纯函数 + 写库调用断言（不触网络；库=conftest 临时库）
# v2b T3（裁决 R9）：落阻塞 eager 丢排队（c: 等待行即取消，不再惰性摘除）
import json, os, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pytest

import board
import db
import runner
import waitq


@pytest.fixture(autouse=True)
def _clean_waitq_tables():
    """每例前后清 waitq 两表（v2b T3 起种子真实等待行；conftest 临时库）。"""
    def _clean():
        with db.connect() as conn:
            for t in ("wait_items", "chat_msgs"):
                conn.execute(f"DELETE FROM {t}")
    _clean()
    yield
    _clean()


def _card(**kw):
    base = {"id": 1, "column_key": "doing", "block_kind": None,
            "block_text": "", "session_id": "s-1", "origin": ""}
    base.update(kw)
    return base


# ---------- block：提问等待 → 阻塞 ----------

def test_pending_blocks_doing():
    r = {"pending": True, "busy": True, "text": "q"}
    assert board._reconcile_action_for("dsh_plugin", _card(), r) == "block"


def test_pending_blocks_review():
    """空闲卡被用户在会话里追问、agent 反提问题：review 也能进阻塞。"""
    r = {"pending": True, "busy": True, "text": "q"}
    assert board._reconcile_action_for(
        "dsh_plugin", _card(column_key="review"), r) == "block"


def test_already_blocked_stays():
    r = {"pending": True, "busy": True, "text": "q"}
    assert board._reconcile_action_for(
        "dsh_plugin", _card(column_key="blocked", block_kind="interaction"),
        r) is None


# ---------- 解除：按 busy 回开发/待审核 ----------

def test_recover_to_doing_when_busy():
    r = {"pending": False, "busy": True, "text": ""}
    assert board._reconcile_action_for(
        "dsh_plugin", _card(column_key="blocked", block_kind="interaction"),
        r) == "to_doing"


def test_recover_to_review_when_idle():
    r = {"pending": False, "busy": False, "text": ""}
    assert board._reconcile_action_for(
        "dsh_plugin", _card(column_key="blocked", block_kind="interaction"),
        r) == "to_review"


def test_recover_keeps_legacy_doing_when_platform_run():
    """平台在管运行期解除保持旧语义回 doing（收尾仍归 _finish_run）。"""
    r = {"pending": False, "busy": True, "text": ""}
    assert board._reconcile_action_for(
        "dsh_plugin", _card(column_key="blocked", block_kind="interaction"),
        r, has_run=True) == "recover"


# ---------- 列映射：busy→doing / 空闲→review ----------

def test_review_back_to_doing_when_busy():
    r = {"pending": False, "busy": True, "text": ""}
    assert board._reconcile_action_for(
        "dsh_plugin", _card(column_key="review"), r) == "to_doing"


def test_doing_to_review_when_idle():
    r = {"pending": False, "busy": False, "text": ""}
    assert board._reconcile_action_for("dsh_plugin", _card(), r) == "to_review"


def test_doing_stays_when_busy():
    r = {"pending": False, "busy": True, "text": ""}
    assert board._reconcile_action_for("dsh_plugin", _card(), r) is None


def test_platform_run_cards_not_column_mapped():
    """在管运行卡的 busy/空闲流转归 _finish_run，调和器不做列映射。"""
    r = {"pending": False, "busy": False, "text": ""}
    assert board._reconcile_action_for("dsh_plugin", _card(), r,
                                       has_run=True) is None


# ---------- 不干预规则 ----------

def test_queue_placeholder_not_touched():
    r = {"pending": False, "busy": False, "text": ""}
    assert board._reconcile_action_for(
        "dsh_plugin", _card(block_kind="queue"), r) is None


# ---------- 排队占位卡的在跑会话（2026-09-10：recover 回排队后仍会提问） ----------

def test_queue_placeholder_with_live_question_blocks():
    """占位卡 + 平台在管运行：会话是新提问等待，照常进阻塞。

    场景（真实案例）：运行中卡被交互阻塞 → 用户作答 → 调和器 recover 落
    doing/queue 排队占位（项目被其他单元占用）→ 会话没停，稍后再提问——此前
    守卫把 queue 卡一律跳过，提问永不被发现，卡片卡在「排队中」不进阻塞列。
    """
    r = {"pending": True, "busy": True, "text": "确认按上述方案实施吗？"}
    assert board._reconcile_action_for(
        "dsh_plugin", _card(block_kind="queue"), r, has_run=True) == "block"


def test_queue_placeholder_blocks_without_platform_run():
    """服务重启后平台 _RUNS 已丢（has_run=False）：占位卡会话仍在问照常进阻塞。"""
    r = {"pending": True, "busy": True, "text": "q"}
    assert board._reconcile_action_for(
        "dsh_plugin", _card(block_kind="queue"), r) == "block"


def test_queue_placeholder_busy_without_question_stays():
    """占位卡会话在跑但无提问：不搬列（等串行位），也不因 busy 落回 doing。"""
    r = {"pending": False, "busy": True, "text": ""}
    assert board._reconcile_action_for(
        "dsh_plugin", _card(block_kind="queue"), r, has_run=True) is None


def test_manual_blocked_not_touched():
    """手动阻塞卡等待用户回答（pending）：维持阻塞态、不升级 manual 标记。"""
    r = {"pending": True, "busy": True, "text": "q"}
    assert board._reconcile_action_for(
        "dsh_plugin", _card(column_key="blocked", block_kind="manual"),
        r) is None


def test_manual_blocked_running_returns_to_doing():
    """手动阻塞卡会话在跑（用户在会话详情页发消息等）：回开发列（2026-09-11 修复）。

    真实故障：卡 210 手动阻塞后用户在会话窗发消息，会话整轮跑完，卡片滞留
    阻塞列——状态机此前对 manual 一律 None。用户约定：所有正在运行的卡片
    都应显示在「正在开发」列。
    """
    r = {"pending": False, "busy": True, "text": ""}
    assert board._reconcile_action_for(
        "dsh_plugin", _card(column_key="blocked", block_kind="manual"),
        r) == "to_doing"


def test_manual_blocked_idle_stays():
    """手动阻塞卡会话空闲：维持用户停车位，不动。"""
    r = {"pending": False, "busy": False, "text": ""}
    assert board._reconcile_action_for(
        "dsh_plugin", _card(column_key="blocked", block_kind="manual"), r) is None


def test_manual_blocked_live_msg_returns_to_doing():
    """消息排队尚未执行（会话还不 busy）：本卡消息在跑/排队同样视作运行中。"""
    r = {"pending": False, "busy": False, "text": ""}
    assert board._reconcile_action_for(
        "dsh_plugin", _card(column_key="blocked", block_kind="manual"), r,
        live_msg=True) == "to_doing"


def test_manual_blocked_stop_recent_ignores_stale_busy():
    """刚被平台停过会话（拖入阻塞）的宽限期内：busy 可能是 abort 残留，不回搬；
    但消息驱动（live_msg）是强信号，不受宽限期限制。"""
    r = {"pending": False, "busy": True, "text": ""}
    assert board._reconcile_action_for(
        "dsh_plugin", _card(column_key="blocked", block_kind="manual"), r,
        stop_recent=True) is None
    assert board._reconcile_action_for(
        "dsh_plugin", _card(column_key="blocked", block_kind="manual"), r,
        live_msg=True, stop_recent=True) == "to_doing"


def test_doing_with_live_msg_stays():
    """开发列卡片有排队/执行中的消息：不回退待审核（消息驱动即运行中，
    防 pending 消息尚未执行时被空闲判定搬走）。"""
    r = {"pending": False, "busy": False, "text": ""}
    assert board._reconcile_action_for("dsh_plugin", _card(), r,
                                       live_msg=True) is None


def test_done_and_todo_not_touched():
    r = {"pending": False, "busy": True, "text": ""}
    for col in ("todo", "done"):
        assert board._reconcile_action_for(
            "dsh_plugin", _card(column_key=col), r) is None


def test_cli_family_never_touched():
    r = {"pending": True, "busy": True, "text": "q"}
    assert board._reconcile_action_for("kimi", _card(), r) is None


# ---------- apply：read-verify-write ----------

def test_apply_writes_expected_fields(monkeypatch):
    calls = []
    monkeypatch.setattr(board, "db", type("D", (), {
        "get_board_card": staticmethod(lambda cid: _card(id=cid)),
        "update_board_card": staticmethod(
            lambda cid, **kw: calls.append((cid, kw)))})())
    board._iw_apply("dsh_plugin", _card(id=7), "block",
                    {"pending": True, "busy": True, "text": "你希望我做什么？"})
    assert calls == [(7, {"column_key": "blocked", "block_kind": "interaction",
                          "block_text": "你希望我做什么？"})]


def test_apply_skips_after_user_change(monkeypatch):
    cases = [
        # 重读已在 todo（用户拖走）→ block 跳过
        (_card(id=7), {"pending": True, "busy": True, "text": "q"}, "block",
         {"column_key": "todo"}),
        # 重读已改手动阻塞（用户拖入，刚被平台停会话）→ to_doing 跳过
        # （stop_recent 宽限期内不据 abort 残留 busy 回搬，2026-09-11）
        (_card(id=7, column_key="blocked", block_kind="interaction"),
         {"pending": False, "busy": True, "text": ""}, "to_doing",
         {"block_kind": "manual"}),
    ]
    for cur, r, action, re_read in cases:
        calls = []
        board._STOP_STAMP.clear()
        if re_read.get("block_kind") == "manual":
            board._STOP_STAMP[7] = time.time()   # 模拟刚停过会话
        monkeypatch.setattr(board, "db", type("D", (), {
            "get_board_card": staticmethod(
                lambda cid, _k=re_read: _card(id=cid, **_k)),
            "update_board_card": staticmethod(
                lambda cid, **kw: calls.append((cid, kw)))})())
        board._iw_apply("dsh_plugin", cur, action, r)
        assert calls == []
    board._STOP_STAMP.clear()


# ---------- 权限审批等待（spike_权限等待_20260906 B3） ----------

def test_approval_wait_state_machine_blocks():
    """approval 等待经既有 block 通道进阻塞（状态机无需感知枚举类型）。"""
    r = {"pending": True, "busy": True, "text": "请求审批：Running: echo hi"}
    assert board._reconcile_action_for("dsh_plugin", _card(), r) == "block"


# ---------- 恢复/回 doing 的排队与占用（2026-09-09 语义） ----------

class _FakeRunner:
    """recover/to_doing/to_review 分支用的假 runner：记录调用
    （finish_reasons 记录行收口 reason 标签，v3b 出队归位断言用）。"""
    def __init__(self):
        self.calls = {"sub": [], "start": [], "finish": [], "finish_reasons": []}

    def submit_card(self, cid):
        self.calls["sub"].append(cid)

    def card_started(self, cid, pid, ext=None):
        self.calls["start"].append(cid)

    def card_finished(self, cid, reason=""):
        self.calls["finish"].append(cid)
        self.calls["finish_reasons"].append(reason)


def _apply_card(**kw):
    base = {"id": 7, "project_id": 9, "column_key": "blocked",
            "block_kind": "interaction", "block_text": "",
            "session_id": "s-1", "origin": ""}
    base.update(kw)
    return base


def _prepare_apply(monkeypatch, card, action, fake):
    """_iw_apply 通用夹具：状态机固定返回 action，_has_active_run 恒 True
    （recover 语义要求平台在管）, 假 runner 已装订。"""
    monkeypatch.setattr(board, "_reconcile_action_for", lambda *a, **k: action)
    monkeypatch.setattr(board, "_has_active_run", lambda cid: True)
    monkeypatch.setattr(board.db, "get_board_card", lambda cid: card)
    monkeypatch.setattr(board.runner, "INSTANCE", fake)


def test_apply_recover_other_busy_direct_with_occupancy(monkeypatch):
    """平台卡交互阻塞解除（在管运行，2026-09-13 修订）：项目被其他单元占用也
    直回 doing 并登记占用——本卡会话仍在跑，占用者即本卡自身；落 doing/queue
    排队占位会与「会话运行中」徽标矛盾同显（真实故障：卡 300）。"""
    calls = []
    fake = _FakeRunner()
    monkeypatch.setattr(board.db, "update_board_card",
                        lambda cid, **kw: calls.append(kw))
    _prepare_apply(monkeypatch, _apply_card(), "recover", fake)
    board._iw_apply("dsh_plugin", _apply_card(), "recover",
                    {"pending": False, "busy": True, "text": ""})
    assert calls == [{"column_key": "doing", "block_kind": None, "block_text": ""}]
    assert fake.calls["sub"] == [] and fake.calls["start"] == [7]


def test_apply_recover_idle_reclaims_occupancy(monkeypatch):
    """项目空闲 → 直回 doing 并重新登记 runner 占用（占住串行位，防恢复后
    与后续单元并发），不入队。"""
    calls = []
    fake = _FakeRunner()
    monkeypatch.setattr(board.db, "update_board_card",
                        lambda cid, **kw: calls.append(kw))
    _prepare_apply(monkeypatch, _apply_card(), "recover", fake)
    board._iw_apply("dsh_plugin", _apply_card(), "recover",
                    {"pending": False, "busy": True, "text": ""})
    assert calls == [{"column_key": "doing", "block_kind": None, "block_text": ""}]
    assert fake.calls["start"] == [7] and fake.calls["sub"] == []


def test_apply_recover_own_occupancy_direct(monkeypatch):
    """本卡已有活跃行（占位者就是本卡自身）→ 直回 doing、行不动（补回幂等
    no-op）：排队会堵住自身占着的运行位。"""
    calls = []
    fake = _FakeRunner()
    monkeypatch.setattr(board.db, "update_board_card",
                        lambda cid, **kw: calls.append(kw))
    _prepare_apply(monkeypatch, _apply_card(), "recover", fake)
    waitq.enter_running(waitq.KIND_CARD, 7, 9)    # 本卡自己的活跃行（行即占位）
    board._iw_apply("dsh_plugin", _apply_card(), "recover",
                    {"pending": False, "busy": True, "text": ""})
    assert calls == [{"column_key": "doing", "block_kind": None, "block_text": ""}]
    assert fake.calls["sub"] == [] and fake.calls["start"] == []


def test_apply_recover_restores_row_with_other_holder(monkeypatch):
    """F2 回归（评审 Important）：出队释放 c: 行后项目被他主行占着，阻塞解除
    恢复仍须补回本卡 c: 行（行口径下不存在「被拒」形态——I1：卡回开发容器即
    有活跃行）。ext 落 reason=阻塞解除恢复（真行白盒）。"""
    calls = []
    r = _FakeRunner()
    r._cond = threading.Condition()          # 真 card_started 需要（notify_all）
    r.card_started = lambda cid, pid, ext=None: \
        runner.Runner.card_started(r, cid, pid, ext=ext)
    monkeypatch.setattr(board.db, "update_board_card",
                        lambda cid, **kw: calls.append(kw))
    _prepare_apply(monkeypatch, _apply_card(), "recover", r)
    tid = waitq.enqueue(waitq.KIND_TASK, 999, 9)   # 出队窗口他主行已占位
    waitq.claim(tid, "worker")
    board._iw_apply("dsh_plugin", _apply_card(), "recover",
                    {"pending": False, "busy": True, "text": ""})
    assert calls == [{"column_key": "doing", "block_kind": None, "block_text": ""}]
    crow = waitq.get_active(waitq.KIND_CARD, 7)
    assert crow is not None and crow["state"] == "running"    # 本卡行已补回
    assert waitq.get_active(waitq.KIND_TASK, 999) is not None  # 他主行不受影响
    assert json.loads(crow["evidence"])["reason"] == "阻塞解除恢复"


def test_apply_to_doing_busy_session_direct(monkeypatch):
    """平台卡从待审核/解除阻塞回 doing：会话实况 busy 也直写、不入队
    （2026-09-13 修订，原 2026-09-09「项目忙落排队占位」语义废止）——to_doing
    蕴含运行信号（busy/live_msg），落排队占位会在 turn 结束后被统一队列拾起、
    重复发「继续」起一轮，且与「会话运行中」徽标矛盾同显（真实故障：卡 300）。"""
    calls = []
    fake = _FakeRunner()
    monkeypatch.setattr(board, "_has_active_run", lambda cid: False)
    monkeypatch.setattr(board, "_reconcile_action_for", lambda *a, **k: "to_doing")
    monkeypatch.setattr(board.db, "get_board_card",
                        lambda cid: _apply_card(column_key="review", origin=""))
    monkeypatch.setattr(board.db, "update_board_card",
                        lambda cid, **kw: calls.append(kw))
    monkeypatch.setattr(board.runner, "INSTANCE", fake)
    board._iw_apply("dsh_plugin", _apply_card(column_key="review", origin=""),
                    "to_doing", {"pending": False, "busy": True, "text": ""})
    assert calls == [{"column_key": "doing", "block_kind": None, "block_text": ""}]
    assert fake.calls["sub"] == [] and fake.calls["start"] == []


def test_apply_to_doing_sync_parallel_direct(monkeypatch):
    """sync 卡回 doing 维持强制并行：项目忙也直写不排队、不登记占用。"""
    calls = []
    fake = _FakeRunner()
    monkeypatch.setattr(board, "_has_active_run", lambda cid: False)
    monkeypatch.setattr(board, "_reconcile_action_for", lambda *a, **k: "to_doing")
    monkeypatch.setattr(board.db, "get_board_card",
                        lambda cid: _apply_card(column_key="review", origin="sync"))
    monkeypatch.setattr(board.db, "update_board_card",
                        lambda cid, **kw: calls.append(kw))
    monkeypatch.setattr(board.runner, "INSTANCE", fake)
    board._iw_apply("dsh_plugin", _apply_card(column_key="review", origin="sync"),
                    "to_doing", {"pending": False, "busy": True, "text": ""})
    assert calls == [{"column_key": "doing", "block_kind": None, "block_text": ""}]
    assert fake.calls["sub"] == [] and fake.calls["start"] == []


def test_apply_to_doing_live_msg_direct(monkeypatch):
    """本卡会话由平台消息单元驱动（live_msg）：项目忙也直写 doing、不入队。

    落排队占位会让统一队列在消息 turn 结束后拾起该卡、重复发「继续」起一轮
    （卡片单元拾取判定撞不上 _RUNS——消息驱动的会话没有平台运行条目）。
    """
    calls = []
    fake = _FakeRunner()
    monkeypatch.setattr(board, "_has_active_run", lambda cid: False)
    monkeypatch.setattr(board, "_reconcile_action_for", lambda *a, **k: "to_doing")
    monkeypatch.setattr(board.chat, "live_of_sid", lambda sid: True)
    monkeypatch.setattr(board.db, "get_board_card",
                        lambda cid: _apply_card(column_key="blocked",
                                                block_kind="manual"))
    monkeypatch.setattr(board.db, "update_board_card",
                        lambda cid, **kw: calls.append(kw))
    monkeypatch.setattr(board.runner, "INSTANCE", fake)
    board._iw_apply("dsh_plugin",
                    _apply_card(column_key="blocked", block_kind="manual"),
                    "to_doing", {"pending": False, "busy": True, "text": ""})
    assert calls == [{"column_key": "doing", "block_kind": None, "block_text": ""}]
    assert fake.calls["sub"] == [] and fake.calls["start"] == []


# ---------- _iw_once 守卫：排队占位卡的探测（2026-09-10） ----------


def _fake_proj(pid=9):
    return {"id": pid, "archived": 0, "project_dir": "/tmp/x",
            "agent_path": "dsh-plugin:/usr/bin/dsh"}


def _once(monkeypatch, cards, r, live=False, runner=None):
    """跑一轮调和扫描（不触网络），返回 [(card_id, action)]；live=本卡消息实况。
    runner=注入的假 runner（默认 None：board 退化直起路径）。"""
    applies = []
    monkeypatch.setattr(board.db, "list_projects_all", lambda: [_fake_proj()])
    monkeypatch.setattr(board.db, "list_board_cards", lambda pid: cards)
    monkeypatch.setattr(board, "_iw_interaction", lambda *a, **k: r)
    monkeypatch.setattr(board.chat, "live_of_sid", lambda sid: live)
    monkeypatch.setattr(board, "_iw_apply",
                        lambda fam, c, action, rr: applies.append((c["id"], action)))
    monkeypatch.setattr(board.runner, "INSTANCE", runner)
    board._iw_once()
    return applies


def test_iw_once_blocks_queue_card_with_live_question(monkeypatch):
    """有会话的排队占位卡照常探测：会话在问 → 落阻塞动作（回归用例）。

    此前守卫 `block_kind in ("queue","manual")` 直接跳过，占位卡的在跑会话
    提问永不被发现（真实故障：卡片停在「正在开发/排队中」不进阻塞列）。
    """
    cards = [_card(id=5, block_kind="queue")]
    applies = _once(monkeypatch, cards,
                    {"pending": True, "busy": True, "text": "q"})
    assert applies == [(5, "block")]


def test_iw_once_skips_queue_card_without_session(monkeypatch):
    """从未起过会话的真排队卡（无 sid）：不探测不搬列。"""
    cards = [_card(id=6, block_kind="queue", session_id="")]
    applies = _once(monkeypatch, cards,
                    {"pending": True, "busy": True, "text": "q"})
    assert applies == []


def test_iw_once_queue_card_busy_no_question_untouched(monkeypatch):
    """占位卡在跑无提问：守卫放行探测但仍不搬列（状态机 queue 分支只放行 block）。"""
    cards = [_card(id=7, block_kind="queue")]
    applies = _once(monkeypatch, cards,
                    {"pending": False, "busy": True, "text": ""})
    assert applies == []


def test_iw_once_manual_blocked_pending_untouched(monkeypatch):
    """手动阻塞卡等待用户回答（pending）：探测照做但维持阻塞态（不升级 manual）。"""
    cards = [_card(id=8, column_key="blocked", block_kind="manual")]
    applies = _once(monkeypatch, cards,
                    {"pending": True, "busy": True, "text": "q"})
    assert applies == []


def test_iw_once_manual_blocked_busy_returns_to_doing(monkeypatch):
    """手动阻塞卡会话在跑（用户在会话窗发消息）：守卫放行探测 → 回开发列。

    修复前守卫 `block_kind == "manual"` 直接 continue，卡片滞留阻塞列
    （真实故障：卡 210，2026-09-10）。
    """
    cards = [_card(id=8, column_key="blocked", block_kind="manual")]
    applies = _once(monkeypatch, cards,
                    {"pending": False, "busy": True, "text": ""})
    assert applies == [(8, "to_doing")]


def test_iw_once_manual_blocked_stop_grace_ignores_stale_busy(monkeypatch):
    """刚被平台停过会话（拖入阻塞）的手动阻塞卡：宽限期内不据残留 busy 回搬。"""
    cards = [_card(id=8, column_key="blocked", block_kind="manual")]
    monkeypatch.setattr(board, "_stop_recent", lambda cid: True)
    applies = _once(monkeypatch, cards,
                    {"pending": False, "busy": True, "text": ""})
    assert applies == []


def test_iw_once_manual_blocked_idle_untouched(monkeypatch):
    """手动阻塞卡空闲（停车位）：维持不干预。"""
    cards = [_card(id=8, column_key="blocked", block_kind="manual")]
    applies = _once(monkeypatch, cards,
                    {"pending": False, "busy": False, "text": ""})
    assert applies == []


def test_iw_once_manual_blocked_live_msg_returns_to_doing(monkeypatch):
    """消息排队尚未执行（会话还不 busy）：live_msg 同样触发回开发列。"""
    cards = [_card(id=8, column_key="blocked", block_kind="manual")]
    applies = _once(monkeypatch, cards,
                    {"pending": False, "busy": False, "text": ""}, live=True)
    assert applies == [(8, "to_doing")]


# ---------- to_review 出队归位（2026-09-16 卡 388 实障；v3b 概念收敛） ----------


def test_apply_to_review_dequeues_delivered_occupancy(monkeypatch):
    """送达恢复的会话不在 _RUNS（_finish_run 不会收尾）：空闲转待审核时必须
    出队收口该卡的行/占用，否则项目串行位泄漏——统一队列拒绝拾起该项目任何新
    单元、后续待送达答案永久等待（真实故障：卡 388 送达后占住项目 9 一天，
    卡 389 的答案 22 小时未送达、队列清空也不开工）。v3b：原「to_review 兜底
    释放」独立概念退场，改走容器归位的出队原语（reason=出队-归位待审核）。"""
    calls = []
    fake = _FakeRunner()
    monkeypatch.setattr(board.db, "update_board_card",
                        lambda cid, **kw: calls.append(kw))
    _prepare_apply(monkeypatch, _apply_card(column_key="doing", block_kind=None),
                   "to_review", fake)
    board._iw_apply("dsh_plugin",
                    _apply_card(column_key="doing", block_kind=None),
                    "to_review", {"pending": False, "busy": False, "text": ""})
    assert calls == [{"column_key": "review", "block_kind": None, "block_text": ""}]
    assert fake.calls["finish"] == [7]
    assert fake.calls["finish_reasons"] == ["出队-归位待审核"]   # 出队标签（v3b）


def test_apply_to_review_without_occupancy_finish_idempotent(monkeypatch):
    """收尾只看行态（v2 §2.5.2-1 占用/事实分离，v3d 收口）：无活跃行的卡转
    待审核同样经出队原语幂等收口——fake 记录一次 card_finished
    调用，但无行可收（无活跃行时各子步 no-op）；
    列照搬 review。（原「不持占用不触发释放」守卫已随占用概念一并退场：
    收口尝试幂等无害，无需先查持有。）"""
    calls = []
    fake = _FakeRunner()
    monkeypatch.setattr(board.db, "update_board_card",
                        lambda cid, **kw: calls.append(kw))
    _prepare_apply(monkeypatch, _apply_card(column_key="doing", block_kind=None),
                   "to_review", fake)
    board._iw_apply("dsh_plugin",
                    _apply_card(column_key="doing", block_kind=None),
                    "to_review", {"pending": False, "busy": False, "text": ""})
    assert fake.calls["finish"] == [7]                 # 无条件幂等收口（守卫退役）
    assert calls == [{"column_key": "review", "block_kind": None, "block_text": ""}]


# ---------- 写回竞态守卫：已答待送达卡不受调和动作影响（2026-09-17） ----------

def test_apply_skips_answer_pending_card(monkeypatch):
    """已答待送达的卡：调和动作一律跳过（堵写回竞态，2026-09-17 复现修复）。

    竞态：tick 先按旧快照（卡在 doing、kimi 侧提问中）算出 block；用户随后作答
    （answer_interaction 落 doing/queue + 权威 answer 行写入 wait_items）；_iw_apply
    的写前复核在 doing/queue + kimi 侧仍 pending 下重评同为 block → 把卡写回
    blocked/interaction，待送达窗口内卡片漂出「正在开发」列（实障卡 389）。
    待送达窗口的列归属由作答/送达路径独占（作答落列 + 送达执行体归位），写点
    必须先认该判据（临时库复现脚本：未加守卫时写后 column=blocked）。"""
    calls = []
    fake = _FakeRunner()
    monkeypatch.setattr(board.db, "get_board_card",
                        lambda cid: _apply_card(column_key="doing",
                                                block_kind="queue"))
    monkeypatch.setattr(board.db, "update_board_card",
                        lambda cid, **kw: calls.append(kw))
    monkeypatch.setattr(board, "_has_active_run", lambda cid: False)
    monkeypatch.setattr(board.runner, "INSTANCE", fake)
    i = waitq.enqueue(waitq.KIND_ANSWER, 7, 9,
                      meta={"sid": "s-1", "qid": "Q-1", "answers": []})
    try:
        board._iw_apply("dsh_plugin",
                        _apply_card(column_key="doing", block_kind="queue"),
                        "block", {"pending": True, "busy": True, "text": "q"})
        assert calls == []                       # 不写库：待送达列归属不受调和
        assert waitq.get_active(waitq.KIND_ANSWER, 7) is not None   # 仍待送达
    finally:
        waitq.cancel(waitq.KIND_ANSWER, 7, "测试清理")   # 不留跨用例残留行


# ---------- blocked+无阻塞标记残留态归位（2026-09-17，卡 388 实障） ----------

def test_blocked_without_kind_running_returns_to_doing():
    """blocked+无标记（作答落列写入失败/送达只清标记的残留态）：会话在跑 → 回开发列。

    此前该形态被守卫按「其他 blocked 类型」整类跳过（状态机也恒 None），运行中卡
    滞留阻塞列、会话结束后 _finish_run 也不收（只认 doing / blocked+interaction）
    ——卡 388 实障滞留阻塞列两天。"""
    r = {"pending": False, "busy": True, "text": ""}
    assert board._reconcile_action_for(
        "dsh_plugin", _card(column_key="blocked", block_kind=None), r) == "to_doing"


def test_blocked_without_kind_idle_to_review():
    """残留态卡会话空闲（已结束）：回待审核收尾（与 blocked+interaction 同语义）。"""
    r = {"pending": False, "busy": False, "text": ""}
    assert board._reconcile_action_for(
        "dsh_plugin", _card(column_key="blocked", block_kind=None), r) == "to_review"


def test_blocked_without_kind_live_msg_returns_to_doing():
    """残留态卡由消息驱动（消息排队尚未执行）：live_msg 同样回开发列。"""
    r = {"pending": False, "busy": False, "text": ""}
    assert board._reconcile_action_for(
        "dsh_plugin", _card(column_key="blocked", block_kind=None), r,
        live_msg=True) == "to_doing"


def test_blocked_without_kind_platform_run_returns_to_doing():
    """残留态卡平台在管（busy 瞬时不稳）：按 has_run 回开发列，收尾仍归 _finish_run。"""
    r = {"pending": False, "busy": False, "text": ""}
    assert board._reconcile_action_for(
        "dsh_plugin", _card(column_key="blocked", block_kind=None), r,
        has_run=True) == "to_doing"


def test_blocked_without_kind_pending_blocks_interaction():
    """残留态卡会话又提问：pending 分支先手，升格 interaction 阻塞（不误回开发列）。"""
    r = {"pending": True, "busy": True, "text": "q"}
    assert board._reconcile_action_for(
        "dsh_plugin", _card(column_key="blocked", block_kind=None), r) == "block"


def test_iw_once_blocked_without_kind_probed_and_mapped(monkeypatch):
    """守卫放行 blocked+无标记卡探测并按会话实况归位（此前整类跳过永不搬运）。"""
    cards = [_card(id=8, column_key="blocked", block_kind=None)]
    assert _once(monkeypatch, cards,
                 {"pending": False, "busy": True, "text": ""}) == [(8, "to_doing")]
    assert _once(monkeypatch, cards,
                 {"pending": False, "busy": False, "text": ""}) == [(8, "to_review")]


# ---------- 落阻塞 eager 丢排队（v2b T3，R9：阻塞独立容器不占队列位） ----------

def _eager_block_setup(monkeypatch, pid, cid):
    """排队中卡被提问落 blocked 的公共夹具：真实 c: 等待行（doing+queue 占位）
    + 真实状态机（queue+pending→block）+ 出队/推送/实况桩。"""
    iid = waitq.enqueue_card(cid, pid)
    monkeypatch.setattr(board, "_has_active_run", lambda c: False)
    monkeypatch.setattr(board.chat, "live_of_sid", lambda sid: False)
    monkeypatch.setattr(board, "_stop_recent", lambda c: False)
    monkeypatch.setattr(board.feishu, "card_blocked", lambda *a, **k: None)
    return iid


def test_block_drops_card_wait_eagerly(monkeypatch):
    """落阻塞 eager 丢排队（v2b T3，裁决 R9）：排队中卡被提问落 blocked 时
    c: 等待行**即** cancelled（不再靠补位器「占位非 doing+queue」惰性摘除
    ——行不留队等拾取），占位清除后落 blocked/interaction。"""
    pid = db.insert_project(0, "eager", "/tmp/eager", "dsh-plugin:/usr/bin/dsh", "/tmp/eager/w")
    cid = db.insert_board_card(pid, "排队卡")
    iid = _eager_block_setup(monkeypatch, pid, cid)
    board._iw_apply("dsh_plugin", db.get_board_card(cid), "block",
                    {"pending": True, "busy": True, "text": "q?"})
    assert waitq.get_active(waitq.KIND_CARD, cid) is None      # eager 取消
    assert json.loads(waitq.get_item(iid)["meta"])["cancel_reason"] \
        == "落阻塞丢排队"
    cur = db.get_board_card(cid)
    assert (cur["column_key"], cur["block_kind"]) == ("blocked", "interaction")
    assert waitq.get_active(waitq.KIND_CARD, cid) is None      # 无残留可拾取


# ---------- dsh_plugin：同族语义（路线 A P1 打通，2026-10-03） ----------
# 此前 `_reconcile_action_for` 的门禁是 ("kimi_web","opencode_web")，dsh 卡压根
# 不参与调和——表现为「agent 提问了卡片也不进阻塞、答完也不回列」。以下三例把
# dsh 钉进状态机与读口。

def test_dsh_plugin_pending_blocks_card():
    """dsh 卡提问等待 → 进阻塞（与 kimi_web 同款判定）。"""
    r = {"pending": True, "busy": True, "text": "q"}
    assert board._reconcile_action_for("dsh_plugin", _card(), r) == "block"
    assert board._reconcile_action_for(
        "dsh_plugin", _card(column_key="review"), r) == "block"


def test_dsh_plugin_recover_and_idle_paths():
    """dsh 卡：交互阻塞解除按 busy 回开发列/待审核；doing 空闲回待审核。"""
    assert board._reconcile_action_for(
        "dsh_plugin", _card(column_key="blocked", block_kind="interaction"),
        {"pending": False, "busy": True}) == "to_doing"
    assert board._reconcile_action_for(
        "dsh_plugin", _card(column_key="blocked", block_kind="interaction"),
        {"pending": False, "busy": False}) == "to_review"
    assert board._reconcile_action_for(
        "dsh_plugin", _card(column_key="doing"),
        {"pending": False, "busy": False}) == "to_review"
    assert board._reconcile_action_for(
        "dsh_plugin", _card(column_key="doing"),
        {"pending": False, "busy": True}) is None      # 在管运行：列流转归收尾


def test_dsh_plugin_interaction_reads_hub_memory(monkeypatch):
    """`_iw_interaction` 的 dsh 分支：读 EventHub 注册表（P4 事件化；原为 /status），
    提问 → pending + 逐题全量 + qid=call_id（作答链路的键）；非 running 时短路。"""
    monkeypatch.setattr(board.dshdriver, "status", lambda sid: (_ for _ in ()).throw(
        AssertionError("P4 后不应再调 dshdriver.status")))
    monkeypatch.setattr(board.dshevents, "get", lambda sid: {
        "status": "running",
        "interaction": {"kind": "question", "call_id": "CALL-9",
                        "questions": [{"id": "q_0", "question": "选？",
                                       "options": ["A", "B"], "multi": False}]},
    })
    r = board._iw_interaction("dsh_plugin", {"id": 1}, "s-1")
    assert r["pending"] is True and r["busy"] is True
    assert r["kind"] == "question" and r["qid"] == "CALL-9"
    assert [o["label"] for o in r["questions"][0]["options"]] == ["A", "B"]
    # 审批：只展示不代答（answerable=False）
    monkeypatch.setattr(board.dshevents, "get", lambda sid: {
        "status": "running",
        "interaction": {"kind": "approval", "id": "A-1", "tool": "bash"},
    })
    r2 = board._iw_interaction("dsh_plugin", {"id": 1}, "s-1")
    assert r2["pending"] is True and r2["kind"] == "approval"
    assert r2["answerable"] is False and r2["approval_id"] == "A-1"
    # 空闲：pending 短路（不看残留 interaction）
    monkeypatch.setattr(board.dshevents, "get", lambda sid: {
        "status": "idle", "interaction": {"kind": "question"}})
    r3 = board._iw_interaction("dsh_plugin", {"id": 1}, "s-1")
    assert r3["pending"] is False and r3["busy"] is False
