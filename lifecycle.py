#!/usr/bin/env python3
"""宿主生命周期治理（路线 A P2，2026-10-03）。

背景（方案 `doc_ai/plan/202610/20261003_0657_….md` §四）：dsh 插件形态下
Python 后端是 dsh 宿主进程 spawn 的子进程。宿主退出/崩溃/被 `kill -9` 时，
后端**必须自己退出**——否则会成为孤儿：继续跑任务线程、继续写同一个 SQLite，
新实例再起就是双进程双写同库（任务重复执行、队列行被抢）。

本模块提供三件事，全部纯标准库：

1. **父死感知** `arm_parent_watch(on_exit)`
   - 机制 A（跨平台）：**stdin 管道 EOF**。插件 spawn 时把 `stdio[0]` 设成
     `'pipe'` 且永不写入；父进程无论怎样死亡（含 `kill -9`），OS 都会关闭写端
     ⇒ 本进程 `os.read(0, …)` 收到 `b''`。真机实测：node 父被 kill -9 后
     **1.94s** 退出。
   - 机制 B（Linux 加固）：启动时自设 `PR_SET_PDEATHSIG=SIGTERM`（内核级，
     管道异常时的第二道），设完复核 `getppid()!=1`（父在设置前就死的竞态）。
     真机实测：**1.80s** 收到信号。
   - **误报防护**：EOF/信号后复核父进程是否真死（`pid_alive(getppid())`）——
     父还活着（例如 stdin 不是管道、或管道被无关方关闭）只记日志不自杀。

2. **同库单实例** `SingleInstance`
   - `<db>.lock` 排它锁（`platcompat.lock_fd`）+ `<db>.pid` 记录
     `{pid, ppid, repo_dir, parent_watch, started_at}`。
   - 锁被占时：读 pid 记录——若记录进程**由父死感知托管**（`parent_watch=true`）
     且其父已死 ⇒ 判定为**存量孤儿**（升级前的强杀残留），SIGTERM 后重试拿锁；
     否则视为真·另一实例，明确报错退出（防双写同库）。
   - 安全阀：`allow_shared=True`（`--allow-shared-db`）显式关闭该闸。

3. **子进程树清理** `kill_children(pids, grace)`
   - 退出前把本进程拉起的子进程（压测 loadgen / `verify.py` / agent CLI）整组
     终止，避免「父退子留」。

设计口径：**默认全部不启用**（独立启动/测试夹具行为不变）；由插件 spawn 时
显式传 `--parent-watch`，单实例锁则对所有启动方式生效（同库互斥本就是项目约定，
`--allow-shared-db` 为逃生口）。
"""

import json
import os
import signal
import sys
import threading
import time

import platcompat

# 父死感知等待读 stdin 的分片大小（EOF 判定与内容无关，读到 0 字节即 EOF）
STDIN_CHUNK = 4096
# 存量孤儿 SIGTERM 后等待其让出锁的上限（秒）
STALE_WAIT = 5.0
# 子进程树清理：SIGTERM 后升级 SIGKILL 的宽限（秒）
KILL_GRACE = 1.5

_PDEATHSIG_ARMED = False


def _term_pid(pid, sig=signal.SIGTERM):
    """只终止**单个 pid**（不做进程组/树）：用于收口存量孤儿——见 `_reap_stale` 注释。

    POSIX：`os.kill`；Windows：无优雅信号，psutil 走 TerminateProcess。
    异常一律吞（收口失败由调用方的等待循环兜底）。
    """
    try:
        if os.name == "nt":
            import psutil
            psutil.Process(int(pid)).terminate()
        else:
            os.kill(int(pid), sig)
    except Exception:                            # noqa: BLE001
        pass


def _safe_kill_tree(pid, sig=signal.SIGTERM):
    """终止进程树，但**目标与我们同进程组时降级为单进程终止**（防自杀）。

    `platcompat.kill_tree` 在 POSIX 走 `killpg`；若目标进程与我们同组（父进程没
    给子进程 setsid 的情形），整组终止会连带杀掉本进程——实测在单测里踩中。
    自己的子进程都经 `spawn_session` 独立成组，正常路径不受影响。
    """
    try:
        if os.name != "nt" and os.getpgid(int(pid)) == os.getpgid(0):
            _term_pid(pid, sig)
            return
    except OSError:
        return
    try:
        platcompat.kill_tree(int(pid), sig)
    except OSError:
        pass


def parent_alive(ppid=None):
    """父进程是否仍存活（ppid 缺省取 `os.getppid()`）。

    POSIX 上孤儿会被 init 收养（ppid=1）；Windows 不收养，ppid 仍指向已死进程，
    故统一用 `platcompat.pid_alive` 判活，ppid<=1 直接视为父已死。
    """
    try:
        ppid = int(os.getppid() if ppid is None else ppid)
    except (TypeError, ValueError):
        return False
    if ppid <= 1:
        return False
    return platcompat.pid_alive(ppid)


def arm_pdeathsig(sig=signal.SIGTERM):
    """Linux：自设 PR_SET_PDEATHSIG（父进程死亡时内核投递信号）。

    返回状态串：`armed` / `skipped`（非 Linux）/ `failed: 原因`。
    设完复核 `getppid()==1`——父恰好在设置前死亡时信号不会补发，此时返回
    `parent-gone` 交调用方立即退出。

    注意：值在 fork 出的子进程里会被清空、跨 execve 保留，故必须在**本进程**
    启动早期设置，且此后不得再 fork（本进程只 spawn 子进程，不影响自身设置）。
    """
    global _PDEATHSIG_ARMED
    if not sys.platform.startswith("linux"):
        return "skipped"
    try:
        import ctypes
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        PR_SET_PDEATHSIG = 1
        if libc.prctl(PR_SET_PDEATHSIG, int(sig), 0, 0, 0) != 0:
            return f"failed: prctl errno={ctypes.get_errno()}"
    except Exception as e:                       # noqa: BLE001 —— 加固机制失败不致命
        return f"failed: {e}"
    _PDEATHSIG_ARMED = True
    if os.getppid() <= 1:
        return "parent-gone"                     # 设置前父已死：信号不会来，立即退出
    return "armed"


def arm_parent_watch(on_exit, logger=None, pdeathsig=True):
    """启用父死感知（stdin EOF + Linux PDEATHSIG）。返回状态 dict（可断言/记日志）。

    `on_exit()`：确认父已死时调用（应尽快退出；调用方负责优雅收尾）。
    `logger(msg)`：日志函数（缺省 print 到 stderr）。
    仅应在 `--parent-watch`（插件形态）下调用：独立启动时 stdin 可能是
    /dev/null（立即 EOF），虽然会被「父存活复核」挡住不自杀，但没必要起线程。

    线程为 daemon：主进程正常退出时不会阻塞。
    """
    log = logger or (lambda m: print(m, file=sys.stderr, flush=True))
    state = {"armed": True, "pdeathsig": "skipped", "stdin_watch": True,
             "spurious_eof": False, "trigger": ""}

    def _fire(trigger):
        if state["trigger"]:
            return                               # 只触发一次
        state["trigger"] = trigger
        log(f"[lifecycle] 父进程已消失（{trigger}），后端退出")
        try:
            on_exit()
        except SystemExit:
            raise
        except Exception as e:                   # noqa: BLE001 —— 退出路径不抛
            log(f"[lifecycle] 退出回调异常: {e}")

    if pdeathsig:
        st = arm_pdeathsig()
        state["pdeathsig"] = st
        if st == "parent-gone":
            _fire("pdeathsig-parent-gone")
            return state
        # PDEATHSIG 的处理器：收到信号即父死（内核投递），直接走退出路径
        def _on_sig(signum, frame):
            _fire(f"pdeathsig-signal-{signum}")
        try:
            signal.signal(signal.SIGTERM, _on_sig)
        except (ValueError, OSError) as e:       # 非主线程调用方自行处理
            log(f"[lifecycle] PDEATHSIG 处理器注册失败: {e}")

    def _watch_stdin():
        """读 stdin：0 字节（EOF）或读异常 ⇒ 父死写端已关。"""
        try:
            while True:
                try:
                    chunk = os.read(0, STDIN_CHUNK)
                except (OSError, ValueError):
                    chunk = b""
                if not chunk:
                    break
                # 父进程若真写入了内容（本机制不使用该通道），丢弃即可
        except Exception:                        # noqa: BLE001
            pass
        if not parent_alive():
            _fire("stdin-eof")
        else:
            # 管道被无关方关闭（stdin 不是管道/被外部关）：只记一次，不自杀；
            # 线程到此结束（否则会空转在 EOF 上）
            state["spurious_eof"] = True
            log("[lifecycle] stdin EOF 但父进程仍存活：判定为误报，继续运行")

    t = threading.Thread(target=_watch_stdin, name="parent-watch-stdin", daemon=True)
    t.start()
    return state


# --------------------------------------------------------------------------
# 同库单实例
# --------------------------------------------------------------------------

class SingleInstance:
    """`<db>.lock` 排它锁 + `<db>.pid` 归属记录（防同库双实例双写）。

    用法：
        inst = SingleInstance(db.db_path(), repo_dir=..., parent_watch=True)
        if not inst.acquire():
            print(inst.reason, file=sys.stderr); sys.exit(3)
        ... 运行期持有 inst；退出时 inst.release()（进程退出也会自动释放 flock）
    """

    def __init__(self, db_file, repo_dir="", parent_watch=False,
                 allow_shared=False, logger=None, stale_wait=STALE_WAIT):
        self.db_file = os.path.abspath(db_file)
        self.lock_path = self.db_file + ".lock"
        self.pid_path = self.db_file + ".pid"
        self.repo_dir = repo_dir
        self.parent_watch = bool(parent_watch)
        self.allow_shared = bool(allow_shared)
        self.stale_wait = stale_wait
        self.log = logger or (lambda m: print(m, file=sys.stderr, flush=True))
        self.reason = ""
        self.reaped_pid = 0
        self._fd = None

    # ---------- 记录读写 ----------

    def _read_record(self):
        try:
            with open(self.pid_path, encoding="utf-8") as f:
                rec = json.load(f)
            return rec if isinstance(rec, dict) else None
        except (OSError, ValueError):
            return None

    def _write_record(self, pid):
        tmp = self.pid_path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"pid": pid, "ppid": os.getppid(),
                           "repo_dir": self.repo_dir,
                           "parent_watch": self.parent_watch,
                           "started_at": int(time.time())}, f)
            os.replace(tmp, self.pid_path)
        except OSError as e:
            # 记录写不进去不影响运行（只是失去存量孤儿识别能力）
            self.log(f"[lifecycle] pid 记录写入失败（忽略）: {e}")

    def _remove_record(self):
        try:
            os.remove(self.pid_path)
        except OSError:
            pass

    # ---------- 存量孤儿判定 ----------

    @staticmethod
    def _looks_like_server(pid):
        """粗校验 pid 是否是 touchstone 的 server.py（防 PID 复用误杀）。

        读不到命令行时返回 True（宁可不杀——见 acquire 的调用点：仅在
        「pid 记录声明 parent_watch 且其父已死」时才走到这里）。
        """
        try:
            if sys.platform.startswith("linux"):
                with open(f"/proc/{int(pid)}/cmdline", "rb") as f:
                    return b"server.py" in f.read()
            import psutil
            return any("server.py" in str(a) for a in psutil.Process(int(pid)).cmdline())
        except Exception:                        # noqa: BLE001
            return True

    def _reap_stale(self, rec):
        """存量孤儿（父死感知托管 + 父已死）：SIGTERM 后等其让出锁。

        只向**该 pid 单个进程**发信号，**不做进程组/树终止**：孤儿往往与它的宿主
        （甚至是正在启动我们的这个 dsh 进程）处在同一个进程组，`killpg` 会连带
        杀掉自己——实测踩中（单测里直接把自己的进程组干掉）。孤儿自身的退出回调
        会收尾它的子进程；升级前的旧孤儿没有该回调，其子进程可能残留，属可接受
        代价（远好于误杀宿主）。
        """
        pid = int(rec.get("pid") or 0)
        if pid <= 0 or not platcompat.pid_alive(pid):
            return False                         # 记录已过期：直接尝试拿锁
        if not rec.get("parent_watch"):
            return False                         # 非父死感知托管的实例：绝不代杀
        if parent_alive(rec.get("ppid")):
            return False                         # 记录进程的父还活着：真·另一实例
        if not self._looks_like_server(pid):
            self.log(f"[lifecycle] pid 记录 {pid} 不像本平台后端（PID 复用？），不处置")
            return False
        self.log(f"[lifecycle] 发现存量孤儿后端 pid={pid}（父已死），SIGTERM 收口…")
        _term_pid(pid)
        deadline = time.time() + self.stale_wait
        while time.time() < deadline:
            if not platcompat.pid_alive(pid):
                break
            time.sleep(0.1)
        if platcompat.pid_alive(pid):
            self.log(f"[lifecycle] 孤儿 pid={pid} 未在 {self.stale_wait}s 内退出，放弃收口")
            return False
        self.reaped_pid = pid
        self.log(f"[lifecycle] 存量孤儿 pid={pid} 已收口")
        return True

    # ---------- 加锁 ----------

    def acquire(self):
        """拿同库单实例锁。True=拿到（已写 pid 记录）；False=被真·另一实例占用。

        非阻塞试锁 + 存量孤儿收口：拿到即写记录返回；拿不到先读 pid 记录——
        若记录进程由父死感知托管且其父已死，判为存量孤儿，SIGTERM 后在
        `stale_wait` 内重试；否则立即返回 False 并给出可执行的报错文案。
        """
        os.makedirs(os.path.dirname(self.lock_path), exist_ok=True)
        if self.allow_shared:
            self.log("[lifecycle] --allow-shared-db：跳过同库单实例锁（自担双写风险）")
            return True
        try:
            fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o644)
        except OSError as e:
            self.log(f"[lifecycle] 锁文件打开失败（降级为无锁运行）: {e}")
            return True
        self._fd = fd
        deadline = time.time() + max(self.stale_wait, 0.5) + 1.0
        reaped = False
        while True:
            if platcompat.lock_fd(fd, blocking=False):
                self._write_record(os.getpid())
                return True
            rec = self._read_record()
            if rec and not reaped and self._reap_stale(rec):
                reaped = True                   # 孤儿已收口：其锁随进程退出释放，再试
                continue
            if rec:
                self.reason = (
                    f"同一数据库已有运行中的实例：pid={rec.get('pid')} "
                    f"ppid={rec.get('ppid')} repo={rec.get('repo_dir') or '-'}"
                    f"（库 {self.db_file}）。如需并行请用独立库"
                    f"（TOUCHSTONE_DB / 插件 extraEnv.TOUCHSTONE_DB），"
                    f"或显式 --allow-shared-db 自担双写风险。")
            else:
                self.reason = (f"锁文件被占用且无归属记录：{self.lock_path}"
                               f"（库 {self.db_file}）。若确认无实例在跑，"
                               f"删除该锁文件后重试。")
            return False
        # 不可达：while True 内所有分支都 return（保静态检查可读性）

    def release(self):
        """释放锁与 pid 记录（幂等；仅当记录仍是自己时删）。"""
        rec = self._read_record()
        if rec and int(rec.get("pid") or 0) == os.getpid():
            self._remove_record()
        if self._fd is not None:
            platcompat.unlock_fd(self._fd)
            try:
                os.close(self._fd)
            except OSError:
                pass
            self._fd = None


# --------------------------------------------------------------------------
# 子进程树清理
# --------------------------------------------------------------------------

def collect_child_pids():
    """收集本进程拉起的、仍在跑的 agent/脚本子进程 pid（runner + board 在管条目）。

    防御式实现：模块未加载/结构变化都不抛异常（退出路径不能因收集失败而卡）。
    """
    pids = set()
    try:
        import runner as runner_mod
        inst = getattr(runner_mod, "INSTANCE", None)
        procs = getattr(inst, "_procs", None) or {}
        for proc in list(procs.values()):
            if proc is not None and getattr(proc, "poll", None) and proc.poll() is None:
                pids.add(int(proc.pid))
    except Exception:                            # noqa: BLE001
        pass
    try:
        import board as board_mod
        runs = getattr(board_mod, "_RUNS", None) or {}
        for rec in list(runs.values()):
            proc = (rec or {}).get("proc")
            if proc is not None and proc.poll() is None:
                pids.add(int(proc.pid))
    except Exception:                            # noqa: BLE001
        pass
    return sorted(pids)


def kill_children(pids=None, grace=KILL_GRACE, logger=None):
    """整组终止子进程（先 SIGTERM，宽限后仍活则 SIGKILL）。返回 (term, killed) 计数。"""
    log = logger or (lambda m: print(m, file=sys.stderr, flush=True))
    targets = list(pids if pids is not None else collect_child_pids())
    if not targets:
        return 0, 0
    for pid in targets:
        _safe_kill_tree(pid, signal.SIGTERM)
    deadline = time.time() + grace
    while time.time() < deadline:
        if not any(platcompat.pid_alive(p) for p in targets):
            break
        time.sleep(0.05)
    killed = 0
    for pid in targets:
        if platcompat.pid_alive(pid):
            _safe_kill_tree(pid, signal.SIGKILL)
            killed += 1
    log(f"[lifecycle] 退出前清理子进程: 共 {len(targets)} 个（SIGTERM {len(targets)}，"
        f"升级 SIGKILL {killed}）")
    return len(targets), killed
