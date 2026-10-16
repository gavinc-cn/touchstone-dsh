# 卡面「最后更新时间」（2026-10-10 批次）：
#   - 时间源 = `board_cards.updated_at`（卡片行最后被改写的时刻：改名/改描述/搬列/
#     排队态变化/平台收尾搬列…；agent 在会话里干活**不**刷它，见 spec/board 相关节）；
#   - 下发形态 = `card_json` 里的 `updated_at_ts`（**毫秒 epoch**，与前端既有
#     `scheduled_at`/`last_error_at` 同口径），由服务器**本地时间**解释换算
#     （`time.mktime(strptime(...))`，与 `db.now_str` 写入口径互逆）——前端拿 epoch
#     算相对时间/按浏览器时区显示，绕开「UTC 串被当本地时间解析差 8 小时」的坑；
#   - 坏值/空值 ⇒ None（前端不渲染），绝不抛异常打穿读板路径。
import os
import sys
import time
import uuid

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import board, db  # noqa: E402

FMT = "%Y-%m-%d %H:%M:%S"


def _mk_project():
    uid = uuid.uuid4().hex[:8]
    return db.insert_project(0, f"cardtime-{uid}", f"/tmp/cardtime-{uid}",
                             "", f"/tmp/cardtime-{uid}/work")


def _mk_card(project_id, title="最后更新时间用例"):
    return db.insert_board_card(project_id, title, "描述")


def _row_ts(card_id):
    """库里 updated_at 的字符串原值。"""
    return db.get_board_card(card_id)["updated_at"]


def test_card_json_carries_ms_epoch():
    """card_json 下发 updated_at_ts=毫秒 epoch，且与 updated_at 同源（同一次换算）。"""
    pid = _mk_project()
    cid = _mk_card(pid)
    raw = _row_ts(cid)
    payload = board.card_json(db.get_board_card(cid))
    assert payload["updated_at"] == raw
    assert isinstance(payload["updated_at_ts"], int)
    expect_s = int(time.mktime(time.strptime(raw, FMT))) * 1000
    assert payload["updated_at_ts"] == expect_s


def test_updated_at_ts_is_server_local_interpretation():
    """时区口径钉子：换算按**服务器本地时间**解释（与 now_str 互逆）。

    用一个会区分两种解释的判据：把 TZ 强制成非 UTC 时区（有 tzset 的平台），
    「本地时间解释」下 `db.now_str()` 换出来的 epoch 必须贴着 `time.time()`；
    若有人把实现改成「按 UTC 解释」，在 TZ=Asia/Shanghai 下会偏 8 小时，本用例红。"""
    if not hasattr(time, "tzset"):
        pytest.skip("该平台无 time.tzset，无法强制时区")
    old = os.environ.get("TZ")
    os.environ["TZ"] = "Asia/Shanghai"
    time.tzset()
    try:
        ts = board.card_ts_ms(db.now_str())
        assert ts is not None
        assert abs(ts / 1000.0 - time.time()) < 5
    finally:
        if old is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = old
        time.tzset()


def test_bad_or_empty_timestamp_degrades_to_none():
    """坏串/空串/None ⇒ None（不抛异常、不返回 0——0 会被前端当 1970 年渲染）。"""
    assert board.card_ts_ms("不是时间") is None
    assert board.card_ts_ms("") is None
    assert board.card_ts_ms(None) is None
    assert board.card_ts_ms("2026-13-45 99:99:99") is None

    pid = _mk_project()
    cid = _mk_card(pid)
    with db.connect() as conn:
        conn.execute("UPDATE board_cards SET updated_at='坏值' WHERE id=?", (cid,))
    assert board.card_json(db.get_board_card(cid))["updated_at_ts"] is None


def test_updated_at_ts_advances_with_card_write():
    """卡片被改写 ⇒ updated_at 与 updated_at_ts 同步前进（卡面时间会跟着动）。"""
    pid = _mk_project()
    cid = _mk_card(pid)
    before = board.card_json(db.get_board_card(cid))["updated_at_ts"]
    time.sleep(1.1)                      # now_str 秒级精度：隔一秒才看得出前进
    db.update_board_card(cid, title="改名了")
    after = board.card_json(db.get_board_card(cid))["updated_at_ts"]
    assert after > before
    assert abs(after / 1000.0 - time.time()) < 5


def test_board_payload_cards_all_carry_field():
    """读板载荷每张卡都带 updated_at_ts（前端无需分支兜底；老库/坏值卡为 None）。"""
    pid = _mk_project()
    cid = _mk_card(pid)
    payload = board.board_payload(pid)
    card = next(c for c in payload["cards"] if c["id"] == cid)
    assert isinstance(card["updated_at_ts"], int)


# ---------- UI 接线守卫（静态扫描，2026-10-10） ----------
# 本功能的失败面很窄但静默：字段名一旦不一致（服务端改名 / 前端拼错），卡面只是
# **不显示小字**，没有异常、没有报错，任何单元测试都发现不了（前端对缺失字段按
# 「不渲染」降级）。故用静态扫描钉住四处接线的字段名与类名一致——纯字符串比对，
# 不依赖浏览器，快层即可跑。
UI_SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "webui", "src")


def _read(*parts):
    with open(os.path.join(UI_SRC, *parts), encoding="utf-8") as f:
        return f.read()


def test_ui_wiring_field_and_class_names():
    """服务端字段 `updated_at_ts` ↔ 前端读取 ↔ 卡面类名 `.board-card-time` 四处对齐。"""
    server_src = open(os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "board.py"),
        encoding="utf-8").read()
    util = _read("utils", "cardTime.js")
    board_jsx = _read("components", "BoardTab.jsx")
    css = _read("styles", "components.css")
    assert '"updated_at_ts"' in server_src          # card_json 下发的键名
    assert "updated_at_ts" in util                  # 前端读的就是这个键名
    assert "cardTimeLabel" in board_jsx and "board-card-time" in board_jsx
    assert ".board-card-time" in css                # 类名有样式定义（否则渲染了也看不出）

