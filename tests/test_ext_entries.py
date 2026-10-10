# 外部条目 ext 行 + 探测对象改造（v2d T4；v2 §2.2/§2.3/§2.5.2-5，裁决 R13/R15）：
# 外部直跑会话以 wait_items kind=ext 行入场——target=卡 id、meta 带 sid、
# 入场即 running（不由平台启动）入运行前缀（复数并存、位次计入「前面还有几个」）；
# 结束/消失 → finish("ext:<卡 id>") → 行终态 + 补位（时机③）。
# 探测对象=项目活跃会话集合：单族化后只有 dsh_plugin——读 EventHub 进程内快照
# （P4 事件化，零请求）、按会话 cwd 归属项目；退场族无精确 busy 信号不建 ext 行。
# 外部位次语义与退役的 _SYNC_BUSY 内存集合逐点等价：unit_busy=运行前缀窗口已满
# （ext 行即前缀成员，v3d 起探针退役、两处口径合一）/_pick_locked 对 a: 单元折抵
# ext: 键（P2 R1）。
import json, os, sys, threading, time, uuid
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


def _mk_project(agent_path="dsh-plugin:/usr/bin/dsh", name="ext"):
    """真实项目行（dsh-plugin 前缀=会话常驻族的唯一入口，探测按读口打桩）。"""
    uid = uuid.uuid4().hex[:8]
    pid = db.insert_project(0, f"{name}-{uid}", f"/tmp/{name}-{uid}",
                            agent_path, f"/tmp/{name}-{uid}/work")
    return db.get_project(pid)


def _mk_card(pid, title, column="doing", sid="", origin="", block_kind=None):
    cid = db.insert_board_card(pid, title)
    db.update_board_card(cid, column_key=column, session_id=sid, origin=origin,
                         block_kind=block_kind)
    return cid


class _CountingCond:
    """notify_all 计数的 Condition 包装（补位唤醒断言用，同 test_starting_timeout）。"""
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


def _bare_runner():
    """真实 _pick_locked/unit_busy 的裸 runner 单例（无 worker 线程）。"""
    r = runner.Runner.__new__(runner.Runner)
    r._lock = threading.Lock()
    r._cond = _CountingCond()
    r._procs, r._stop_requested = {}, set()
    return r


def _tick(monkeypatch, proj, by_sid, runs=None):
    """跑一轮调和器节拍：项目列表收敛到本测试项目（免扫真实库其他项目），
    会话实况按 sid 打桩；返回真实 card_finished 的裸 runner 单例
    （notify 计数在 `inst._cond.notifies`=补位唤醒断言）。"""
    monkeypatch.setattr(board.db, "list_projects_all", lambda: [proj])
    monkeypatch.setattr(board, "_iw_interaction",
                        lambda fam, p, sid, busy_hint=None: by_sid.get(sid))
    monkeypatch.setattr(board, "_RUNS", runs or {})
    inst = _bare_runner()
    inst._cond.notifies = 0                    # 只计本轮节拍自身的唤醒
    monkeypatch.setattr(board.runner, "INSTANCE", inst)
    board._iw_once()
    return inst


def _ext_rows(pid):
    return waitq.active_ext_items(pid)

def _prefix_members(pid):
    """调度前缀成员（行口径：只读行，唯一来源）。"""
    return runner.Runner._prefix_members(waitq.active_items()).get(pid) or set()


# ---------- 1. 外部 busy 会话 → ext 行 running 入前缀（brief 先败①） ----------

def test_external_busy_session_enters_prefix(monkeypatch):
    """外部 busy 会话 → ext 行 running 入运行前缀，位次计入「前面还有几个」
    （v2 §2.2【已定】：外部条目入前缀；§2.2 位次口径含前缀）。"""
    proj = _mk_project()
    pid = proj["id"]
    sc = _mk_card(pid, "同步卡", sid="s-ext-1", origin="sync")
    holder = _mk_card(pid, "平台卡", column="todo")
    inst = _tick(monkeypatch, proj, {"s-ext-1": {"pending": False, "busy": True}})
    rows = _ext_rows(pid)
    assert len(rows) == 1
    row = rows[0]
    assert row["kind"] == "ext" and row["target_id"] == str(sc)
    assert row["state"] == "running"                 # 入场即 running（不由平台启动）
    assert json.loads(row["meta"])["sid"] == "s-ext-1"   # meta 带 sid
    assert inst._cond.notifies >= 1                  # 占用变化唤醒补位（时机①）
    assert _prefix_members(pid) == {f"ext:{sc}"}     # 行即成员：运行前缀成员
    assert board.ext_active(pid) is True             # 行读口（外部会话在跑）
    # 位次口径：前缀成员在前（「前面还有 1 个」）
    cw = waitq.enqueue_card(holder, pid)
    assert waitq.position(cw) == (2, 2)
    assert board.ext_active(pid + 12345) is False    # 他项目不受影响


def test_doing_order_includes_ext_rows(monkeypatch):
    """doing 列展示序=队序含 ext 行（v2c R11 小口径 + T4）：外部卡的运行位次
    按其 ext 行 seq 落运行位区（原「无活跃行落 sort_order 兜底」自然退场）。"""
    proj = _mk_project()
    pid = proj["id"]
    sc = _mk_card(pid, "同步卡", sid="s-ext-1", origin="sync")
    _tick(monkeypatch, proj, {"s-ext-1": {"pending": False, "busy": True}})
    order = board._doing_queue_order(pid)
    assert order[sc][0] == 0                          # 运行位区（rank0）按 seq
    assert order[sc][1] == _ext_rows(pid)[0]["seq"]


# ---------- 2. ext 占前缀 → 平台单元不补位（brief 先败②） ----------

def test_platform_units_wait_behind_ext(monkeypatch):
    """ext 占运行前缀 → 平台等待单元不补位（serial N=1，补位规则①/②）：
    前缀成员（ext 行）已满窗；ext 行收尾后立即补位（时机③）。"""
    proj = _mk_project()
    pid = proj["id"]
    sc = _mk_card(pid, "同步卡", sid="s-ext-1", origin="sync")
    _tick(monkeypatch, proj, {"s-ext-1": {"pending": False, "busy": True}})
    cid = _mk_card(pid, "平台卡", column="todo")
    waitq.enqueue_card(cid, pid)
    r = _bare_runner()
    assert r._pick_locked() is None                  # 前缀满（ext 行即前缀成员）：留队
    waitq.cancel(waitq.KIND_EXT, sc, "外部会话结束")  # 外部行退场（收尾路径见下例）
    assert r._pick_locked() == f"c:{cid}"            # 前缀空出 → 补位


# ---------- 3. busy 回落/消失 → finish + 补位（brief 先败③） ----------

def test_ext_disappear_finishes_and_refills(monkeypatch):
    """busy 回落 → finish("ext:<卡 id>", "外部会话结束") → 行终态 + 补位唤醒
    （时机③）；幂等（终态行重入不再改写）。"""
    proj = _mk_project()
    pid = proj["id"]
    sc = _mk_card(pid, "同步卡", sid="s-ext-1", origin="sync")
    _tick(monkeypatch, proj, {"s-ext-1": {"pending": False, "busy": True}})
    rid = _ext_rows(pid)[0]["id"]
    calls = []
    real_finish = board.finish
    monkeypatch.setattr(board, "finish",
                        lambda key, reason, **kw:
                        calls.append((key, reason)) or real_finish(key, reason, **kw))
    inst = _tick(monkeypatch, proj, {"s-ext-1": {"pending": False, "busy": False}})
    # 唯一收尾点，reason 逐字（同轮卡列流转另调 c: 收尾，此处只钉 ext 面）
    assert [c for c in calls if c[0].startswith("ext:")] \
        == [(f"ext:{sc}", "外部会话结束")]
    assert waitq.get_item(rid)["state"] == "done"    # 行终态化
    assert inst._cond.notifies >= 1                  # 补位唤醒（时机③）
    assert _ext_rows(pid) == [] and board.ext_active(pid) is False
    cid = _mk_card(pid, "平台卡", column="todo")
    waitq.enqueue_card(cid, pid)
    assert _bare_runner()._pick_locked() == f"c:{cid}"
    assert board.finish(f"ext:{sc}", "外部会话结束") is False   # 幂等：无活跃行


def test_ext_finish_terminalizes_without_runner(monkeypatch, capsys):
    """runner 缺位（调试退化）同样收口 ext 行：外部条目无平台收尾面，行终态化
    不依赖 runner 单例（仅补位唤醒需要它）。收口成功落 reason 日志（v3 终审修复：
    ext 行的 reason 与 c: 行同型丢失，收尾点统一补回 `[board] 外部条目收尾：…`）。"""
    proj = _mk_project()
    pid = proj["id"]
    sc = _mk_card(pid, "同步卡", sid="s-ext-1", origin="sync")
    waitq.insert_ext(pid, sc, "s-ext-1")
    monkeypatch.setattr(board.runner, "INSTANCE", None)
    assert board.finish(f"ext:{sc}", "外部会话结束") is True
    assert f"[board] 外部条目收尾：ext:{sc}（外部会话结束）" in capsys.readouterr().out
    assert _ext_rows(pid) == []
    assert board.finish(f"ext:{sc}", "外部会话结束") is False   # 行已终态：no-op
    assert "外部条目收尾" not in capsys.readouterr().out        # 未收口不落日志


# ---------- 4. 复数外部条目并存（brief 先败④） ----------

def test_multiple_ext_entries_coexist(monkeypatch):
    """复数外部会话各自一行并存（v2 §2.2【已定】）；前缀计数/位次全计，
    独立生灭（一个退场不影响另一个）。"""
    proj = _mk_project()
    pid = proj["id"]
    a = _mk_card(pid, "同步卡A", sid="s-a", origin="sync")
    b = _mk_card(pid, "同步卡B", sid="s-b", origin="sync")
    _tick(monkeypatch, proj, {"s-a": {"pending": False, "busy": True},
                              "s-b": {"pending": False, "busy": True}})
    assert sorted(r["target_id"] for r in _ext_rows(pid)) == sorted([str(a), str(b)])
    assert all(r["state"] == "running" for r in _ext_rows(pid))
    assert _prefix_members(pid) == {f"ext:{a}", f"ext:{b}"}
    holder = _mk_card(pid, "平台卡", column="todo")
    cw = waitq.enqueue_card(holder, pid)
    assert waitq.position(cw) == (3, 3)              # 两个前缀成员在前
    assert _bare_runner().unit_busy(pid) is True     # 前缀行在场即忙（行即占位）
    _tick(monkeypatch, proj, {"s-a": {"pending": False, "busy": False},
                              "s-b": {"pending": False, "busy": True}})
    assert [r["target_id"] for r in _ext_rows(pid)] == [str(b)]


# ---------- 5. 挂起 interaction 的 ext 行不计前缀（brief 先败⑤） ----------

def test_ext_interaction_suspended_not_counted(monkeypatch):
    """挂起（interaction）态不算占用（豁免面②迁移）：调和器不为挂起会话建行、
    已存在的行随挂起收口，等待单元照常补位（挂起即出队：卡已离开开发容器）。"""
    proj = _mk_project()
    pid = proj["id"]
    sc = _mk_card(pid, "同步卡", sid="s-ext-1", origin="sync")
    # ① 同轮即探到挂起（卡尚未及搬列）：不建行
    _tick(monkeypatch, proj, {"s-ext-1": {"pending": True, "busy": True, "text": "?"}})
    assert _ext_rows(pid) == []
    # ② 先建行（busy 无等待）→ 会话提问挂起（卡落阻塞列）→ 行收口、前缀空出
    _tick(monkeypatch, proj, {"s-ext-1": {"pending": False, "busy": True}})
    assert len(_ext_rows(pid)) == 1
    db.update_board_card(sc, column_key="blocked", block_kind="interaction")
    _tick(monkeypatch, proj, {"s-ext-1": {"pending": True, "busy": True, "text": "?"}})
    assert _ext_rows(pid) == [] and _prefix_members(pid) == set()
    cid = _mk_card(pid, "平台卡", column="todo")
    waitq.enqueue_card(cid, pid)
    assert _bare_runner()._pick_locked() == f"c:{cid}"   # 出队


# ---------- 6. CLI 族不建 ext 行（brief 先败⑥） ----------

def test_cli_family_no_ext_rows(monkeypatch):
    """CLI 族无精确 busy 信号不参与占用探测（豁免面③沿用）：不建行、连会话
    枚举都不做；跨族残留在场行按「CLI 族无外部占用信号」收口（防堵死项目）。"""
    proj = _mk_project(agent_path="/usr/bin/kimi", name="extcli")
    pid = proj["id"]
    cid = _mk_card(pid, "CLI 同步卡", sid="s-cli", origin="sync")
    listed = []
    monkeypatch.setattr(board.sessparse, "list_sessions",
                        lambda *a, **k: listed.append(a) or [])
    _tick(monkeypatch, proj, {"s-cli": {"pending": False, "busy": True}})
    assert _ext_rows(pid) == [] and board.ext_active(pid) is False
    assert listed == []                              # 不枚举
    assert board._ext_refresh(proj) is False          # 刷新路径同样不建行
    waitq.insert_ext(pid, cid, "s-cli")              # 残留行（跨族历史）
    assert board.ext_active(pid) is True
    _tick(monkeypatch, proj, {})
    assert _ext_rows(pid) == []                      # 防御收口
    assert db.get_board_card(cid)["column_key"] == "doing"   # 不搬列（只收行）


# ---------- 7. 未建卡的在跑会话：补一次 sync 投影再落行 ----------

def test_ext_refresh_probes_session_without_card(monkeypatch):
    """项目活跃会话集合口径（R15）：未建卡的 busy 会话按需补一次 sync 投影
    再落行（否则「会话已在跑、平台不知情」窗口照旧）。"""
    proj = _mk_project()
    pid = proj["id"]
    monkeypatch.setattr(board.sessparse, "list_sessions",
                        lambda fam, d: [{"sid": "s-new", "title": "新会话", "mtime": 0}])
    monkeypatch.setattr(board.dshevents, "connected", lambda: True)
    monkeypatch.setattr(board.dshevents, "snapshot", lambda: {
        "s-new": {"session_id": "s-new", "status": "running",
                  "cwd": proj["project_dir"]}})
    monkeypatch.setattr(board, "_sync_session_busy", lambda *a, **k: True)
    monkeypatch.setattr(board.sessparse, "session_exists", lambda fam, s: True)
    assert board._ext_refresh(proj) is True
    rows = _ext_rows(pid)
    assert len(rows) == 1
    card = db.get_board_card(int(rows[0]["target_id"]))
    assert card["origin"] == "sync" and card["column_key"] == "doing"


# ---------- 8. 落列口径沿用现状默认（brief 先败⑧） ----------

def test_ext_column_fallout_unchanged(monkeypatch):
    """落列口径沿用现状默认（R13；v2 §4 待定 1）：实况空闲→待审核、
    归档→已完成、会话存储被删→已完成——ext 行不改变列流转。"""
    proj = _mk_project()
    pid = proj["id"]
    # ① 实况空闲 → 待审核（ext 行收口 + 调和器列流转不变）
    sc = _mk_card(pid, "同步卡", sid="s-idle", origin="sync")
    _tick(monkeypatch, proj, {"s-idle": {"pending": False, "busy": True}})
    assert db.get_board_card(sc)["column_key"] == "doing"
    _tick(monkeypatch, proj, {"s-idle": {"pending": False, "busy": False}})
    assert _ext_rows(pid) == []
    assert db.get_board_card(sc)["column_key"] == "review"
    # ② 归档 → 已完成（sync_sessions 投影，ext 行随卡离开发列而收口）
    ar = _mk_card(pid, "归档卡", sid="s-arch", origin="sync")
    waitq.insert_ext(pid, ar, "s-arch")
    monkeypatch.setattr(board, "_sync_session_busy", lambda *a, **k: False)
    monkeypatch.setattr(board.sessparse, "list_sessions",
                        lambda fam, d: [{"sid": "s-arch", "title": "归档卡",
                                         "mtime": 0, "archived": True}])
    board.sync_sessions(proj)
    assert db.get_board_card(ar)["column_key"] == "done"
    _tick(monkeypatch, proj, {"s-arch": {"pending": False, "busy": False}})
    assert _ext_rows(pid) == []
    assert db.get_board_card(ar)["column_key"] == "done"      # 行收口不搬列
    # ③ 会话存储被删 → 已完成
    gone = _mk_card(pid, "删除卡", sid="s-gone", origin="sync")
    waitq.insert_ext(pid, gone, "s-gone")
    monkeypatch.setattr(board.sessparse, "list_sessions", lambda fam, d: [])
    monkeypatch.setattr(board.sessparse, "session_exists", lambda fam, s: False)
    board.sync_sessions(proj)
    assert db.get_board_card(gone)["column_key"] == "done"
    _tick(monkeypatch, proj, {})
    assert _ext_rows(pid) == []


# ---------- 9. 两处口径合一（探针退役逐点钉） ----------

def test_ext_row_readers_and_answer_exemption(monkeypatch):
    """探针退役后的等价性（逐点钉，v3d R8）：unit_busy=运行前缀窗口已满
    （ext 行即前缀成员，两处口径合一）；a: 单元与平台单元同口径受 ext 行闸
    （2026-09-28 #610 实障收敛，原 P2 R1「投递只看窗口不看外部探针」豁免撤销
    ——ext 行在场 a: 留队，行退场放行）。"""
    proj = _mk_project(agent_path="", name="extr")   # 族无关：直接种 ext 行
    pid = proj["id"]
    sc = _mk_card(pid, "同步卡", sid="s-ext-1", origin="sync")
    r = _bare_runner()
    assert r.unit_busy(pid) is False and r._pick_locked() is None   # 无行：不设障
    waitq.insert_ext(pid, sc, "s-ext-1")
    assert r.unit_busy(pid) is True                  # ext 行即前缀成员（行口径）
    # c: 单元被 ext 行挡住（行即成员：前缀窗口满）
    cid = _mk_card(pid, "平台卡", column="todo")
    waitq.enqueue_card(cid, pid)
    assert r._pick_locked() is None
    # a: 单元同受 ext 行闸（2026-09-28 #610 收敛）：ext 行在场 a: 留队，
    # 行退场即放行（答案送达与外部会话不再并发）
    proj2 = _mk_project(agent_path="", name="extr2")
    pid2 = proj2["id"]
    sc2 = _mk_card(pid2, "同步卡2", sid="s-ext-2", origin="sync")
    waitq.insert_ext(pid2, sc2, "s-ext-2")
    acard = _mk_card(pid2, "作答卡", column="doing", block_kind="queue")
    waitq.enqueue(waitq.KIND_ANSWER, acard, pid2, meta={"sid": "s-ans"})
    assert r._pick_locked() is None                   # ext 行在场：a: 留队
    waitq.finish_by_target(waitq.KIND_EXT, sc2)
    assert r._pick_locked() == f"a:{acard}"


def test_ext_row_is_occupancy_for_platform_card_driven_outside(monkeypatch):
    """I1 闭合（v2d T2 硬移交）：平台卡被用户 TUI 直跑（无平台在管单元）时
    同样成占位源——项目不许在同项目并发起单元；平台持有者在场则不建行
    （前缀 ext:/c: 键双计结构性消除）。"""
    proj = _mk_project(name="extp")
    pid = proj["id"]
    cid = _mk_card(pid, "平台卡", column="review", sid="s-plat")
    _tick(monkeypatch, proj, {"s-plat": {"pending": False, "busy": True}})
    assert [r["target_id"] for r in _ext_rows(pid)] == [str(cid)]
    assert db.get_board_card(cid)["column_key"] == "doing"      # 调和器列流转不变
    assert _bare_runner().unit_busy(pid) is True                # 行即占位
    # 平台持有者在场（在管条目）：不建行（外部条目与平台单元互斥）
    cid2 = _mk_card(pid, "平台在管卡", column="doing", sid="s-run")
    _tick(monkeypatch, proj, {"s-run": {"pending": False, "busy": True}},
          runs={cid2: {"proc": None, "sid": "s-run"}})
    assert all(r["target_id"] != str(cid2) for r in _ext_rows(pid))


# ---------- 10. 重启映射（v2 §5 第 4 条） ----------

def test_recover_ext_restart_mapping(monkeypatch):
    """重启映射：ext 行按项目活跃会话集合重新精确对账——实况在→保持 running、
    实况空闲→done、退场族残留→done（外部会话不受平台重启影响，占用不丢）。"""
    busy = _mk_project(name="extbusy")
    idle = _mk_project(name="extidle")
    cli = _mk_project(agent_path="/usr/bin/kimi", name="extclic")
    c_busy = _mk_card(busy["id"], "在跑同步卡", sid="s-busy", origin="sync")
    c_idle = _mk_card(idle["id"], "空闲同步卡", sid="s-idle", origin="sync")
    c_cli = _mk_card(cli["id"], "CLI 同步卡", sid="s-cli", origin="sync")
    r_busy = waitq.insert_ext(busy["id"], c_busy, "s-busy")[0]
    r_idle = waitq.insert_ext(idle["id"], c_idle, "s-idle")[0]
    r_cli = waitq.insert_ext(cli["id"], c_cli, "s-cli")[0]
    monkeypatch.setattr(board, "_recover_web_card", lambda p, c: None)
    monkeypatch.setattr(board.db, "list_queued_board_cards", lambda: [])
    monkeypatch.setattr(board.runner, "INSTANCE", _bare_runner())
    monkeypatch.setattr(board, "_RUNS", {})
    monkeypatch.setattr(board, "sync_sessions", lambda p: [])
    monkeypatch.setattr(board.dshevents, "connected", lambda: True)
    monkeypatch.setattr(board.dshevents, "snapshot", lambda: {
        "s-busy": {"session_id": "s-busy", "status": "running",
                   "cwd": busy["project_dir"]},
        "s-idle": {"session_id": "s-idle", "status": "idle",
                   "cwd": idle["project_dir"]},
        "s-cli": {"session_id": "s-cli", "status": "running",
                  "cwd": cli["project_dir"]}})
    board.recover()
    assert waitq.get_item(r_busy)["state"] == "running"    # 实况在：保持（占用不丢）
    assert waitq.get_item(r_idle)["state"] == "done"       # 实况空闲：收口
    assert waitq.get_item(r_cli)["state"] == "done"        # 退场族：无信号 → 收口


def test_recover_sync_card_not_adopted_as_unit(monkeypatch):
    """外部直跑卡（origin=sync）busy 时不收养为平台单元（v2d T4）：不建 _RUNS
    条目、不建 c: 行、列不动——占位与收尾归 ext 行（`_recover_ext_rows` 保持
    running）；平台自建卡收养行为逐字不变。"""
    proj = _mk_project(name="extadopt")
    pid = proj["id"]
    sc = _mk_card(pid, "外部同步卡", sid="s-ext-1", origin="sync")
    pc = _mk_card(pid, "平台卡", sid="s-run", origin="")
    waitq.insert_ext(pid, sc, "s-ext-1")
    monkeypatch.setattr(board.db, "list_queued_board_cards", lambda: [])
    monkeypatch.setattr(board.runner, "INSTANCE", _bare_runner())
    monkeypatch.setattr(board, "_RUNS", {})
    monkeypatch.setattr(board, "sync_sessions", lambda p: [])
    monkeypatch.setattr(board.dshevents, "get",
                        lambda sid: {"status": "running"})
    monkeypatch.setattr(board.dshevents, "connected", lambda: True)
    # 就绪闸（2026-10-08 批次 C）：本用例模拟「中枢在线且快照可信」的恢复场景，
    # 故一并声明 aligned——不可信时 _recover_web_card 一律不搬列（未知 ≠ 空闲）。
    monkeypatch.setattr(board.dshevents, "aligned", lambda: True)
    monkeypatch.setattr(board.dshevents, "snapshot", lambda: {
        "s-ext-1": {"session_id": "s-ext-1", "status": "running",
                    "cwd": proj["project_dir"]}})
    board.recover()
    assert sc not in board._RUNS and pc in board._RUNS      # 外部卡不收养
    assert waitq.get_active(waitq.KIND_CARD, sc) is None   # 不建平台 c: 行
    assert waitq.get_active(waitq.KIND_CARD, pc) is not None   # 平台卡收养照旧（行即占位）
    assert db.get_board_card(sc)["column_key"] == "doing"  # 列不动（列映射归调和器）
    assert [r["target_id"] for r in waitq.active_ext_items(pid)] == [str(sc)]


def test_insert_ext_conflict_reuses_active_row():
    """insert_ext 撞活跃唯一索引 → 重查复用既有行（模块既有 idiom，fix round 1
    评审 Minor-2）：`upsert_ext` 的 check-then-insert 窗口内并发建行不再把
    IntegrityError 抛穿到 socketserver 层。"""
    proj = _mk_project(name="extdup")
    pid = proj["id"]
    sc = _mk_card(pid, "同步卡", sid="s-1", origin="sync")
    rid, seq = waitq.insert_ext(pid, sc, "s-1")
    rid2, seq2 = waitq.insert_ext(pid, sc, "s-1")          # 撞索引：复用既有行
    assert (rid2, seq2) == (rid, seq)
    assert len(_ext_rows(pid)) == 1
    waitq.finish_by_target(waitq.KIND_EXT, sc)
    rid3, _ = waitq.insert_ext(pid, sc, "s-1")             # 终态后重新建行（新 id）
    assert rid3 != rid and waitq.active_ext_items(pid)[0]["id"] == rid3


def test_iw_once_probe_unknown_keeps_ext_rows(monkeypatch):
    """单卡探测不明（dsh：EventHub 未连接/读不到该会话，`_iw_interaction` 回
    None）→ 本轮不对账该卡 ext 行（宁多等不可误放行）：既有行保留 running、
    占用不丢、不唤醒补位；恢复后按实况照常收口（fix round 1，评审 I1——原实现
    把「项目级 map 拉不到」退化成 `_ext_stale_finish(pid, {}, set())`，一次瞬时
    故障即把持久占用全部落终态并 notify，队首单元立刻可起跑与仍在跑的外部会话
    并发）。"""
    proj = _mk_project(name="extdsh")
    pid = proj["id"]
    sc = _mk_card(pid, "外部同步卡", sid="s-ext-1", origin="sync")
    waitq.insert_ext(pid, sc, "s-ext-1")
    # 逐卡探测不明（by_sid 缺省 → `_iw_interaction` 返回 None＝hub 未知口径）
    inst = _tick(monkeypatch, proj, {})
    assert [r["target_id"] for r in _ext_rows(pid)] == [str(sc)]   # 行保留（未终态化）
    assert _ext_rows(pid)[0]["state"] == "running"
    assert board.ext_active(pid) is True          # 占位源仍在
    assert inst._cond.notifies == 0               # 未误唤醒补位（占位未变）
    # 恢复：探测可用且该会话 busy → 行保持；转空闲 → 行照常收口（对账自愈）
    _tick(monkeypatch, proj, {"s-ext-1": {"pending": False, "busy": True}})
    assert _ext_rows(pid)[0]["state"] == "running"
    _tick(monkeypatch, proj, {"s-ext-1": {"pending": False, "busy": False}})
    assert _ext_rows(pid) == []                   # 实况空闲：收口
    assert board.ext_active(pid) is False


# ---------- 11. 收口轮：重启刷新覆盖面（v2d 子批收口，评审项 2） ----------

def test_recover_ext_refresh_covers_queued_card_projects(monkeypatch):
    """重启刷新面=有 ext 行的项目 ∪ 有排队卡的项目（评审项 2，对齐旧
    `_sync_busy_refresh` 的调用面）：平台停机期间外部会话起跑（无行）时，重启后
    排队卡所在项目仍要建行——否则队列会在外部会话运行中起单元。"""
    proj = _mk_project(name="extrecq")
    pid = proj["id"]
    sc = _mk_card(pid, "外部同步卡", sid="s-ext-1", origin="sync")
    qc = _mk_card(pid, "排队卡")
    waitq.enqueue_card(qc, pid)                      # doing+queue 排队占位
    monkeypatch.setattr(board.db, "list_queued_board_cards",
                        lambda: [db.get_board_card(qc)])
    monkeypatch.setattr(board, "_recover_web_card", lambda p, c: None)
    monkeypatch.setattr(board.runner, "INSTANCE", _bare_runner())
    monkeypatch.setattr(board, "_RUNS", {})
    monkeypatch.setattr(board.dshevents, "connected", lambda: True)
    monkeypatch.setattr(board.dshevents, "snapshot", lambda: {
        "s-ext-1": {"session_id": "s-ext-1", "status": "running",
                    "cwd": proj["project_dir"]}})
    board.recover()
    assert [r["target_id"] for r in waitq.active_ext_items(pid)] == [str(sc)]


def test_starting_timeout_row_closure(monkeypatch):
    """starting 超时死腿的行收口（评审项 4）：唯一收尾点 finish 把行收口
    （failed「starting 超时」），不再有独立的「释放」动作可断言。"""
    # 显式 CLI 族路径（/usr/bin/kimi）：本用例验 CLI 族的「starting 超时 → 可证未起
    # → 行收口」判据；2026-10-03 起空 agent_path 默认族是 dsh_plugin（web 族，按
    # 会话实况判活、不可证未起时只告警不处置），语义不同，故不能用空串。
    proj = _mk_project(agent_path="/usr/bin/kimi", name="extrst")
    pid = proj["id"]
    cid = _mk_card(pid, "超时卡")
    rid = _stale_starting_row(pid, cid)
    monkeypatch.setattr(board.runner, "INSTANCE", _bare_runner())
    monkeypatch.setattr(board, "_RUNS", {})
    board._reconcile_starting_rows()
    row = waitq.get_item(rid)
    assert row["state"] == "failed"
    assert json.loads(row["meta"])["error"] == "starting 超时"


def _stale_starting_row(pid, cid, age_s=600):
    """造超龄 c: starting 行（本文件自备，免跨文件依赖）。"""
    rid = waitq.enqueue_card(cid, pid, from_column="review")
    assert waitq.claim(rid, "worker") is True
    old = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time() - age_s))
    with db.connect() as conn:
        conn.execute("UPDATE wait_items SET claimed_at=? WHERE id=?", (old, rid))
    return rid


# ---------- 探测域收窄 + sync busy 按需判定（2026-09-27 拖拽入队慢批） ----------

def test_sync_sessions_web_family_skips_bound_busy_probe(monkeypatch):
    """sync 巡视 busy 按需判定：web 族存量卡只用 archived，不再逐会话探测
    ——只对未绑卡会话（要建新卡）判 busy，且经 _sync_session_busy 传
    wait=False（30s 巡视不再阻塞）。断言打在 _web_busy 面（wait 实参在那里
    才可见）。"""
    proj = _mk_project()
    pid = proj["id"]
    _mk_card(pid, "存量卡", column="review", sid="s-have", origin="sync")
    probed = []

    def fake_web_busy(family, pdir, sid, wait=True):
        probed.append((sid, wait))
        return False
    monkeypatch.setattr(board, "_web_busy", fake_web_busy)
    monkeypatch.setattr(board.sessparse, "list_sessions",
                        lambda fam, d: [
                            {"sid": "s-have", "title": "存量", "mtime": 0},
                            {"sid": "s-new", "title": "新会话", "mtime": 0}])
    monkeypatch.setattr(board.sessparse, "session_exists", lambda fam, s: True)
    created = board.sync_sessions(proj)
    assert len(created) == 1                        # 只有 s-new 建卡
    assert probed == [("s-new", False)]             # 存量卡会话不探；wait=False


# ---------- dsh_plugin：ext 探测读 EventHub 快照（P1 打通、P4 事件化，2026-10-03）---
# P1 时这条分支补上了 dsh 的 ext 探测（此前掉进 opencode 分支必然失败，方案 §2.1 #16）；
# P4 把读口从「每轮一次 /live」换成 EventHub 的本地快照（零请求）。

def test_ext_candidates_dsh_reads_hub_by_cwd(monkeypatch):
    """本地快照按 cwd 归属：在跑的**外部**会话建 desired；跨项目 cwd 不计；
    空闲不计；在跑但无卡的会话进 unbound（调用方补一次投影再反查）。"""
    proj = _mk_project(agent_path="dsh-plugin:/usr/bin/dsh", name="extdsh")
    pid = proj["id"]
    card = _mk_card(pid, "dsh 在跑卡", sid="session-a")
    other = _mk_project(agent_path="dsh-plugin:/usr/bin/dsh", name="extdsh2")
    monkeypatch.setattr(board, "_RUNS", {})
    # P4：读口是 EventHub 快照——驱动层被炸掉也照样工作（证明零请求）
    def boom(*a, **kw):
        raise AssertionError("P4 后 ext 探测不应再打驱动")
    monkeypatch.setattr(board.dshdriver, "live", boom)
    monkeypatch.setattr(board.dshevents, "connected", lambda: True)
    monkeypatch.setattr(board.dshevents, "snapshot", lambda: {
        "session-a": {"session_id": "session-a", "status": "running", "owned": False,
                      "cwd": proj["project_dir"]},
        "session-b": {"session_id": "session-b", "status": "running", "owned": False,
                      "cwd": other["project_dir"]},   # 跨项目 → 不计
        "session-c": {"session_id": "session-c", "status": "idle", "owned": False,
                      "cwd": proj["project_dir"]},    # 空闲 → 不计
        "session-d": {"session_id": "session-d", "status": "running", "owned": True,
                      "cwd": proj["project_dir"]},    # 在跑但平台无卡 → unbound
    })
    desired, hold, unbound, unknown = board._ext_candidates(
        proj, db.list_board_cards(pid))
    assert desired == {card: "session-a"}
    assert unbound == {"session-d"}
    assert hold == set() and unknown == set()


def test_ext_refresh_dsh_driver_down_keeps_rows(monkeypatch):
    """事件中枢未连接（探测不明）→ `_ext_refresh` 返回 None（保既有行、宁可多等）。

    单族化（P7b B4）后探测读口就是 `dshevents`（原逐会话驱动 `/live` 已退场）：
    `connected()` False 时 `_ext_candidates` 抛 DshDriverError，`_ext_refresh`
    收敛为 None（绝不把未知当空闲）。"""
    proj = _mk_project(agent_path="dsh-plugin:/usr/bin/dsh", name="extdshdown")
    _mk_card(proj["id"], "在跑卡", sid="session-x")
    monkeypatch.setattr(board.dshevents, "connected", lambda: False)
    monkeypatch.setattr(board.dshevents, "snapshot",
                        lambda: pytest.fail("断连时不应取快照"))
    assert board._ext_refresh(proj) is None


# ---------- 12. 会话已不在 dsh 池（disposed）→ 僵尸 ext 行当轮收口 ----------
# 2026-10-07 实障（卡 870 排队 5 小时未被启动）：dsh 会话结束走 `session/disposed`
# （`dshevents` 摘条目）或从 `/live` 快照消失，`_iw_interaction` 读不到即回 None；
# 旧口径把这种「在线但会话不在池」与「中枢断连＝真未知」混为一谈、一律 hold 保行，
# 子代理会话留下的 ext 行因此永久占位（项目常驻「有外部会话在跑」⇒ 永不补位）。

def test_iw_once_hub_online_missing_session_closes_ext_rows(monkeypatch):
    """中枢在线、注册表却无该会话（外部会话已被 dsh 释放）→ 当轮收口 ext 行并
    唤醒补位；这是 ext 行唯一的自动收口路径（旧实现要等用户动作触发
    `_ext_refresh`，实障里等了 271 分钟）。"""
    proj = _mk_project(agent_path="dsh-plugin:/usr/bin/dsh", name="extgone")
    pid = proj["id"]
    sc = _mk_card(pid, "外部同步卡", sid="s-ext-gone", origin="sync")
    waitq.insert_ext(pid, sc, "s-ext-gone")
    monkeypatch.setattr(board.dshevents, "connected", lambda: True)
    inst = _tick(monkeypatch, proj, {})          # 在线但注册表无该 sid
    assert _ext_rows(pid) == []                  # 占用行当轮收口
    assert board.ext_active(pid) is False
    assert inst._cond.notifies >= 1              # 前缀成员消失 → 唤醒补位


def test_iw_once_hub_offline_keeps_ext_rows(monkeypatch):
    """中枢断连（真未知）→ 仍然保行（「宁可多等不可误放行」原口径不动）。

    与上例互为对照：同样 `_iw_interaction` 回 None，只有 `connected()` 为真才
    按「会话不在池」收口——断连时的读不到绝不推断成空闲。"""
    proj = _mk_project(agent_path="dsh-plugin:/usr/bin/dsh", name="extoff")
    pid = proj["id"]
    sc = _mk_card(pid, "外部同步卡", sid="s-ext-off", origin="sync")
    waitq.insert_ext(pid, sc, "s-ext-off")
    monkeypatch.setattr(board.dshevents, "connected", lambda: False)
    inst = _tick(monkeypatch, proj, {})
    assert [r["target_id"] for r in _ext_rows(pid)] == [str(sc)]   # 行保留
    assert _ext_rows(pid)[0]["state"] == "running"
    assert inst._cond.notifies == 0              # 未误唤醒补位


def test_refresh_ext_rows_closes_stale_and_wakes(monkeypatch):
    """`refresh_ext_rows`（周期自检/启动补跑共用入口）：按中枢快照对账活跃 ext 行
    ——不在快照里的会话（已结束）行收口并唤醒补位；有变化即唤醒，无变化不唤醒。"""
    proj = _mk_project(agent_path="dsh-plugin:/usr/bin/dsh", name="extrefresh")
    pid = proj["id"]
    sc = _mk_card(pid, "外部同步卡", sid="s-ext-1", origin="sync")
    waitq.insert_ext(pid, sc, "s-ext-1")
    monkeypatch.setattr(board.dshevents, "connected", lambda: True)
    monkeypatch.setattr(board.dshevents, "snapshot", lambda: {})   # 会话已不在池
    monkeypatch.setattr(board.db, "list_projects_all", lambda: [proj])
    inst = _bare_runner()
    inst._cond.notifies = 0
    monkeypatch.setattr(board.runner, "INSTANCE", inst)
    before = inst._cond.notifies
    assert board.refresh_ext_rows() is True
    assert _ext_rows(pid) == []
    assert inst._cond.notifies > before          # 占用消失 → 唤醒补位
    after = inst._cond.notifies
    assert board.refresh_ext_rows() is False     # 无活跃行：无变化、不空唤醒
    assert inst._cond.notifies == after


def test_refresh_ext_rows_keeps_rows_when_hub_offline(monkeypatch):
    """中枢未连接 → `refresh_ext_rows` 一律保行（探测不可用不改动任何行）。"""
    proj = _mk_project(agent_path="dsh-plugin:/usr/bin/dsh", name="extrefoff")
    pid = proj["id"]
    sc = _mk_card(pid, "外部同步卡", sid="s-ext-2", origin="sync")
    waitq.insert_ext(pid, sc, "s-ext-2")
    monkeypatch.setattr(board.dshevents, "connected", lambda: False)
    monkeypatch.setattr(board.dshevents, "snapshot",
                        lambda: pytest.fail("断连时不应取快照"))
    monkeypatch.setattr(board.db, "list_projects_all", lambda: [proj])
    inst = _bare_runner()
    inst._cond.notifies = 0
    monkeypatch.setattr(board.runner, "INSTANCE", inst)
    assert board.refresh_ext_rows() is False
    assert [r["target_id"] for r in _ext_rows(pid)] == [str(sc)]
    assert inst._cond.notifies == 0


def _stub_hub_snapshot(monkeypatch):
    """把中枢打桩成「已连接但池内无任何会话」（外部会话已结束的实况）。"""
    monkeypatch.setattr(board.dshevents, "connected", lambda: True)
    monkeypatch.setattr(board.dshevents, "snapshot", lambda: {})


def test_start_ext_recover_after_connect_runs_refresh(monkeypatch):
    """启动补跑：等中枢首连就绪后收口僵尸 ext 行（`board.recover()` 里那次对账
    执行在 `dshevents.start()` 之前，探测必然不可用、一律保行）。"""
    proj = _mk_project(agent_path="dsh-plugin:/usr/bin/dsh", name="extboot")
    pid = proj["id"]
    sc = _mk_card(pid, "外部同步卡", sid="s-ext-boot", origin="sync")
    waitq.insert_ext(pid, sc, "s-ext-boot")
    _stub_hub_snapshot(monkeypatch)
    inst = _bare_runner()
    inst._cond.notifies = 0
    monkeypatch.setattr(board.runner, "INSTANCE", inst)
    monkeypatch.setattr(board.dshevents, "wait_connected", lambda t: True)
    th = board.start_ext_recover_after_connect(timeout=0.5)
    th.join(5.0)
    assert not th.is_alive()
    assert _ext_rows(pid) == []                  # 僵尸行已收口
    assert inst._cond.notifies >= 1              # 占用消失 → 唤醒补位


def test_start_ext_recover_after_connect_skips_when_not_connected(monkeypatch):
    """中枢未就绪（独立形态/宿主不可达）→ 不跑对账（保行，等调和器与自检接手）。"""
    calls = []
    monkeypatch.setattr(board.dshevents, "wait_connected", lambda t: False)
    monkeypatch.setattr(board, "refresh_ext_rows",
                        lambda reason="": calls.append(reason))
    th = board.start_ext_recover_after_connect(timeout=0.05)
    th.join(5.0)
    assert not th.is_alive()
    assert calls == []


def test_stale_ext_row_cleared_by_watcher_unblocks_queued_card(monkeypatch):
    """实障链路回归（2026-10-07 卡 870）：外部会话 busy 建 ext 行挡住平台排队卡 →
    会话结束、注册表摘条目（中枢在线却读不到）→ 调和器当轮收口 → 排队卡立即补位。

    ① 段即旧实现的行为（读不到＝未知 ⇒ 保行 ⇒ 排队卡永不启动）；② 段是修复后的
    行为。两段合起来才能证明这条测试抓的就是实障根因，而不是别的路径顺手收了口。"""
    proj = _mk_project(agent_path="dsh-plugin:/usr/bin/dsh", name="extstale")
    pid = proj["id"]
    sc = _mk_card(pid, "外部同步卡", sid="s-ext-1", origin="sync")
    _tick(monkeypatch, proj, {"s-ext-1": {"pending": False, "busy": True}})
    cid = _mk_card(pid, "平台卡", column="todo")
    waitq.enqueue_card(cid, pid)
    r = _bare_runner()
    assert r._pick_locked() is None                  # 外部占用：排队卡留队
    # ① 中枢未连接（真未知）：保行——旧口径下这条行会一直留到用户动作
    _tick(monkeypatch, proj, {})
    assert board.ext_active(pid) is True
    assert r._pick_locked() is None
    # ② 中枢在线、注册表无该会话（外部会话已结束）：当轮收口 → 立即补位
    monkeypatch.setattr(board.dshevents, "connected", lambda: True)
    _tick(monkeypatch, proj, {})
    assert board.ext_active(pid) is False
    assert r._pick_locked() == f"c:{cid}"


# ------------------------------------- 子代理会话不构成占用（2026-10-07）

def test_ext_candidates_skips_subagent_sessions(monkeypatch):
    """子代理会话不算项目外部占用：注册表 `origin=subagent` 的行既不进 desired
    （不建 ext 行）也不进 unbound（不触发一次 sync 投影）——子代理是主会话的实现
    细节，它占位会让项目永不补位（2026-10-07 实障：卡 870 排队 5 小时）。
    对照：同形主会话（origin 空）照旧进 desired。"""
    proj = _mk_project(agent_path="dsh-plugin:/usr/bin/dsh", name="extsubcand")
    pid = proj["id"]
    card = _mk_card(pid, "主会话卡", sid="session-main-1")
    monkeypatch.setattr(board, "_RUNS", {})
    monkeypatch.setattr(board.dshevents, "connected", lambda: True)
    monkeypatch.setattr(board.dshevents, "snapshot", lambda: {
        "session-main-1": {"session_id": "session-main-1", "status": "running",
                           "owned": False, "origin": "", "cwd": proj["project_dir"]},
        "session-sub-1": {"session_id": "session-sub-1", "status": "running",
                          "owned": False, "origin": "subagent",
                          "cwd": proj["project_dir"]},
    })
    desired, hold, unbound, unknown = board._ext_candidates(
        proj, db.list_board_cards(pid))
    assert desired == {card: "session-main-1"}
    assert unbound == set() and hold == set() and unknown == set()


def test_iw_once_subagent_card_creates_no_ext_row(monkeypatch):
    """存量遗留卡（绑子代理会话）实况 busy ⇒ 调和器**不建 ext 行**、排队卡立即补位。

    测点走磁盘兜底：注册表未上报 origin（旧插件形态）时，占用豁免回落
    `sessparse.is_subagent` 的会话头读口。对照段：主会话 busy 卡照旧建行挡位
    （证明本用例抓的是子代理豁免，不是别的路径顺手放行）。"""
    proj = _mk_project(agent_path="dsh-plugin:/usr/bin/dsh", name="extsubocc")
    pid = proj["id"]
    _mk_card(pid, "子代理卡", sid="sub-1", origin="sync")
    _mk_card(pid, "主会话同步卡", sid="main-1", origin="sync")
    monkeypatch.setattr(board.sessparse, "is_subagent", lambda fam, s: s == "sub-1")
    _tick(monkeypatch, proj, {"sub-1": {"pending": False, "busy": True}})
    assert _ext_rows(pid) == []                      # 子代理 busy：不落行
    cid = _mk_card(pid, "平台卡", column="todo")
    waitq.enqueue_card(cid, pid)
    r = _bare_runner()
    assert r._pick_locked() == f"c:{cid}"            # 不算占用：立即补位
    _tick(monkeypatch, proj, {"main-1": {"pending": False, "busy": True}})
    assert board.ext_active(pid) is True             # 对照：主会话照旧挡位
    assert r._pick_locked() is None
