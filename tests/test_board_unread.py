# 卡片「状态有更新·用户还没打开过」标记（2026-10-07 批次）：
#   - 列变化（真变化）⇒ unread=1：平台/agent 自己搬列的路径（收尾→待审核、
#     调和器落阻塞、归档同步→已完成…）缺省 mark_unread=True，集中由
#     db.update_board_card 派生维护；
#   - 用户本人在看板上的操作（拖列/开始/停止/作答送达）显式 mark_unread=False，
#     不给自己发提醒；
#   - 用户打开卡片详情 ⇒ POST .../viewed ⇒ db.mark_card_viewed 清 0（不刷
#     updated_at，防污染「更新新→旧」排序与排队序）；
#   - 非列字段更新（标题/描述/会话绑定）不置位。
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import board, db  # noqa: E402


def _mk_project(agent_path=""):
    """真实项目行（settings_of 读库落默认 serial）；空 agent_path 归 dsh_plugin 族。"""
    uid = uuid.uuid4().hex[:8]
    return db.insert_project(0, f"unread-{uid}", f"/tmp/unread-{uid}",
                             agent_path, f"/tmp/unread-{uid}/work")


def _mk_card(project_id, title="未读标记用例"):
    return db.insert_board_card(project_id, title, "描述")


def _unread(card_id):
    """读库里的 unread 原值（0/1；避免经 card_json 的布尔归一掩盖取值问题）。"""
    return db.get_board_card(card_id)["unread"]


def test_column_change_marks_unread():
    """平台/agent 搬列（缺省 mark_unread=True）⇒ 置位，且 card_json 透传布尔。"""
    pid = _mk_project()
    cid = _mk_card(pid)
    assert _unread(cid) == 0                    # 建卡不置位（新卡不是「状态更新」）
    db.update_board_card(cid, column_key="review")
    assert _unread(cid) == 1
    assert board.card_json(db.get_board_card(cid))["unread"] is True


def test_same_column_write_does_not_mark():
    """同列写回（值没变）不算状态更新——move_card 同列早退、dequeue_start 对已在
    doing/queue 的卡写回 doing 都走这条，不能置位。"""
    pid = _mk_project()
    cid = _mk_card(pid)
    db.update_board_card(cid, column_key="doing", block_kind="queue")
    assert _unread(cid) == 1                    # 首跨列 todo→doing 是真变化
    db.mark_card_viewed(cid)
    assert _unread(cid) == 0
    db.update_board_card(cid, column_key="doing", block_kind=None)   # 同列再写
    assert _unread(cid) == 0


def test_non_column_update_does_not_mark():
    """非列字段（标题/描述/最后错误/会话绑定）更新不置位。"""
    pid = _mk_project()
    cid = _mk_card(pid)
    db.update_board_card(cid, title="改个标题", last_error="x")
    db.update_board_card(cid, sessions="[]", session_id="")
    assert _unread(cid) == 0


def test_mark_unread_false_suppresses():
    """用户本人操作引起的列迁移（mark_unread=False）不置位。"""
    pid = _mk_project()
    cid = _mk_card(pid)
    db.update_board_card(cid, mark_unread=False, column_key="review")
    assert _unread(cid) == 0
    assert board.card_json(db.get_board_card(cid))["unread"] is False


def test_move_card_user_drag_does_not_mark():
    """用户拖列/点按钮走 board.move_card ⇒ 不置位。"""
    pid = _mk_project()
    cid = _mk_card(pid)
    proj = db.get_project(pid)
    card, err = board.move_card(proj, cid, "review")
    assert err is None and card["column"] == "review"
    assert _unread(cid) == 0


def test_finish_to_review_marks_unread():
    """唯一收尾点 finish 的搬列（会话结束→待审核、归档同步→已完成）缺省置位。"""
    pid = _mk_project()
    cid = _mk_card(pid)
    db.update_board_card(cid, mark_unread=False, column_key="doing")
    assert _unread(cid) == 0
    board.finish(f"c:{cid}", "会话结束收尾", to_column="review")
    assert _unread(cid) == 1
    assert db.get_board_card(cid)["column_key"] == "review"


def test_stop_card_does_not_mark():
    """用户「停止」等待区卡（doing/queue → 待审核）走 mark_unread=False。"""
    pid = _mk_project()
    cid = _mk_card(pid)
    db.update_board_card(cid, mark_unread=False, column_key="doing",
                         block_kind="queue")
    assert board.stop_card(cid) is True
    card = db.get_board_card(cid)
    assert card["column_key"] == "review"
    assert _unread(cid) == 0


def test_mark_viewed_clears_and_keeps_updated_at():
    """打开卡片 ⇒ 清标记；updated_at 不动（查看不是内容变更）；重复调用返回 False。"""
    pid = _mk_project()
    cid = _mk_card(pid)
    db.update_board_card(cid, column_key="review")
    before = db.get_board_card(cid)["updated_at"]
    assert db.mark_card_viewed(cid) is True
    after = db.get_board_card(cid)
    assert after["unread"] == 0
    assert after["updated_at"] == before        # 只看不写时间戳
    assert db.mark_card_viewed(cid) is False    # 幂等：本就未读不再回 changed
    assert db.mark_card_viewed(99999999) is False   # 无卡：安全 no-op


def test_recover_web_card_does_not_mark():
    """服务重启恢复把 doing 卡回落 review 是平台重建视图 ⇒ 不置「有更新」标记
    （否则每次重启整列 doing 卡一次性打满标记，本机实测十余张）。"""
    pid = _mk_project()                      # 空 agent_path ⇒ dsh_plugin（web 族）
    cid = _mk_card(pid)
    db.update_board_card(cid, mark_unread=False, column_key="doing")
    proj = db.get_project(pid)
    board._recover_web_card(proj, db.get_board_card(cid))   # 无 sid ⇒ busy=False
    card = db.get_board_card(cid)
    assert card["column_key"] == "review"
    assert card["unread"] == 0


def test_recover_retired_family_does_not_mark():
    """recover() 的退场族回列分支同样不置位（同一「重启重建视图」口径）。"""
    pid = _mk_project(agent_path="/usr/bin/kimi")   # 退场族：走 CLI 防御分支
    cid = _mk_card(pid)
    db.update_board_card(cid, mark_unread=False, column_key="doing")
    board.recover()
    card = db.get_board_card(cid)
    assert card["column_key"] == "review"
    assert card["unread"] == 0


def test_board_payload_carries_unread():
    """读板载荷（前端契约）带 unread 字段：置位卡 True、普通卡 False。"""
    pid = _mk_project()
    c_auto = _mk_card(pid, "自动搬列的卡")
    c_plain = _mk_card(pid, "普通卡")
    db.update_board_card(c_auto, column_key="review")
    payload = board.board_payload(pid)
    by_id = {c["id"]: c for c in payload["cards"]}
    assert by_id[c_auto]["unread"] is True
    assert by_id[c_plain]["unread"] is False


def test_migrate_adds_unread_column(tmp_path):
    """旧库补列：拷一份当前库、删掉 unread 列模拟旧库 → migrate() 补回且存量卡默认 0。

    刻意在**副本**上跑（拷贝当前库结构再 DROP COLUMN），不动 conftest 的套件库：
    迁移失败也只是这一份副本的事，不会把后续用例拖进「列缺失」的坑。
    """
    import sqlite3
    pid = _mk_project()
    cid = _mk_card(pid)
    db.update_board_card(cid, column_key="review")      # 先有一张「已置位」的卡
    legacy = tmp_path / "legacy.db"
    src = db.connect()
    try:
        dst = sqlite3.connect(str(legacy))
        try:
            src.backup(dst)                             # 全量拷贝（结构 + 数据）
            dst.execute("ALTER TABLE board_cards DROP COLUMN unread")
            dst.commit()
        finally:
            dst.close()
    finally:
        src.close()
    old = db.DB_OVERRIDE
    db.DB_OVERRIDE = str(legacy)
    try:
        chk = db.connect()
        try:
            cols = {r["name"] for r in chk.execute("PRAGMA table_info(board_cards)")}
            assert "unread" not in cols                 # 旧库形态成立
        finally:
            chk.close()
        db.migrate()
        chk = db.connect()
        try:
            cols = {r["name"] for r in chk.execute("PRAGMA table_info(board_cards)")}
            assert "unread" in cols                     # 补列成功
            row = chk.execute("SELECT unread FROM board_cards WHERE id=?",
                              (cid,)).fetchone()
            assert row["unread"] == 0                   # 存量卡不补发标记
        finally:
            chk.close()
    finally:
        db.DB_OVERRIDE = old
