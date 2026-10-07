# 看板回收站单测：软删除（移入回收站）/ 还原 / 彻底删除（连带评论）/ 清空 /
# 已删卡作父任务被拒（db 用临时库，不触网络/真实数据）
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["TOUCHSTONE_DB"] = tempfile.mktemp(suffix=".db")
import board
import db


def setup_module(module):
    db.init_db()
    db.migrate()


def test_trash_hides_and_restore_returns():
    """移入回收站后看板列表消失、回收站可见（带 trashed_at）；还原后看板重新可见。"""
    cid = db.insert_board_card(9001, "卡甲")
    assert any(c["id"] == cid for c in db.list_board_cards(9001))
    db.trash_board_card(cid)
    assert not any(c["id"] == cid for c in db.list_board_cards(9001))  # 看板屏蔽
    trashed = [c for c in db.list_trashed_cards(9001) if c["id"] == cid]
    assert trashed and trashed[0]["trashed_at"]  # 回收站可见并带删除时间
    assert db.get_board_card(cid)["trashed"] == 1
    assert board.card_json(db.get_board_card(cid))["trashed"] is True  # 前端字段
    db.restore_board_card(cid)
    assert any(c["id"] == cid for c in db.list_board_cards(9001))      # 还原回看板
    row = db.get_board_card(cid)
    assert row["trashed"] == 0 and row["trashed_at"] is None
    assert not any(c["id"] == cid for c in db.list_trashed_cards(9001))


def test_trash_then_restore_keeps_place():
    """还原保留原列原 sort_order（回原位置，不落列尾）。"""
    cid = db.insert_board_card(9005, "卡乙")
    db.update_board_card(cid, column_key="review", sort_order=3)
    db.trash_board_card(cid)
    db.restore_board_card(cid)
    row = db.get_board_card(cid)
    assert row["column_key"] == "review" and row["sort_order"] == 3


def test_purge_board_card_deletes_comments():
    """真删：行与评论一并删除，不可恢复。"""
    cid = db.insert_board_card(9002, "卡丙")
    db.insert_board_comment(cid, "评论一")
    db.purge_board_card(cid)
    assert db.get_board_card(cid) is None
    with db.connect() as conn:
        n = conn.execute("SELECT COUNT(*) FROM board_comments WHERE card_id=?",
                         (cid,)).fetchone()[0]
    assert n == 0  # 评论连带删除


def test_purge_trashed_cards_clears_only_trashed():
    """清空回收站只真删已删卡，正常卡不受影响。"""
    a = db.insert_board_card(9003, "删A")
    b = db.insert_board_card(9003, "删B")
    c = db.insert_board_card(9003, "留C")
    db.trash_board_card(a)
    db.trash_board_card(b)
    db.purge_trashed_cards(9003)
    assert db.get_board_card(a) is None and db.get_board_card(b) is None
    assert db.get_board_card(c) is not None
    assert db.list_trashed_cards(9003) == []


def test_set_parent_rejects_trashed_parent():
    """已进回收站的卡不能作为父任务（防孤儿依赖），还原后可正常设置。"""
    p = db.insert_board_card(9004, "父P")
    ch = db.insert_board_card(9004, "子Ch")
    db.trash_board_card(p)
    assert board.set_parent(9004, ch, p) == "cycle"
    db.restore_board_card(p)
    assert board.set_parent(9004, ch, p) is None
    assert db.get_board_card(ch)["parent_card_id"] == p
