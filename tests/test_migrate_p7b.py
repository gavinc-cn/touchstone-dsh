#!/usr/bin/env python3
"""P7b 存量数据迁移脚本（`migrate_p7b.py`）单测：legacy 判定、dry-run 不改写、
apply 的范围（只动 legacy 项目）、备份与清单、幂等。

用最小 schema（只建本脚本读写的三张表）——迁移逻辑不依赖平台完整建表。
"""
import json
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import migrate_p7b                                          # noqa: E402


def _mkdb(path, projects, cards=(), tasks=()):
    """建最小库：projects(id,name,agent_path) / board_cards / tasks。"""
    conn = sqlite3.connect(path)
    conn.executescript(
        "CREATE TABLE projects(id INTEGER PRIMARY KEY, name TEXT, agent_path TEXT);"
        "CREATE TABLE board_cards(id INTEGER PRIMARY KEY, project_id INTEGER, "
        "session_id TEXT, sessions TEXT);"
        "CREATE TABLE tasks(id INTEGER PRIMARY KEY, project_id INTEGER, session_id TEXT);")
    conn.executemany("INSERT INTO projects VALUES(?,?,?)", projects)
    conn.executemany("INSERT INTO board_cards VALUES(?,?,?,?)", cards)
    conn.executemany("INSERT INTO tasks VALUES(?,?,?)", tasks)
    conn.commit()
    conn.close()


@pytest.mark.parametrize("path,legacy", [
    ("", False),                                    # 未配置＝默认族，不动
    ("dsh-plugin:/usr/bin/dsh", False),             # 已迁移
    ("kimi-web:/usr/bin/kimi", True),               # web 虚拟条目
    ("opencode-web:/usr/bin/opencode", True),
    ("/usr/local/bin/kimi", True),                  # CLI 族
    ("/usr/local/bin/opencode", True),
    ("/usr/bin/claude", True),
    ("/opt/conda/bin/hermes", True),
    ("/usr/bin/dsh", True),                         # dsh CLI 族（已下线，归到插件）
    ("/usr/bin/true", False),                       # 未知名＝默认族，不动
])
def test_is_legacy_truth_table(path, legacy):
    """legacy 判定真值表：空/已迁移/未知名都不动，只迁移明确属于已下线族的路径。"""
    assert migrate_p7b.is_legacy(path) is legacy


def test_plan_counts_only_legacy(tmp_path):
    db = str(tmp_path / "t.db")
    _mkdb(db,
          projects=[(1, "老的", "kimi-web:/usr/bin/kimi"),
                    (2, "已迁", "dsh-plugin:/usr/bin/dsh"),
                    (3, "空族", ""),
                    (4, "未知", "/usr/bin/true")],
          cards=[(10, 1, "s-kimi", '["s-kimi"]'),     # legacy：待清
                 (11, 2, "s-dsh", '["s-dsh"]'),       # dsh：不能动
                 (12, 1, "", "[]")],                  # legacy 但本就空：不计
          tasks=[(20, 1, "s-kimi"), (21, 2, "s-dsh"), (22, 4, "")])
    p = migrate_p7b.plan(db)
    assert [r["id"] for r in p["projects"]] == [1]
    assert p["cards"] == 1 and p["tasks"] == 1


def test_apply_scope_backup_and_idempotent(tmp_path):
    """apply：只改 legacy 项目的列；备份+清单落盘；再跑一次为 no-op。"""
    db = str(tmp_path / "t.db")
    _mkdb(db,
          projects=[(1, "老的", "kimi-web:/usr/bin/kimi"),
                    (2, "已迁", "dsh-plugin:/usr/bin/dsh")],
          cards=[(10, 1, "s-kimi", '["s-kimi"]'),
                 (11, 2, "s-dsh", '["s-dsh"]')],
          tasks=[(20, 1, "s-kimi"), (21, 2, "s-dsh")])
    res = migrate_p7b.apply(db, "/usr/bin/dsh")
    assert res["changed"] is True
    assert len(res["projects"]) == 1 and res["cards"] == 1 and res["tasks"] == 1
    assert os.path.isfile(res["backup"]) and os.path.isfile(res["manifest"])
    man = json.load(open(res["manifest"], encoding="utf-8"))
    assert man["projects"][0]["old"] == "kimi-web:/usr/bin/kimi"
    assert man["projects"][0]["new"] == "dsh-plugin:/usr/bin/dsh"

    conn = sqlite3.connect(db)
    rows = {r[0]: r for r in conn.execute(
        "SELECT id, agent_path FROM projects")}
    assert rows[1][1] == "dsh-plugin:/usr/bin/dsh"
    assert rows[2][1] == "dsh-plugin:/usr/bin/dsh"          # dsh 项目原样
    cards = {r[0]: r for r in conn.execute(
        "SELECT id, session_id, sessions FROM board_cards")}
    assert cards[10][1] == "" and cards[10][2] == "[]"      # legacy 卡解绑
    assert cards[11][1] == "s-dsh"                          # dsh 卡不动
    tasks = {r[0]: r for r in conn.execute("SELECT id, session_id FROM tasks")}
    assert tasks[20][1] == "" and tasks[21][1] == "s-dsh"
    conn.close()

    again = migrate_p7b.apply(db, "/usr/bin/dsh")
    assert again["changed"] is False                        # 幂等


def test_dry_run_does_not_write(tmp_path, capsys):
    """默认 dry-run：只打印计划，数据一行不改。"""
    db = str(tmp_path / "t.db")
    _mkdb(db, projects=[(1, "老的", "/usr/bin/kimi")],
          cards=[(10, 1, "s-kimi", '["s-kimi"]')], tasks=[(20, 1, "s-kimi")])
    assert migrate_p7b.main(["--db", db]) == 0
    out = capsys.readouterr().out
    assert "dry-run" in out and "--apply" in out
    conn = sqlite3.connect(db)
    assert conn.execute("SELECT agent_path FROM projects").fetchone()[0] == "/usr/bin/kimi"
    assert conn.execute("SELECT session_id FROM board_cards").fetchone()[0] == "s-kimi"
    conn.close()


def test_apply_without_legacy_is_noop(tmp_path):
    """没有 legacy 项目时不备份、不写清单（避免噪音文件）。"""
    db = str(tmp_path / "t.db")
    _mkdb(db, projects=[(1, "已迁", "dsh-plugin:/usr/bin/dsh")])
    res = migrate_p7b.apply(db, "/usr/bin/dsh")
    assert res["changed"] is False and res["backup"] == ""
    assert not [f for f in os.listdir(tmp_path) if ".bak-p7b-" in f]
