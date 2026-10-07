# 唯一收尾点 board.finish(unit_key, reason)（v2d T1，裁决 R14；v2 §2.5.2-4）：
# 卡片生命周期各释放点（_finish_run 正常尾/卡已删、_iw_apply to_review 出队归位、
# _leave_doing 容器迁移两态、move_card 移列释放、delete_card_cleanup、dequeue_start
# 起跑失败回滚、runner worker finally c: 分支）收敛单点——行 finishing→终态 +
# 搬列 + notify 补位（时机②）；幂等（finishing/终态
# 重入各一次）。行态口径统一：waiting=取消域（作答排队防御收窄 waiting-only）、
# starting=worker finally 域（finish 不抢标）、running/finishing=finish() 域
# （card_finished 门禁扩 (running,finishing)）；recover c: 行全表兜底扫描。
import json, os, re, sys, threading, types, uuid
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

import board, db, runner, waitq


@pytest.fixture(autouse=True)
def _clean_tables():
    """每例前后清等待项/消息表（conftest 临时库；种子行落真表）。"""
    def _clean():
        with db.connect() as conn:
            for t in ("wait_items", "chat_msgs"):
                conn.execute(f"DELETE FROM {t}")
    _clean()
    yield
    _clean()


def _mk_project(agent_path="/usr/bin/kimi"):
    """真实项目行（settings_of 读库落默认 serial；默认显式给旧族可执行名——
    P7b 起归 retired，`_ext_refresh`/`_web_family` 仍归 None/False 不触 REST）。

    注：2026-10-03 起「空/未知 agent_path」默认族为 dsh_plugin（web 族），
    本文件的收尾断言都不依赖可跑族，故显式给一个非 web 族路径（留空会落
    dsh_plugin web 族，收尾路径会去触 REST）。"""
    uid = uuid.uuid4().hex[:8]
    return db.insert_project(0, f"fin-{uid}", f"/tmp/fin-{uid}", agent_path,
                             f"/tmp/fin-{uid}/work")


class _CountingCond:
    """notify_all 计数的 Condition 包装（finish → card_finished 的补位唤醒断言用）。"""
    def __init__(self):
        self._c = threading.Condition()
        self.notifies = 0

    def __enter__(self):
        return self._c.__enter__()

    def __exit__(self, *a):
        return self._c.__exit__(*a)

    def notify_all(self):
        self.notifies += 1
        self._c.notify_all()


def _bare_instance():
    """真实 card_started/card_finished/_pick_locked 的裸 runner 单例（无 worker
    线程；notify_all 计数）。"""
    r = runner.Runner.__new__(runner.Runner)
    r._lock = threading.Lock()
    r._cond = _CountingCond()
    r._procs, r._stop_requested = {}, set()
    return r


def _seed_running_unit(pid, cid):
    """造「运行中卡片单元」事实源（force 落表形态，v2b T4）：c: 行 running
    ——行即占位表征（v3d 起无第二表征）。返回行 id。"""
    row_id, _ = waitq.insert_card_force_start(cid, pid)
    waitq.mark_running(waitq.KIND_CARD, cid)
    return row_id


def _capture_finish(monkeypatch):
    """捕获出队收口调用 [(key, reason)]——出队点 reason 标签表用。"""
    calls = []
    real = board.finish

    def _rec(key, reason, **kw):
        calls.append((key, reason))
        return real(key, reason, **kw)
    monkeypatch.setattr(board, "finish", _rec)
    return calls


def _patch_watch_once_idle_tail(monkeypatch):
    """_watch_once 尾部与本轮无关的扫描打桩（定时开工/会话同步）。"""
    monkeypatch.setattr(board, "_enter_doing", lambda proj, r: (None, None))
    monkeypatch.setattr(board, "sync_sessions", lambda proj: [])
    monkeypatch.setattr(board.feishu, "card_review", lambda *a, **k: None)


# ---------- 1. 幂等（brief 先败①） ----------

def test_finish_is_idempotent(monkeypatch):
    """唯一收尾点幂等：重复触发（行已终态重入）行收口、搬列各一次；
    行 finishing 重入门禁：并发/中断重入直接返回（列/行不动）。"""
    pid = _mk_project()
    cid = db.insert_board_card(pid, "幂等卡")
    db.update_board_card(cid, column_key="doing")
    rid = _seed_running_unit(pid, cid)
    inst = _bare_instance()
    monkeypatch.setattr(board.runner, "INSTANCE", inst)
    updates = []
    real_update = db.update_board_card
    monkeypatch.setattr(board.db, "update_board_card",
                        lambda i, **kw: updates.append(kw) or real_update(i, **kw))
    board.finish(f"c:{cid}", "会话结束收尾", to_column="review")
    board.finish(f"c:{cid}", "会话结束收尾", to_column="review")   # 终态行重入
    assert updates == [{"mark_unread": True, "column_key": "review",
                        "block_kind": None,
                        "block_text": ""}]               # 搬列各一次（缺省置「有更新」标记）
    assert waitq.get_item(rid)["state"] == "done"        # 行终态（唯一表征）
    assert db.get_board_card(cid)["column_key"] == "review"

    # finishing 重入门禁：前次收尾进行中/中断，重入直接返回（各子步不再生效）
    pid2 = _mk_project()
    cid2 = db.insert_board_card(pid2, "重入卡")
    db.update_board_card(cid2, column_key="doing")
    rid2 = _seed_running_unit(pid2, cid2)
    waitq.mark_finishing(waitq.KIND_CARD, cid2)          # 置 finishing（收尾进行中）
    board.finish(f"c:{cid2}", "会话结束收尾", to_column="review")
    row2 = waitq.get_active(waitq.KIND_CARD, cid2)
    assert row2 is not None and row2["state"] == "finishing"   # 行未动
    assert db.get_board_card(cid2)["column_key"] == "doing"    # 列未搬


# ---------- 2. 五路触发殊途同归（brief 先败②） ----------

def test_five_triggers_converge(monkeypatch, tmp_path):
    """五路触发（进程退出/SSE idle/轮询回落/调和器/recover）殊途同归：
    行终态 + 搬列 + notify 补位（出队即收行，无第二表征）。recover 归位口径
    逐字保留——行落 failed「服务重启中断」（restart 路径不经 finish()）。"""
    log = tmp_path / "board.log"
    log.write_text("")
    finishes = _capture_finish(monkeypatch)          # 出队收口调用（key/reason）

    # ① 进程退出（CLI proc.poll() → _watch_once → _finish_run → finish）
    pid = _mk_project()
    cid = db.insert_board_card(pid, "cli卡")
    db.update_board_card(cid, column_key="doing", session_id="s-cli")
    rid = _seed_running_unit(pid, cid)
    inst = _bare_instance()
    monkeypatch.setattr(board.runner, "INSTANCE", inst)
    proc = types.SimpleNamespace(returncode=0, poll=lambda: 0)
    rec = {"proc": proc, "log_path": str(log), "started_at": 0,
           "usage_path": None, "family": "kimi", "project_dir": "/tmp/x"}
    monkeypatch.setattr(board, "_RUNS", {cid: rec})
    _patch_watch_once_idle_tail(monkeypatch)
    board._watch_once()
    assert db.get_board_card(cid)["column_key"] == "review"     # 搬列
    assert waitq.get_item(rid)["state"] == "done"               # 行终态
    assert (f"c:{cid}", "会话结束收尾") in finishes              # reason 标签
    assert inst._cond.notifies >= 1                             # notify 补位

    # ② SSE idle（v2d T2 事件处理器调用形态预埋：session.idle → finish 直调；
    # 本任务先钉收敛点本身——行收口/搬列经 to_column 一次完成）
    pid = _mk_project()
    cid = db.insert_board_card(pid, "sse卡")
    db.update_board_card(cid, column_key="doing")
    rid = _seed_running_unit(pid, cid)
    inst = _bare_instance()
    monkeypatch.setattr(board.runner, "INSTANCE", inst)
    board.finish(f"c:{cid}", "会话空闲(SSE)", to_column="review")
    assert db.get_board_card(cid)["column_key"] == "review"
    assert waitq.get_item(rid)["state"] == "done"
    assert (f"c:{cid}", "会话空闲(SSE)") in finishes
    assert inst._cond.notifies >= 1

    # ③ 轮询回落（web busy 过又回落 → _watch_once → _finish_run → finish）
    pid = _mk_project()
    cid = db.insert_board_card(pid, "web卡")
    db.update_board_card(cid, column_key="doing", session_id="s-web")
    rid = _seed_running_unit(pid, cid)
    inst = _bare_instance()
    monkeypatch.setattr(board.runner, "INSTANCE", inst)
    rec = {"proc": None, "sid": "s-web", "family": "dsh_plugin",
           "project_dir": "/tmp/x", "started_at": 0, "seen_busy": True,
           "aborted": False, "turn_baseline": None, "log_path": str(log)}
    monkeypatch.setattr(board, "_RUNS", {cid: rec})
    monkeypatch.setattr(board, "_session_state_family",
                        lambda *a, **k: board.STATE_IDLE)
    monkeypatch.setattr(board, "_web_turn_error", lambda r: "")
    _patch_watch_once_idle_tail(monkeypatch)
    board._watch_once()
    assert db.get_board_card(cid)["column_key"] == "review"
    assert waitq.get_item(rid)["state"] == "done"
    assert (f"c:{cid}", "会话结束收尾") in finishes
    assert inst._cond.notifies >= 1

    # ④ 调和器（_iw_apply to_review → 出队归位，收尾只看行态）
    pid = _mk_project()
    cid = db.insert_board_card(pid, "调和卡")
    db.update_board_card(cid, column_key="doing", session_id="s-1")
    rid = _seed_running_unit(pid, cid)
    inst = _bare_instance()
    monkeypatch.setattr(board.runner, "INSTANCE", inst)
    monkeypatch.setattr(board, "_reconcile_action_for", lambda *a, **k: "to_review")
    monkeypatch.setattr(board, "_has_active_run", lambda c: False)
    monkeypatch.setattr(board.chat, "live_of_sid", lambda sid: False)
    board._iw_apply("dsh_plugin", db.get_board_card(cid), "to_review",
                    {"pending": False, "busy": False, "text": ""})
    assert db.get_board_card(cid)["column_key"] == "review"
    assert waitq.get_item(rid)["state"] == "done"
    assert (f"c:{cid}", "出队-归位待审核") in finishes
    assert inst._cond.notifies >= 1

    # ⑤ recover 归位（口径逐字保留：行 failed「服务重启中断」+ 搬列 review；
    # restart 路径不经 finish()，行收口归 recover 映射与启动对账）
    pid = _mk_project()
    cid = db.insert_board_card(pid, "恢复卡")
    db.update_board_card(cid, column_key="doing", session_id="s-1")
    rid = _seed_running_unit(pid, cid)
    monkeypatch.setattr(board.runner, "INSTANCE", _bare_instance())
    monkeypatch.setattr(board, "_RUNS", {})                     # 无实况
    monkeypatch.setattr(board, "_recover_web_card", lambda p, c: None)
    monkeypatch.setattr(board.db, "list_queued_board_cards", lambda: [])
    board.recover()
    assert db.get_board_card(cid)["column_key"] == "review"
    row = waitq.get_item(rid)
    assert row["state"] == "failed"
    assert json.loads(row["meta"])["error"] == "服务重启中断"


# ---------- 3. 补位时机②（brief 先败③） ----------

def test_finish_frees_window_and_refills(monkeypatch):
    """finish 收口运行行（serial N=1：一个前缀行即满窗）后，
    补位器下一拍拾起等待区队首（补位时机②，裁决 R5⑤）。"""
    pid = _mk_project()
    cid_a = db.insert_board_card(pid, "运行卡")
    db.update_board_card(cid_a, column_key="doing")
    _seed_running_unit(pid, cid_a)
    cid_b = db.insert_board_card(pid, "等待卡")
    waitq.enqueue_card(cid_b, pid)                             # 等待区队首
    inst = _bare_instance()
    monkeypatch.setattr(board.runner, "INSTANCE", inst)
    assert inst._pick_locked() is None                         # 前缀满：不补位
    board.finish(f"c:{cid_a}", "会话结束收尾")
    assert inst._pick_locked() == f"c:{cid_b}"                 # 补位：队首起跑


# ---------- 4. 行为等价对拍：六出队点 reason 标签表（brief ④，specQ §3；v3b 换标签面） ----------

def test_dequeue_reason_tags_equivalence(monkeypatch, tmp_path):
    """六出队点 reason 标签表（specQ §3；v3b 换标签面）：_finish_run 卡已删变体、
    move_card 移列、容器迁移两态（出队-拖入阻塞 / 出队-交互阻塞）、
    dequeue_start 起跑失败回滚、delete_card_cleanup 卡片删除（_finish_run 会话
    结束收尾与 _iw_apply to_review 出队归位在 test_five_triggers_converge
    ①③④ 腿已钉）。标签经唯一收尾点 finish 的 reason 形参观测（旧租约释放
    日志面已随占用概念退场，本表是标签的唯一观测点）。"""
    log = tmp_path / "board.log"
    log.write_text("")
    pid = _mk_project()
    monkeypatch.setattr(board.runner, "INSTANCE", _bare_instance())
    finishes = _capture_finish(monkeypatch)

    # ① _finish_run 卡已删变体 → 会话结束-卡已删
    monkeypatch.setattr(board.db, "get_board_card", lambda i: None)
    monkeypatch.setattr(board, "_web_turn_error", lambda r: "")
    board._finish_run(999, {"proc": None, "sid": "", "log_path": str(log)})
    assert ("c:999", "会话结束-卡已删") in finishes
    monkeypatch.undo()                                   # 还原桩，后续腿用真库
    monkeypatch.setattr(board.runner, "INSTANCE", _bare_instance())
    finishes = _capture_finish(monkeypatch)

    # ② move_card doing→review → 移列释放
    cid = db.insert_board_card(pid, "移列卡")
    db.update_board_card(cid, column_key="doing")
    waitq.enter_running(waitq.KIND_CARD, cid, pid)
    monkeypatch.setattr(board, "_RUNS", {})
    board.move_card({"id": pid}, cid, "review")
    assert (f"c:{cid}", "移列释放") in finishes

    # ③ _leave_doing stop=True（手动拖入阻塞）→ 出队-拖入阻塞
    cid = db.insert_board_card(pid, "出队卡1")
    db.update_board_card(cid, column_key="doing")
    waitq.enter_running(waitq.KIND_CARD, cid, pid)
    board._leave_doing(db.get_board_card(cid), reason="出队-拖入阻塞")
    assert (f"c:{cid}", "出队-拖入阻塞") in finishes

    # ④ _leave_doing stop=False（交互挂起出队）→ 出队-交互阻塞（running 行随
    # 出队终态化 done——v2b 涌现记录保留，方向正确）
    cid = db.insert_board_card(pid, "出队卡2")
    db.update_board_card(cid, column_key="doing")
    rid = _seed_running_unit(pid, cid)
    board._leave_doing(db.get_board_card(cid), stop=False,
                       reason="出队-交互阻塞")
    assert (f"c:{cid}", "出队-交互阻塞") in finishes
    assert waitq.get_item(rid)["state"] == "done"

    # ⑤ dequeue_start 起跑失败回滚 → 起跑失败回滚；starting 行不收（v2b fix
    # round 1 基线：终态归 worker finally failed「起会话失败」，finish 不抢标）
    cid = db.insert_board_card(pid, "起跑失败卡")
    db.update_board_card(cid, column_key="review")
    iid = waitq.enqueue_card(cid, pid, from_column="review")
    assert waitq.claim(iid, "worker")                    # worker 拾取 → starting
    monkeypatch.setattr(board, "_RUNS", {})
    monkeypatch.setattr(board, "start_card",
                        lambda p, c, extra="": (_ for _ in ()).throw(
                            RuntimeError("起不动")))
    assert board.dequeue_start({"id": pid, "agent_path": ""},
                               db.get_board_card(cid)) is False
    assert (f"c:{cid}", "起跑失败回滚") in finishes
    assert waitq.get_item(iid)["state"] == "starting"    # finish 不收 starting
    waitq.finish_by_target(waitq.KIND_CARD, cid,
                           waitq.STATE_FAILED, "起会话失败")   # worker finally 同型
    row = waitq.get_item(iid)
    assert row["state"] == "failed"
    assert json.loads(row["meta"])["error"] == "起会话失败"
    assert db.get_board_card(cid)["column_key"] == "review"    # 回 from_column

    # ⑥ delete_card_cleanup → 卡片删除
    cid = db.insert_board_card(pid, "删除卡")
    waitq.enter_running(waitq.KIND_CARD, cid, pid)
    board.delete_card_cleanup(cid)
    assert (f"c:{cid}", "卡片删除") in finishes
    assert waitq.get_active(waitq.KIND_CARD, cid) is None


# ---------- 5. card_finished 门禁扩 (running,finishing)（v2b fix note 评估落地） ----------

def test_card_finished_gate_running_and_finishing():
    """行收口门禁=(running, finishing)：finish() 的 mark_finishing 先把
    running 行置 finishing（finishing 态唯一生产路径），card_finished 必须
    接纳 finishing 才能完成终态化；running 口径不变；starting 不收（起跑失败
    行终态归 worker finally failed——v2b fix round 1 基线钉死）。"""
    inst = _bare_instance()
    pid = _mk_project()
    # running → done（口径不变）
    cid = db.insert_board_card(pid, "r卡")
    rid = _seed_running_unit(pid, cid)
    inst.card_finished(cid, reason="测试收尾")
    assert waitq.get_item(rid)["state"] == "done"
    # finishing → done（扩态：门禁不收则 finish() 标的行无人终态化）
    cid = db.insert_board_card(pid, "f卡")
    rid = _seed_running_unit(pid, cid)
    waitq.mark_finishing(waitq.KIND_CARD, cid)
    inst.card_finished(cid, reason="测试收尾")
    assert waitq.get_item(rid)["state"] == "done"
    # starting → 不收（终态归 worker finally 域）
    cid = db.insert_board_card(pid, "s卡")
    iid = waitq.enqueue_card(cid, pid)
    waitq.claim(iid, "worker")
    inst.card_finished(cid, reason="测试收尾")
    assert waitq.get_item(iid)["state"] == "starting"


# ---------- 5b. 收尾 reason 日志落点（v3 终审修复：v3d 删租约日志后 running 行 reason 无落点） ----------

def test_finish_logs_reason_when_row_collected(monkeypatch, capsys):
    """收尾点日志落点：`board.finish` **真实收口一行** ⇒ 一行确定性日志
    `[board] 卡片收尾：c:<id>（<reason>）`（v3d 删 `waitq.release` 的
    「释放租约 c:N（reason）」后，运行/收尾态行上的 reason 曾无任何落点）；
    行未收口不落日志（终态重入 no-op / starting 行门禁跳过）——落点判据与
    `runner.card_finished` 返回的收口事实同源。"""
    pid = _mk_project()
    inst = _bare_instance()
    monkeypatch.setattr(board.runner, "INSTANCE", inst)
    cid = db.insert_board_card(pid, "日志卡")
    db.update_board_card(cid, column_key="doing")
    rid = _seed_running_unit(pid, cid)
    board.finish(f"c:{cid}", "会话结束收尾")
    out = capsys.readouterr().out
    assert f"[board] 卡片收尾：c:{cid}（会话结束收尾）" in out   # reason 落点
    assert waitq.get_item(rid)["state"] == "done"
    board.finish(f"c:{cid}", "会话结束收尾")                    # 终态重入：行未收口
    assert "卡片收尾" not in capsys.readouterr().out
    # starting 行：门禁不收（终态归 worker finally），同样不落收尾日志
    cid2 = db.insert_board_card(pid, "起点卡")
    iid = waitq.enqueue_card(cid2, pid)
    waitq.claim(iid, "worker")
    board.finish(f"c:{cid2}", "起跑失败回滚")
    assert "卡片收尾" not in capsys.readouterr().out
    assert waitq.get_item(iid)["state"] == "starting"


# ---------- 6. 作答排队防御行态口径（v2b 终审记录①：不再命中 force running 行） ----------

def test_answer_defense_cancel_waiting_only(monkeypatch):
    """作答排队防御只收 waiting 行（P4 R10 本义=防旧队列条目被拾起误发
    「继续」），不再命中 force running 行——running/finishing 行终态化归
    finish() 唯一收尾点、starting 归 worker finally（行态口径统一）。"""
    submitted = []
    monkeypatch.setattr(board.runner, "INSTANCE",
                        type("R", (), {"submit_answer": staticmethod(
                            lambda c: submitted.append(c))})())
    meta = {"sid": "s-1", "qid": "Q-1", "answers": []}
    # waiting 行：照常取消（防御本义）
    pid = _mk_project()
    cid = db.insert_board_card(pid, "排队卡")
    iid = waitq.enqueue_card(cid, pid)
    board._queue_answer_unit({"id": pid}, cid, "s-1", dict(meta))
    row = waitq.get_item(iid)
    assert row["state"] == "cancelled"
    assert json.loads(row["meta"])["cancel_reason"] == "作答排队防御"
    assert waitq.get_active(waitq.KIND_ANSWER, cid) is not None
    assert submitted == [cid]
    # running 行（force 落表在跑）：不再被防御命中，终态化归 finish()
    cid2 = db.insert_board_card(pid, "force卡")
    rid2 = _seed_running_unit(pid, cid2)
    board._queue_answer_unit({"id": pid}, cid2, "s-1", dict(meta))
    row2 = waitq.get_item(rid2)
    assert row2["state"] == "running"                    # 未被防御 cancel 命中
    assert waitq.get_active(waitq.KIND_ANSWER, cid2) is not None


# ---------- 7. recover c: 行全表兜底扫描（v2a T1 minor 收口） ----------

def test_recover_backstop_scans_all_card_rows(monkeypatch):
    """c: 行全表兜底（防御纵深，结构性不可达）：非 doing 卡的活跃 c: 行在
    recover 时按 doing 卡映射同口径收口——无 _RUNS 实况 starting→cancelled /
    running,finishing→failed「服务重启中断」；waiting 行重启存活不动；
    兜底不搬列（列归位归 doing 卡主循环）。"""
    pid = _mk_project()
    cid_s = db.insert_board_card(pid, "starting卡")      # 留 todo（非 doing）
    rid_s, _ = waitq.insert_card_force_start(cid_s, pid)
    cid_r = db.insert_board_card(pid, "running卡")
    rid_r, _ = waitq.insert_card_force_start(cid_r, pid)
    waitq.mark_running(waitq.KIND_CARD, cid_r)
    cid_w = db.insert_board_card(pid, "waiting卡")
    rid_w = waitq.enqueue_card(cid_w, pid)               # waiting：重启存活
    db.update_board_card(cid_w, column_key="todo", block_kind=None)  # 撤占位免入队重建
    monkeypatch.setattr(board.runner, "INSTANCE", _bare_instance())
    monkeypatch.setattr(board, "_RUNS", {})
    monkeypatch.setattr(board, "_recover_web_card", lambda p, c: None)
    monkeypatch.setattr(board.db, "list_queued_board_cards", lambda: [])
    board.recover()
    row_s = waitq.get_item(rid_s)
    assert row_s["state"] == "cancelled"
    assert json.loads(row_s["meta"])["cancel_reason"] == "服务重启中断"
    row_r = waitq.get_item(rid_r)
    assert row_r["state"] == "failed"
    assert json.loads(row_r["meta"])["error"] == "服务重启中断"
    assert waitq.get_item(rid_w)["state"] == "waiting"   # 存活不动
    assert db.get_board_card(cid_s)["column_key"] == "todo"   # 兜底不搬列
