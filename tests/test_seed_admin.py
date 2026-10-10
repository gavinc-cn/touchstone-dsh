"""db 种子返回值 / TS_ADMIN_PASSWORD 覆盖 / 首启横幅提示 / 强制改密标记 单测。

背景：早期启动横幅无条件打印「admin / 123456」；2026-09-27 整改为仅在种子发生的那一次
提示并支持 TS_ADMIN_PASSWORD 自定义初始口令；2026-10-02 起未设该变量时不再回落固定
口令，改为随机生成 16 位一次性初始口令（必须首次登录改密），随机口令只在横幅打印一次。
2026-10-08 增：插件形态（薄壳下发 `TS_ADMIN_PASSWORDLESS=1`）种子为空口令 admin、
不强制改密——面板本来就是免登 admin，口令只用于独立形态/直连登录。
conftest 已置套件级临时库并建表，但 admin 在套件级 init_db 时已被种子——
各用例先清空 users 复原「空库」前提（users 无外键引用，直接 DELETE 即可）。
"""
import pytest

import auth
import db
from server import _seed_hint


@pytest.fixture(autouse=True)
def _no_passwordless_leak(monkeypatch):
    """默认清掉插件形态开关：只有显式设置它的用例才走空口令分支。"""
    monkeypatch.delenv("TS_ADMIN_PASSWORDLESS", raising=False)


def _wipe_users():
    """清空 users 表，复原 seed_admin 的「无任何用户」前提。"""
    with db.connect() as conn:
        conn.execute("DELETE FROM users")


def _insert_user(name, password):
    """直接插一行用户（绕过 HTTP 注册口），供「已有用户」分支用。"""
    pw_hash, salt = auth.md5_password(password)
    with db.connect() as conn:
        conn.execute("INSERT INTO users(username, pass_hash, salt, created_at)"
                     " VALUES(?,?,?,?)", (name, pw_hash, salt, db.now_str()))


def test_seed_admin_random_pw_once_and_must_change(monkeypatch):
    """空库 + 未设 TS_ADMIN_PASSWORD：随机一次性口令，标记强制改密，取走即清。"""
    monkeypatch.delenv("TS_ADMIN_PASSWORD", raising=False)
    _wipe_users()
    db.take_seed_password()          # 清掉可能残留的上一次取值，保证断言从零开始
    assert db.seed_admin() is True
    row = db.get_user_by_name("admin")
    assert row is not None
    pw = db.take_seed_password()
    assert len(pw) >= 12, "一次性口令应为随机长串"
    assert pw != "123456", "不得再回落固定默认口令"
    assert auth.verify_password(pw, row["pass_hash"], row["salt"])
    assert row["must_change_pw"] == 1
    assert db.take_seed_password() == "", "口令读后即清，不可二次打印"


def test_seed_admin_skips_when_any_user_exists(monkeypatch):
    """已有任意用户：不再种子，返回 False，且不产生 admin。"""
    monkeypatch.delenv("TS_ADMIN_PASSWORD", raising=False)
    _wipe_users()
    _insert_user("alice", "alice-pass")
    assert db.seed_admin() is False
    assert db.get_user_by_name("admin") is None


def test_seed_admin_env_password_overrides_default(monkeypatch):
    """TS_ADMIN_PASSWORD 非空：初始口令用环境值，且不置强制改密标记。"""
    _wipe_users()
    monkeypatch.setenv("TS_ADMIN_PASSWORD", "env-secret-9")
    assert db.seed_admin() is True
    row = db.get_user_by_name("admin")
    assert auth.verify_password("env-secret-9", row["pass_hash"], row["salt"])
    assert not auth.verify_password("123456", row["pass_hash"], row["salt"])
    assert row["must_change_pw"] == 0, "部署方自定义口令视为有意设定，不强制改密"
    assert db.take_seed_password() == ""


def test_change_password_clears_must_change_flag(monkeypatch):
    """改密成功后清 must_change_pw（服务端拦截门据此放行其余端点）。"""
    monkeypatch.delenv("TS_ADMIN_PASSWORD", raising=False)
    _wipe_users()
    db.seed_admin()
    uid = db.get_user_by_name("admin")["id"]
    assert db.get_user_by_id(uid)["must_change_pw"] == 1
    pw_hash, salt = auth.md5_password("new-pw-123456")
    db.change_password(uid, pw_hash, salt)
    row = db.get_user_by_id(uid)
    assert row["must_change_pw"] == 0
    assert auth.verify_password("new-pw-123456", row["pass_hash"], row["salt"])


def test_seed_hint_only_on_fresh_seed():
    """横幅提示仅种子发生时出现；日常启动为空串（口令字样不落日志）。"""
    assert _seed_hint(False) == ""
    hint = _seed_hint(True, "one-time-pw-9")
    assert "one-time-pw-9" in hint and "首次登录" in hint


def test_seed_hint_env_password_not_echoed(monkeypatch):
    """环境变量覆盖时，提示指向变量名而不回显口令值本身。"""
    monkeypatch.setenv("TS_ADMIN_PASSWORD", "env-secret-9")
    hint = _seed_hint(True)
    assert "TS_ADMIN_PASSWORD" in hint
    assert "env-secret-9" not in hint
    assert "123456" not in hint


def test_seed_hint_no_pw_after_taken(monkeypatch):
    """随机口令已被取走（如重启后再次调用）：横幅不再重复任何口令明文。"""
    monkeypatch.delenv("TS_ADMIN_PASSWORD", raising=False)
    hint = _seed_hint(True)
    assert "口令" in hint
    for token in ("123456", "token_urlsafe"):
        assert token not in hint


# ---------- 插件形态空口令种子（2026-10-08） ----------

def test_seed_admin_passwordless_in_plugin_mode(monkeypatch):
    """`TS_ADMIN_PASSWORDLESS=1`（插件形态）：空口令 admin、不强制改密、不进横幅。

    用户口径：插件形态默认 admin + 空密码，用户设置了密码就按设置的来。
    空口令 = 「没设置密码」，面板免登进来就能用；独立形态/直连登录时空密码即可进。
    """
    monkeypatch.delenv("TS_ADMIN_PASSWORD", raising=False)
    monkeypatch.setenv("TS_ADMIN_PASSWORDLESS", "1")
    _wipe_users()
    db.take_seed_password()
    assert db.seed_admin() is True
    row = db.get_user_by_name("admin")
    assert row["must_change_pw"] == 0, "空口令不该触发强制改密门"
    assert auth.verify_password("", row["pass_hash"], row["salt"]) is True
    assert auth.verify_password("123456", row["pass_hash"], row["salt"]) is False
    assert db.take_seed_password() == "", "空口令没有可打印的一次性口令"


def test_seed_admin_env_password_beats_passwordless(monkeypatch):
    """显式 `TS_ADMIN_PASSWORD` 优先于插件形态开关（部署方有意设定的口令不被覆盖）。"""
    _wipe_users()
    monkeypatch.setenv("TS_ADMIN_PASSWORD", "env-secret-9")
    monkeypatch.setenv("TS_ADMIN_PASSWORDLESS", "1")
    assert db.seed_admin() is True
    row = db.get_user_by_name("admin")
    assert auth.verify_password("env-secret-9", row["pass_hash"], row["salt"])
    assert auth.verify_password("", row["pass_hash"], row["salt"]) is False
    assert row["must_change_pw"] == 0


def test_seed_admin_default_random_when_no_switch(monkeypatch):
    """两个开关都没有 → 保持现状（随机一次性口令 + 强制首登改密）。"""
    monkeypatch.delenv("TS_ADMIN_PASSWORD", raising=False)
    _wipe_users()
    db.take_seed_password()
    assert db.seed_admin() is True
    row = db.get_user_by_name("admin")
    assert row["must_change_pw"] == 1
    assert auth.verify_password(db.take_seed_password(), row["pass_hash"], row["salt"])
