#!/usr/bin/env python3
"""platcompat 跨平台兼容层的 POSIX 分支测试。

Windows 分支（msvcrt/psutil/Job Object）在 Linux 上无法执行，不做假覆盖；
其正确性由 Windows 实机验证清单（doc_ai plan）承担。本文件只锁 POSIX 行为
与改造前逐点等价：flock 互斥、kill(pid,0) 探活、killpg 进程组终止、
start_new_session 独立会话。
"""

import os
import subprocess
import sys

import pytest

import platcompat

pytestmark = pytest.mark.skipif(
    platcompat.IS_WINDOWS, reason="POSIX 分支测试，Windows 上跳过")


def test_lock_fd_roundtrip(tmp_path):
    """加锁→解锁→再加锁单进程可重入；fd 非法（<0/None）静默忽略不抛。"""
    path = tmp_path / "lock"
    fd = os.open(str(path), os.O_CREAT | os.O_RDWR, 0o644)
    try:
        platcompat.lock_fd(fd)
        platcompat.unlock_fd(fd)
        platcompat.lock_fd(fd)   # 解锁后可再次加锁
        platcompat.unlock_fd(fd)
    finally:
        os.close(fd)
    platcompat.lock_fd(-1)       # 非法 fd：安全忽略
    platcompat.unlock_fd(None)


def test_lock_fd_mutual_exclusion(tmp_path):
    """跨进程互斥：本进程持锁期间，另一进程 flock 非阻塞加锁必须失败
    （与改造前 _launch_lock 的 flock 语义一致）。"""
    path = tmp_path / "lock"
    fd = os.open(str(path), os.O_CREAT | os.O_RDWR, 0o644)
    platcompat.lock_fd(fd)
    try:
        code = (
            "import fcntl\n"
            f"fd = open({str(path)!r}, 'r+')\n"
            "try:\n"
            "    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)\n"
            "    print('acquired')\n"
            "except OSError:\n"
            "    print('blocked')\n"
        )
        out = subprocess.run([sys.executable, "-c", code],
                             capture_output=True, text=True, timeout=10)
        assert out.stdout.strip() == "blocked"
    finally:
        platcompat.unlock_fd(fd)
        os.close(fd)


def test_pid_alive():
    """自身存活、瞬时子进程死后不存活、非法 pid 安全返回 False。"""
    assert platcompat.pid_alive(os.getpid())
    assert not platcompat.pid_alive(0)
    assert not platcompat.pid_alive(-1)
    assert not platcompat.pid_alive(None)
    proc = subprocess.Popen(["sleep", "30"])
    try:
        assert platcompat.pid_alive(proc.pid)
    finally:
        proc.kill()
        proc.wait()
    assert not platcompat.pid_alive(proc.pid)


def test_spawn_session_new_session_and_kill_tree():
    """spawn_session 起独立会话的子进程（getsid 与父不同），可被 kill_tree
    整组终止（等价改造前 start_new_session + os.killpg 链路）。"""
    proc = platcompat.spawn_session(["sleep", "30"])
    try:
        assert os.getsid(proc.pid) != os.getsid(0)  # 新会话：sid 与本进程不同
        platcompat.kill_tree(proc.pid)
        proc.wait(timeout=10)
        assert proc.returncode is not None
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_kill_tree_dead_pid_raises():
    """目标进程已死并被收尸后 kill_tree 抛 ProcessLookupError（OSError 子类，
    与既有调用点 os.killpg 的异常面一致，供「杀失败视为未命中」分支承接）。"""
    proc = subprocess.Popen(["sleep", "30"])
    proc.kill()
    proc.wait()
    with pytest.raises(OSError):
        platcompat.kill_tree(proc.pid)
