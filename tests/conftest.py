# 套件级测试隔离：TOUCHSTONE_DB 必须先于任何测试模块 import db 就位——
# db 模块在 import 时读取该环境变量冻结库路径；此前隔离靠 test_board_enhance
# 模块顶 setenv，字母序在其前的测试模块会把整套件拖到真实库上跑（曾发生
# 真实库写入，幸为 no-op update）。conftest 先行 setenv 一并根治。
import os
import tempfile

if not os.environ.get("TOUCHSTONE_DB"):
    fd, _path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    os.environ["TOUCHSTONE_DB"] = _path

# 套件级建表：个别用例（如 board_payload 的 active_tasks 经 db.list_tasks）直接
# 查表，此前靠「套件内更早的用例先 init_db」的隐式顺序才过，单独跑文件即
# no such table。统一在此建表（init_db 幂等），文件级/套件级运行行为一致。
import db as _db

_db.init_db()

# 套件级 runner 单例隔离（2026-09-14）：server.py 尾部在 import 时构造
# runner.Runner() 并装到 runner.INSTANCE（真实服务入口所需）。任何用例
# `import server` 之后，「无 runner 单例」这一默认假设即被静默破坏——board
# 直投（deliver_comment 走统一队列而非 _deliver_now）/直起等分支随导入顺序
# 换路径，曾致 test_deliver_comment 等成片失败。每例前后统一还原为 None；
# 用例自行设置的假体（monkeypatch）不受影响。
import pytest
import runner as _runner


@pytest.fixture(autouse=True)
def _isolate_runner_instance():
    _runner.INSTANCE = None
    yield
    _runner.INSTANCE = None


# 套件级「看板在管条目」隔离（2026-10-03，P7b B4）：`board._RUNS`（卡 id → 会话
# 条目）是**进程内存态**。起会话类用例（如 test_dsh_plugin 的 `_start_web` 用例）
# 会登记条目而不在例内收尾，残留条目会被后续用例的巡视/收尾/归属判定读到——
# 实测：同进程先跑 tests/test_dsh_plugin.py::test_start_web_dsh_splits_provider
# （残留 2 条）再跑 test_board_queue_doing.py::test_recover_refreshes_ext_before_requeue
# 会打挂后者（该用例把 db.connect 桩成假连接，残条目让 recover 走进异常分支）。
# 默认文件序（board* 在 dsh* 前）不触发，随机序/单文件重排会。每例前后清空即可：
# 需要「跨用例保留条目」的场景不存在（用例自身 seeding 均在用例体内 monkeypatch）。
import board as _board


@pytest.fixture(autouse=True)
def _isolate_board_runs():
    _board._RUNS.clear()
    yield
    _board._RUNS.clear()


# 套件级「野 worker 免疫」（2026-09-23，v3a 抽查修复）：真实 Runner() 的 6 个
# worker 线程随进程存活（`_worker` 循环无退出条件，daemon），而 `import server`
# （模块级构造 Runner 装进 runner.INSTANCE）与各用例自建的真实单例都会把它们留在
# 进程里——它们每 5s 轮询**共享**临时库，会与前序/后续用例的行互相抢：claim 走
# 自己的 _pick_locked，甚至用当前用例 monkeypatch 的 `runner.db` 桩去执行其行
# （执行体抛错后按 c: 分支落 failed 并把活跃行留下）。
# 实证（本次修复的诊断实验）：在 tests/test_runner_pick_prefix.py 前置 12 个遗留
# 单例（=72 worker）后，该文件 1–2 个用例内必挂，且 dump 证实行被遗留 worker
# claim（`claimed_by='worker'`/state=starting）、项目 9 残留 `c:1,c:3..c:6` 活跃行；
# 全量跑下则为偶发（抽查两次各挂该文件一个不同用例：pick 到 None / claim 到 None）。
# 修法：**用例开始前已存在**的 Runner 实例判为「遗留」，当例内其拾取入口
# `_pick_locked` 失效（返回 None ⇒ worker 空转等下一拍，不碰任何行）。
# 口径边界（按 pytest 夹具实例化序，实证勿想当然）：
#   - 模块/会话/类级夹具建的 Runner 先于本函数级 autouse 夹具实例化 ⇒ 判为遗留、静音
#     （当前套件无用例依赖「跨用例长活的真实实例」的 worker 循环；回归钉
#     test_leaked_runner_workers_cannot_steal_rows 正是刻意利用这一顺序）；
#   - 用例函数体内新建的实例、以及同级**非 autouse** 函数夹具新建的实例
#     （autouse 先于同级非 autouse 实例化）⇒ 不在快照内，照常工作；
#   - 裸实例（`Runner.__new__`，单测主力）从不登记 ⇒ 不受影响。
# 若将来有模块确需「跨用例长活的真实 Runner 驱动队列」，请在该模块显式请求豁免
# （白名单/标记），不要删静音。
# 不采用「停线程」：`_worker` 无退出条件，停线程需改产品代码；产品侧无需改动
# （真实服务只跑一个单例，不存在遗留形态）。
_ALL_RUNNERS = []      # 进程内构造过的真实 Runner 实例（遗留判定的唯一数据源）


def _register_runner_instance(orig_init):
    """包 `Runner.__init__` 登记实例（**在 conftest import 期安装**，非夹具内）。

    安装时机是硬约束：pytest 的**收集阶段先于任何夹具**——若在 session 夹具里装，
    任何「模块 import 期就构造 Runner」的形态（如 `import server`：server.py:4423
    在模块级 `runner_instance = runner.Runner()`）会漏登记 → 该实例整个会话不被
    静音，正是要防的野 worker。当前套件无模块级 `import server`（全在用例体内），
    故此洞暂未触发；装在此处即从结构上关闭它（新增模块不会再引入该形态）。
    仅包一层追加登记，不改 Runner 行为；本进程退出即随进程结束。
    """
    def _init(self, *args, **kwargs):
        orig_init(self, *args, **kwargs)
        _ALL_RUNNERS.append(self)

    _runner.Runner.__init__ = _init


_register_runner_instance(_runner.Runner.__init__)


@pytest.fixture(autouse=True)
def _mute_leaked_runner_picks():
    """当例内让「遗留 Runner」的 worker 拾取入口失效（见上方说明）。

    用**夹具私有** `pytest.MonkeyPatch.context()`（而非共享的函数级 `monkeypatch`
    夹具）：后者与用例共用同一实例，任何用例调用 `monkeypatch.undo()`（如
    `tests/test_board_finish.py` 还原桩的既有用法、v3c 修复轮前
    `test_board_busy` 的同款写法）都会把本静音**一并撤销**
    → 该例剩余时间里遗留 worker 恢复自由拾取（共享临时库）。
    实测（2026-09-24 v3c 修复轮诊断）：`tests/test_runner_pick_prefix.py::
    test_leaked_runner_workers_cannot_steal_rows` 偶发失败（全量跑约 1/4），
    失败栈 = 遗留 worker 在静音被撤窗口拾到的键（`c:1`）在后续用例里
    `claim_by_target` 抢走该用例的种子行 → `_process_card` 撞用例的 `runner.db`
    桩（`'D' object has no attribute 'get_project'`）→ 行被 `finish_by_target`
    终态化 → 断言拿到 None。夹具私有实例不受用例 undo 影响，这类窗口结构性消失。
    """
    leaked = {id(r) for r in _ALL_RUNNERS}      # 本用例开始前已存在 = 遗留
    if not leaked:
        yield
        return
    with pytest.MonkeyPatch.context() as mp:
        orig_pick = _runner.Runner._pick_locked

        def _pick_locked(self):
            if id(self) in leaked:
                return None                      # 遗留 worker：空转，不扫行
            return orig_pick(self)

        mp.setattr(_runner.Runner, "_pick_locked", _pick_locked)
        yield
