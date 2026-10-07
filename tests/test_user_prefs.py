# 用户 UI 偏好（user_prefs 表）：读写 roundtrip、UPSERT 覆盖、用户/项目维度隔离
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db

db.init_db()  # 幂等建表（conftest 已把 TOUCHSTONE_DB 指到临时库）


def test_user_prefs_roundtrip_and_upsert():
    db.set_user_pref(1, 5, "tabs", {"order": ["board", "tasks"], "hidden": []})
    assert db.get_user_prefs(1, 5) == {"tabs": {"order": ["board", "tasks"],
                                                "hidden": []}}
    # 同键再次写入 = 整对象覆盖
    db.set_user_pref(1, 5, "tabs", {"order": ["tasks", "board"], "hidden": ["bugs"]})
    assert db.get_user_prefs(1, 5)["tabs"] == {"order": ["tasks", "board"],
                                               "hidden": ["bugs"]}


def test_user_prefs_isolation():
    db.set_user_pref(1, 5, "tabs", {"hidden": ["bugs"]})
    db.set_user_pref(2, 5, "tabs", {"hidden": ["monitor"]})   # 不同用户
    db.set_user_pref(1, 6, "tabs", {"hidden": ["stress"]})    # 不同项目
    assert db.get_user_prefs(1, 5)["tabs"] == {"hidden": ["bugs"]}
    assert db.get_user_prefs(2, 5)["tabs"] == {"hidden": ["monitor"]}
    assert db.get_user_prefs(1, 6)["tabs"] == {"hidden": ["stress"]}
    assert db.get_user_prefs(3, 5) == {}                      # 无记录返回空


def test_user_prefs_bad_json_skipped(monkeypatch):
    db.set_user_pref(1, 7, "good", {"a": 1})
    with db.connect() as conn:
        conn.execute("INSERT OR REPLACE INTO user_prefs"
                     "(user_id, project_id, key, value, updated_at)"
                     " VALUES(1, 7, 'bad', '{not-json', 'now')")
    prefs = db.get_user_prefs(1, 7)
    assert prefs == {"good": {"a": 1}}   # 坏 JSON 键降级跳过，不炸接口
