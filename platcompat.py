#!/usr/bin/env python3
"""Touchstone 跨平台兼容层：Windows 原生运行支持的集中封装（POSIX 行为逐点等价）。

五类平台差异各收敛为一个入口，业务模块（runner/board/chat/lifecycle/touchstone）
不再出现平台分支：
- spawn_session      拉起独立进程组的后台子进程（压测脚本 / 平台进程）
- kill_tree          按进程组（POSIX）/进程树（Windows）整组终止
- pid_alive          PID 探活（Windows 的 os.kill(pid, 0) 语义是无条件
                     TerminateProcess，会误杀目标进程，必须走 psutil）
- lock_fd/unlock_fd  跨进程互斥文件锁（POSIX flock / Windows msvcrt.locking）
- keep_with_parent   Windows Job Object 等价 PR_SET_PDEATHSIG：父进程退出
                     （含强杀）时内核终止整个作业；POSIX 为 no-op（父死信号
                     由 spawn_session 的 preexec 承担）

P7b（2026-10-03 B4）删族后无调用方的两个入口（**保留**：Windows 兼容层资产，
删掉会让后续再引入托管子进程时又要重写一遍）：
- `keep_with_parent` / `listen_ports`：随 kimi web / opencode serve 托管进程
  退场而暂无调用方（`listen_ports` 原供 ocweb 在 Windows 上做端口归属）。
`spawn_session`（**唯一生产调用点 = 压测发压轮**，runner.py:1758；启停器/server 起子进程
走 subprocess.Popen，不经本层）、`lock_fd`/`pid_alive`/`kill_tree`
（lifecycle/waitq/runner/board）仍有调用方。

psutil 仅在 Windows 分支内懒加载：Linux 运行时无需安装（requirements.txt 中
的声明面向 Windows 部署）。fcntl/msvcrt 同样只在对应分支内导入，保证模块在
两平台上均可安全顶层 import。锁与父死联动失败均静默降级，绝不阻塞主流程；
kill_tree 的异常面与被替换的 os.killpg 一致（ProcessLookupError/
PermissionError 等 OSError 系），由调用方既有 try/except 承接。
"""

import os
import signal
import subprocess
import time

IS_WINDOWS = os.name == "nt"

LOCK_SPIN_TIMEOUT = 10.0   # Windows 文件锁自旋上限（秒），超时降级无锁


def spawn_session(cmd, *, preexec_fn=None, **kw):
    """拉起「独立进程组」的后台子进程（压测脚本 / 平台进程）。

    POSIX：等价 subprocess.Popen(..., start_new_session=True)——子进程为新会话
    （亦即新进程组）的组长，kill_tree(pid) 可整组终止；preexec_fn 仅 POSIX
    生效（父死联动，如 PDEATHSIG），原样透传给 Popen。
    Windows：无进程组语义（start_new_session 被 Popen 静默忽略、preexec_fn
    直接 ValueError），改传 CREATE_NO_WINDOW 隐藏控制台窗口（子进程 stdout
    均已重定向到日志，无窗口需求）；进程树终止由 kill_tree 的 psutil 分支
    承担，父死联动由 keep_with_parent 的 Job Object 承担。
    """
    if IS_WINDOWS:
        kw.pop("start_new_session", None)  # Windows 无此语义，显式丢弃防歧义
        kw["creationflags"] = kw.get("creationflags", 0) | getattr(
            subprocess, "CREATE_NO_WINDOW", 0)
        return subprocess.Popen(cmd, **kw)
    if preexec_fn is not None:
        kw["preexec_fn"] = preexec_fn
    kw["start_new_session"] = True
    return subprocess.Popen(cmd, **kw)


def pid_alive(pid):
    """进程探活。POSIX 用 kill(pid, 0)（仅校验存在性，不投递信号）；Windows
    必须 psutil.pid_exists——os.kill(pid, 0) 在 Windows 上按退出码 0 无条件
    TerminateProcess，会把目标进程杀掉。pid 非法/已死返回 False；
    POSIX EPERM（进程存在但无权发信号）视为存活。"""
    try:
        pid = int(pid or 0)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    try:
        if IS_WINDOWS:
            import psutil
            return psutil.pid_exists(pid)
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def kill_tree(pid, sig=signal.SIGTERM):
    """整组/整树终止子进程。异常面与 os.killpg 一致（ProcessLookupError/
    PermissionError 等 OSError 系），本函数不吞异常，由调用方既有 try/except
    承接（如 stop 路径的「杀失败视为未命中」）。

    POSIX：killpg(getpgid(pid))——调用点的子进程均为 spawn_session 的会话
    首领，getpgid(pid) 即其所在组，与既有 os.killpg(os.getpgid(pid), sig)
    写法逐点等价。
    Windows：psutil 自底向上先杀子孙再杀自身（TerminateProcess，Windows 无
    优雅终止信号可投递）；NoSuchProcess 映射为 ProcessLookupError、
    AccessDenied 映射为 PermissionError，保持与 POSIX 相同的异常类型族。
    """
    pid = int(pid)
    if IS_WINDOWS:
        import psutil
        try:
            root = psutil.Process(pid)
        except psutil.NoSuchProcess:
            raise ProcessLookupError(pid) from None
        try:
            tree = root.children(recursive=True)
        except psutil.NoSuchProcess:
            tree = []
        for p in reversed(tree):  # 先杀子孙：避免父死后子孙重新收养/失控
            try:
                p.kill()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        try:
            root.kill()
        except psutil.NoSuchProcess:
            raise ProcessLookupError(pid) from None
        except psutil.AccessDenied:
            raise PermissionError(pid) from None
        return
    os.killpg(os.getpgid(pid), sig)


def lock_fd(fd, timeout=LOCK_SPIN_TIMEOUT, blocking=True):
    """跨进程排它文件锁（配对 unlock_fd 释放）。

    POSIX：flock(fd, LOCK_EX) 阻塞等待（P7b 前 kimi web 启动锁同语义，不限
    时）。Windows：msvcrt.locking 阻塞模式单次上限 10 秒，改为 LK_NBLCK 自旋
    直至拿锁或超时（锁 0 偏移起 1 字节；字节范围允许超出文件大小，无需写入
    内容，但自旋前后须保持文件偏移一致）。
    fd 非法或加锁失败静默降级为无锁（调用方既有语义：锁异常不阻塞主流程）；
    Windows 自旋超时同样降级——宁可极端并发下多拉一个实例，也不卡死启动。

    `blocking=False`（2026-10-03 新增，lifecycle.SingleInstance 用）：**只试一次**
    立即返回布尔结果，绝不等待——调用方要在「被占用」时给出明确报错退出，
    而不是阻塞在锁上。返回值：True=已持锁，False=被他人占用/拿不到。
    """
    if fd is None or fd < 0:
        return False
    try:
        if IS_WINDOWS:
            import msvcrt
            if not blocking:
                try:
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                    return True
                except OSError:
                    return False
            deadline = time.monotonic() + timeout
            while True:
                try:
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                    return True
                except OSError:
                    if time.monotonic() >= deadline:
                        return False  # 超时降级为无锁
                    time.sleep(0.05)
        import fcntl
        if not blocking:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return True
            except OSError:
                return False
        fcntl.flock(fd, fcntl.LOCK_EX)
        return True
    except OSError:
        return False  # 锁异常：视为无锁继续（不阻塞主流程）


def unlock_fd(fd):
    """释放 lock_fd 的锁；fd 非法/未加锁/重复解锁一律安全忽略。"""
    if fd is None or fd < 0:
        return
    try:
        if IS_WINDOWS:
            import msvcrt
            try:
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
            return
        import fcntl
        fcntl.flock(fd, fcntl.LOCK_UN)
    except OSError:
        pass


def keep_with_parent(proc):
    """（仅 Windows 生效；POSIX 为 no-op——父死信号由 spawn_session 的
    preexec 承担）把子进程加入 KILL_ON_JOB_CLOSE 的 Job Object：本进程（父）
    无论优雅退出还是被强杀，内核关闭 job 句柄时按位终止整个作业（含子进程
    自行拉起的孙进程；未设 BREAKAWAY_OK，孙进程无法脱离作业）——
    PR_SET_PDEATHSIG 的 Windows 等价物。
    job 句柄故意不 CloseHandle：随父进程存活，父亡即内核回收并触发整组终止。
    任意一步失败静默降级：优雅退出路径仍有调用方 shutdown() 兜底。"""
    if not IS_WINDOWS:
        return
    handle = getattr(proc, "_handle", None)
    if not handle:
        return
    try:
        import ctypes
        from ctypes import wintypes

        class _IO_COUNTERS(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in (
                "ReadOperationCount", "WriteOperationCount",
                "OtherOperationCount", "ReadTransferCount",
                "WriteTransferCount", "OtherTransferCount")]

        class _BASIC_LIMIT(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),          # ULONG_PTR
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class _EXT_LIMIT(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", _BASIC_LIMIT),
                ("IoInfo", _IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        k32 = ctypes.windll.kernel32
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
        JobObjectExtendedLimitInformation = 9
        hjob = k32.CreateJobObjectW(None, None)
        if not hjob:
            return
        info = _EXT_LIMIT()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not k32.SetInformationJobObject(
                hjob, JobObjectExtendedLimitInformation,
                ctypes.byref(info), ctypes.sizeof(info)):
            k32.CloseHandle(hjob)
            return
        if not k32.AssignProcessToJobObject(hjob, int(handle)):
            k32.CloseHandle(hjob)
    except Exception:
        pass  # Job Object 不可用（老系统/沙箱等）：降级为仅优雅退出兜底


def listen_ports(pid):
    """（仅 Windows 分支调用）psutil 枚举 pid 持有的 LISTEN 端口集合。
    POSIX 端口归属由调用方的 /proc 实现承担（原 ocweb 的 `_pid_listen_ports`，
    P7b B4 随该驱动退场）。查询失败（权限不足/进程已退出）容错返回空集，
    调用方降级候选窗口扫描。"""
    import psutil
    ports = set()
    try:
        conns = psutil.net_connections(kind="inet")
    except psutil.Error:
        return ports
    for c in conns:
        if c.status == psutil.CONN_LISTEN and c.pid == int(pid) and c.laddr:
            ports.add(c.laddr.port)
    return ports
