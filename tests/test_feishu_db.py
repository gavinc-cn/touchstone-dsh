# app_settings / feishu_hooks / feishu_outbox 读写（conftest 已隔离 TOUCHSTONE_DB）
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db

db.init_db()  # 测试库建表（幂等；conftest 已把 TOUCHSTONE_DB 指到临时库）


def test_app_setting_roundtrip_and_degrade():
    assert db.get_app_setting("feishu") == {}
    db.set_app_setting("feishu", {"enabled": True, "base_url": "http://x"})
    assert db.get_app_setting("feishu")["base_url"] == "http://x"
    db.set_app_setting("feishu", {"enabled": False})          # UPSERT 覆盖
    assert db.get_app_setting("feishu") == {"enabled": False}


def test_feishu_hook_upsert():
    assert db.get_feishu_hook(101) is None
    db.set_feishu_hook(101, "https://h/1", "s1",
                       "blocked_interaction,task_failed", 1)
    row = db.get_feishu_hook(101)
    assert row["webhook_url"] == "https://h/1" and row["enabled"] == 1
    db.set_feishu_hook(101, "", "", "", 0)                    # 再写覆盖
    assert db.get_feishu_hook(101)["enabled"] == 0


def test_outbox_dedup_and_due():
    oid = db.feishu_outbox_push("https://t", "s", '{"x":1}', "k:1")
    assert oid is not None
    # 同 dedup_key 存在 pending 行：不重复入队
    assert db.feishu_outbox_push("https://t", "s", '{"x":2}', "k:1") is None
    due = db.feishu_outbox_due(time.time())
    assert [r["id"] for r in due] == [oid]
    db.feishu_outbox_mark(oid, "failed", 4, 0, "boom")
    assert db.feishu_outbox_due(time.time()) == []
    assert db.feishu_outbox_recent(10)[0]["status"] == "failed"
    assert db.feishu_outbox_recent(10)[0]["last_error"] == "boom"


def test_feishu_user_cfg_roundtrip():
    assert db.get_feishu_user_cfg(999) == {}
    db.set_feishu_user_cfg(999, {"enabled": True, "default_webhook": "https://u",
                                 "app_id": "cli_x", "app_secret": "s"})
    cfg = db.get_feishu_user_cfg(999)
    assert cfg["default_webhook"] == "https://u" and cfg["app_id"] == "cli_x"
    db.set_feishu_user_cfg(999, {"enabled": False})          # UPSERT 覆盖
    assert db.get_feishu_user_cfg(999) == {"enabled": False}
    assert db.list_feishu_user_cfgs() == [(999, {"enabled": False})]


def test_outbox_user_scope():
    a = db.feishu_outbox_push("https://a", "", "{}", "k:u1", user_id=1)
    b = db.feishu_outbox_push("https://b", "", "{}", "k:u2", user_id=2)
    assert {r["id"] for r in db.feishu_outbox_recent(50, user_id=1)} == {a}
    assert {r["id"] for r in db.feishu_outbox_recent(50, user_id=2)} == {b}
    assert {r["id"] for r in db.feishu_outbox_recent(50)} >= {a, b}  # 不过滤=全量
    db.feishu_outbox_mark(a, "sent", 0, 0)                   # 清掉 pending，防污染后续 due 用例
    db.feishu_outbox_mark(b, "sent", 0, 0)


def test_legacy_global_cfg_migrates_to_admin():
    """旧全局 app_settings['feishu'] 迁移给 admin 自己的用户配置（已有私户配置不覆盖）。"""
    db.set_app_setting("feishu", {"enabled": True, "app_id": "cli_old",
                                  "app_secret": "sec", "default_webhook": "https://old"})
    db.migrate()
    admin = db.get_user_by_name("admin")
    cfg = db.get_feishu_user_cfg(admin["id"])
    assert cfg.get("app_id") == "cli_old"
    db.set_app_setting("feishu", {"enabled": True, "app_id": "cli_new",
                                  "default_webhook": "https://new"})
    db.migrate()
    assert db.get_feishu_user_cfg(admin["id"]).get("app_id") == "cli_old"  # 幂等不覆盖
