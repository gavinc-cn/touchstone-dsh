# starting 态超时 + 对账兜底（v2d T3；v2 §2.5.2-5，裁决 R6）：
# c: 行 starting = 「拾取 → 会话证实」窗口（claim 后会话尚未证实运行）；窗口内
# 崩溃/异常若把行永久钉在 starting，行即成员的补位器会永远少一个位次。裁定：
#   · 调和器 5s 节拍（_iw_once → _reconcile_starting_rows）对超龄
#     （> board._STARTING_TIMEOUT_S，90s=原 WEB_TURN_START_TIMEOUT 数值）行三态复核：
#       实况在跑 → waitq.mark_running 自愈（不处置）；
#       可证未起 → 行 failed（error="starting 超时"）+ 卡回 meta.from_column
#                  + finish（唯一收尾点）+ 告警日志；
#       不可证   → 只告警（「未知 ≠ 结束」对账哲学，specQ §10 同款）；
#   · selfcheck 超龄判据扩 running/finishing（v2a T1 minor 收口），无证据佐证
#     一律告警不自动收口（R11 边界沿用）。
# 90s 宽限补丁（WEB_TURN_START_TIMEOUT）语义并入本阈值；`_rec_active`「条目存在
# 即运行中」退役（防宽限误判职责由 starting 态显式承担）。
import json, os, subprocess, sys, threading, time, types, uuid
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
    """真实 card_started/card_finished 的裸 runner 单例（无 worker 线程）。"""
    r = runner.Runner.__new__(runner.Runner)
    r._lock = threading.Lock()
    r._cond = _CountingCond()
    r._procs, r._stop_requested, r._busy_probe = {}, set(), None
    return r


def _mk_project(agent_path="/usr/bin/kimi"):
    """真实项目行（默认显式给退场族路径 = 非 web 族，`_web_family` 归 None 不触 REST）。

    注：2026-10-03 前默认空串也归 CLI 族；默认族改 dsh_plugin 后空串已是 web 族
    （dsh 卡按 web 语义收口，行收口判据不同），故非 web 腿显式给退场族路径
    （`/usr/bin/kimi` → `retired`，仅存量项目如此）。"""
    uid = uuid.uuid4().hex[:8]
    return db.insert_project(0, f"st-{uid}", f"/tmp/st-{uid}", agent_path,
                             f"/tmp/st-{uid}/work")


def _mk_task(pid):
    return db.insert_task(pid, "st", 0, "不复测", "rounds", 1)


def _stale_starting(pid, cid, from_column="review", age_s=600):
    """造「拾取→会话证实窗口」残留行：c: 行 starting + claimed_at 做旧。返回行 id。"""
    rid = waitq.enqueue_card(cid, pid, from_column=from_column)
    assert waitq.claim(rid, "worker") is True
    old = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time() - age_s))
    with db.connect() as conn:
        conn.execute("UPDATE wait_items SET claimed_at=? WHERE id=?", (old, rid))
    return rid


def _mk_card(pid, title, column="doing", sid=""):
    cid = db.insert_board_card(pid, title)
    db.update_board_card(cid, column_key=column, session_id=sid)
    return cid


def _web_rec(cid, sid, family="dsh_plugin", **kw):
    """在管 web 条目（_RUNS rec）最小事实源。"""
    rec = {"proc": None, "sid": sid, "family": family, "project_dir": "/tmp/x",
           "started_at": 0, "seen_busy": False, "aborted": False,
           "turn_baseline": None, "log_path": ""}
    rec.update(kw)
    return rec


def _patch_reconcile_prelude(monkeypatch):
    """调和器节拍扫描面无本项目外的干扰（项目列表空 + 无同步卡探测变化）。"""
    monkeypatch.setattr(board.db, "list_projects_all", lambda: [])


# ---------- 1. 可证未起 → finish("starting 超时")（brief 先败①） ----------

def test_starting_timeout_provable_dead_fails(monkeypatch, capsys):
    """starting 超龄 + 可证未起（非 web 族无进程面 / web 会话无 turn）→
    finish(reason="starting 超时")：行 failed（error 落 meta）+ 卡回
    meta.from_column + 行收口（唯一收尾点）+ 告警日志；第一腿经 _iw_once
    全链路（调和器节拍接线）。"""
    # ① 非 web 族：无在管条目、无存活 pid 证据 → 进程面可证未起
    pid = _mk_project()
    cid = _mk_card(pid, "非 web 超时卡")
    rid = _stale_starting(pid, cid, from_column="review")
    inst = _bare_instance()
    monkeypatch.setattr(board.runner, "INSTANCE", inst)
    monkeypatch.setattr(board, "_RUNS", {})
    _patch_reconcile_prelude(monkeypatch)
    board._iw_once()                                  # 调和器节拍（接线断言）
    assert waitq.get_active(waitq.KIND_CARD, cid) is None
    row = waitq.get_item(rid)
    assert row["state"] == "failed"
    assert json.loads(row["meta"])["error"] == "starting 超时"
    assert db.get_board_card(cid)["column_key"] == "review"    # 回 from_column
    assert waitq.get_item(rid)["state"] == "failed"           # 唯一收尾点收行（无第二表征可泄漏）
    assert inst._cond.notifies >= 1                            # 补位唤醒
    out = capsys.readouterr().out
    assert "starting 超时" in out                              # 告警日志

    # ② web：会话 idle 且 turn 归属基线未动 → 可证未起；在管条目随本处置弹出
    #    （否则巡视侧随后按「turn 未开始」再收一遍，把卡列改写回 review）
    pid2 = _mk_project(agent_path="dsh-plugin:/usr/bin/dsh")
    cid2 = _mk_card(pid2, "web 超时卡", sid="s-to")
    rid2 = _stale_starting(pid2, cid2, from_column="todo")
    rec = _web_rec(cid2, "s-to", turn_baseline=("completed", 3))
    monkeypatch.setattr(board, "_RUNS", {cid2: rec})
    monkeypatch.setattr(board, "_session_state_family",
                        lambda *a, **k: board.STATE_IDLE)
    monkeypatch.setattr(board, "_web_turn_ran", lambda r: False)
    board._reconcile_starting_rows()
    row2 = waitq.get_item(rid2)
    assert row2["state"] == "failed"
    assert json.loads(row2["meta"])["error"] == "starting 超时"
    assert db.get_board_card(cid2)["column_key"] == "todo"     # 回 from_column
    assert cid2 not in board._RUNS                             # 条目随处置弹出
    assert "starting 超时" in capsys.readouterr().out


# ---------- 2. 实况在跑 → mark_running 自愈（brief 先败②） ----------

def test_starting_timeout_alive_self_heals(monkeypatch, capsys):
    """超龄但实况在跑（非 web 族子进程存活 / web 会话 busy）→ mark_running 自愈：
    行转 running 留队构成运行前缀（位次计入），不处置——卡列/在管条目不动。"""
    # ① 非 web 族：在管条目子进程存活
    pid = _mk_project()
    cid = _mk_card(pid, "非 web 在跑卡")
    rid = _stale_starting(pid, cid)
    monkeypatch.setattr(board.runner, "INSTANCE", _bare_instance())
    proc = types.SimpleNamespace(poll=lambda: None)
    monkeypatch.setattr(board, "_RUNS", {cid: {"proc": proc, "started_at": 0}})
    board._reconcile_starting_rows()
    assert waitq.get_item(rid)["state"] == "running"           # 自愈（不终态化）
    assert db.get_board_card(cid)["column_key"] == "doing"     # 不处置：列不动
    assert waitq.get_item(rid)["state"] == "running"          # 行自愈留队
    assert cid in board._RUNS
    assert "自愈" in capsys.readouterr().out

    # ② web：会话 busy（实况在跑）
    pid2 = _mk_project(agent_path="dsh-plugin:/usr/bin/dsh")
    cid2 = _mk_card(pid2, "web 在跑卡", sid="s-run")
    rid2 = _stale_starting(pid2, cid2)
    rec = _web_rec(cid2, "s-run")
    monkeypatch.setattr(board, "_RUNS", {cid2: rec})
    monkeypatch.setattr(board, "_session_state_family",
                        lambda *a, **k: board.STATE_RUNNING)
    board._reconcile_starting_rows()
    assert waitq.get_item(rid2)["state"] == "running"
    assert db.get_board_card(cid2)["column_key"] == "doing"

    # ③ 无在管条目但行 evidence.pid 指向存活进程（orphan 面，R11④ 进程证据
    #    v3c 迁行）→ 自愈
    pid3 = _mk_project()
    cid3 = _mk_card(pid3, "孤儿进程卡")
    rid3 = _stale_starting(pid3, cid3)
    waitq.mark_evidence(waitq.KIND_CARD, cid3, {"pid": os.getpid()})
    monkeypatch.setattr(board, "_RUNS", {})
    board._reconcile_starting_rows()
    assert waitq.get_item(rid3)["state"] == "running"
    assert json.loads(waitq.get_item(rid3)["meta"] or "{}").get("error") is None


# ---------- 3. 不可证 → 只告警（brief 先败③） ----------

def test_starting_timeout_unknown_only_alerts(monkeypatch, capsys):
    """不可证（会话实况读不到 / 短 turn 已跑基线反证不了）→ 只告警不处置：
    行仍 starting、卡列/在管条目全不动（「未知 ≠ 结束」）。"""
    # ① web 无在管条目 + 会话实况读不到（REST 失败 → unknown）
    pid = _mk_project(agent_path="dsh-plugin:/usr/bin/dsh")
    cid = _mk_card(pid, "未知卡", sid="s-unk")
    rid = _stale_starting(pid, cid)
    monkeypatch.setattr(board.runner, "INSTANCE", _bare_instance())
    monkeypatch.setattr(board, "_RUNS", {})
    monkeypatch.setattr(board, "_session_state_family",
                        lambda *a, **k: board.STATE_UNKNOWN)
    board._reconcile_starting_rows()
    assert waitq.get_active(waitq.KIND_CARD, cid)["state"] == "starting"   # 不处置
    assert db.get_board_card(cid)["column_key"] == "doing"
    assert waitq.get_active(waitq.KIND_CARD, cid) is not None
    assert "告警" in capsys.readouterr().out

    # ② web 在管条目 + 会话 idle 但短 turn 已跑（_web_turn_ran True）→ 不可证未起
    pid2 = _mk_project(agent_path="dsh-plugin:/usr/bin/dsh")
    cid2 = _mk_card(pid2, "短 turn 卡", sid="s-quick")
    rid2 = _stale_starting(pid2, cid2)
    rec = _web_rec(cid2, "s-quick", turn_baseline=("completed", 1))
    monkeypatch.setattr(board, "_RUNS", {cid2: rec})
    monkeypatch.setattr(board, "_session_state_family",
                        lambda *a, **k: board.STATE_IDLE)
    monkeypatch.setattr(board, "_web_turn_ran", lambda r: True)
    board._reconcile_starting_rows()
    assert waitq.get_active(waitq.KIND_CARD, cid2)["state"] == "starting"
    assert cid2 in board._RUNS                    # 在管条目不动（收尾归巡视）
    assert "告警" in capsys.readouterr().out


# ---------- 4. 起跑窗口重入拦截（starting 态显式承担防重入，R6） ----------

def test_start_entry_blocked_by_starting_state(monkeypatch):
    """活跃 c: 行在场（起跑窗口）时重按开始被拦：`_enter_doing` 预检返回
    「会话运行中」——不再像 `_rec_active` 旧口径那样先入队留下一枚排队占位
    残影（原口径只在 start_card 调用时才拦，且入队已先行）；start_card 门禁
    只看在管条目，worker 自持 starting 行的起跑路径不受影响（dequeue_start
    全链回归由 test_board_queue_doing / test_board_finish 钉）。"""
    # 起跑入口只对可跑族（dsh）开放：退场族在 `_enter_doing` 入口即被 RETIRED_MSG 拦下
    pid = _mk_project(agent_path="dsh-plugin:/usr/bin/dsh")
    cid = _mk_card(pid, "起跑窗口卡")
    rid = _stale_starting(pid, cid, from_column="review")
    db.update_board_card(cid, column_key="doing", block_kind=None, block_text="")
    proj = db.get_project(pid)
    card, err = board._enter_doing(proj, db.get_board_card(cid))
    assert err == {"error": "会话运行中，请等待完成或先停止"}
    row = waitq.get_active(waitq.KIND_CARD, cid)
    assert row["id"] == rid and row["state"] == "starting"      # 行未被动
    assert db.get_board_card(cid)["block_kind"] is None         # 未落排队占位残影
    assert db.get_board_card(cid)["column_key"] == "doing"

    # worker 自持行起跑不受影响：start_card 门禁不含行判据（只有入口面查）
    # （`_spawn` CLI 起进程助手已随 P7b 删除，起会话只剩 _start_web 一条路）
    monkeypatch.setattr(board, "_start_web", lambda *a, **k: "/tmp/st.log")
    assert board.start_card(proj, db.get_board_card(cid)) == "/tmp/st.log"


# ---------- 5. 范围钉：仅 c: 参与（t:/m:/a: 的 starting 是执行全程常态） ----------

def test_reconcile_scope_card_rows_only(monkeypatch, capsys):
    """超时对账只碰 c: 行：t:/m:/a: 的 starting 是执行全程常态（拾取即占位，
    长跑任务小时级），不得因超龄被收尾——其崩溃残留归 recover 映射与队列自检
    （R11 边界）。"""
    pid = _mk_project()
    tid = _mk_task(pid)
    iid = waitq.enqueue(waitq.KIND_TASK, tid, pid)
    assert waitq.claim(iid, "worker") is True
    waitq.msg_enqueue("m-st", pid, "s-1", "长跑消息")
    waitq.claim_by_target(waitq.KIND_MSG, "m-st", "worker")
    cid_a = _mk_card(pid, "作答卡")
    waitq.enqueue(waitq.KIND_ANSWER, cid_a, pid, meta={"sid": "s-1"})
    waitq.claim_by_target(waitq.KIND_ANSWER, cid_a, "worker")
    with db.connect() as conn:
        conn.execute("UPDATE wait_items SET claimed_at='2000-01-01 00:00:00'"
                     " WHERE id=? OR (kind='msg' AND target_id='m-st')"
                     " OR (kind='answer' AND target_id=?)",
                     (iid, str(cid_a)))
    monkeypatch.setattr(board.runner, "INSTANCE", _bare_instance())
    monkeypatch.setattr(board, "_RUNS", {})
    board._reconcile_starting_rows()
    assert waitq.get_item(iid)["state"] == "starting"          # t: 不动
    assert waitq.get_active(waitq.KIND_MSG, "m-st")["state"] == "starting"
    assert waitq.get_active(waitq.KIND_ANSWER, cid_a)["state"] == "starting"
    assert "starting 超时" not in capsys.readouterr().out       # 无处置日志


# ---------- 6. selfcheck 超龄判据扩面（brief 先败④） ----------

def test_unit_liveness_probe_three_states(monkeypatch):
    """行判活探针（v3c 行版 `board.unit_liveness`，经 runner.set_liveness_probe
    注册给对账/自检）：输入=**活跃等待项行**——web 族卡按会话三态映射
    running→alive / idle→dead（waitq 侧 R11a 降级不采信）/ unknown→unknown；
    非 c: 行、非 web 族卡、卡行已删、target 非数字一律 None（交 waitq 内建证据）。"""
    pid = _mk_project(agent_path="dsh-plugin:/usr/bin/dsh")
    cid = _mk_card(pid, "探针卡", sid="s-probe")
    row = waitq.get_item(waitq.enqueue_card(cid, pid))
    monkeypatch.setattr(board, "_session_state_family",
                        lambda *a, **k: board.STATE_RUNNING)
    assert board.unit_liveness(row) == "alive"
    monkeypatch.setattr(board, "_session_state_family",
                        lambda *a, **k: board.STATE_IDLE)
    assert board.unit_liveness(row) == "dead"
    monkeypatch.setattr(board, "_session_state_family",
                        lambda *a, **k: board.STATE_UNKNOWN)
    assert board.unit_liveness(row) == "unknown"
    assert board.unit_liveness(dict(row, kind=waitq.KIND_TASK, target_id="1")) is None
    assert board.unit_liveness(dict(row, target_id="not-an-id")) is None
    pid2 = _mk_project()                             # 退场族路径=非 web 族
    cid2 = _mk_card(pid2, "非 web 卡")
    assert board.unit_liveness(waitq.get_item(
        waitq.enqueue_card(cid2, pid2))) is None
    rid3 = waitq.enqueue_card(987656, pid2)          # 卡行已删
    assert board.unit_liveness(waitq.get_item(rid3)) is None


def test_selfcheck_units_respects_platform_managed_rows(monkeypatch):
    """Important-2 回归（修复轮）：平台在管（`_RUNS` 条目在场）的 c: 行即便
    「可证死」（非 web 族卡进程已退 → 行 evidence.pid 不再存活）也不由自检收口——
    收尾归巡视 `_finish_run`（R4 收尾归属），否则一次成功会话的终态会被自检
    抢先写死成 `failed`（`card_finished` 门禁届时见行已终态），污染 v3d 将作为
    权威的审计行并瞬时造出 I1 自报。
    守卫只作用于 managed 面：`_RUNS` 无条目的卡死行（自检是唯一恢复路径）
    照常收口，不因新守卫停滞。"""
    dead = subprocess.Popen([sys.executable, "-c", "pass"])
    dead.wait()                                        # 已退出并回收的 pid
    pid = _mk_project()
    cid = _mk_card(pid, "在管卡")
    rid, _ = waitq.insert_card_force_start(cid, pid)
    waitq.mark_running(waitq.KIND_CARD, cid)
    waitq.mark_evidence(waitq.KIND_CARD, cid, {"pid": dead.pid})   # 可证死证据
    monkeypatch.setattr(board.runner, "INSTANCE", _bare_instance())
    rec = _web_rec(cid, "s-managed", family="dsh_plugin")
    rec["proc"] = dead                                 # 在管条目（收尾归巡视）
    monkeypatch.setattr(board, "_RUNS", {cid: rec})
    assert board.unit_managed(waitq.get_item(rid)) is True
    assert waitq.selfcheck_units(min_age=0, managed=board.unit_managed) == []
    row = waitq.get_item(rid)
    assert row["state"] == "running"                   # 未被自检收口
    assert json.loads(row["meta"] or "{}").get("error") is None
    # 巡视收口（唯一收尾点）→ done：会话正常结束的终态不被自检改写
    board.finish(f"c:{cid}", "会话结束收尾")
    assert waitq.get_item(rid)["state"] == "done"

    # 反向对照（同形态卡，不注入 managed=缺省 None）：行被收口成 failed——
    # 钉住「拦截者正是 managed 面」，不是别的偶然因素
    cid3 = _mk_card(pid, "无豁免对照卡")
    rid3, _ = waitq.insert_card_force_start(cid3, pid)
    waitq.mark_running(waitq.KIND_CARD, cid3)
    waitq.mark_evidence(waitq.KIND_CARD, cid3, {"pid": dead.pid})
    problems = waitq.selfcheck_units(min_age=0)
    assert any("自检收口可证死行" in p and f"c:{cid3}" in p for p in problems)
    row3 = waitq.get_item(rid3)
    assert row3["state"] == "failed"
    assert json.loads(row3["meta"])["error"] == "周期自检：可证明失效"

    # _RUNS 无条目的卡死行：managed 判据为假 → 自检照常收口（不停滞）
    cid2 = _mk_card(pid, "卡死行卡")
    rid2, _ = waitq.insert_card_force_start(cid2, pid)
    waitq.mark_running(waitq.KIND_CARD, cid2)
    waitq.mark_evidence(waitq.KIND_CARD, cid2, {"pid": dead.pid})
    monkeypatch.setattr(board, "_RUNS", {})
    assert board.unit_managed(waitq.get_item(rid2)) is False
    problems = waitq.selfcheck_units(min_age=0, managed=board.unit_managed)
    assert any("自检收口可证死行" in p and f"c:{cid2}" in p for p in problems)
    assert waitq.get_active(waitq.KIND_CARD, cid2) is None
    # 判据只覆盖看板卡：t:/m:/a: 行不豁免（无 _RUNS 语义）
    assert board.unit_managed({"kind": waitq.KIND_TASK, "target_id": "1"}) is False
    assert board.unit_managed({"kind": waitq.KIND_CARD,
                               "target_id": "not-an-id"}) is False


def test_selfcheck_starting_stale_warns(monkeypatch):
    """selfcheck 超龄判据（v3c 行口径）：starting/running/finishing 超龄且无
    可证明证据（判活非 alive ∧ 无新鲜心跳）→ 告警（**不自动收口**，R11 边界
    沿用——行不动；判活只需行自身证据）；三态同面覆盖
    （v2a T1 minor 收口：force 落表行的三态都要有自检覆盖）；有行证据不误报；
    selfcheck_units 亦只收口可证死行，不误动这些未知行。"""
    pid = _mk_project()
    cid_s = _mk_card(pid, "starting 卡")
    rid_s = _stale_starting(pid, cid_s, age_s=7200)   # 越过 CLAIM_STALE_S（1800s）
    cid_r = _mk_card(pid, "running 卡")
    rid_r, _ = waitq.insert_card_force_start(cid_r, pid)
    waitq.mark_running(waitq.KIND_CARD, cid_r)
    cid_f = _mk_card(pid, "finishing 卡")
    rid_f, _ = waitq.insert_card_force_start(cid_f, pid)
    waitq.mark_running(waitq.KIND_CARD, cid_f)
    waitq.mark_finishing(waitq.KIND_CARD, cid_f)
    for rid in (rid_r, rid_f):                     # 三态同口径做旧 claimed_at
        with db.connect() as conn:
            conn.execute("UPDATE wait_items SET claimed_at='2000-01-01 00:00:00'"
                         " WHERE id=?", (rid,))
    problems = waitq.selfcheck()
    assert any("starting 超龄" in p and str(cid_s) in p for p in problems)
    assert any("running 超龄" in p and str(cid_r) in p for p in problems)
    assert any("finishing 超龄" in p and str(cid_f) in p for p in problems)
    # 告警不释放：行态与活跃性均不动
    assert waitq.get_item(rid_s)["state"] == "starting"
    assert waitq.get_item(rid_r)["state"] == "running"
    assert waitq.get_item(rid_f)["state"] == "finishing"
    assert waitq.selfcheck_units() != []           # 并入周期自检报告面
    assert waitq.get_item(rid_s)["state"] == "starting"
    # 有行证据（心跳新鲜）即不误报（v3c：行证据是唯一佐证源）
    assert waitq.touch_unit(waitq.KIND_CARD, cid_s, "busy=1(poll)") is True
    ids = [p for p in waitq.selfcheck() if "id=" in p]
    # 按 `target=<cid> ` 精确匹配（末断言同款）：cid_s 是自增卡 id，裸子串会与
    # 同行的 `claimed_at=2000-01-01 ...` 字面撞车（cid_s=200 时 "200" ∈ "2000"，
    # 全量跑实测误报）——断言本义是「cid_s 不被报告」
    assert all(f"target={cid_s} " not in p for p in ids)
    # t:/m: 同口径（非 c: 类也走同一判据面）
    tid = _mk_task(pid)
    iid = waitq.enqueue(waitq.KIND_TASK, tid, pid)
    waitq.claim(iid, "worker")
    with db.connect() as conn:
        conn.execute("UPDATE wait_items SET claimed_at='2000-01-01 00:00:00'"
                     " WHERE id=?", (iid,))
    assert any("starting 超龄" in p and f"target={tid}" in p
               for p in waitq.selfcheck())


# ---------- 7. T3 复审项收口（v2d T4）：aborted 交巡视 / 告警节流 / 入口预检 / finishing ----------

def test_starting_timeout_aborted_defers_to_watch(monkeypatch, capsys):
    """用户停卡（rec.aborted）的卡死期不判「starting 超时」失败：按 unknown 交
    巡视侧 _finish_run 按正常停止收尾（T3 复审项①）——行/卡列不动。"""
    pid = _mk_project(agent_path="dsh-plugin:/usr/bin/dsh")
    cid = _mk_card(pid, "停卡窗口卡", sid="s-abort")
    rid = _stale_starting(pid, cid)
    monkeypatch.setattr(board.runner, "INSTANCE", _bare_instance())
    rec = _web_rec(cid, "s-abort", aborted=True, turn_baseline=("completed", 2))
    monkeypatch.setattr(board, "_RUNS", {cid: rec})
    monkeypatch.setattr(board, "_session_state_family",
                        lambda *a, **k: board.STATE_IDLE)
    monkeypatch.setattr(board, "_web_turn_ran", lambda r: False)
    board._reconcile_starting_rows()
    assert waitq.get_item(rid)["state"] == "starting"      # 不判失败
    assert waitq.get_active(waitq.KIND_CARD, cid) is not None and cid in board._RUNS
    assert "告警" in capsys.readouterr().out               # 走 unknown 只告警


def test_starting_unknown_alert_throttled(monkeypatch, capsys):
    """unknown 分支告警节流（T3 复审项③）：同卡窗内只报一行（5s 节拍不刷屏），
    行仍不处置。"""
    pid = _mk_project(agent_path="dsh-plugin:/usr/bin/dsh")
    cid = _mk_card(pid, "未知滞留卡", sid="s-thr")
    _stale_starting(pid, cid)
    monkeypatch.setattr(board.runner, "INSTANCE", _bare_instance())
    monkeypatch.setattr(board, "_RUNS", {})
    monkeypatch.setattr(board, "_session_state_family",
                        lambda *a, **k: board.STATE_UNKNOWN)
    monkeypatch.setattr(board, "_starting_alert_at", {})
    board._reconcile_starting_rows()
    first = capsys.readouterr().out
    board._reconcile_starting_rows()
    second = capsys.readouterr().out
    assert "告警" in first and "告警" not in second        # 节流命中：第二拍静默
    assert waitq.get_active(waitq.KIND_CARD, cid)["state"] == "starting"


def test_card_unit_active_includes_finishing(monkeypatch):
    """`_card_unit_active` 覆盖 finishing（T3 复审项⑤）：收尾瞬态同样算在管，
    入口面重按开始被拦（防与 finish 的行收口/搬列抢跑）。"""
    pid = _mk_project(agent_path="dsh-plugin:/usr/bin/dsh")
    cid = _mk_card(pid, "收尾窗口卡")
    rid, _ = waitq.insert_card_force_start(cid, pid)
    waitq.mark_running(waitq.KIND_CARD, cid)
    waitq.mark_finishing(waitq.KIND_CARD, cid)
    assert board._card_unit_active(cid) is True
    db.update_board_card(cid, column_key="doing", block_kind=None, block_text="")
    card, err = board._enter_doing(db.get_project(pid), db.get_board_card(cid))
    assert err == {"error": "会话运行中，请等待完成或先停止"}
    assert waitq.get_item(rid)["state"] == "finishing"     # 行未被动


def test_enter_doing_missing_card_guard(monkeypatch):
    """入口预检的并发删卡守卫（T3 复审项②）：活跃 c: 行在场但卡行已被删时
    返回错误字典而非炸 card_json(None)。"""
    pid = _mk_project(agent_path="dsh-plugin:/usr/bin/dsh")
    cid = 987654
    waitq.enqueue_card(cid, pid)                            # 活跃 c: waiting 行
    waitq.claim_by_target(waitq.KIND_CARD, cid, "worker")   # → starting（触发预检）
    row = {"id": cid, "project_id": pid, "column_key": "todo", "block_kind": None,
           "block_text": "", "parent_card_id": None}
    card, err = board._enter_doing(db.get_project(pid), row)
    assert card is None and err == {"error": "卡片不存在"}
