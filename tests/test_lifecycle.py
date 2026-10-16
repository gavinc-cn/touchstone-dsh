#!/usr/bin/env python3
"""宿主生命周期治理单测（路线 A P2，2026-10-03）。

覆盖三件事（与 `lifecycle.py` 三节一一对应）：

1. **父死感知**（真机语义，不 mock）：
   - stdin 管道 EOF：中间进程被 `kill -9` 后，子进程靠 EOF 自主退出；
   - Linux PDEATHSIG：stdin 不可用（DEVNULL）时，内核信号兜底；
   - 误报防护：stdin 立即 EOF 但父仍存活 ⇒ **不得**自杀。
2. **同库单实例锁**：第二个实例被拒（带可执行报错文案）、释放后可再拿、
   存量孤儿（parent_watch=true 且父已死）被收口接手、非托管记录绝不代杀、
   `allow_shared` 逃生口。
3. **子进程树清理**：`kill_children` 连孙进程一起终止（POSIX 走进程组）。

这些用例都起真实子进程（毫秒级脚本），断言的是进程存活状态，不是内部调用。
"""
import json
import os
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import lifecycle
import platcompat

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = sys.executable

# 子进程脚本：武装父死感知后长睡（on_exit 用 os._exit —— 回调跑在看门狗线程里，
# sys.exit 只会结束该线程，进程照旧活着；server.py 的真实回调同款）
CHILD_WATCH_SRC = """
import os, sys, time
sys.path.insert(0, {root!r})
import lifecycle
lifecycle.arm_parent_watch(lambda: os._exit(0), pdeathsig={pdeathsig},
                           logger=lambda m: None)
while True:
    time.sleep(0.2)
"""

# 中间进程脚本：拉起上面的子进程（stdin 管道或 DEVNULL），打印子进程 pid 后长睡
MIDDLE_SRC = """
import subprocess, sys, time
p = subprocess.Popen([{py!r}, "-c", {child!r}],
                     stdin=({devnull} and subprocess.DEVNULL or subprocess.PIPE))
print(p.pid, flush=True)
time.sleep(60)
"""

# 「像 server.py 的进程」：cmdline 里带 server.py 字样（供 _looks_like_server 命中）
FAKE_SERVER_SRC = """
import sys, time
sys.argv = ["server.py", "--fake"]
time.sleep(60)
"""

MIDDLE_FAKE_SERVER_SRC = """
import subprocess, sys, time
p = subprocess.Popen([{py!r}, "-c", {child!r}, "server.py"], stdin=subprocess.DEVNULL)
print(p.pid, flush=True)
time.sleep(60)
"""

# 存量孤儿替身：**自己持有同库单实例锁**（真实孤儿正是持锁跑着的那一个），
# 记录里 parent_watch=true（由 SingleInstance 写入）；cmdline 带 server.py。
ORPHAN_HOLD_SRC = """
import os, sys, time
sys.path.insert(0, {root!r})
import lifecycle
inst = lifecycle.SingleInstance({db!r}, repo_dir="/repo", parent_watch=True,
                                logger=lambda m: None)
assert inst.acquire(), "孤儿替身未能拿到锁"
print(os.getpid(), flush=True)
while True:
    time.sleep(0.2)
"""

MIDDLE_ORPHAN_SRC = """
import subprocess, sys, time
p = subprocess.Popen([{py!r}, "-c", {child!r}, "server.py"], stdin=subprocess.DEVNULL)
print(p.pid, flush=True)
time.sleep(60)
"""


def _spawn_middle(devnull, pdeathsig, middle_src=None):
    """起中间进程：返回 (Popen, 子进程 pid)。子进程 pid 由中间进程 stdout 首行给出。"""
    child = CHILD_WATCH_SRC.format(root=ROOT, pdeathsig=pdeathsig)
    src = (middle_src or MIDDLE_SRC).format(py=PY, child=child, devnull=devnull)
    proc = subprocess.Popen([PY, "-c", src], stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True)
    line = proc.stdout.readline().strip()
    assert line.isdigit(), f"未取到子进程 pid: {line!r}"
    return proc, int(line)


def _wait_dead(pid, timeout=8.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not platcompat.pid_alive(pid):
            return True
        time.sleep(0.1)
    return False


def _kill(pid):
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass


# ---------- 1. 父死感知 ----------

def test_parent_watch_stdin_eof_kills_child():
    """机制 A：中间进程被 kill -9 ⇒ 子进程 stdin EOF + 父已死 ⇒ 自主退出。"""
    middle, cpid = _spawn_middle(devnull=False, pdeathsig=False)
    try:
        assert platcompat.pid_alive(cpid)
        os.kill(middle.pid, signal.SIGKILL)
        middle.wait(timeout=5)
        assert _wait_dead(cpid, timeout=8.0), "EOF 通道未生效：子进程仍存活"
    finally:
        _kill(cpid)
        _kill(middle.pid)


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="PDEATHSIG 仅 Linux")
def test_parent_watch_pdeathsig_kills_child():
    """机制 B：stdin 不可用（DEVNULL，EOF 立即误报后线程退出）时，内核 PDEATHSIG 兜底。"""
    middle, cpid = _spawn_middle(devnull=True, pdeathsig=True)
    try:
        time.sleep(0.6)                       # 让子进程完成武装（含 EOF 误报判定）
        assert platcompat.pid_alive(cpid), "子进程在武装阶段就退出了（误报防护失效？）"
        os.kill(middle.pid, signal.SIGKILL)
        middle.wait(timeout=5)
        assert _wait_dead(cpid, timeout=8.0), "PDEATHSIG 未生效：子进程仍存活"
    finally:
        _kill(cpid)
        _kill(middle.pid)


def test_parent_watch_spurious_eof_does_not_exit():
    """误报防护：stdin 立即 EOF（DEVNULL）但父存活 ⇒ 子进程必须继续跑。"""
    middle, cpid = _spawn_middle(devnull=True, pdeathsig=False)
    try:
        time.sleep(1.5)
        assert platcompat.pid_alive(cpid), "父仍存活却自杀了（误报防护失效）"
    finally:
        _kill(cpid)
        _kill(middle.pid)


def test_arm_parent_watch_state_fields():
    """arm 返回值自描述（pdeathsig 状态 / 触发通道），便于 server 启动日志与断言。"""
    st = lifecycle.arm_parent_watch(lambda: None, logger=lambda m: None, pdeathsig=False)
    assert st["armed"] is True and st["stdin_watch"] is True
    assert st["pdeathsig"] == "skipped" and st["trigger"] == ""


def test_parent_alive_false_for_init_and_bogus():
    assert lifecycle.parent_alive(1) is False
    assert lifecycle.parent_alive(0) is False
    assert lifecycle.parent_alive("x") is False
    assert lifecycle.parent_alive(os.getpid()) is True     # 自己必然存活


# ---------- 2. 同库单实例锁 ----------

def test_single_instance_blocks_second(tmp_path):
    """同库第二实例被拒，报错文案含 pid/库路径与逃生口提示；释放后可再拿。"""
    db = str(tmp_path / "t.db")
    logs = []
    a = lifecycle.SingleInstance(db, repo_dir="/repo", logger=logs.append)
    assert a.acquire() is True
    try:
        assert os.path.isfile(db + ".pid")
        rec = json.load(open(db + ".pid", encoding="utf-8"))
        assert rec["pid"] == os.getpid() and rec["parent_watch"] is False
        b = lifecycle.SingleInstance(db, logger=logs.append)
        assert b.acquire() is False
        assert "已有运行中的实例" in b.reason and db in b.reason
        assert "--allow-shared-db" in b.reason
        # 逃生口：显式共库（自担双写）
        c = lifecycle.SingleInstance(db, allow_shared=True, logger=logs.append)
        assert c.acquire() is True
        c.release()
    finally:
        a.release()
    # 释放后可再拿
    d = lifecycle.SingleInstance(db, logger=logs.append)
    assert d.acquire() is True
    d.release()
    assert not os.path.exists(db + ".pid")


def test_single_instance_reaps_stale_orphan(tmp_path):
    """存量孤儿（持锁 + parent_watch=true + 其父已死）被 SIGTERM 收口后接手（P2 的 D 项）。

    真实场景：升级前的旧后端被 `kill -9` 的 dsh 留下——它**仍持着锁**在跑任务，
    新实例启动时必须先把它收口，否则要么拿不到锁、要么与之双写同库。
    """
    db = str(tmp_path / "t.db")
    logs = []
    child_src = ORPHAN_HOLD_SRC.format(root=ROOT, db=db)
    middle_src = MIDDLE_ORPHAN_SRC.format(py=PY, child=child_src)
    middle = subprocess.Popen([PY, "-c", middle_src], stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True)
    orphan_pid = int(middle.stdout.readline().strip())
    try:
        assert platcompat.pid_alive(orphan_pid)
        # 等孤儿替身真正拿到锁并写出记录（子进程启动是异步的；它随后也会往同一条
        # stdout 管道打印自己的 pid，这里只等文件，不再读管道）
        deadline = time.time() + 5
        while time.time() < deadline and not os.path.exists(db + ".pid"):
            time.sleep(0.05)
        assert os.path.exists(db + ".pid"), "孤儿替身未写出 pid 记录（未拿到锁？）"
        rec0 = json.load(open(db + ".pid", encoding="utf-8"))
        assert rec0["pid"] == orphan_pid and rec0["parent_watch"] is True
        os.kill(middle.pid, signal.SIGKILL)      # 父死 ⇒ 孤儿（仍持锁）
        middle.wait(timeout=5)
        time.sleep(0.3)
        assert platcompat.pid_alive(orphan_pid), "孤儿未成形（父死不该杀子）"
        inst = lifecycle.SingleInstance(db, repo_dir="/repo", logger=logs.append,
                                        stale_wait=4.0)
        assert inst.acquire() is True
        assert inst.reaped_pid == orphan_pid
        assert not platcompat.pid_alive(orphan_pid), "孤儿未被收口"
        inst.release()
    finally:
        _kill(orphan_pid)
        _kill(middle.pid)


def test_single_instance_never_kills_when_parent_alive(tmp_path):
    """记录指向活进程且其父仍存活 ⇒ 判为真·另一实例：拒绝且**不杀**。"""
    db = str(tmp_path / "t.db")
    logs = []
    holder = os.open(db + ".lock", os.O_RDWR | os.O_CREAT, 0o644)
    try:
        assert platcompat.lock_fd(holder, blocking=False) is True
        with open(db + ".pid", "w", encoding="utf-8") as f:
            json.dump({"pid": os.getpid(), "ppid": os.getppid(), "repo_dir": "/repo",
                       "parent_watch": True, "started_at": 0}, f)
        inst = lifecycle.SingleInstance(db, logger=logs.append, stale_wait=0.5)
        assert inst.acquire() is False
        assert inst.reaped_pid == 0
        assert "已有运行中的实例" in inst.reason
        assert platcompat.pid_alive(os.getpid())          # 自己当然还活着
    finally:
        platcompat.unlock_fd(holder)
        os.close(holder)


def test_single_instance_takes_free_lock_with_dead_record(tmp_path):
    """记录里的进程已死（锁自然已释放）⇒ 直接接手，不误报占用、不误杀。"""
    db = str(tmp_path / "t.db")
    with open(db + ".pid", "w", encoding="utf-8") as f:
        json.dump({"pid": 999999, "ppid": 999998, "repo_dir": "/repo",
                   "parent_watch": True, "started_at": 0}, f)
    inst = lifecycle.SingleInstance(db, logger=lambda m: None, stale_wait=1.0)
    assert inst.acquire() is True
    assert inst.reaped_pid == 0
    inst.release()


def test_lock_fd_nonblocking_returns_false_when_held(tmp_path):
    """platcompat.lock_fd(blocking=False) 拿不到即返回 False（不等待）。"""
    path = str(tmp_path / "x.lock")
    fd1 = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
    fd2 = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        t0 = time.time()
        assert platcompat.lock_fd(fd1, blocking=False) is True
        assert platcompat.lock_fd(fd2, blocking=False) is False
        assert time.time() - t0 < 0.5, "非阻塞试锁不得等待"
        platcompat.unlock_fd(fd1)
        assert platcompat.lock_fd(fd2, blocking=False) is True
    finally:
        platcompat.unlock_fd(fd1)
        platcompat.unlock_fd(fd2)
        os.close(fd1)
        os.close(fd2)


# ---------- 3. 子进程树清理 ----------

def test_kill_children_terminates_tree(tmp_path):
    """kill_children 连孙进程一起终止（POSIX 走进程组；Windows 走 psutil 树）。"""
    src = ("import subprocess, sys, time\n"
           f"g = subprocess.Popen([{PY!r}, '-c', 'import time; time.sleep(60)'])\n"
           "print(g.pid, flush=True)\n"
           "time.sleep(60)\n")
    proc = platcompat.spawn_session([PY, "-c", src], stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, text=True)
    gpid = int(proc.stdout.readline().strip())
    try:
        assert platcompat.pid_alive(proc.pid) and platcompat.pid_alive(gpid)
        term, killed = lifecycle.kill_children([proc.pid], grace=2.0,
                                               logger=lambda m: None)
        assert term == 1
        # 直接子进程要 wait() 回收：僵尸进程对 kill(pid,0) 仍报「存活」
        assert proc.wait(timeout=5) is not None
        assert _wait_dead(gpid, timeout=5), \
            f"孙进程未清干净（SIGKILL 升级数 {killed}）"
    finally:
        _kill(proc.pid)
        _kill(gpid)


def test_collect_child_pids_never_raises():
    """收集口是防御式实现（退出路径不能因结构变化抛异常）。"""
    pids = lifecycle.collect_child_pids()
    assert isinstance(pids, list)
    assert pids == sorted(pids)


# ---------- 4. 真机端到端（真 server.py） ----------

WEB_DIST = os.path.join(ROOT, "webui", "dist")
_needs_dist = pytest.mark.skipif(
    not os.path.isfile(os.path.join(WEB_DIST, "index.html")),
    reason="缺少 webui/dist（先执行 ./touchstone.sh build）")


def _server_env(db):
    """起真 server.py 用的隔离环境。

    `TOUCHSTONE_RUN_DIR` 必须指到临时目录：server.py 默认把实际端口写进
    `<仓库>/.run/server.port`，而用例退出时 `_cleanup()` 会删掉它——直接跑会**删掉真实
    实例（插件形态生产后端）的端口标记**（实测：跑完 pytest 后 `.run/server.port` 消失，
    生产后端仍在 :40237 跑）。与 tools/parity 的 `buildBackendEnv` 同口径。
    """
    env = dict(os.environ, TOUCHSTONE_DB=db, TS_ADMIN_PASSWORD="ts-lifecycle-pw",
               TOUCHSTONE_RUN_DIR=tempfile.mkdtemp(prefix="ts-lifecycle-run-"))
    env.pop("TS_PARENT_WATCH", None)
    return env


def _read_until(proc, marker, timeout=30.0):
    """读子进程 stdout 直到出现 marker（server.py 启动横幅里有 TOUCHSTONE_LISTEN）。"""
    buf = []
    end = time.time() + timeout
    while time.time() < end:
        line = proc.stdout.readline()
        if not line:
            break
        buf.append(line)
        if marker in line:
            return True, "".join(buf)
    return False, "".join(buf)


@_needs_dist
def test_server_second_instance_same_db_refused(tmp_path):
    """同库第二实例被拒（exit 3 + 明确文案），第一实例正常启动；SIGTERM 可正常收尾。"""
    db = str(tmp_path / "t.db")
    a = subprocess.Popen([PY, "server.py", "--host", "127.0.0.1", "--port", "0",
                          "--web-dir", WEB_DIST],
                         cwd=ROOT, env=_server_env(db), stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, text=True)
    try:
        ok, out = _read_until(a, "TOUCHSTONE_LISTEN")
        assert ok, f"实例 A 未就绪:\n{out}"
        b = subprocess.run([PY, "server.py", "--host", "127.0.0.1", "--port", "0",
                            "--web-dir", WEB_DIST],
                           cwd=ROOT, env=_server_env(db), capture_output=True,
                           text=True, timeout=60)
        assert b.returncode == 3, f"第二实例未被拒: rc={b.returncode}\n{b.stdout}\n{b.stderr}"
        assert "同一数据库已有运行中的实例" in (b.stdout + b.stderr)
        assert "--allow-shared-db" in (b.stdout + b.stderr)
        # 逃生口：显式共库可起（自担风险）
        c = subprocess.Popen([PY, "server.py", "--host", "127.0.0.1", "--port", "0",
                              "--web-dir", WEB_DIST, "--allow-shared-db"],
                             cwd=ROOT, env=_server_env(db), stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True)
        try:
            ok2, out2 = _read_until(c, "TOUCHSTONE_LISTEN")
            assert ok2, f"--allow-shared-db 实例未就绪:\n{out2}"
        finally:
            c.terminate()
            c.wait(timeout=20)
    finally:
        a.terminate()
        a.wait(timeout=20)
    assert not os.path.exists(db + ".pid"), "正常退出未清理 pid 记录"


@_needs_dist
def test_server_parent_watch_exits_when_parent_killed(tmp_path):
    """真机主线：dsh 宿主被 kill -9 ⇒ 后端 server.py 自主退出（P2 的验收判据）。

    中间进程替身 dsh：它的 stdin 管道写端在自己手里（插件同款），被 SIGKILL 后
    OS 关闭写端 ⇒ server.py 收到 EOF 且父已死 ⇒ 收尾退出（不再留孤儿）。
    """
    db = str(tmp_path / "t.db")
    child_cmd = [PY, os.path.join(ROOT, "server.py"), "--host", "127.0.0.1",
                 "--port", "0", "--web-dir", WEB_DIST, "--parent-watch"]
    middle_src = (
        "import subprocess, sys, time\n"
        "p = subprocess.Popen(%r, stdin=subprocess.PIPE, stdout=sys.stdout,\n"
        "                     stderr=subprocess.STDOUT, cwd=%r, env=%r)\n"
        "print('CHILD_PID', p.pid, flush=True)\n"
        "time.sleep(120)\n" % (child_cmd, ROOT, _server_env(db)))
    # 中间进程用 sleep 而不是 read stdin：后者在 stdin 为 /dev/null 的环境里会立刻
    # 结束（子进程在武装前就成了孤儿，测的就不是「父被 kill -9」这条路径了）
    middle = subprocess.Popen([PY, "-c", middle_src], stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    spid = 0
    try:
        ok, out = _read_until(middle, "TOUCHSTONE_LISTEN")
        assert ok, f"server.py 未就绪:\n{out}"
        spid = next(int(ln.split()[1]) for ln in out.splitlines()
                    if ln.startswith("CHILD_PID"))
        assert platcompat.pid_alive(spid)
        os.kill(middle.pid, signal.SIGKILL)          # 模拟 dsh 被 kill -9
        middle.wait(timeout=5)
        assert _wait_dead(spid, timeout=12.0), \
            f"父被 kill -9 后后端未退出（孤儿！）pid={spid}"
    finally:
        _kill(spid)
        _kill(middle.pid)


# ---------- 2b. 第二道闸：SQLite 排它锁（M1，2026-10-11）----------
#
# Node 后端没有 stdlib flock，改用同一 `<db>.lock` 文件上的 SQLite 排它锁
# （`PRAGMA locking_mode=EXCLUSIVE` + 一次写事务，持锁到进程结束）。两种锁机制
# **互不相干**：Node 持 SQLite 锁时 Python 的 flock 照样能拿到 ⇒ 只靠 flock 挡不住
# Node 版实例。下面几条是「跨语言互斥真的成立」的证据；最后一条是反例自证。

NODE_LOCK_HOLD_SRC = """
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.TS_LOCK_PATH, { timeout: 0 });
db.exec('PRAGMA busy_timeout=0');
db.exec('PRAGMA locking_mode=EXCLUSIVE');
db.exec('CREATE TABLE IF NOT EXISTS lock_holder (id INTEGER PRIMARY KEY CHECK (id = 1),'
      + ' pid INTEGER NOT NULL, started_at INTEGER NOT NULL)');
db.prepare('INSERT OR REPLACE INTO lock_holder(id, pid, started_at) VALUES(1, ?, ?)')
  .run(process.pid, Math.floor(Date.now() / 1000));
console.log('HOLDING');
setTimeout(() => {}, 60000);
"""

NODE_LOCK_TRY_SRC = """
const { DatabaseSync } = require('node:sqlite');
try {
  const db = new DatabaseSync(process.env.TS_LOCK_PATH, { timeout: 0 });
  db.exec('PRAGMA busy_timeout=0');
  db.exec('PRAGMA locking_mode=EXCLUSIVE');
  db.exec('CREATE TABLE IF NOT EXISTS lock_holder (id INTEGER PRIMARY KEY CHECK (id = 1),'
        + ' pid INTEGER NOT NULL, started_at INTEGER NOT NULL)');
  db.prepare('INSERT OR REPLACE INTO lock_holder(id, pid, started_at) VALUES(1, ?, ?)')
    .run(process.pid, 0);
  console.log('GOT');
} catch (e) {
  console.log('BUSY:' + e.message);
  process.exit(1);
}
"""

NODE = shutil.which("node")

# 「像 Node 后端的进程」：`-e` 脚本 + argv 里带 backend/server.js（供 _looks_like_server 命中）
NODE_FAKE_BACKEND_SRC = "setTimeout(() => {}, 60000)"


def _spawn_node(src, lock_path):
    env = dict(os.environ, TS_LOCK_PATH=lock_path)
    return subprocess.Popen([NODE, "--disable-warning=ExperimentalWarning", "-e", src],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            env=env)


@pytest.mark.skipif(not NODE, reason="需要 node 可执行文件（跨语言互斥用例）")
def test_node_sqlite_lock_blocks_python_instance(tmp_path):
    """Node 版实例持锁时，Python 版实例必须被拒（否则两版会同库双写）。"""
    db = str(tmp_path / "t.db")
    proc = _spawn_node(NODE_LOCK_HOLD_SRC, db + ".lock")
    try:
        assert proc.stdout.readline().strip() == "HOLDING"
        inst = lifecycle.SingleInstance(db, logger=lambda m: None)
        assert inst.acquire() is False, "Node 持锁时 Python 竟拿到锁：跨语言互斥失效"
        assert "--allow-shared-db" in inst.reason
    finally:
        proc.kill()
        proc.wait(timeout=10)


@pytest.mark.skipif(not NODE, reason="需要 node 可执行文件（跨语言互斥用例）")
def test_python_sqlite_lock_blocks_node(tmp_path):
    """Python 版实例持锁时，Node 版的同款取锁动作必须 busy 失败。"""
    db = str(tmp_path / "t.db")
    inst = lifecycle.SingleInstance(db, logger=lambda m: None)
    assert inst.acquire() is True
    try:
        proc = _spawn_node(NODE_LOCK_TRY_SRC, db + ".lock")
        out, _err = proc.communicate(timeout=30)
        assert proc.returncode == 1, out
        assert out.strip().startswith("BUSY:"), out
    finally:
        inst.release()


@pytest.mark.skipif(not NODE, reason="需要 node 可执行文件（跨语言互斥用例）")
def test_sqlite_gate_is_load_bearing(tmp_path, monkeypatch):
    """反例自证：短路第二道闸后，Node 持锁时 Python **必须能**拿到锁。

    证明 `test_node_sqlite_lock_blocks_python_instance` 测的是 SQLite 锁本身——
    Node 侧没有 flock，只靠 flock 时 Python 一定成功（本用例绿），因此上一条的红
    只可能来自第二道闸。
    """
    db = str(tmp_path / "t.db")
    proc = _spawn_node(NODE_LOCK_HOLD_SRC, db + ".lock")
    try:
        assert proc.stdout.readline().strip() == "HOLDING"
        monkeypatch.setattr(lifecycle.SingleInstance, "_acquire_sqlite_lock",
                            lambda self: ("ok", ""))
        inst = lifecycle.SingleInstance(db, logger=lambda m: None)
        assert inst.acquire() is True, "短路第二道闸后仍拿不到锁：说明 flock 也挡住了（用例前提有误）"
        inst.release()
    finally:
        proc.kill()
        proc.wait(timeout=10)


def test_sqlite_lock_released_on_sigkill(tmp_path):
    """持锁进程被 `kill -9` ⇒ 锁自动释放，新实例无需任何清理即可接手。"""
    db = str(tmp_path / "t.db")
    child_src = (
        "import sys, time\n"
        f"sys.path.insert(0, {ROOT!r})\n"
        "import lifecycle\n"
        f"inst = lifecycle.SingleInstance({db!r}, logger=lambda m: None)\n"
        "assert inst.acquire()\n"
        "print('LOCKED', flush=True)\n"
        "time.sleep(60)\n")
    proc = subprocess.Popen([PY, "-c", child_src], stdout=subprocess.PIPE, text=True)
    try:
        assert proc.stdout.readline().strip() == "LOCKED"
        os.kill(proc.pid, signal.SIGKILL)
        proc.wait(timeout=10)
        inst = lifecycle.SingleInstance(db, logger=lambda m: None)
        assert inst.acquire() is True
        inst.release()
    finally:
        _kill(proc.pid)


def test_sqlite_lock_writes_holder_row(tmp_path):
    """锁文件真的变成了带归属行的 SQLite 库（第二道闸确实在写，不是空转）。

    只能在 `release()` 之后读：EXCLUSIVE 模式下持锁期间别的连接读不了这个文件
    （这正是互斥的来源）。
    """
    db = str(tmp_path / "t.db")
    inst = lifecycle.SingleInstance(db, logger=lambda m: None)
    assert inst.acquire() is True
    inst.release()
    conn = sqlite3.connect(db + ".lock")
    try:
        row = conn.execute("SELECT pid, started_at FROM lock_holder WHERE id=1").fetchone()
    finally:
        conn.close()
    assert row is not None, "锁文件里没有 lock_holder 行：第二道闸没真写"
    assert row[0] == os.getpid() and row[1] > 0


@pytest.mark.skipif(not NODE, reason="需要 node 可执行文件（跨语言用例）")
def test_looks_like_server_accepts_node_backend():
    """孤儿收口要认两版后端的命令行（Python `server.py` / Node `backend/server.js`）。"""
    proc = subprocess.Popen([NODE, "--disable-warning=ExperimentalWarning", "-e",
                             "setTimeout(() => {}, 60000)", "backend/server.js"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(0.4)
        assert lifecycle.SingleInstance._looks_like_server(proc.pid) is True
    finally:
        proc.kill()
        proc.wait(timeout=10)


@pytest.mark.skipif(not NODE, reason="需要 node 可执行文件（跨语言用例）")
def test_reap_stale_node_orphan(tmp_path):
    """Node 版孤儿（宿主被 kill -9、它被 init 收养）能被 SIGTERM 收口。

    为什么要「中间进程 + 杀宿主」这一套：若孤儿的父进程还活着，它死后是**僵尸**，
    `kill(pid, 0)` 仍成功 ⇒ `pid_alive` 恒为真，收口等待循环必然超时。真实的孤儿
    由 init 收养并回收，僵尸这条只存在于「测试自己当父进程」的构造里。
    """
    db = str(tmp_path / "t.db")
    middle_src = (
        "import subprocess, sys, time\n"
        f"p = subprocess.Popen([{NODE!r}, '--disable-warning=ExperimentalWarning',\n"
        f"                      '-e', {NODE_FAKE_BACKEND_SRC!r}, 'backend/server.js'],\n"
        "                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,\n"
        "                     stderr=subprocess.DEVNULL)\n"
        "print(p.pid, flush=True)\n"
        "time.sleep(120)\n")
    middle = subprocess.Popen([PY, "-c", middle_src], stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, text=True)
    orphan_pid = 0
    try:
        orphan_pid = int(middle.stdout.readline().strip())
        assert platcompat.pid_alive(orphan_pid)
        os.kill(middle.pid, signal.SIGKILL)          # 模拟宿主被 kill -9
        middle.wait(timeout=10)
        time.sleep(0.5)                              # 等它被 init 收养（ppid=1）
        inst = lifecycle.SingleInstance(db, logger=lambda m: None, stale_wait=5)
        assert inst._reap_stale({"pid": orphan_pid, "ppid": middle.pid,
                                 "repo_dir": "/repo", "parent_watch": True,
                                 "backend": "node"}) is True
        assert inst.reaped_pid == orphan_pid
        assert not platcompat.pid_alive(orphan_pid)
    finally:
        _kill(orphan_pid)
        _kill(middle.pid)


# ---------- 2c. 锁文件不可用 ⇒ fail closed（2026-10-11 评审 P1）----------
#
# 评审实测：锁文件是垃圾内容/是目录时，两版**都能就绪** ⇒ 跨语言互斥无声消失、同库双写。
# 现在一律拒绝启动（调用方 exit 3）并给出「移走再启动」的修复步骤；确要自担风险走
# --allow-shared-db。这三条就是那个决策的钉子。

def test_lock_path_is_directory_fails_closed(tmp_path):
    """锁路径是个目录（打不开）⇒ 拒绝启动并给修复步骤，不再「降级为无锁运行」。"""
    db = str(tmp_path / "t.db")
    os.makedirs(db + ".lock")                     # 锁路径占成目录
    inst = lifecycle.SingleInstance(db, logger=lambda m: None)
    assert inst.acquire() is False
    assert "单实例锁文件不可用" in inst.reason
    assert f"{db}.lock" in inst.reason and ".broken" in inst.reason
    assert "--allow-shared-db" in inst.reason


def test_lock_file_garbage_fails_closed(tmp_path):
    """锁文件是文本垃圾（不是 SQLite 库）⇒ 拒绝启动。"""
    db = str(tmp_path / "t.db")
    with open(db + ".lock", "w", encoding="utf-8") as f:
        f.write("这不是 SQLite 库\n")
    inst = lifecycle.SingleInstance(db, logger=lambda m: None)
    assert inst.acquire() is False
    assert "单实例锁文件不可用" in inst.reason


def test_allow_shared_bypasses_unusable_lock(tmp_path):
    """逃生口仍有效：--allow-shared-db 时锁文件损坏也照常起步（自担双写风险）。"""
    db = str(tmp_path / "t.db")
    os.makedirs(db + ".lock")
    logs = []
    inst = lifecycle.SingleInstance(db, allow_shared=True, logger=logs.append)
    assert inst.acquire() is True
    assert any("--allow-shared-db" in m for m in logs)
    inst.release()
