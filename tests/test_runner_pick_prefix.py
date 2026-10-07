# 补位器真值表（v2a T3，裁决 R5/R2）：队首启动 + 运行前缀窗口（serial N=1 /
# parallel N=5；t: 单元恒 1）+ WORKERS=6。
# v3a 读口切行：前缀成员= wait_items state∈(starting,running) 行（**唯一来源**——
# c: 行起跑证实后跨轮 running 存活；v3d 起无任何第二表征）；
# 拾取逐项目只看等待区队首行。
# 本套件接替退役的 tests/test_pick_compare.py（P4 新旧对拍，裁决 R5 注：
# 「test_pick_compare 退役由补位真值表接替」）。
# 野 worker 免疫（2026-09-23，v3a 抽查修复）：真实 Runner 的 worker 线程随进程
# 存活、每 5s 轮询共享临时库，会抢本套件的种子行（本套件全部用例用裸 Runner，
# 不依赖 worker 循环）——conftest 的 `_mute_leaked_runner_picks` 让「用例开始前
# 已存在」的实例拾取入口失效；末例 `test_leaked_runner_workers_cannot_steal_rows`
# 用显式唤醒把该保证钉死（复现方式与实测证据见 v3a 批次报告 §B）。
import os, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pytest

import board, db, runner, waitq


@pytest.fixture(autouse=True)
def _clean_tables():
    """每例前后清 waitq 两表（conftest 临时库；种子行落真表）。"""
    def _clean():
        with db.connect() as conn:
            for t in ("wait_items", "chat_msgs"):
                conn.execute(f"DELETE FROM {t}")
    _clean()
    yield
    _clean()


def _card(**kw):
    base = {"id": 1, "project_id": 9, "title": "t", "description": "",
            "column_key": "doing", "sort_order": 1, "session_id": "",
            "sessions": "[]", "block_kind": "queue",
            "block_text": "排队等待：统一队列", "parent_card_id": None,
            "origin": "", "done_at": None, "trashed": 0, "trashed_at": None,
            "scheduled_at": None, "jira_key": "", "last_error": "",
            "last_error_at": None, "created_at": 0, "updated_at": 0}
    base.update(kw)
    return base


def _task(tid, pid=9, **kw):
    d = {"id": tid, "project_id": pid, "status": "queued",
         "task_type": "normal", "payload": ""}
    d.update(kw)
    return d


def _bare_runner():
    """裸 Runner（不起 worker 线程，仅测补位判定）：字段清单对齐
    tests/test_waitq_shadow.py 既有做法（_cond/_procs/_stop_requested）。
    生产锁形（普通 Lock）：收口直调用例与 _worker 持锁形状一致。"""
    r = runner.Runner.__new__(runner.Runner)
    r._lock = threading.Lock()
    r._cond = threading.Condition(r._lock)
    r._procs = {}
    r._stop_requested = set()
    return r


def _stub_data(monkeypatch, cards=None, tasks=None, mode="serial"):
    """runner.db 静态数据 + board.settings_of 模式打桩（sort 恒 manual——
    列序挑先本批保留，真值表默认入队序=列序不触发提升）。"""
    cards, tasks = cards or {}, tasks or {}
    monkeypatch.setattr(runner, "db", type("D", (), {
        "get_board_card": staticmethod(lambda cid: cards.get(int(cid))),
        "get_task": staticmethod(lambda tid: tasks.get(int(tid)))})())
    monkeypatch.setattr(board, "settings_of",
                        lambda pid: {"mode": mode, "sort": {"doing": "manual"}})


def _claim_and_start(r, key):
    """走真实锁内收口（claim 仲裁 + 行口径窗口复判），等价 worker 拾取后动作。"""
    with r._cond:
        return r._claim_and_start_locked(key)


def test_workers_six_reaches_parallel_window():
    """WORKERS=6（裁决 R2）：v2 并行窗口 N=5 须可达（单项目并行 5 + 1 余量给
    m:/a: 瞬态投递单元，防饿死）；正确性由前缀窗口保证，worker 数只影响吞吐。"""
    assert runner.Runner.WORKERS == 6
    assert runner.Runner.WORKERS >= runner.Runner.PARALLEL_PREFIX_N + 1


def test_serial_starts_only_queue_head(monkeypatch):
    """serial 项目（N=1）：队首 1 个起跑，第二个 waiting 不启动（R5②）。"""
    _stub_data(monkeypatch,
               cards={1: _card(id=1, sort_order=1), 2: _card(id=2, sort_order=2)})
    r = _bare_runner()
    waitq.enqueue(waitq.KIND_CARD, 1, 9)
    waitq.enqueue(waitq.KIND_CARD, 2, 9)
    assert r._pick_locked() == "c:1"                 # 队首起跑
    assert _claim_and_start(r, "c:1") == 9           # 行置 starting（worker 同款）
    assert r._pick_locked() is None                  # 前缀 1 ≥ 1：第二个留队
    assert waitq.get_active(waitq.KIND_CARD, 2)["state"] == "waiting"


def test_parallel_starts_up_to_five(monkeypatch):
    """parallel 项目（N=5）：队首 5 个依次起跑，第 6 个留队（R5②/③）。"""
    _stub_data(monkeypatch, mode="parallel",
               cards={i: _card(id=i, sort_order=i) for i in range(1, 7)})
    r = _bare_runner()
    for i in range(1, 7):
        waitq.enqueue(waitq.KIND_CARD, i, 9)
    for i in range(1, 6):
        assert r._pick_locked() == f"c:{i}"          # 队首依次补位
        assert _claim_and_start(r, f"c:{i}") == 9    # 行口径窗口放行
    assert r._pick_locked() is None                  # 前缀 5 ≥ 5：第 6 个留队
    assert waitq.get_active(waitq.KIND_CARD, 6)["state"] == "waiting"


def test_starting_row_not_restarted(monkeypatch):
    """starting 行在场计入前缀、不重复启动（R5④）：claim 窗口的行已 starting
    即占前缀位（单看任何第二表征都会漏计起步中条目；「claimed
    不计」旧口径废止，serial 下后续 waiting 行不再补位）。"""
    _stub_data(monkeypatch,
               cards={1: _card(id=1, sort_order=1), 2: _card(id=2, sort_order=2)})
    r = _bare_runner()
    waitq.enqueue(waitq.KIND_CARD, 1, 9)
    waitq.enqueue(waitq.KIND_CARD, 2, 9)
    waitq.claim_by_target(waitq.KIND_CARD, 1, "worker")   # 行 starting（起步窗口形态）
    assert r._pick_locked() is None                  # 前缀 {c:1}（行即成员）≥ 1
    assert waitq.get_active(waitq.KIND_CARD, 2)["state"] == "waiting"


def test_forced_row_fills_prefix_no_refill(monkeypatch):
    """force 直起落表行计入前缀（R5①/④）：force 落表形态=前缀尾行
    （starting→起跑证实 running），serial 下占满窗口 → 后续
    不补位；parallel 下同样消耗名额（差 1 满仍可补 1 个，满 5 即拒）。计数只认
    行（唯一成员面）——同键不存在第二表征。
    种子行 not_before 钉远期：防套件遗留野 worker 抢行（本用例断窗口/复判口径，
    两处都不读 not_before；拾取层的真值由同文件其他用例承担）。"""
    _stub_data(monkeypatch, mode="serial",
               cards={i: _card(id=i, sort_order=i) for i in (12, 13)})
    r = _bare_runner()
    far = time.time() + 3600
    # force 直起形态（board._enter_doing force 路径）：落表行 + 证实 running
    waitq.insert_card_force_start(11, 9)
    waitq.mark_running(waitq.KIND_CARD, 11)
    waitq.enqueue(waitq.KIND_CARD, 12, 9, not_before=far)
    assert r._prefix_window_full(9) is True          # serial：force 行占满窗口 1
    assert r._unit_window_blocked(9, "c:12", waitq.KIND_CARD) is True
    # parallel：窗口 5，force 行计入但未满 → 可补位（复判放行）
    _stub_data(monkeypatch, mode="parallel",
               cards={i: _card(id=i, sort_order=i) for i in (12, 13)})
    assert r._prefix_window_full(9) is False
    assert r._unit_window_blocked(9, "c:12", waitq.KIND_CARD) is False
    for fid in (14, 15, 16, 17):
        waitq.insert_card_force_start(fid, 9)        # force 落表行填满窗口（前缀尾）
        waitq.mark_running(waitq.KIND_CARD, fid)
    waitq.enqueue(waitq.KIND_CARD, 13, 9, not_before=far)
    assert r._prefix_window_full(9) is True          # 前缀 5 ≥ 5：不再补位
    assert r._unit_window_blocked(9, "c:13", waitq.KIND_CARD) is True


def test_row_free_unit_does_not_occupy_window(monkeypatch):
    """R1 反向钉子（v3d 去占用）：窗口只认**行**——表中无行的键（未入队/已终态）
    不参与前缀与放行判定，任何历史形态的表征都不再存在可查面。"""
    _stub_data(monkeypatch, cards={2: _card(id=2, sort_order=2)})
    r = _bare_runner()
    waitq.enqueue(waitq.KIND_CARD, 2, 9)
    assert r._prefix_members(waitq.active_items()).get(9) is None
    assert r._pick_locked() == "c:2"                 # 无行即不占窗


def test_stub_ext_row_fills_prefix(monkeypatch):
    """手工建 ext running 行 → 占前缀不启动（R5①，为 v2d 预埋接口：R13 外部
    条目 kind='ext' 入场即 running、复数入运行前缀、不由平台拾取启动）。
    v2a 四类封闭集外的 waiting 行不拾不炸（防御分支，本批不可达）。"""
    _stub_data(monkeypatch, cards={2: _card(id=2, sort_order=2)})
    r = _bare_runner()
    with db.connect() as conn:                  # 手工 ext 行（waitq.KINDS 尚无 ext，
        conn.execute(                           # v2d 才由 R13 路径写入；直插模拟）
            "INSERT INTO wait_items (project_id, kind, target_id, state, seq,"
            " created_at, meta) VALUES (9,'ext','7','running',"
            " (SELECT COALESCE(MAX(seq),0)+1 FROM wait_items),?, '{}')",
            (db.now_str(),))
    waitq.enqueue(waitq.KIND_CARD, 2, 9)
    assert r._pick_locked() is None             # ext running 行占住前缀（serial N=1）
    assert r._pick_locked() is None             # 幂等：遍历未知 kind 前缀行不炸
    with db.connect() as conn:
        row = conn.execute("SELECT state FROM wait_items WHERE kind='ext'").fetchone()
    assert row["state"] == "running"            # ext 行不被拾取/不被改写


def test_answer_own_session_msg_exemption(monkeypatch):
    """a: 行卡 391 豁免（R5⑥/R7 行口径）：目标会话被「同 sid 的 m: 运行单元」
    占位时该占位不计入前缀（sid 反查 chat_msgs 行）→ 可启动（防死锁
    唯一闸：m: 单元占着运行位等 turn、turn 挂提问等答案）；别的会话 m: 占位不
    豁免；同场另有真他主前缀行时豁免只折抵自身占位、真他主仍占窗（选择性
    折抵，非旧二元 bypass）。"""
    _stub_data(monkeypatch)
    r = _bare_runner()
    # —— 形态一：占位者=本会话 m: 运行单元（行 starting + chat_msgs.sid=s-1）——
    waitq.msg_enqueue("m1", 9, "s-1", "hi")
    assert _claim_and_start(r, "m:m1") == 9           # m: 起跑（行即占位表征）
    i = waitq.enqueue(waitq.KIND_ANSWER, 5, 9, meta={"sid": "s-1"})
    assert r._pick_locked() == "a:5"                  # 豁免：m:m1 不计前缀 → 可启动
    assert _claim_and_start(r, "a:5") == 9            # own-hold 全链路走通
    assert waitq.get_active(waitq.KIND_ANSWER, 5)["state"] == "starting"
    waitq.mark_done(i)                                # 送达结束（执行体同款）
    waitq.finish_by_target(waitq.KIND_MSG, "m1")
    waitq.msg_finish("m1", "done")
    # —— 形态二（他项目隔离）：占位者=别的会话的 m: 单元 → 不豁免，留队 ——
    waitq.msg_enqueue("m2", 8, "s-99", "hi")
    assert _claim_and_start(r, "m:m2") == 8           # 占位者属项目 8（sid=s-99）
    waitq.enqueue(waitq.KIND_ANSWER, 6, 8, meta={"sid": "s-1"})
    assert r._pick_locked() is None                   # 别的会话不豁免（防借道解锁）
    waitq.cancel(waitq.KIND_ANSWER, 6, "测试收尾")     # 形态二行清场（否则队首留队
    # 会压住形态三的后续行——逐项目只看等待区队首行，R5②）
    # —— 形态三：同场另有真他主 → 豁免只折抵自身占位（选择性，非二元 bypass）——
    tid8 = waitq.enqueue(waitq.KIND_TASK, 8, 8)
    waitq.claim(tid8, "worker")                       # 行 starting = 真他主前缀行
    waitq.enqueue(waitq.KIND_ANSWER, 7, 8, meta={"sid": "s-99"})
    assert r._pick_locked() is None                   # m:m2 折抵后 t:8 仍占满窗口
    waitq.cancel(waitq.KIND_TASK, 8, "测试收尾")
    assert r._pick_locked() == "a:7"                  # 真他主退场：仅剩自身占位 → 放行


def test_task_unit_always_serial(monkeypatch):
    """t: 单元恒 1（R5③ + §11 裁决①任务串行红线不动）：parallel 项目中队首
    t: 起跑后第二个 t: 与后续 c: 均不补位（前缀内有 t: 成员即窗口 1——任务
    不与同项目任何单元并发改代码）。"""
    _stub_data(monkeypatch, mode="parallel",
               cards={3: _card(id=3, sort_order=3)},
               tasks={1: _task(1), 2: _task(2)})
    r = _bare_runner()
    waitq.enqueue(waitq.KIND_TASK, 1, 9)
    waitq.enqueue(waitq.KIND_TASK, 2, 9)
    waitq.enqueue(waitq.KIND_CARD, 3, 9)
    assert r._pick_locked() == "t:1"                  # 队首 t: 起跑
    assert _claim_and_start(r, "t:1") == 9            # 行口径（t: 恒 1）
    assert r._pick_locked() is None                   # t:2/c:3 均留队（前缀含 t:）
    assert waitq.get_active(waitq.KIND_TASK, 2)["state"] == "waiting"
    assert waitq.get_active(waitq.KIND_CARD, 3)["state"] == "waiting"


def test_ext_row_gates_pick_serial(monkeypatch):
    """外部条目门禁（serial）：ext 行即前缀成员——行在场留队、行退场即放行
    （调度侧不再有独立探针注册面）；serial 下与窗口闸同结论。"""
    _stub_data(monkeypatch, cards={1: _card(id=1, sort_order=1)})
    r = _bare_runner()
    waitq.enqueue(waitq.KIND_CARD, 1, 9)
    assert r._pick_locked() == "c:1"                  # 无 ext 行：照常拾取
    sc = db.insert_board_card(9, "同步卡", "")
    waitq.insert_ext(9, sc, "s-ext")
    assert r._pick_locked() is None                   # 外部会话在跑：留队
    waitq.finish_by_target(waitq.KIND_EXT, sc)
    assert r._pick_locked() == "c:1"                  # 行退场：放行


def test_ext_row_blocks_platform_units_regardless_of_window(monkeypatch):
    """**项目外部条目闸**（v3d 修复轮裁决，回归钉）：存在活跃 `ext:` 行 ⇒
    该项目本轮不补位，**与窗口 N 无关**——parallel（N=5）下窗口未满也留队
    （外部会话不受平台控制，平台起的单元不与它并发改代码；serial 同结论）。
    判据直接来自 ext: 行（行即成员，唯一来源），不经任何探针注册面。

    三条腿：① parallel + 1 条 ext 行 → 不启动平台卡单元；② serial 同形态一致；
    ③ ext 行退场后 parallel 正常起满 5 席（闸只对「外部条目在场」生效）。"""
    # ① parallel：窗口 3/5 未满，但 ext 行在场 → 不启动
    _stub_data(monkeypatch, mode="parallel",
               cards={i: _card(id=i, sort_order=i) for i in (1, 2, 3)})
    r = _bare_runner()
    sc = db.insert_board_card(9, "同步卡")
    waitq.insert_ext(9, sc, "s-ext")
    for i in (1, 2, 3):
        waitq.enqueue(waitq.KIND_CARD, i, 9)
    assert r._prefix_window_full(9) is False           # 并行窗口未满（5 席）
    assert r._pick_locked() is None                    # 仍留队（ext 行闸，与 N 无关）
    # ② serial 同形态一致（窗口闸与 ext 闸同结论）
    _stub_data(monkeypatch, mode="serial", cards={1: _card(id=1, sort_order=1)})
    assert r._pick_locked() is None
    # ③ ext 行退场：parallel 正常起满 5 席
    waitq.finish_by_target(waitq.KIND_EXT, sc)
    _stub_data(monkeypatch, mode="parallel",
               cards={i: _card(id=i, sort_order=i) for i in range(1, 7)})
    for i in range(1, 7):
        waitq.enqueue(waitq.KIND_CARD, i, 9)
    for i in range(1, 6):
        assert r._pick_locked() == f"c:{i}"            # 无 ext 行：按窗口正常补位
        assert _claim_and_start(r, f"c:{i}") == 9
    assert r._pick_locked() is None                    # 满 5 席：第 6 留队（窗口闸）


def test_ext_row_blocks_answer_unit(monkeypatch):
    """外部条目闸对 a: 同样生效（2026-09-28 #610 实障收敛，原「a: 豁免不回退」
    反转）：ext: 行在场时 a: 留队——答案送达会唤醒目标会话继续跑，与别人的
    外部会话即真实并发改代码；ext 行退场即放行。自身占位折抵（本卡 c:/同会话
    m:）不受影响；⚡立即送达（deliver_pending_answer_now）不走补位器，仍为
    用户自担风险的人工通道。"""
    _stub_data(monkeypatch, mode="parallel")
    r = _bare_runner()
    sc = db.insert_board_card(9, "同步卡")
    waitq.insert_ext(9, sc, "s-ext")
    waitq.enqueue(waitq.KIND_ANSWER, 5, 9, meta={"sid": "s-1"})
    assert r._pick_locked() is None                   # ext 行在场：a: 留队
    waitq.finish_by_target(waitq.KIND_EXT, sc)
    assert r._pick_locked() == "a:5"                  # 行退场：放行
    assert _claim_and_start(r, "a:5") == 9            # 收口全链走通


def test_unit_busy_counts_prefix_rows_and_ext_rows(monkeypatch):
    """unit_busy（提交时判定「是否排队」）与调度放行口径一致：前缀行在场即忙
    （serial ≡ 任一前缀行），**或**项目存在活跃 ext 行即忙（parallel 下窗口未满
    也忙——与 `_pick_locked` 的项目外部条目闸同结论）；行/外部行退场即空闲。"""
    _stub_data(monkeypatch, mode="parallel",
               cards={i: _card(id=i, sort_order=i) for i in range(1, 7)})
    r = _bare_runner()
    assert r.unit_busy(9) is False
    sc = db.insert_board_card(9, "同步卡")
    waitq.insert_ext(9, sc, "s-ext")                  # 外部会话在跑
    assert r._prefix_window_full(9) is False           # 窗口未满（parallel 5 席）
    assert r.unit_busy(9) is True                      # 但项目忙（ext 行闸）
    assert r.unit_busy(8) is False                     # 他项目不受影响
    waitq.finish_by_target(waitq.KIND_EXT, sc)
    assert r.unit_busy(9) is False                     # 外部行退场即空闲
    _stub_data(monkeypatch, mode="serial", cards={1: _card(id=1, sort_order=1)})
    ci = waitq.enqueue(waitq.KIND_CARD, 1, 9)
    waitq.claim(ci, "worker")                          # 前缀行在场（serial 窗口 1）
    assert r.unit_busy(9) is True


def test_answer_own_card_row_exemption(monkeypatch):
    """卡 391 双判据之本卡侧：占位者=本卡 c: 运行行（跨轮存活的会话占位形态）
    时该占位不计前缀，a: 可启动；他卡答案不受影响（前缀内非自身占位照常计数）。
    收口全链路另有 test_waitq_shadow 两例钉死。"""
    _stub_data(monkeypatch)
    r = _bare_runner()
    waitq.insert_card_force_start(5, 9)               # 本卡会话占位（force 落表形态）
    waitq.mark_running(waitq.KIND_CARD, 5)
    waitq.enqueue(waitq.KIND_ANSWER, 5, 9, meta={"sid": "s-1"})
    waitq.enqueue(waitq.KIND_ANSWER, 6, 9, meta={"sid": "s-9"})
    assert r._pick_locked() == "a:5"                  # 本卡占位折抵 → 可启动
    waitq.claim_by_target(waitq.KIND_ANSWER, 5, "worker")   # a:5 起步中（starting）
    assert r._pick_locked() is None                   # a:6：c:5 与 a:5 均非自身占位


def test_card_started_keeps_running_row_in_prefix(monkeypatch):
    """v3a 行即条目（本批核心）：起跑证实后 c: 行 **running 跨轮存活**并计入
    运行前缀——多轮间反复判定仍满窗；会话结束
    （card_finished）行终态化后窗口让出、队首补位。"""
    _stub_data(monkeypatch,
               cards={1: _card(id=1, sort_order=1), 2: _card(id=2, sort_order=2)})
    r = _bare_runner()
    waitq.enqueue(waitq.KIND_CARD, 1, 9)
    waitq.enqueue(waitq.KIND_CARD, 2, 9)              # 队首后继（窗口让出后补位）
    assert _claim_and_start(r, "c:1") == 9            # worker 拾取：行置 starting
    assert r._pick_locked() is None                   # 前缀 {c:1}（starting 行）≥ 1
    assert r.card_started(1, 9) is True               # 起跑证实：行置 running（不终态化）
    row = waitq.get_active(waitq.KIND_CARD, 1)
    assert row is not None and row["state"] == "running"
    assert r._prefix_members(waitq.active_items()).get(9) == {"c:1"}
    assert r._prefix_window_full(9) is True           # 行即成员：前缀窗口满
    assert r._pick_locked() is None                   # 跨轮存活期间照常占窗
    for _ in range(3):                                # 跨轮：行不因反复判定而漂移
        assert r._pick_locked() is None
    r.card_finished(1, reason="测试收尾")              # 会话结束：行终态 + 释放
    assert waitq.get_active(waitq.KIND_CARD, 1) is None
    assert r._prefix_window_full(9) is False
    assert r._pick_locked() == "c:2"                  # 窗口让出 → 队首补位


def test_queue_head_blocks_same_project_followers(monkeypatch):
    """逐项目只看等待区队首行（R5② 队首启动）：队首行暂不可启动（not_before
    退避未到）时同项目后续行本轮不补位；他项目不受影响（跨项目并行不变）。"""
    _stub_data(monkeypatch, cards={1: _card(id=1, sort_order=1),
                                   2: _card(id=2, project_id=8, sort_order=2)})
    r = _bare_runner()
    waitq.enqueue(waitq.KIND_ANSWER, 7, 9, meta={"sid": "s-1"},
                  not_before=time.time() + 3600)      # 队首退避中
    waitq.enqueue(waitq.KIND_CARD, 1, 9)              # 同项目后续行
    waitq.enqueue(waitq.KIND_CARD, 2, 8)              # 他项目行
    assert r._pick_locked() == "c:2"                  # 项目 9 队首留队 → 不向下补位
    assert waitq.get_active(waitq.KIND_CARD, 1)["state"] == "waiting"
    assert waitq.get_active(waitq.KIND_ANSWER, 7)["state"] == "waiting"


def test_dirty_target_rows_skipped_without_crash(monkeypatch):
    """c:/t: 脏行（target 非数字；生产不可达，测试字符串 target 残留的实障）
    在有效性判定处跳过——不摘除（行归属方自会清理）、不炸 worker 线程；
    后续正常行照常补位。"""
    _stub_data(monkeypatch, cards={1: _card(id=1, sort_order=1)})
    r = _bare_runner()
    waitq.enqueue(waitq.KIND_CARD, "idx-starting", 9)   # c: 脏行（状态机用例形态）
    waitq.enqueue(waitq.KIND_TASK, "idx-running", 9)    # t: 脏行
    waitq.enqueue(waitq.KIND_CARD, 1, 9)                # 正常行
    assert r._pick_locked() == "c:1"                    # 跳过脏行照常补位（无 ValueError）
    assert waitq.get_active(waitq.KIND_CARD, "idx-starting") is not None   # 不摘除
    assert waitq.get_active(waitq.KIND_TASK, "idx-running") is not None


def test_worker_wakes_on_periodic_tick_without_notify(monkeypatch):
    """补位时机④（裁决 R5⑤，v2a 子批终审 Critical）：worker 的 `_cond.wait`
    带 5s 节拍兜底——队首 not_before 退避头阻塞 + 静场（全程无任何 notify）
    下，节拍唤醒重跑补位器，not_before 到期即拾起。
    修复前 wait 无超时：静场永不唤醒，整个项目饥饿到下个外部事件（answer
    退避 30s×3≈90s starvation；v2b 作答一律入队会放大）。"""
    r = _bare_runner()
    delivered = []
    monkeypatch.setattr(board, "_deliver_answer_unit",
                        lambda cid: delivered.append(cid))
    waitq.enqueue(waitq.KIND_ANSWER, 5, 9, meta={"sid": "s-1"},
                  not_before=time.time() + 1.0)          # 队首退避 1s（头阻塞形态）
    t = threading.Thread(target=r._worker, daemon=True)  # 真实 worker 循环，全程不 notify
    t.start()
    try:
        deadline = time.time() + 8
        while time.time() < deadline and not delivered:
            time.sleep(0.05)
        assert delivered == [5]      # 无 notify 静场下节拍兜底拾起（修复前永不拾）
    finally:
        r._pick_locked = lambda: None   # 实例级打桩（不经 monkeypatch）：防本 worker
        # 在后续用例继续拾取共享库的行（套件遗留野 worker 免疫，与既有 not_before
        # 钉远期手法同意图）


# ---------- v3a 抽查修复：野 worker 不得抢本套件的种子行（回归钉） ----------

@pytest.fixture(scope="module")
def _leaked_runner():
    """模拟「前序文件遗留的真实 Runner」（6 worker 线程 daemon 常驻、每 5s 轮询
    共享临时库）：模块级夹具在首个用例 setup 期（早于 conftest 的函数级 autouse
    夹具）创建，故按遗留判定被静音——与全量跑里 `import server`/他例自建单例的
    形态一致。"""
    return runner.Runner()


def test_leaked_runner_workers_cannot_steal_rows(monkeypatch, _leaked_runner):
    """回归钉（根因：遗留 worker 抢行；实测：前置 12 个遗留单例=72 worker 时本
    文件 1–2 例内必挂，dump 显示行被遗留 worker claim、行残留）：

    遗留 Runner 的 worker 一旦拾取，conftest `_mute_leaked_runner_picks` 必让
    其结果为 None（空转不扫行）。本用例**不靠 sleep 赌运气**：显式唤醒遗留 worker
    并轮询等待「它真的拾取过一次」（spy 记录该次返回），再断言行完好、且那次拾取
    结果恒 None——消除时序依赖后，静音一旦失效（修复前形态）该断言必挂：
    实测临时禁用静音 → 本用例 2/2 FAILED（`seen` 出现 'c:1' 且行被抢）。"""
    _stub_data(monkeypatch,
               cards={1: _card(id=1, sort_order=1), 2: _card(id=2, sort_order=2)})
    r = _bare_runner()
    waitq.enqueue(waitq.KIND_CARD, 1, 9)
    waitq.enqueue(waitq.KIND_CARD, 2, 9)
    seen = []                              # 遗留实例 worker 的拾取结果（恒 None）
    orig_pick = runner.Runner._pick_locked   # 已是 conftest 的静音包装
    def _spy(self):
        got = orig_pick(self)
        if self is _leaked_runner and threading.current_thread().name != "MainThread":
            seen.append(got)
        return got
    monkeypatch.setattr(runner.Runner, "_pick_locked", _spy)
    deadline = time.time() + 5
    while not seen and time.time() < deadline:   # 唤醒直至证实其真的拾取过
        with _leaked_runner._cond:
            _leaked_runner._cond.notify_all()
        time.sleep(0.05)
    assert seen, "遗留 worker 5s 内未拾取（夹具/线程异常，非本回归目标）"
    assert all(got is None for got in seen), \
        f"遗留 worker 拾取结果应恒 None（静音），实际 {seen}"   # 6 worker ⇒ 多条 None
    assert waitq.get_active(waitq.KIND_CARD, 1)["state"] == "waiting"   # 未被抢
    assert waitq.get_active(waitq.KIND_CARD, 2)["state"] == "waiting"
    assert r._pick_locked() == "c:1"       # 本用例自己的裸实例照常
    assert _claim_and_start(r, "c:1") == 9
    with db.connect() as conn:             # 遗留 worker 未留下任何残留行
        assert conn.execute("SELECT COUNT(*) n FROM wait_items WHERE state IN"
                            " ('starting','running','finishing')").fetchone()["n"] == 1


def test_undo_does_not_disarm_leaked_runner_mute(monkeypatch, _leaked_runner):
    """回归钉（v3c 修复轮，2026-09-24）：用例调用 `monkeypatch.undo()` **不得**
    撤掉套件级「野 worker 静音」——conftest 该夹具已改用**私有**
    `pytest.MonkeyPatch.context()`，与用例共享的函数级 `monkeypatch` 解耦。

    根因（实测）：此前静音经共享 monkeypatch 实例的类级补丁实现，
    `tests/test_board_finish.py` 等用例的 `monkeypatch.undo()` 会把静音一并撤销 →
    该例剩余时间里遗留 worker 恢复自由拾取（共享临时库）；静音被撤窗口拾到的键
    （如 `c:1`）会在后续用例里 `claim_by_target` 抢走其种子行，致
    `test_leaked_runner_workers_cannot_steal_rows` 偶发失败（本会话全量跑约 1/4；
    失败栈：`_process_card` 撞 `runner.db` 桩 → 行被 `finish_by_target` 终态化 →
    断言拿到 None）。本用例以「undo 后静音仍在场」把该不变量钉死。
    显式请求模块级 `_leaked_runner`：模块级夹具先于本函数级 autouse 夹具实例化
    ⇒ 单跑本用例时静音也确有对象可静（否则夹具走 leaked 为空分支）。
    """
    class_attr = runner.Runner.__dict__.get("_pick_locked")
    assert "_mute_leaked_runner_picks" in getattr(class_attr, "__qualname__", ""), \
        f"前置：静音包装应在场，实际 {class_attr!r}"
    monkeypatch.setattr(runner, "INSTANCE", None)   # 本用例自有桩（旧行为下 undo 会连静音一起撤）
    monkeypatch.undo()
    now = runner.Runner.__dict__.get("_pick_locked")
    assert now is class_attr, "undo() 不得改动套件级静音补丁"
    assert "_mute_leaked_runner_picks" in getattr(now, "__qualname__", "")
