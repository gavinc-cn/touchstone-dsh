#!/usr/bin/env python3
"""对拍探针（过渡期专用，Gate 2 删 Python 时一并删除）：在**同一份冻结库字节**上跑
Python `db.py` 的读函数，把结果 dump 成 JSON 供 Node 侧逐项 deep-equal。

为什么需要它：Node 版 `backend/lib/db.js` 读路径（M3）的判据是「与 Python 同名函数
逐点等价」，而只有真跑 Python 才能给出这个基准（`backend/test/db-read.test.mjs` 的
跨语言抽查段是调用方）。口径**就是 Python 函数本身**——探针只做两件事：把 `db.DB_OVERRIDE`
指到请求给的库（等价于 `TOUCHSTONE_DB` 环境变量，Python 侧模块级常量，只能这么改）、
把 sqlite3.Row 转成 JSON 可表达的 dict/list。任何"顺手归一"（改排序、补默认值、转类型）
都会把差异掩盖掉，故一律不做。

用法：
    python3 tools/parity/probe/db_read.py --db <库文件> [--request <json 文件>]
    缺省从 stdin 读一个 JSON 请求：
        {"db": "<库文件路径，可被 --db 覆盖>", "ops": [{"op": "...", ...}, ...]}
    每个 op 输出一行 JSON：{"i": <序号>, "ok": true, "value": ...}
                     或 {"i": <序号>, "ok": false, "error_kind": "TypeError", "error": "..."}

**只读**：探针只会调 db.py 的读函数（SELECT），绝不写库；调用方仍应传一份库拷贝的路径
（生产库 `~/.touchstone/touchstone.db` 永远不要指过来）。`meta` op 回文件 sha256，
供对拍器证明「两侧读的是同一份冻结字节」。

支持的 op（字段即 Python 函数的实参；带 id 的 op 需要调用方自己给真实 id）：
    meta / cases_root{work_dir} / bug_root{work_dir} / row_opt{row,key,default}
    project_view{project_id} / list_projects{user_id} / list_projects_all
    get_project{project_id} / list_users
    get_task{task_id} / list_tasks{project_id} / list_all_tasks
    list_rounds{task_id} / get_round{round_id} / get_log_round{task_id,round_no}
    get_board_card{card_id} / list_board_cards{project_id} / list_trashed_cards{project_id}
    board_counts_many{project_ids} / list_queued_board_cards / list_board_comments{project_id}
    get_board_settings{project_id} / get_app_setting{key} / get_user_prefs{user_id,project_id}
"""
import hashlib
import json
import os
import sqlite3
import sys

# Python 后端源码在 <仓库>/backend_py/（2026-10-19 起）
sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))))),
    "backend_py"))

import db  # noqa: E402


def _jsonable(value):
    """sqlite3.Row → dict（Python 侧返回的行有两种形态：Row 与 dict），递归到底。"""
    if isinstance(value, sqlite3.Row):
        return {k: _jsonable(value[k]) for k in value.keys()}
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    return value


def _raw_project_row(project_id):
    """取 projects 的**原始行**（不注入派生键），专供 project_view op 单独验证注入逻辑。"""
    with db.connect() as conn:
        return conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()


def _meta():
    """库指纹：路径 + sha256 + schema 版本（对拍前置断言「两侧同一份字节」用）。"""
    path = db.db_path()
    with open(path, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    return {"path": path, "sha256": digest, "schema_version": db.SCHEMA_VERSION}


OPS = {
    "meta": lambda o: _meta(),
    "cases_root": lambda o: db.cases_root_of(o["work_dir"]),
    "bug_root": lambda o: db.bug_root_of(o["work_dir"]),
    "row_opt": lambda o: db.row_opt(o.get("row"), o["key"], o.get("default", "")),
    "project_view": lambda o: db.project_view(_raw_project_row(o["project_id"])),
    "list_projects": lambda o: db.list_projects(o["user_id"]),
    "list_projects_all": lambda o: db.list_projects_all(),
    "get_project": lambda o: db.get_project(o["project_id"]),
    "list_users": lambda o: db.list_users(),
    "get_task": lambda o: db.get_task(o["task_id"]),
    "list_tasks": lambda o: db.list_tasks(o["project_id"]),
    "list_all_tasks": lambda o: db.list_all_tasks(),
    "list_rounds": lambda o: db.list_rounds(o["task_id"]),
    "get_round": lambda o: db.get_round(o["round_id"]),
    "get_log_round": lambda o: db.get_log_round(o["task_id"], o["round_no"]),
    "get_board_card": lambda o: db.get_board_card(o["card_id"]),
    "list_board_cards": lambda o: db.list_board_cards(o["project_id"]),
    "list_trashed_cards": lambda o: db.list_trashed_cards(o["project_id"]),
    "board_counts_many": lambda o: db.board_counts_many(o["project_ids"]),
    "list_queued_board_cards": lambda o: db.list_queued_board_cards(),
    "list_board_comments": lambda o: db.list_board_comments(o["project_id"]),
    "get_board_settings": lambda o: db.get_board_settings(o["project_id"]),
    "get_app_setting": lambda o: db.get_app_setting(o["key"]),
    "get_user_prefs": lambda o: db.get_user_prefs(o["user_id"], o["project_id"]),
}


def main(argv):
    db_file = None
    request_path = None
    i = 1
    while i < len(argv):
        if argv[i] == "--db":
            i += 1
            db_file = argv[i]
        elif argv[i] == "--request":
            i += 1
            request_path = argv[i]
        else:
            print(f"未知参数: {argv[i]}", file=sys.stderr)
            return 2
        i += 1
    raw = open(request_path, encoding="utf-8").read() if request_path else sys.stdin.read()
    req = json.loads(raw)
    target = db_file or req.get("db")
    if not target:
        print("必须给库路径（--db 或请求里的 db 字段）", file=sys.stderr)
        return 2
    # 只有模块级 DB_OVERRIDE 能改落点（等价于 TOUCHSTONE_DB），改前先确认文件真在
    db.DB_OVERRIDE = os.path.abspath(target)
    for idx, op in enumerate(req.get("ops") or []):
        name = op.get("op")
        fn = OPS.get(name)
        if fn is None:
            print(json.dumps({"i": idx, "ok": False, "error_kind": "UnknownOp",
                              "error": f"未知 op: {name}"}, ensure_ascii=False), flush=True)
            continue
        try:
            value = _jsonable(fn(op))
        except Exception as e:  # noqa: BLE001 —— 探针要把异常形态如实带给对拍器
            print(json.dumps({"i": idx, "ok": False, "error_kind": type(e).__name__,
                              "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False), flush=True)
            continue
        print(json.dumps({"i": idx, "ok": True, "value": value}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
