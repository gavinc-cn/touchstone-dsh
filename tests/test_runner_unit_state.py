# 统一队列单元态查询（会话详情页标题「队列」徽标数据源）：running/queued/idle 与位次
# v2a T4 起位次含运行前缀（裁决 R7）：pos=前缀长度（starting/running/finishing
# 全计——claimed 已被 starting 吸收，v2a T1）+ waiting 中 seq 更小者 + 1；
# v3a 起前缀成员=行（唯一来源，R1/R2）：c: 行在起跑证实后跨轮 running 存活；
# 行消失（终态/取消）→ idle。
# v3d 起 running 判据 = 本单元有活跃非等待行（行即唯一表征，第二表征 API 已删）。
import os, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db
import runner
import waitq


def setup_function(_fn):
    """每个用例前清空等待项表（conftest 临时库；种子行落真表）。"""
    with db.connect() as conn:
        conn.execute("DELETE FROM wait_items")


def _bare():
    """裸 Runner（不起 worker 线程）：unit_state 仅需锁（运行态读等待项行）。"""
    r = runner.Runner.__new__(runner.Runner)
    r._cond = threading.Condition(threading.Lock())
    return r


def test_running_from_active_row():
    """任务单元正在执行：行 starting（拾取即占位）→ running。"""
    waitq.enqueue(waitq.KIND_TASK, 7, 9)
    waitq.claim_by_target(waitq.KIND_TASK, 7, "worker")
    r = _bare()
    assert r.unit_state("t:7", 9) == {"state": "running", "pos": 0, "total": 0}


def test_running_project_mismatch_is_not_running():
    """行在他项目（调用方传参漂移防御）：本项目视角不报运行中。"""
    waitq.enqueue(waitq.KIND_TASK, 7, 10)
    waitq.claim_by_target(waitq.KIND_TASK, 7, "worker")
    r = _bare()
    assert r.unit_state("t:7", 9) == {"state": "idle", "pos": 0, "total": 0}


def test_running_card_row_reports_running():
    """卡片会话行 running（跨轮持有归 card_started/card_finished）→ running。"""
    r = _bare()
    assert r.unit_state("c:5", 9) == {"state": "idle", "pos": 0, "total": 0}
    waitq.enter_running(waitq.KIND_CARD, 5, 9)
    assert r.unit_state("c:5", 9) == {"state": "running", "pos": 0, "total": 0}


def test_queued_pos_counts_same_project_only():
    """位次只数本项目活跃行：他项目单元插在中间不影响 pos/total（无前缀时
    与旧口径同值——waiting 排号不变）。"""
    waitq.enqueue(waitq.KIND_TASK, 1, 9)
    waitq.enqueue(waitq.KIND_CARD, 5, 9)
    waitq.enqueue(waitq.KIND_TASK, 2, 10)
    waitq.enqueue(waitq.KIND_CARD, 6, 9)
    r = _bare()
    assert r.unit_state("c:5", 9) == {"state": "queued", "pos": 2, "total": 3}
    assert r.unit_state("c:6", 9) == {"state": "queued", "pos": 3, "total": 3}
    assert r.unit_state("t:2", 10) == {"state": "queued", "pos": 1, "total": 1}


def test_queued_pos_counts_running_prefix():
    """位次含运行前缀（v2a T4，裁决 R7；v3a 读口切行）：pos=前缀成员数（项目内
    starting/running/finishing **行**，唯一来源）+ waiting 中 seq 更小者 + 1；
    total=项目成员总数（行）。
    运行 1 + 等待 2：后者 pos=2,3 / total=3（「claimed 不计」旧口径废止）。"""
    i = waitq.enqueue(waitq.KIND_TASK, 1, 9)
    waitq.claim(i, "worker")                     # starting（前缀成员）
    waitq.enqueue(waitq.KIND_CARD, 5, 9)
    waitq.enqueue(waitq.KIND_CARD, 6, 9)
    r = _bare()
    assert r.unit_state("c:5", 9) == {"state": "queued", "pos": 2, "total": 3}
    assert r.unit_state("c:6", 9) == {"state": "queued", "pos": 3, "total": 3}
    # running 态行同样计入前缀（证实运行不改变前缀成员身份）
    waitq.mark_running(waitq.KIND_TASK, 1)
    assert r.unit_state("c:5", 9) == {"state": "queued", "pos": 2, "total": 3}


def test_queued_pos_finishing_counts_prefix_too():
    """finishing 行同计前缀（R7「全计」；调度口径（补位器窗口）不计 finishing、
    位次口径另含——waitq.PREFIX_STATES 注释在案的两口径分工）。"""
    i = waitq.enqueue(waitq.KIND_TASK, 1, 9)
    waitq.claim(i, "worker")
    waitq.mark_running(waitq.KIND_TASK, 1)
    waitq.mark_finishing(waitq.KIND_TASK, 1)     # finishing（位次前缀成员）
    waitq.enqueue(waitq.KIND_CARD, 5, 9)
    r = _bare()
    assert r.unit_state("c:5", 9) == {"state": "queued", "pos": 2, "total": 2}


def test_queued_pos_counts_running_row_prefix():
    """v3a 位次读口切行：running 行（起跑证实后跨轮存活的 c: 行形态）计入前缀，
    **无需任何第二表征**——行即成员，行即权威（v3d 起无第二表征可查）。
    种子行 not_before 钉远期：防套件遗留野 worker（M5 独立清理任务）抢走
    本用例的 waiting 种子（位次判定不读 not_before，口径不变）。"""
    i = waitq.enqueue(waitq.KIND_CARD, 7, 9)
    waitq.claim(i, "worker")                        # 拾取 → starting
    waitq.mark_running(waitq.KIND_CARD, 7)          # 起跑证实 → running（跨轮存活）
    waitq.enqueue(waitq.KIND_CARD, 5, 9, not_before=time.time() + 3600)
    r = _bare()
    assert r.unit_state("c:5", 9) == {"state": "queued", "pos": 2, "total": 2}
    # 前缀行自身按 running 上报（不落 queued 支）
    assert r.unit_state("c:7", 9) == {"state": "running", "pos": 0, "total": 0}


def test_queued_total_counts_rows_only():
    """total/前缀只数行（行是唯一成员面）：行与任何历史镜像都无需按键去重。"""
    i = waitq.enqueue(waitq.KIND_TASK, 1, 9)
    waitq.claim(i, "worker")
    waitq.mark_running(waitq.KIND_TASK, 1)
    waitq.enqueue(waitq.KIND_CARD, 5, 9, not_before=time.time() + 3600)
    r = _bare()
    assert r.unit_state("c:5", 9) == {"state": "queued", "pos": 2, "total": 2}


def test_queued_message_unit_project_from_row():
    """消息单元项目取等待项行（P4 表驱动：行即登记，_msgs 镜像不再是位次数据源）。"""
    waitq.msg_enqueue("abc", 9, "s-1", "hi")
    r = _bare()
    assert r.unit_state("m:abc", 9) == {"state": "queued", "pos": 1, "total": 1}
    assert r.unit_state("m:abc", 10) == {"state": "idle", "pos": 0, "total": 0}


def test_idle_when_not_in_queue():
    """表中无本单元 waiting 行（任务已结束/卡片未入队）→ idle。"""
    r = _bare()
    assert r.unit_state("t:7", 9) == {"state": "idle", "pos": 0, "total": 0}


def test_stale_foreign_key_skipped():
    """他项目的行不串位：本项目位次照常从 1 起（表驱动按 project 过滤）。"""
    waitq.enqueue(waitq.KIND_TASK, 99, 8)
    waitq.enqueue(waitq.KIND_CARD, 5, 9)
    r = _bare()
    assert r.unit_state("c:5", 9) == {"state": "queued", "pos": 1, "total": 1}


def test_stale_own_key_degrades_to_idle():
    """自身行已取消（行消失）：数不到位次 → 按空闲（下轮挑选自会清理）。"""
    waitq.enqueue(waitq.KIND_CARD, 5, 9)
    waitq.cancel(waitq.KIND_CARD, 5, "测试")
    r = _bare()
    assert r.unit_state("c:5", 9) == {"state": "idle", "pos": 0, "total": 0}


def test_bad_key_uid_is_idle():
    """非法键（id 非数字）不抛异常，按空闲返回。"""
    r = _bare()
    assert r.unit_state("c:x", 9) == {"state": "idle", "pos": 0, "total": 0}
