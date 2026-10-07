#!/usr/bin/env python3
"""P6 展示派生：queue_state 派生函数真值表（真表种子）。

判定逻辑全部在服务端（裁决 R5），本文件钉死裁决 R10 的优先级与七枚举全格
（v2a T4 加 starting，裁决 R6）：
idle / queued_serial（等串行位）/ answer_pending（已收下待送达）/
server_queued（服务端排队，仅会话级）/ foreign_busy（等外部会话）/
starting（启动中：板卡已交 runner、会话未证实运行）/ running。
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pytest

import board
import db
import waitq


@pytest.fixture(autouse=True)
def _clean_waitq_tables():
    """每例前后清空 waitq 相关表（conftest 临时库，防跨用例位次串扰）。"""
    def _clean():
        with db.connect() as conn:
            conn.execute("DELETE FROM wait_items")
    _clean()
    yield
    _clean()


def _mk_card(block_kind=""):
    """造一张卡片行（board_cards 真表），返回 card_id。"""
    cid = db.insert_board_card(1, "t", "")
    if block_kind:
        db.update_board_card(cid, block_kind=block_kind)
    return cid


def test_idle_when_nothing_active():
    """无任何等待/运行信号 → idle。"""
    cid = _mk_card()
    row = db.get_board_card(cid)
    assert board.queue_state_of(row) == "idle"


def test_answer_pending_beats_running():
    """互斥例外：answer 活跃行在场时即便 running/busy 为真也判 answer_pending。

    （现状 BoardTab.jsx:509 的 `!card.answer_pending` 排除条件逐字翻印，裁决 R10。）
    """
    cid = _mk_card()
    waitq.enqueue(waitq.KIND_ANSWER, cid, 1)
    row = db.get_board_card(cid)
    assert board.queue_state_of(row, running=True, busy=True) == "answer_pending"


def test_interaction_pending_beats_running():
    """interaction_pending（2026-09-25 第八枚举，#560）：block_kind='interaction'
    （提问挂起等作答）→ interaction_pending，压 running/busy——kimi web turn 在
    等作答期间实况 busy=true（#554 实测 pending_interaction=question 且 busy=true），
    旧判定亮「会话运行中」与阻塞容器语义矛盾；answer 行在场（已作答）仍最高。
    列无关：与前端 🤔 徽标同条件（BoardTab 只看 block_kind）；手动阻塞不受影响。"""
    cid = _mk_card(block_kind="interaction")
    row = db.get_board_card(cid)
    assert board.queue_state_of(row) == "interaction_pending"
    assert board.queue_state_of(row, busy=True) == "interaction_pending"
    assert board.queue_state_of(row, running=True) == "interaction_pending"
    assert board.queue_state_of(row, starting=True) == "interaction_pending"
    waitq.enqueue(waitq.KIND_ANSWER, cid, 1)     # 已作答·待送达仍最高
    assert board.queue_state_of(row, busy=True) == "answer_pending"
    waitq.cancel(waitq.KIND_ANSWER, cid, "测试收尾")
    cid2 = _mk_card(block_kind="manual")         # 手动阻塞不走本枚举
    assert board.queue_state_of(db.get_board_card(cid2)) == "idle"


def test_running_when_running_map_hit():
    """running/busy 命中且无更高优先级 → running。"""
    cid = _mk_card()
    row = db.get_board_card(cid)
    assert board.queue_state_of(row, running=True) == "running"
    assert board.queue_state_of(row, busy=True) == "running"


def test_queued_serial_when_block_kind_queue():
    """block_kind='queue' 占位且无运行 → queued_serial。"""
    cid = _mk_card(block_kind="queue")
    row = db.get_board_card(cid)
    assert board.queue_state_of(row) == "queued_serial"


def test_foreign_busy_when_project_occupied_by_sync():
    """排队占位 + 项目被外部会话占用 → foreign_busy（新通道，明示变更 2）。"""
    cid = _mk_card(block_kind="queue")
    row = db.get_board_card(cid)
    assert board.queue_state_of(row, foreign=True) == "foreign_busy"


def test_msg_queued_counts_as_queued_serial():
    """msg_queued（chat_msgs 表 queued 行带 card_id）→ queued_serial。"""
    cid = _mk_card()
    row = db.get_board_card(cid)
    assert board.queue_state_of(row, msg_queued=True) == "queued_serial"


def test_running_beats_queued_placeholder():
    """优先级冲突对拍：占位卡会话仍在跑（交互阻塞解除回排队态）时运行赢排队
    （互斥不变量：同卡不同时显示「排队中」与「会话运行中」，唯一例外是待送达）。"""
    cid = _mk_card(block_kind="queue")
    row = db.get_board_card(cid)
    assert board.queue_state_of(row, running=True) == "running"
    assert board.queue_state_of(row, busy=True) == "running"


def test_answer_pending_beats_queue_placeholder():
    """传递冲突对拍（T3 补格）：排队占位 + answer 活跃行在场 → answer_pending
    （占位卡作答待送达窗口的真实形态，answer 优先级最高）。"""
    cid = _mk_card(block_kind="queue")
    waitq.enqueue(waitq.KIND_ANSWER, cid, 1)
    row = db.get_board_card(cid)
    assert board.queue_state_of(row) == "answer_pending"


def test_running_beats_foreign_busy():
    """传递冲突对拍（T3 补格）：排队占位 + 外部占用 + 会话在跑 → running
    （running 优先级高于排队分叉；foreign 只在无运行信号时分岔）。"""
    cid = _mk_card(block_kind="queue")
    row = db.get_board_card(cid)
    assert board.queue_state_of(row, running=True, foreign=True) == "running"


def test_starting_when_card_row_starting_not_confirmed():
    """starting（v2a T4 第七枚举，裁决 R6）：c: 行 starting 且未证实 running
    → starting（启动宽限窗口）；判定序插在 running 之后、queued 之前——
    占位/排队信号被压（starting 行在场=已在启动），证实运行后 running 赢。"""
    cid = _mk_card(block_kind="queue")
    i = waitq.enqueue(waitq.KIND_CARD, cid, 1)
    waitq.claim(i, "worker")                     # 已交 runner 拾起（行 starting）
    row = db.get_board_card(cid)
    assert board.queue_state_of(row) == "starting"               # 压排队占位
    assert board.queue_state_of(row, foreign=True) == "starting"  # 压 foreign 分叉
    assert board.queue_state_of(row, running=True) == "running"  # 证实运行 → running
    assert board.queue_state_of(row, busy=True) == "running"
    waitq.enqueue(waitq.KIND_ANSWER, cid, 1)     # answer 优先级仍最高
    assert board.queue_state_of(row) == "answer_pending"
    # 起跑收口（行落 done）后回到排队占位判定
    waitq.finish_by_target(waitq.KIND_CARD, cid)
    waitq.cancel(waitq.KIND_ANSWER, cid, "测试收尾")
    assert board.queue_state_of(row) == "queued_serial"


def test_queue_states_batch_includes_starting():
    """批量派生（board_payload 路径）：c: 行 starting 的卡片一次查询判 starting
    （无 N+1）；与 queued/answer 混排各归其位。"""
    cid_s = _mk_card(block_kind="queue")
    cid_q = _mk_card(block_kind="queue")
    i = waitq.enqueue(waitq.KIND_CARD, cid_s, 1)
    waitq.claim(i, "worker")                     # cid_s 行 starting
    rows = [db.get_board_card(c) for c in (cid_s, cid_q)]
    states = board.queue_states({"id": 1}, rows)
    assert states == {cid_s: "starting", cid_q: "queued_serial"}


def test_card_json_carries_queue_state_last():
    """card_json 返回值新增 queue_state 字段（最后一枚键，既有键序不动）；
    缺省按四参现算（hidden sites 调用点零改动），显式传入时与 answer_pending 同源。"""
    cid = _mk_card()
    row = db.get_board_card(cid)
    d = board.card_json(row)
    assert list(d.keys())[-1] == "queue_state"
    assert d["queue_state"] == "idle"
    waitq.enqueue(waitq.KIND_ANSWER, cid, 1)
    d = board.card_json(row)
    assert d["queue_state"] == "answer_pending" and d["answer_pending"] is True
    # 批量预计算路径：queue_state 显式传入时 answer_pending 与之一致（不二次点查）
    d = board.card_json(row, queue_state=board.QS_ANSWER)
    assert d["answer_pending"] is True
    d = board.card_json(row, queue_state=board.QS_RUNNING)
    assert d["answer_pending"] is False


def test_queue_states_batch_and_foreign(monkeypatch):
    """批量派生：answer/msg 活跃行一次查询（无 N+1）；proj 有活跃 ext 行（外部
    条目闸命中）时排队占位卡整体分岔为 foreign_busy，proj=None 时 foreign 恒 False 降级。"""
    cid_q = _mk_card(block_kind="queue")
    cid_a = _mk_card()
    cid_i = _mk_card()
    waitq.enqueue(waitq.KIND_ANSWER, cid_a, 1)
    rows = [db.get_board_card(c) for c in (cid_q, cid_a, cid_i)]
    proj = {"id": 1}
    # 外部条目读口=项目活跃 ext 行在场（v3d；旧 _SYNC_BUSY 集合与探针注册面退场）
    sc = _mk_card()
    waitq.insert_ext(1, sc, "s-ext")
    states = board.queue_states(proj, rows)
    assert states == {cid_q: "foreign_busy", cid_a: "answer_pending",
                      cid_i: "idle"}
    waitq.finish_by_target(waitq.KIND_EXT, sc)
    states = board.queue_states(proj, rows)
    assert states[cid_q] == "queued_serial"
    assert states[cid_a] == "answer_pending"     # answer 优先级不受外部占用影响
    # 无项目上下文降级：foreign 不可能出现
    waitq.insert_ext(1, sc, "s-ext")
    states = board.queue_states(None, rows)
    assert states[cid_q] == "queued_serial"


def test_session_queue_state_priority(monkeypatch):
    """会话级判定序（裁决 R10）：answer_pending > server_queued
    > interaction_pending > running > starting > queued_serial/foreign_busy
    > idle（v2a T4 加 starting，裁决 R6；2026-09-25 加 interaction_pending；
    任务会话 starting/interaction_pending 恒 False 退化不变）。"""
    import server
    queued = {"state": "queued", "pos": 1, "total": 1}
    running_us = {"state": "running", "pos": 0, "total": 0}
    idle_us = {"state": "idle", "pos": 0, "total": 0}
    # answer 最高：压住 server_queued 与 running（互斥唯一例外）
    assert server._session_queue_state(
        9, queued, running=True, answer_pending=True,
        server_queued=True) == "answer_pending"
    # server_queued 次之（dsh 宿主 inbox 排队行在场，显式入参）
    assert server._session_queue_state(
        9, running_us, server_queued=True) == "server_queued"
    # interaction_pending（2026-09-25 第八枚举）：提问挂起压 running；answer/
    # server_queued 仍更高；任务会话不传该参判定序退化不变
    assert server._session_queue_state(
        9, running_us, running=True,
        interaction_pending=True) == "interaction_pending"
    assert server._session_queue_state(
        9, running_us, running=True, interaction_pending=True,
        answer_pending=True) == "answer_pending"
    assert server._session_queue_state(
        9, running_us, running=True, interaction_pending=True,
        server_queued=True) == "server_queued"
    # running：显式 running（_board_session_running 口径）或 unit_state=running
    assert server._session_queue_state(9, queued, running=True) == "running"
    assert server._session_queue_state(9, running_us) == "running"
    # starting（c: 行 starting 且未证实运行）：压行视角的 unit_state=running
    # 与排队分叉；证实运行（running=True）后 running 赢；answer/server_queued
    # 仍压 starting
    assert server._session_queue_state(9, running_us, starting=True) == "starting"
    assert server._session_queue_state(9, queued, starting=True) == "starting"
    assert server._session_queue_state(
        9, running_us, running=True, starting=True) == "running"
    assert server._session_queue_state(
        9, running_us, answer_pending=True, starting=True) == "answer_pending"
    assert server._session_queue_state(
        9, running_us, server_queued=True, starting=True) == "server_queued"
    # 任务会话：starting 恒 False——行视角 running 不退化（现状保持）
    assert server._session_queue_state(9, running_us, starting=False) == "running"
    # queued 分叉：外部条目闸（与 runner.unit_busy 的 ext 行分量同口径；
    # v3d 判据=项目活跃 ext 行在场，旧 _SYNC_BUSY 集合与探针注册面退场）
    sc = _mk_card()
    waitq.insert_ext(9, sc, "s-ext")
    assert server._session_queue_state(9, queued) == "foreign_busy"
    waitq.finish_by_target(waitq.KIND_EXT, sc)
    assert server._session_queue_state(9, queued) == "queued_serial"
    # 空闲 / runner 缺位（unit_state=None）
    assert server._session_queue_state(9, idle_us) == "idle"
    assert server._session_queue_state(9, None) == "idle"


def test_board_session_meta_project_busy_whitelist():
    """移交①（v2c T4）：board 卡片会话 meta 链路 project_busy 白名单两钉——
    服务端看板会话端点下发 data["project_busy"]（f426b42 已在案）；前端
    SessionView 轮询 setMeta 逐字段白名单含 project_busy（此前漏字段，前端
    永远看不到——ComposerBar 忙碌预测 qstate非idle||project_busy 的兜底失灵）。
    源码钉（白名单是静态契约；行为面由 Playwright/真机走查覆盖）。"""
    import pathlib
    root = pathlib.Path(__file__).resolve().parent.parent
    sv = (root / "webui/src/components/SessionView.jsx").read_text(encoding="utf-8")
    assert "project_busy: d.project_busy" in sv   # 前端轮询白名单（本任务补）
    srv = (root / "server.py").read_text(encoding="utf-8")
    assert 'data["project_busy"]' in srv          # 服务端下发（存量已在案）
