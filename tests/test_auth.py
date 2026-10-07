#!/usr/bin/env python3
"""auth 单测：密码哈希/校验双格式、会话 token、登录限流（2026-09-13 批次）。

纯标准库、零外部依赖：不触网络、不建库。覆盖 auth.py 的对外契约
（PBKDF2 与 MD5 双格式兼容、非字符串入参容错、滑动窗口限流语义）。
"""
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import auth


# ---------- 密码哈希 ----------

def test_md5_password_format_and_vector():
    """md5_password 返回 (32 位 hex, 空串)，且与标准 MD5 向量一致（需求约定算法）。"""
    pw_hash, salt = auth.md5_password("123456")
    assert pw_hash == "e10adc3949ba59abbe56e057f20f883e"
    assert salt == ""
    assert len(pw_hash) == 32


def test_hash_password_pbkdf2_salt_random():
    """hash_password 走 PBKDF2：盐为 16 字节（32 hex），两次调用盐不同（随机盐）。"""
    h1, s1 = auth.hash_password("secret")
    h2, s2 = auth.hash_password("secret")
    assert len(bytes.fromhex(s1)) == 16 and len(s1) == 32
    assert s1 != s2                      # 随机盐
    assert h1 != h2                      # 同密码不同盐 → 哈希不同
    assert len(h1) == 64                 # sha256 → 32 字节 hex


# ---------- 密码校验（双格式兼容） ----------

def test_verify_md5_roundtrip():
    """MD5 存量格式（32 位）校验：正确密码 True、错误密码 False。"""
    pw_hash, salt = auth.md5_password("pass1234")
    assert auth.verify_password("pass1234", pw_hash, salt) is True
    assert auth.verify_password("pass1235", pw_hash, salt) is False


def test_verify_pbkdf2_roundtrip():
    """PBKDF2 格式（非 32 位）校验：正确密码 True、错误密码 False。"""
    pw_hash, salt = auth.hash_password("pass1234")
    assert auth.verify_password("pass1234", pw_hash, salt) is True
    assert auth.verify_password("wrong", pw_hash, salt) is False


def test_verify_password_non_string_returns_false():
    """密码非字符串（JSON null → None、数字）直接判不匹配，不抛异常。"""
    pw_hash, salt = auth.md5_password("pass1234")
    assert auth.verify_password(None, pw_hash, salt) is False
    assert auth.verify_password(12345678, pw_hash, salt) is False


def test_verify_password_bad_salt_does_not_raise():
    """PBKDF2 分支盐非法（非 hex）容错为 False，不抛 ValueError。"""
    assert auth.verify_password("x", "ab" * 32, "not-hex!") is False
    assert auth.verify_password("x", "ab" * 32, "") is False


# ---------- 会话 token ----------

def test_new_token_length_and_randomness():
    """new_token 为 32 字节随机 hex（64 字符），两次不同。"""
    t1, t2 = auth.new_token(), auth.new_token()
    assert len(t1) == 64 and re.fullmatch(r"[0-9a-f]{64}", t1)
    assert t1 != t2


def test_session_expiry_is_future_and_parseable():
    """session_expiry 返回可解析的时间串，且晚于当前约 7 天（TTL 语义）。"""
    s = auth.session_expiry()
    parsed = time.strptime(s, "%Y-%m-%d %H:%M:%S")
    delta = time.mktime(parsed) - time.time()
    assert 6 * 24 * 3600 < delta <= 7 * 24 * 3600 + 5


# ---------- 登录限流 ----------

class _FakeTime:
    """假 time 模块替身：只提供 time()，隔离 auth 的时钟依赖（不动全局 time）。"""

    def __init__(self, now=1000.0):
        self.now = now

    def time(self):
        return self.now


def test_limiter_allows_until_max_then_blocks(monkeypatch):
    """窗口内尝试次数达上限后拒放行（allow=False）。"""
    ft = _FakeTime()
    monkeypatch.setattr(auth, "time", ft)
    lim = auth.LoginLimiter(max_attempts=3, window=60)
    for _ in range(3):
        assert lim.allow("1.2.3.4") is True
        lim.record("1.2.3.4")
    assert lim.allow("1.2.3.4") is False   # 第 4 次超限


def test_limiter_window_slides_out(monkeypatch):
    """旧记录滑出窗口后恢复放行（时间推进 > window）。"""
    ft = _FakeTime()
    monkeypatch.setattr(auth, "time", ft)
    lim = auth.LoginLimiter(max_attempts=1, window=60)
    assert lim.allow("1.2.3.4") is True
    lim.record("1.2.3.4")
    assert lim.allow("1.2.3.4") is False
    ft.now += 61                            # 越过窗口
    assert lim.allow("1.2.3.4") is True


def test_limiter_per_ip_independent(monkeypatch):
    """限流按 IP 独立计数，一个 IP 超限不影响另一个。"""
    ft = _FakeTime()
    monkeypatch.setattr(auth, "time", ft)
    lim = auth.LoginLimiter(max_attempts=1, window=60)
    lim.record("1.1.1.1")
    assert lim.allow("1.1.1.1") is False
    assert lim.allow("2.2.2.2") is True


def test_limiter_record_only_on_check_path(monkeypatch):
    """allow 不产生记录（记录只由调用方在判定后 record）：纯 allow 不改变计数。"""
    ft = _FakeTime()
    monkeypatch.setattr(auth, "time", ft)
    lim = auth.LoginLimiter(max_attempts=1, window=60)
    for _ in range(5):
        assert lim.allow("3.3.3.3") is True  # 未 record，始终放行
