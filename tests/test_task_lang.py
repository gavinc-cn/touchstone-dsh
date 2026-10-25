#!/usr/bin/env python3
"""T13：任务/卡片语言字段与首轮冻结（Python 侧验收）。

与 `backend/test/task-lang.test.mjs` **同一组语义**（双端逐条镜像）：
  ① 迁移：旧库（无 `lang` 列）经 `db.init_db()` 后 tasks/board_cards 两表补列，
     存量行一律 `'zh'`（`backend/schema/fixtures/pre_alter.sql` 造库）；
  ② 任务创建冻结：`X-TS-Lang` → `?lang=` → 用户偏好 → `zh`；非法值**跳过**并落到
     下一来源（R27）；`TS_I18N=0` ⇒ `zh` 且创建路径**不读偏好**（抛错桩）；
  ③ pipeline 后段任务 = 父任务（请求）语言；runner 自动复测/复核任务 = 发起任务语言；
  ④ 卡片：新建 `lang=''`（未冻结）；首次 start 写请求语言；**二次 start 不覆盖**；
     原子冻结口 `db.set_board_card_lang` 先到先得；**所有带请求上下文的起跑入口**
     （start / 拖列进 doing / 强制运行手势 / worktree 合并回交）都在门禁之后冻结；
     无请求上下文的定时开工 / 队列拾起保持 `''`（F1 修复轮）；
  ⑤ payload：任务 JSON（`_task_json`）与看板卡 JSON（`board.card_json`）暴露
     **规范化后**的 `lang`（未知/空/缺失 → zh）；
  ⑥ 飞书打回起跑：`feishu._execute_board_action` 把已解析的收件人语言传给
     `board.start_card`（R22 语言源，不得按展示文案处理）。

全部离线：不建真 dsh 会话、不发真飞书请求、不碰生产库（conftest 已把
`TOUCHSTONE_DB` 指向临时库）；迁移用例在隔离库文件上跑真启动序。
"""
import json
import pathlib
import sqlite3
import threading
import uuid

import pytest

import board
import db
import feishu
import i18n
import runner
import server
import waitq

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCHEMA_DIR = ROOT / "backend" / "schema"
JSON_CT = "application/json; charset=utf-8"


# --------------------------------------------------------------------------
# 测试台：最小 Handler 替身（不建真 socket）+ 停闸 runner 桩
# --------------------------------------------------------------------------
class _StateCache:
    """`state_cache.get()` 的最小替身（案例库扫描与冻结无关，给 0 基数）。"""

    def get(self, *args, **kwargs):
        return {"library": {"stats": {"total": 0}}}

    def fingerprint(self, *args, **kwargs):
        return ""


class FakeHandler(server.Handler):
    """只实现端点用到的 headers/path/_request_user/_respond（见 test_i18n_api 同款）。"""

    state_cache = _StateCache()

    def __init__(self, user, headers=None, path="/api/x"):
        self.headers = dict(headers or {})
        self.path = path
        self._request_user = user
        self.responses = []

    def _current_user(self):
        # 不跑 cookie/信任头链路：用例显式给用户（_owned_project 多用户隔离照走）
        return self._request_user

    def _respond(self, code, body, content_type, extra_headers=None):
        self.responses.append((code, body, content_type))

    def last_json(self):
        assert self.responses, "端点没有任何响应"
        code, body, ctype = self.responses[-1]
        assert ctype == JSON_CT, ctype
        return code, json.loads(body.decode("utf-8"))


class _RunnerStub:
    """停闸 runner：只记账，不拾取、不起会话（board 入队路径只用到这三口）。"""

    def __init__(self):
        self.submitted = []
        self.submitted_cards = []

    def submit(self, task_id):
        self.submitted.append(task_id)

    def submit_card(self, card_id, *args, **kwargs):
        self.submitted_cards.append(card_id)
        return True

    def notify_busy_change(self, *args, **kwargs):
        pass


@pytest.fixture()
def env(monkeypatch, tmp_path):
    """唯一用户 + 唯一项目（非 dsh 族 ⇒ start 路径在起会话前早退，不会真起会话）。"""
    tag = uuid.uuid4().hex[:8]
    user = db.get_user_by_id(db.insert_user(f"tl-{tag}", "x"))
    work_dir = tmp_path / f"tl-{tag}"
    pid = db.insert_project(user["id"], f"tl-{tag}", str(work_dir / "proj"), "",
                            str(work_dir))
    stub = _RunnerStub()
    # server 的建任务入口用 server.runner_instance；board 的起跑用 runner.INSTANCE——
    # 两处都换成同一个停闸桩，用例才能既不拾取也不真起会话（离线硬约束）。
    monkeypatch.setattr(server, "runner_instance", stub)
    monkeypatch.setattr(runner, "INSTANCE", stub)
    return {"user": user, "pid": pid, "work_dir": work_dir, "runner": stub, "tag": tag}


def _create_task(env, headers=None, query="", body=None):
    """走 `_api_create_task`（真 Handler 方法）建普通任务，返回任务 id。"""
    path = f"/api/projects/{env['pid']}/tasks"
    if query:
        path += "?" + query
    handler = FakeHandler(env["user"], headers, path)
    handler._api_create_task(env["pid"], body if body is not None else {"name": "lang"})
    code, payload = handler.last_json()
    assert code == 200, payload
    return payload["id"]


# --------------------------------------------------------------------------
# ① 迁移：旧库补列 + 存量行默认 zh
# --------------------------------------------------------------------------
def test_migrate_adds_lang_to_tasks_and_board_cards(monkeypatch, tmp_path):
    """pre_alter 夹具（无 lang 列）→ init_db 后两表有 lang，存量行 = 'zh'。"""
    old_db = db.DB_OVERRIDE
    path = tmp_path / "pre_alter.db"
    sql = (SCHEMA_DIR / "fixtures" / "pre_alter.sql").read_text(encoding="utf-8")
    conn = sqlite3.connect(str(path))
    try:
        conn.executescript(sql)
        conn.commit()
    finally:
        conn.close()
    # 先断言夹具确实「老」（否则用例会变成空对空）
    conn = sqlite3.connect(str(path))
    try:
        assert "lang" not in {r[1] for r in conn.execute("PRAGMA table_info(tasks)")}
        assert "lang" not in {r[1] for r in conn.execute("PRAGMA table_info(board_cards)")}
    finally:
        conn.close()

    monkeypatch.setattr(db, "DB_OVERRIDE", str(path))
    try:
        db.init_db()
        conn = sqlite3.connect(str(path))
        conn.row_factory = sqlite3.Row
        try:
            for table in ("tasks", "board_cards"):
                cols = {r["name"]: r for r in conn.execute(f"PRAGMA table_info({table})")}
                assert "lang" in cols, f"{table} 缺 lang 列"
                assert cols["lang"]["type"] == "TEXT"
                assert cols["lang"]["notnull"] == 1
                assert cols["lang"]["dflt_value"] == "'zh'"
            assert conn.execute("SELECT lang FROM tasks WHERE id=1").fetchone()["lang"] == "zh"
            assert conn.execute(
                "SELECT lang FROM board_cards WHERE id=1").fetchone()["lang"] == "zh"
        finally:
            conn.close()
    finally:
        db.DB_OVERRIDE = old_db


# --------------------------------------------------------------------------
# ② 语言取值函数（纯语义，双端同名）
# --------------------------------------------------------------------------
@pytest.mark.parametrize("row,expected", [
    ({"lang": "en"}, "en"),
    ({"lang": "EN"}, "en"),
    ({"lang": " en "}, "en"),
    ({"lang": "en-US"}, "zh"),      # 只认规范化值：未知变体读侧一律 zh
    ({"lang": "zh"}, "zh"),
    ({"lang": "zh-CN"}, "zh"),
    ({"lang": ""}, "zh"),
    ({"lang": None}, "zh"),
    ({}, "zh"),
    (None, "zh"),
    ({"lang": 1}, "zh"),
])
def test_task_lang_and_card_lang_normalize(row, expected):
    assert i18n.task_lang(row) == expected
    assert i18n.card_lang(row) == expected


# --------------------------------------------------------------------------
# ③ 任务创建冻结：来源矩阵
# --------------------------------------------------------------------------
def test_create_task_header_lang(env):
    tid = _create_task(env, {"X-TS-Lang": "en"})
    assert db.get_task(tid)["lang"] == "en"


def test_create_task_query_lang(env):
    tid = _create_task(env, query="lang=en")
    assert db.get_task(tid)["lang"] == "en"


def test_create_task_explicit_header_beats_query(env):
    tid = _create_task(env, {"X-TS-Lang": "zh"}, query="lang=en")
    assert db.get_task(tid)["lang"] == "zh"


@pytest.mark.parametrize("headers,query", [
    ({}, ""),                                  # 无头：存量客户端 → zh
    ({"X-TS-Lang": "fr"}, ""),                 # 非法头 → 跳过 → 无偏好 → zh
    ({"X-TS-Lang": ""}, "lang=xx"),            # 空头 + 非法 query → zh
])
def test_create_task_no_valid_signal_is_zh(env, headers, query):
    tid = _create_task(env, headers, query=query)
    assert db.get_task(tid)["lang"] == "zh"


def test_create_task_user_pref_fallback(monkeypatch, env):
    """无显式信号才读偏好；`{v:'en'}` 包装形状 → en。"""
    calls = []

    def fake_prefs(user_id, project_id):
        calls.append((user_id, project_id))
        return {"lang": {"v": "en"}}

    monkeypatch.setattr(server.db, "get_user_prefs", fake_prefs)
    tid = _create_task(env)
    assert db.get_task(tid)["lang"] == "en"
    assert calls == [(env["user"]["id"], 0)]


def test_create_task_invalid_header_falls_through_to_pref(monkeypatch, env):
    """R27：非法头值跳过并落到下一来源（偏好 en ⇒ en，不是无条件 zh）。"""
    monkeypatch.setattr(server.db, "get_user_prefs",
                        lambda uid, pid: {"lang": {"v": "en"}})
    tid = _create_task(env, {"X-TS-Lang": "fr-FR"})
    assert db.get_task(tid)["lang"] == "en"


def test_create_task_ts_i18n_zero_is_zh_and_reads_no_pref(monkeypatch, env):
    """回滚开关：显式 en 头也压回 zh，且创建路径不得读偏好。"""
    monkeypatch.setenv("TS_I18N", "0")

    def boom(*args, **kwargs):
        raise AssertionError("TS_I18N=0 时创建任务不得读用户偏好")

    monkeypatch.setattr(server.db, "get_user_prefs", boom)
    tid = _create_task(env, {"X-TS-Lang": "en"})
    assert db.get_task(tid)["lang"] == "zh"


# --------------------------------------------------------------------------
# ④ pipeline 后段任务继承父任务语言
# --------------------------------------------------------------------------
def test_pipeline_inherits_parent_lang(env):
    tid = _create_task(env, {"X-TS-Lang": "en"},
                       body={"name": "pipeline", "end_stage": "deploy"})
    assert db.get_task(tid)["lang"] == "en"           # 父任务
    pipelines = [r for r in db.list_tasks(env["pid"]) if r["task_type"] == "pipeline"]
    assert len(pipelines) == 1
    assert pipelines[0]["lang"] == "en"               # 后段继承同一请求语言
    payload = json.loads(pipelines[0]["payload"] or "{}")
    assert payload.get("parent_task_id") == tid


def test_pipeline_zh_stays_zh(env):
    tid = _create_task(env, body={"name": "pipeline-zh", "end_stage": "deploy"})
    assert db.get_task(tid)["lang"] == "zh"
    pipelines = [r for r in db.list_tasks(env["pid"]) if r["task_type"] == "pipeline"]
    assert [r["lang"] for r in pipelines] == ["zh"]


# --------------------------------------------------------------------------
# ⑤ 拒绝 bug 建修例任务：请求语言
# --------------------------------------------------------------------------
def test_reject_bug_task_uses_request_lang(env):
    bug_dir = env["work_dir"] / "bug_report" / "BUG1"
    bug_dir.mkdir(parents=True)
    (bug_dir / "bug_report.md").write_text("# 误报\n\n- **状态**: 待修复\n", encoding="utf-8")
    handler = FakeHandler(env["user"], {"X-TS-Lang": "en"},
                          f"/api/projects/{env['pid']}/bugs/BUG1/reject")
    handler._api_reject_bug(env["pid"], "BUG1", {"reason": "不是产品问题"})
    code, payload = handler.last_json()
    assert code == 200 and payload["task_id"]
    task = db.get_task(payload["task_id"])
    assert task["task_type"] == "reject"
    assert task["lang"] == "en"


# --------------------------------------------------------------------------
# ⑥ runner 自动任务：继承发起任务语言
# --------------------------------------------------------------------------
def _bare_runner(monkeypatch):
    """裸 Runner（不跑 worker 线程）；submit 记账、日志行 no-op。"""
    inst = runner.Runner.__new__(runner.Runner)
    submitted = []

    def fake_submit(task_id, *a, **k):
        submitted.append(task_id)

    monkeypatch.setattr(inst, "submit", fake_submit)
    monkeypatch.setattr(inst, "_log_task_line", lambda *a, **k: None)
    return inst, submitted


def test_auto_retest_inherits_fix_task_lang(monkeypatch, env):
    fix_id = db.insert_task(env["pid"], "修复 BUG1", 0, "不复测", "rounds", "1",
                            "fix", json.dumps({"bug_dir": "BUG1"}),
                            lang="en")
    inst, submitted = _bare_runner(monkeypatch)
    inst._maybe_auto_retest(db.get_project(env["pid"]), db.get_task(fix_id))
    rows = [r for r in db.list_tasks(env["pid"])
            if r["task_type"] in ("retest_bug", "script_retest")]
    assert len(rows) == 1
    assert rows[0]["lang"] == "en"
    assert submitted == [rows[0]["id"]]


def test_auto_retest_zh_stays_zh(monkeypatch, env):
    fix_id = db.insert_task(env["pid"], "修复 BUG2", 0, "不复测", "rounds", "1",
                            "fix", json.dumps({"bug_dir": "BUG2"}))
    inst, _submitted = _bare_runner(monkeypatch)
    inst._maybe_auto_retest(db.get_project(env["pid"]), db.get_task(fix_id))
    rows = [r for r in db.list_tasks(env["pid"])
            if r["task_type"] in ("retest_bug", "script_retest")]
    assert [r["lang"] for r in rows] == ["zh"]


def test_spawn_retest_task_writes_lang(monkeypatch, env):
    """`_spawn_retest_task` 的插入口接受 lang（调用点传发起任务语言）。"""
    inst, _submitted = _bare_runner(monkeypatch)
    project = db.get_project(env["pid"])
    tid = inst._spawn_retest_task(project, "BUG3", [], "/tmp/task-lang-round.log",
                                  "复测", lang="en")
    assert db.get_task(tid)["lang"] == "en"


def test_script_retest_spawn_passes_initiator_lang(monkeypatch, env):
    """脚本复测回落 agent 复测时，语言从发起任务继承（不是请求/默认语言）。"""
    task_id = db.insert_task(env["pid"], "脚本复测 BUG4", 0, "不复测", "rounds", "1",
                             "script_retest", json.dumps({"bug_dir": "BUG4"}),
                             lang="en")
    inst, _submitted = _bare_runner(monkeypatch)
    recorded = []
    monkeypatch.setattr(inst, "_script_case_dirs", lambda project, task: None)
    monkeypatch.setattr(inst, "_script_live", lambda *a, **k: None)
    monkeypatch.setattr(inst, "_spawn_retest_task",
                        lambda *a, **k: recorded.append((a, k)) or 1)
    inst._run_script_retest(db.get_project(env["pid"]), db.get_task(task_id))
    assert len(recorded) == 1
    _args, kwargs = recorded[0]
    assert kwargs.get("lang") == "en"


# --------------------------------------------------------------------------
# ⑦ 卡片：未冻结 / 首轮冻结 / 二次 start 不覆盖 / 原子口
# --------------------------------------------------------------------------
def test_new_card_is_unfrozen_and_payload_falls_back_to_zh(env):
    cid = db.insert_board_card(env["pid"], "新卡")
    row = db.get_board_card(cid)
    assert row["lang"] == ""                     # 未冻结（不是 DEFAULT 'zh'）
    assert board.card_json(row)["lang"] == "zh"  # payload 输出规范化的 zh


def test_set_board_card_lang_first_write_wins(env):
    cid = db.insert_board_card(env["pid"], "原子口")
    assert db.set_board_card_lang(cid, "en") is True
    assert db.set_board_card_lang(cid, "zh") is False     # 已冻结：不覆盖
    assert db.get_board_card(cid)["lang"] == "en"


def test_card_start_freezes_request_lang_once(env):
    cid = db.insert_board_card(env["pid"], "起跑")
    project = db.get_project(env["pid"])
    # runner 在岗 ⇒ 走统一排队路径（落 doing+queue，不真起会话），冻结点在入口生效
    card_dict, err = board.start_into_doing(project, db.get_board_card(cid), "",
                                            lang="en")
    assert card_dict is not None and err is None
    assert card_dict["lang"] == "en"
    assert db.get_board_card(cid)["lang"] == "en"
    assert board.card_json(db.get_board_card(cid))["lang"] == "en"
    # 二次 start 带 zh：不覆盖
    board.start_into_doing(project, db.get_board_card(cid), "", lang="zh")
    assert db.get_board_card(cid)["lang"] == "en"


def test_card_start_without_lang_leaves_unfrozen(env):
    """无请求上下文（定时开工 / 队列拾起 / 内部调用）不写卡：保持 ''，payload 仍 zh。

    注意：**拖列进 doing 不是无 lang 路径**——它来自用户请求，会冻结请求语言
    （见下方 `test_card_move_to_doing_freezes_request_lang` 与 F1 修复轮）。
    """
    cid = db.insert_board_card(env["pid"], "无请求上下文")
    project = db.get_project(env["pid"])
    card_dict, err = board.start_into_doing(project, db.get_board_card(cid), "")
    assert card_dict is not None and err is None
    assert db.get_board_card(cid)["lang"] == ""
    assert board.card_json(db.get_board_card(cid))["lang"] == "zh"


def test_start_card_entry_freezes_lang(env):
    cid = db.insert_board_card(env["pid"], "直起")
    # 退场族（kimi）⇒ start_card 在起会话前必抛 RETIRED_MSG；冻结点仍在入口先写。
    with db.connect() as conn:
        conn.execute("UPDATE projects SET agent_path='kimi' WHERE id=?", (env["pid"],))
    project = db.get_project(env["pid"])
    with pytest.raises(RuntimeError):
        board.start_card(project, db.get_board_card(cid), "", lang="en")
    assert db.get_board_card(cid)["lang"] == "en"
    with pytest.raises(RuntimeError):
        board.start_card(project, db.get_board_card(cid), "", lang="zh")
    assert db.get_board_card(cid)["lang"] == "en"


def test_board_start_endpoint_passes_request_lang(env):
    """start 端点 → start_into_doing(..., lang=self._request_lang()) 的接线。"""
    cid = db.insert_board_card(env["pid"], "端点起跑")
    handler = FakeHandler(env["user"], {"X-TS-Lang": "en"},
                          f"/api/projects/{env['pid']}/board/cards/{cid}/start")
    handler._api_board_card_action(env["pid"], cid, "start", {})
    code, payload = handler.last_json()
    assert code == 200 and payload["card"]["id"] == cid   # 入队路径：不真起会话
    assert db.get_board_card(cid)["lang"] == "en"          # 语言已冻结
    # 第二次换 zh 仍不覆盖
    handler2 = FakeHandler(env["user"], {"X-TS-Lang": "zh"},
                           f"/api/projects/{env['pid']}/board/cards/{cid}/start")
    handler2._api_board_card_action(env["pid"], cid, "start", {})
    assert db.get_board_card(cid)["lang"] == "en"


# --------------------------------------------------------------------------
# ⑦b 修复轮 1（F1/F2/F3）：所有带请求上下文的起跑入口都冻结，且冻结在门禁之后
# --------------------------------------------------------------------------
def _seed_wait_row(pid, cid, state, seq):
    """种子一条活跃 c: 行（运行位/等待区判定用；行即成员）。"""
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO wait_items (project_id, kind, target_id, state, seq,"
            " created_at, meta) VALUES (?,'card',?,?,?,?,'{}')",
            (pid, str(cid), state, float(seq), db.now_str()))


def _bare_card_runner():
    """真实 Runner 裸实例（持 _cond，card_started 等收口可跑；无 worker 线程）。"""
    inst = runner.Runner.__new__(runner.Runner)
    inst._cond = threading.Condition()
    return inst


def test_card_move_to_doing_freezes_request_lang(env):
    """拖列进 doing＝会起会话的 HTTP 请求：move 端点也把请求语言冻结到卡上（F1）。"""
    cid = db.insert_board_card(env["pid"], "拖进开发")
    handler = FakeHandler(env["user"], {"X-TS-Lang": "en"},
                          f"/api/projects/{env['pid']}/board/cards/{cid}/move")
    handler._api_board_card_action(env["pid"], cid, "move", {"column": "doing"})
    code, payload = handler.last_json()
    assert code == 200 and payload["card"]["id"] == cid
    assert payload["card"]["lang"] == "en"      # 响应 payload 已按冻结值输出
    assert env["runner"].submitted_cards == [cid]   # 走排队路径（不真起会话）
    assert db.get_board_card(cid)["lang"] == "en"  # 库值已冻结


def test_move_to_doing_prefers_first_request_lang(env):
    """二次 move 带 zh 不覆盖已冻结的 en（先到先得仍然成立）。"""
    cid = db.insert_board_card(env["pid"], "先到先得")
    db.set_board_card_lang(cid, "en")
    project = db.get_project(env["pid"])
    card_dict, err = board.move_card(project, cid, "doing", lang="zh")
    assert err is None and card_dict is not None
    assert db.get_board_card(cid)["lang"] == "en"


def test_move_force_gesture_freezes_request_lang(env, monkeypatch):
    """doing→doing 强制运行手势（同一 move 端点）也冻结请求语言（F1）。

    起跑本身被打桩（不真起会话）；冻结点在起跑动作之前，起跑失败也定格。
    """
    pid = env["pid"]
    rid = db.insert_board_card(pid, "在跑卡")
    db.update_board_card(rid, column_key="doing")
    _seed_wait_row(pid, rid, "running", 1.0)
    wid = db.insert_board_card(pid, "等待卡")
    waitq.enqueue_card(wid, pid)                # 等待行 + doing/queue 占位
    monkeypatch.setattr(runner, "INSTANCE", _bare_card_runner())
    started = []
    monkeypatch.setattr(board, "start_card",
                        lambda p, c, extra="", lang="": (
                            started.append(c["id"]) or "/tmp/task-lang-force.log"))
    monkeypatch.setattr(board, "run_pid", lambda cid: 4321)
    project = db.get_project(pid)
    card, err = board.move_card(project, wid, "doing", before_id=rid, lang="en")
    assert err is None and card is not None
    assert started == [wid]                    # 真走了 force 直起分支
    assert db.get_board_card(wid)["lang"] == "en"


def test_move_blocked_by_parent_gate_keeps_unfrozen(env):
    """被父任务门禁拒绝的 move **不钉语言**（F3：冻结移到门禁之后）。"""
    parent = db.insert_board_card(env["pid"], "父卡")
    db.update_board_card(parent, column_key="doing")
    child = db.insert_board_card(env["pid"], "子卡")
    db.update_board_card(child, parent_card_id=parent)
    project = db.get_project(env["pid"])
    card_dict, err = board.move_card(project, child, "doing", lang="en")
    assert card_dict is None
    assert err == {"blocked": "parent-not-done"}
    assert db.get_board_card(child)["lang"] == ""     # 被拒绝的意图不污染语言


def test_worktree_merge_endpoint_freezes_request_lang(env, monkeypatch):
    """worktree 合并回交（POST .../worktree/merge）同样是请求：冻结 ctx 语言（F1）。"""
    cid = db.insert_board_card(env["pid"], "合并回交")
    db.update_board_card(cid, column_key="review", worktree="/tmp/wt/card_x",
                         session_id="sid-1")
    monkeypatch.setattr(board.worktree, "merge_status", lambda p, c: {
        "ok": True, "error": "", "path": "/tmp/wt/card_x",
        "branch": "ts/card-%d" % cid, "target": "master", "exists": True,
        "branch_exists": True, "dirty": False, "dirty_count": 0,
        "ahead": 2, "behind": 0})
    # env fixture 的停闸 runner：入队只记账（不拾取、不起会话）
    handler = FakeHandler(env["user"], {"X-TS-Lang": "en"},
                          f"/api/projects/{env['pid']}/board/cards/{cid}/worktree/merge")
    handler._api_board_card_worktree_merge(env["pid"], cid)
    code, payload = handler.last_json()
    assert code == 200 and payload["card"]["id"] == cid
    assert db.get_board_card(cid)["lang"] == "en"
    assert env["runner"].submitted_cards == [cid]


def test_scheduled_start_keeps_unfrozen(env, monkeypatch):
    """定时开工（_watch_once，无请求上下文）不冻结：卡保持 ''（F1 负例）。"""
    pid = env["pid"]
    cid = db.insert_board_card(pid, "定时卡")
    db.update_board_card(cid, scheduled_at=1)   # 已到点
    monkeypatch.setattr(board, "_watch_runs_once", lambda: None)
    monkeypatch.setattr(board, "_heal_queue_placeholders", lambda: 0)
    monkeypatch.setattr(board, "sync_sessions", lambda proj: [])
    real_enter = board._enter_doing
    seen = []

    def _rec(proj, r):
        # 只对本用例的卡走真入口（套件共享库可能残留其他定时卡）；调用形态无 lang
        if r["id"] != cid:
            return None, None
        seen.append(r["id"])
        return real_enter(proj, r)

    monkeypatch.setattr(board, "_enter_doing", _rec)
    board._watch_once()
    assert seen == [cid]
    assert db.get_board_card(cid)["lang"] == ""


def test_dequeue_start_keeps_unfrozen(env, monkeypatch):
    """队列拾起（dequeue_start，无请求上下文）不冻结：卡保持 ''（F1 负例）。"""
    cid = db.insert_board_card(env["pid"], "队列拾起")
    seen = []

    def _fake_start(project, card, extra="", lang=""):
        seen.append(lang)
        return "/tmp/task-lang-dequeue.log"

    monkeypatch.setattr(board, "start_card", _fake_start)
    project = db.get_project(env["pid"])
    assert board.dequeue_start(project, db.get_board_card(cid)) is True
    assert seen == [""]
    assert db.get_board_card(cid)["lang"] == ""


def test_lang_not_in_update_whitelist(env):
    """`lang` 不在任务/卡片 update 白名单：绕过冻结口的写一律被静默丢弃（F2）。"""
    tid = db.insert_task(env["pid"], "白名单", 0, "不复测", "rounds", "1", lang="zh")
    db.update_task(tid, lang="en")
    assert db.get_task(tid)["lang"] == "zh"

    cid = db.insert_board_card(env["pid"], "白名单卡")
    db.set_board_card_lang(cid, "zh")
    db.update_board_card(cid, lang="en")
    assert db.get_board_card(cid)["lang"] == "zh"


# --------------------------------------------------------------------------
# ⑧ payload：任务详情/列表与卡片对象新增规范化 lang
# --------------------------------------------------------------------------
def test_task_json_exposes_normalized_lang(env):
    handler = FakeHandler(env["user"])
    en_id = db.insert_task(env["pid"], "en", 0, "不复测", "rounds", "1", lang="en")
    zh_id = db.insert_task(env["pid"], "zh", 0, "不复测", "rounds", "1", lang="zh")
    empty_id = db.insert_task(env["pid"], "empty", 0, "不复测", "rounds", "1", lang="")
    weird_id = db.insert_task(env["pid"], "weird", 0, "不复测", "rounds", "1",
                              lang="en-GB")
    assert handler._task_json(db.get_task(en_id))["lang"] == "en"
    assert handler._task_json(db.get_task(zh_id))["lang"] == "zh"
    assert handler._task_json(db.get_task(empty_id))["lang"] == "zh"
    assert handler._task_json(db.get_task(weird_id))["lang"] == "zh"
    # 键存在且是规范化后的值（不把原始库值透出去）
    assert set(handler._task_json(db.get_task(en_id))).issuperset({"lang"})


def test_card_json_exposes_normalized_lang(env):
    cid = db.insert_board_card(env["pid"], "payload")
    db.set_board_card_lang(cid, "en")
    assert board.card_json(db.get_board_card(cid))["lang"] == "en"
    with db.connect() as conn:                       # 脏值（手工改库）→ 读侧归一 zh
        conn.execute("UPDATE board_cards SET lang='en-US' WHERE id=?", (cid,))
    assert board.card_json(db.get_board_card(cid))["lang"] == "zh"


# --------------------------------------------------------------------------
# ⑨ 飞书打回起跑：传已解析的收件人语言（R22）
# --------------------------------------------------------------------------
def test_feishu_reject_passes_recipient_lang_to_start_card(monkeypatch, env):
    cid = db.insert_board_card(env["pid"], "待审核卡")
    db.update_board_card(cid, column_key="review")
    project = db.get_project(env["pid"])
    card = db.get_board_card(cid)
    captured = []

    monkeypatch.setattr(feishu, "_find_user_card",
                        lambda uid, key, lang="zh": ((project, card), ""))
    monkeypatch.setattr(board, "start_card",
                        lambda p, c, extra="", lang="": captured.append(
                            (p["id"], c["id"], extra, lang)) or "/tmp/task-lang.log")

    text = feishu._execute_board_action(
        {"user_id": env["user"]["id"]},
        {"action": "reject", "groups": [str(cid), "再改改"]},
        "ou_test", lang="en")
    assert captured == [(env["pid"], cid, "再改改", "en")]
    assert text  # 回执文案照旧产出（语言由既有 t('api', …) 渲染，不在本任务范围）
