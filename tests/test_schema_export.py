#!/usr/bin/env python3
"""数据层共享契约守卫（M1，2026-10-11）。

`backend/schema/*` 是 Python（真源在 `db.py`）与 Node（`backend/lib/db.js`）共用的
数据层契约，由 `tools/export_schema.py` 实测导出。本文件是它的**漂移守卫**：

1. 已提交的契约文件必须与「重新导出」逐字节一致（改 db.py 后忘了重跑导出 ⇒ 红）；
2. 契约自洽：`schema.sql` 单独执行即可建出与 `db.init_db()` 完全一致的结构；
3. 两套老库夹具（committed 的 .sql 文本）经 `db.init_db()` 必须收敛回目标结构，
   且数据级迁移的实际效果逐条成立（夹具是「迁移行为」的可执行规格）；
4. 迁移清单本身的不变量：幂等、未知守卫/未知 handler 一律报错（绝不静默跳过）。
"""
import importlib.util
import json
import os
import sqlite3
import sys
import tempfile

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
# Python 后端源码在 backend_py/（2026-10-19 起）；导出器本身也按此目录 import 后端模块
sys.path.insert(0, os.path.join(ROOT, "backend_py"))

import db                                                            # noqa: E402

TOOL_PATH = os.path.join(ROOT, "tools", "export_schema.py")
SCHEMA_DIR = os.path.join(ROOT, "backend", "schema")


def _load_tool():
    spec = importlib.util.spec_from_file_location("ts_export_schema", TOOL_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def isolated_db():
    """隔离 db 模块的库路径与环境（导出器会改 DB_OVERRIDE / TS_ADMIN_PASSWORDLESS）。"""
    old_path = db.DB_OVERRIDE
    old_env = {k: os.environ.get(k) for k in ("TS_ADMIN_PASSWORDLESS", "TS_ADMIN_PASSWORD")}
    tmpdir = tempfile.mkdtemp(prefix="ts-schema-guard-")
    try:
        yield tmpdir
    finally:
        db.DB_OVERRIDE = old_path
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def _exec_sql_file(path):
    """把一份夹具 .sql 执行进一个新库，返回库路径。"""
    out = os.path.join(tempfile.mkdtemp(prefix="ts-fixture-"), "fixture.db")
    conn = sqlite3.connect(out)
    try:
        with open(path, encoding="utf-8") as f:
            conn.executescript(f.read())
        conn.commit()
    finally:
        conn.close()
    return out


def _target_view(tool, tmpdir):
    """跑一次真 init_db() 得到的「目标结构视图」。"""
    db.DB_OVERRIDE = os.path.join(tmpdir, "fresh.db")
    db.init_db()
    return tool.structure_view(tool.snapshot(db.DB_OVERRIDE))


# --------------------------------------------------------------------------
# 1. 漂移守卫
# --------------------------------------------------------------------------

def test_committed_contract_matches_db_truth(isolated_db):
    """已提交的 backend/schema/* 必须与「现在从 db.py 重新导出」逐字节一致。

    这是「两侧不各存一份手写 schema」的机械保证：只改 db.py 不重跑导出，这条即红。
    """
    tool = _load_tool()
    files = tool.export_all(SCHEMA_DIR)
    assert sorted(files) == ["fixtures/ancient.sql", "fixtures/pre_alter.sql",
                             "migrations.json", "schema.json", "schema.sql"]
    drifted = []
    for rel, text in sorted(files.items()):
        with open(os.path.join(SCHEMA_DIR, rel), "rb") as f:
            if f.read() != text.encode("utf-8"):
                drifted.append(rel)
    assert not drifted, (
        f"契约漂移：{drifted} 与重新导出不一致——请跑 `python3 tools/export_schema.py` "
        f"重新导出并提交（改 db.py 的 SCHEMA/MIGRATIONS/migrate() 之后必须重跑）")


def test_schema_version_consistent(isolated_db):
    """三处 schema 版本号同源：db.SCHEMA_VERSION / schema.json / migrations.json。"""
    with open(os.path.join(SCHEMA_DIR, "schema.json"), encoding="utf-8") as f:
        schema_json = json.load(f)
    with open(os.path.join(SCHEMA_DIR, "migrations.json"), encoding="utf-8") as f:
        migrations_json = json.load(f)
    assert schema_json["schemaVersion"] == db.SCHEMA_VERSION
    assert migrations_json["schemaVersion"] == db.SCHEMA_VERSION


def test_migrations_json_covers_python_handlers(isolated_db):
    """清单里出现的 handler 必须在 Python 注册表里有实现（Node 侧另有自查）。"""
    with open(os.path.join(SCHEMA_DIR, "migrations.json"), encoding="utf-8") as f:
        steps = json.load(f)["steps"]
    assert len(steps) == len(db.MIGRATIONS) >= 10
    for step in steps:
        if step.get("handler"):
            assert step["handler"] in db.MIGRATION_HANDLERS, step["id"]
        assert step.get("sql") or step.get("handler"), step["id"]


# --------------------------------------------------------------------------
# 2. schema.sql 自足性
# --------------------------------------------------------------------------

def test_schema_sql_builds_exact_target(isolated_db):
    """schema.sql 整段执行 == db.init_db() 的结构（列集合与索引逐项相同）。"""
    tool = _load_tool()
    target = _target_view(tool, isolated_db)
    out = os.path.join(isolated_db, "from_sql.db")
    conn = sqlite3.connect(out)
    try:
        with open(os.path.join(SCHEMA_DIR, "schema.sql"), encoding="utf-8") as f:
            conn.executescript(f.read())
        conn.commit()
    finally:
        conn.close()
    assert tool.structure_view(tool.snapshot(out)) == target


# --------------------------------------------------------------------------
# 3. 夹具：老库 → 目标（迁移行为规格）
# --------------------------------------------------------------------------

def _converge(tool, fixture_rel, rounds):
    """执行 committed 夹具 → 跑 rounds 轮 init_db → 返回（库路径、结构视图、行查询口）。"""
    path = _exec_sql_file(os.path.join(SCHEMA_DIR, fixture_rel))
    db.DB_OVERRIDE = path
    for _ in range(rounds):
        db.init_db()
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return path, tool.structure_view(tool.snapshot(path)), conn


def test_pre_alter_fixture_converges_to_target(isolated_db):
    """夹具①（缺 ALTER 补列的老库）：一轮 init_db 后结构 == 目标。"""
    tool = _load_tool()
    target = _target_view(tool, isolated_db)
    _path, got, conn = _converge(tool, "fixtures/pre_alter.sql", 1)
    try:
        assert got == target
        assert conn.execute("SELECT json FROM app_settings"
                            " WHERE key='schema_version'").fetchone()["json"] == "1"
    finally:
        conn.close()


def test_ancient_fixture_converges_and_runs_every_declared_migration(isolated_db):
    """夹具②（更老的年代）：两轮收敛 + 每条数据级迁移的实际效果逐条断言。"""
    tool = _load_tool()
    target = _target_view(tool, isolated_db)
    path = _exec_sql_file(os.path.join(SCHEMA_DIR, "fixtures/ancient.sql"))
    db.DB_OVERRIDE = path
    db.init_db()
    # 第一轮的已知行为：projects 全局唯一约束触发重建，重建只搬 12 个老列，
    # 后加的 9 列（model/archived/skill_*5 列/reasoning_effort/permission_mode）被丢掉，
    # 第二轮补列加回——两侧必须一致，对拍器同样按两轮快照
    after1 = tool.structure_view(tool.snapshot(path))
    cols1 = {c[0] for c in after1["projects"]["columns"]}
    assert "model" not in cols1 and "archived" not in cols1
    db.init_db()
    got = tool.structure_view(tool.snapshot(path))
    assert got == target

    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        proj = conn.execute("SELECT bug_dir, work_dir, user_id, guide_text, commit_spec,"
                            " deploy_spec FROM projects WHERE id=1").fetchone()
        assert proj["bug_dir"] == ""                       # 工作目录化：废弃列置空
        assert proj["work_dir"] == "/tmp/ts-fixture/proj"  # 旧「案例库根」取父目录
        assert proj["user_id"] == 1                        # 回填给 admin
        assert "git commit message 规范：fix: 老规范" in proj["guide_text"]
        assert "部署说明：部署：老说明" in proj["guide_text"]
        assert proj["commit_spec"] == "" and proj["deploy_spec"] == ""
        assert conn.execute("SELECT state FROM wait_items WHERE kind='card'"
                            ).fetchone()["state"] == "starting"
        assert conn.execute("SELECT count(*) AS n FROM sqlite_master WHERE name='leases'"
                            ).fetchone()["n"] == 0
        assert conn.execute("SELECT count(*) AS n FROM feishu_user_cfgs"
                            ).fetchone()["n"] == 1
        card = conn.execute("SELECT column_key, block_text, last_error FROM board_cards"
                            " WHERE id=1").fetchone()
        assert card["column_key"] == "doing"        # blocked+queue → doing
        assert card["block_text"] == "" and card["last_error"] == ""
        idx_sql = conn.execute("SELECT sql FROM sqlite_master"
                               " WHERE name='idx_wait_active'").fetchone()["sql"]
        assert "'starting'" in idx_sql
    finally:
        conn.close()


# --------------------------------------------------------------------------
# 4. 迁移器不变量
# --------------------------------------------------------------------------

def test_declared_migrations_are_idempotent(isolated_db):
    """清单可重复跑：第二轮只应执行「无条件 + 幂等」的三步，且不再有数据改写。"""
    db.DB_OVERRIDE = os.path.join(isolated_db, "fresh.db")
    db.init_db()
    again = db.run_declared_migrations()
    assert again == ["2026-09-04_projects_user_name_unique_index",
                     "2026-09-24_drop_leases",
                     "2026-10-11_schema_version_stamp"]
    conn = db.connect()
    try:
        assert conn.execute("SELECT count(*) AS n FROM app_settings"
                            " WHERE key='schema_version'").fetchone()["n"] == 1
    finally:
        conn.close()


def test_unknown_guard_kind_raises(isolated_db):
    """未知守卫 kind 必须报错（静默跳过会让两侧库悄悄分叉）。"""
    db.DB_OVERRIDE = os.path.join(isolated_db, "fresh.db")
    db.init_db()
    conn = db.connect()
    try:
        with pytest.raises(ValueError):
            db.migration_when_hit(conn, {"kind": "no-such-kind"})
    finally:
        conn.close()


def test_unknown_handler_raises(isolated_db, monkeypatch):
    """未知 handler 必须报错退出，绝不静默跳过。"""
    db.DB_OVERRIDE = os.path.join(isolated_db, "fresh.db")
    db.init_db()
    monkeypatch.setattr(db, "MIGRATIONS", [
        {"id": "bogus", "desc": "假步骤", "when": None, "handler": "nope_not_impl"}])
    with pytest.raises(RuntimeError):
        db.run_declared_migrations()


def test_guards_fire_only_when_condition_holds(isolated_db):
    """rows 守卫：条件不成立时跳过、成立时执行（老库夹具上全部 13 步都该触发）。"""
    path = _exec_sql_file(os.path.join(SCHEMA_DIR, "fixtures/ancient.sql"))
    db.DB_OVERRIDE = path
    executed = db.run_declared_migrations()          # 夹具上直接跑清单（不先 migrate）
    ids = {step["id"] for step in db.MIGRATIONS}
    assert set(executed) == ids, "老库夹具应触发全部声明式迁移"
    conn = db.connect()
    try:
        assert conn.execute("SELECT state FROM wait_items WHERE kind='card'"
                            ).fetchone()["state"] == "starting"
    finally:
        conn.close()
