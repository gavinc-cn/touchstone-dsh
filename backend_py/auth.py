#!/usr/bin/env python3
"""Touchstone 认证：PBKDF2 密码哈希、session 签发与校验、登录限流。

纯标准库。db 层会话表由 server.py 组装调用（本模块不依赖 db.py）。
"""

import hashlib
import hmac
import os
import secrets
import threading
import time

PBKDF2_ITER = 100_000
SESSION_TTL = 7 * 24 * 3600  # 7 天
COOKIE_NAME = "ts_session"


def hash_password(password):
    """返回 (哈希 hex, 盐 hex)。PBKDF2-HMAC-SHA256，10 万轮，16 字节随机盐。

    仅用于种子 admin 等存量账号；新写入的密码统一用 md5_password（见下）。
    """
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITER)
    return digest.hex(), salt.hex()


def md5_password(password):
    """返回 (MD5 hex, 盐空串)。

    按需求约定：注册用户/后台重置/修改密码统一用 MD5 存储（无盐）。仅 32 位 hex。
    """
    return hashlib.md5(password.encode("utf-8")).hexdigest(), ""


def verify_password(password, pass_hash, salt_hex):
    """常量时间比对，防时序侧信道。

    兼容两种存量格式：长度为 32 的 hex 按 MD5 验证（新注册/重置的密码），
    否则按 PBKDF2（种子 admin 等旧账号）。
    密码非字符串（如 JSON null）直接判不匹配，不抛异常。
    """
    if not isinstance(password, str):
        return False
    if len(pass_hash) == 32:
        return hmac.compare_digest(md5_password(password)[0], pass_hash)
    try:
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                                     bytes.fromhex(salt_hex), PBKDF2_ITER)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(digest.hex(), pass_hash)


def new_token():
    """新会话 token（32 字节随机 hex）。"""
    return secrets.token_hex(32)


def session_expiry():
    """会话过期时间字符串（now + 7 天）。"""
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time() + SESSION_TTL))


class LoginLimiter:
    """每 IP 每分钟最多 10 次登录尝试的滑动窗口限流（内存态即可）。"""

    def __init__(self, max_attempts=10, window=60):
        self.max_attempts = max_attempts
        self.window = window
        self._lock = threading.Lock()
        self._records = {}  # ip -> [尝试时间戳]

    def allow(self, ip):
        """返回 True 表示本次尝试放行（尝试计数在 check 后须调用 record）。"""
        now = time.time()
        with self._lock:
            records = [t for t in self._records.get(ip, []) if now - t < self.window]
            self._records[ip] = records
            return len(records) < self.max_attempts

    def record(self, ip):
        with self._lock:
            self._records.setdefault(ip, []).append(time.time())

