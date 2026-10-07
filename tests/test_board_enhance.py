# 看板增强单测：done_at 自动维护 + 列内重排（db 用临时库，不触网络/真实数据）
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["TOUCHSTONE_DB"] = tempfile.mktemp(suffix=".db")
import pytest
import board
import db


def setup_module(module):
    db.init_db()
    db.migrate()


def test_done_at_auto_maintained():
    """column_key 进出 done 时 done_at 自动盖/清；显式给 done_at 不被覆盖。"""
    cid = db.insert_board_card(9001, "卡1")
    assert db.get_board_card(cid)["done_at"] is None
    db.update_board_card(cid, column_key="done")
    t1 = db.get_board_card(cid)["done_at"]
    assert t1  # 进入 done 已盖时间
    db.update_board_card(cid, column_key="review")
    assert db.get_board_card(cid)["done_at"] is None  # 离开 done 已清
    db.update_board_card(cid, column_key="done")
    assert db.get_board_card(cid)["done_at"] >= t1    # 再次进入刷新（字符串时间可比）
    db.update_board_card(cid, column_key="todo", done_at="")
    assert db.get_board_card(cid)["done_at"] == ""    # 显式值优先，不被自动逻辑覆盖


def test_move_card_sort_order_tail():
    """跨列移卡 sort_order = 目标列 MAX+1（manual 列拖入落列尾）。"""
    ids = [db.insert_board_card(9002, t) for t in ("甲", "乙")]
    db.insert_board_card(9002, "丙")
    # 先移乙（todo 序号 2）再移甲（todo 序号 1）：old 保留旧序号时 review 内序
    # 仍是 [甲(1), 乙(2)]，与拖入先后相反 → 断言失败（RED 判定点）
    proj = {"id": 9002, "project_dir": "", "agent_path": "kimi", "archived": 0}
    board.move_card(proj, ids[1], "review")
    board.move_card(proj, ids[0], "review")
    got = sorted((db.get_board_card(i) for i in ids), key=lambda r: r["sort_order"])
    assert [r["id"] for r in got] == [ids[1], ids[0]] and got[0]["sort_order"] == 1


def _row(cid):
    return {"id": cid}


def test_reorder_plan_move_before():
    cards = [_row(1), _row(2), _row(3)]
    assert board.reorder_plan(cards, 3, 1) == [(3, 1), (1, 2), (2, 3)]


def test_reorder_plan_move_to_tail():
    cards = [_row(1), _row(2), _row(3)]
    assert board.reorder_plan(cards, 1, None) == [(2, 1), (3, 2), (1, 3)]


def test_reorder_plan_bad_targets():
    with pytest.raises(ValueError):
        board.reorder_plan([_row(1)], 9, None)   # 卡不在列内
    with pytest.raises(ValueError):
        board.reorder_plan([_row(1)], 1, 9)      # before 卡不在列内


def test_reorder_card_resorts_column():
    """db 级：manual 模式列拖排生效（settings 缺省即 manual）；非法列内序不变。"""
    ids = [db.insert_board_card(9003, t) for t in ("一", "二", "三")]
    assert board.reorder_card(9003, ids[2], ids[0]) is None
    got = sorted((db.get_board_card(i) for i in ids), key=lambda r: r["sort_order"])
    assert [r["id"] for r in got] == [ids[2], ids[0], ids[1]]


# ---------- 跨列移动插入指定位置（move_into_plan + move_card before_id） ----------


def test_move_into_plan_mid():
    """跨列插入纯函数：把卡插到 before_id 之前（其余卡相对顺序不变）。"""
    cards = [_row(1), _row(2), _row(3)]
    assert board.move_into_plan(cards, 9, 2) == [(1, 1), (9, 2), (2, 3), (3, 4)]


def test_move_into_plan_tail():
    """before_id=None → 列尾。"""
    cards = [_row(1), _row(2), _row(3)]
    assert board.move_into_plan(cards, 9, None) == [(1, 1), (2, 2), (3, 3), (9, 4)]


def test_move_into_plan_bad_before():
    """before_id 不在列内抛 ValueError（调用方转 400）。"""
    with pytest.raises(ValueError):
        board.move_into_plan([_row(1)], 9, 7)


def test_move_card_before_inserts_mid_manual():
    """manual 列跨列移卡带 before_id：整列重写 sort_order 插到 before 前。"""
    ids = [db.insert_board_card(9101, t) for t in ("甲", "乙", "丙")]
    proj = {"id": 9101, "project_dir": "", "agent_path": "kimi", "archived": 0}
    board.move_card(proj, ids[1], "review")               # 乙先移入 review（落尾）
    board.move_card(proj, ids[0], "review", before_id=ids[1])  # 甲插入乙之前
    rev = [r["id"] for r in db.list_board_cards(9101) if r["column_key"] == "review"]
    assert rev == [ids[0], ids[1]]                        # 甲在乙前（插入生效）
    assert db.get_board_card(ids[2])["column_key"] == "todo"  # 未动卡仍在 todo


def test_move_card_before_bad_target():
    """manual 目标列 + before_id 不在该列 → 400（列不变），不误插他列卡位置。"""
    ids = [db.insert_board_card(9102, t) for t in ("甲", "乙", "丙")]
    proj = {"id": 9102, "project_dir": "", "agent_path": "kimi", "archived": 0}
    board.move_card(proj, ids[0], "review")               # 甲移入 review（乙丙仍 todo）
    card_dict, err = board.move_card(proj, ids[1], "review", before_id=ids[2])
    assert err == {"error": "目标位置卡不在该列"}
    assert card_dict is None and db.get_board_card(ids[1])["column_key"] == "todo"


def test_move_card_before_ignored_on_nonmanual():
    """非 manual 目标列忽略 before_id（落列尾，显示由排序方案决定）。"""
    ids = [db.insert_board_card(9103, t) for t in ("甲", "乙")]
    db.set_board_settings(9103, {"sort": {"review": "created_desc"}})
    proj = {"id": 9103, "project_dir": "", "agent_path": "kimi", "archived": 0}
    board.move_card(proj, ids[1], "review")               # 乙落尾（MAX+1）
    board.move_card(proj, ids[0], "review", before_id=ids[1])  # 非 manual：仍落尾
    rev = [r["id"] for r in db.list_board_cards(9103) if r["column_key"] == "review"]
    assert rev == [ids[1], ids[0]]                        # 乙在前（甲被忽略插到列尾）


def test_board_counts_many():
    """board_counts_many 按项目统计 doing/blocked/review 三列卡片数（回收站外）。"""
    pids = (9111, 9112)
    c1 = db.insert_board_card(9111, "甲")
    c2 = db.insert_board_card(9111, "乙")
    c3 = db.insert_board_card(9112, "丙")
    db.update_board_card(c1, column_key="doing")
    db.update_board_card(c2, column_key="blocked")
    db.update_board_card(c3, column_key="review")
    got = db.board_counts_many(pids)
    assert got[9111] == {"doing": 1, "blocked": 1, "review": 0}
    assert got[9112] == {"doing": 0, "blocked": 0, "review": 1}
    # 回收站卡片不计入；空列表返回空字典
    db.trash_board_card(c2)
    assert db.board_counts_many(pids)[9111]["blocked"] == 0
    assert db.board_counts_many([]) == {}


# ---------- 并行模式两档（2026-09-17 删只读并行档） ----------


def test_settings_of_normalizes_removed_mode():
    """模式读取层归一：已删档的 readonly-parallel 与任何未知值恒按 serial 处理
    （存量行无需迁移脚本），parallel 原样保留；合法值仅两档。"""
    assert board.MODE_VALUES == ("serial", "parallel")
    db.set_board_settings(9299, {"mode": "readonly-parallel"})
    assert board.settings_of(9299)["mode"] == "serial"    # 存量过渡档归一
    db.set_board_settings(9299, {"mode": "bogus"})
    assert board.settings_of(9299)["mode"] == "serial"    # 未知值同款兜底
    db.set_board_settings(9299, {"mode": "parallel"})
    assert board.settings_of(9299)["mode"] == "parallel"  # 合法档原样
