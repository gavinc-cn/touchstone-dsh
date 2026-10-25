#!/usr/bin/env python3
"""导出数据层共享契约：`backend/schema/*`（Node 后端重写 M1，2026-10-11）。

**真源在 `db.py`**（`SCHEMA` 字符串 + `MIGRATIONS` 声明式清单 + `migrate()` 的 DDL 补列），
本脚本把真源**实测导出**成 Node 侧只读的契约文件：

    backend/schema/schema.sql            目标 schema 的完整 DDL（可整段执行，幂等）
    backend/schema/schema.json           结构化目标（表/列/索引；Node 收敛器按它补列建索引）
    backend/schema/migrations.json       数据级/结构重建迁移清单（两版执行同一份）
    backend/schema/fixtures/pre_alter.sql  旧库夹具①：缺 ALTER 补列、无历史包袱
    backend/schema/fixtures/ancient.sql    旧库夹具②：更老的年代（全局唯一索引/leases/
                                           claimed 行/旧局部索引/待桥接飞书配置）

用法：

    python3 tools/export_schema.py            # 重新导出（写盘）
    python3 tools/export_schema.py --check    # 只校验：重导出与已提交文件必须逐字节一致
    python3 tools/export_schema.py --print-snapshot <库文件>   # 调试：打印结构快照

改 `db.py` 的 SCHEMA/MIGRATIONS/migrate() 之后**必须重跑导出**；pytest
`tests/test_schema_export.py` 用 `--check` 做漂移守卫（不重跑就红）。

设计口径（与方案 §3.4 的差异，已在实施记录里说明）：
  - Python 侧**不在运行期读**这些文件（零新增启动失败面），靠 `--check` 守卫「导出与真源
    逐字节一致」达到同一目的：两侧不会各存一份手写 schema。
  - 列**顺序**不属于契约（老库经 ALTER 补列的顺序与新库 DDL 顺序本就不同）：结构比对按
    列集合（name/type/notnull/default/pk）与索引条目，DDL 原文只用于生成 schema.sql。
"""

import argparse
import difflib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_DIR = REPO_ROOT / "backend" / "schema"
FIXTURE_DIR = SCHEMA_DIR / "fixtures"

# 生成物抬头（**不含时间戳**：必须逐字节可复现，否则 --check 无意义）
SQL_HEADER = "-- 由 tools/export_schema.py 从 db.py 生成，请勿手改。改 db.py 后重跑导出。"

# 远古夹具相对目标 schema 缺哪些列（= migrate() 里 ALTER 补的那些列）。
# 这是「年代快照」，随 migrate() 新增补列时必须同步（导出器的自检会兜住漏改：
# 夹具经 init_db() 后必须收敛回目标结构，漏列会直接报错）。
ANCIENT_DROP_COLUMNS = {
    "users": ["must_change_pw"],
    "tasks": ["task_type", "start_stage", "end_stage", "payload", "extra", "model",
              "permission", "auto_commit", "auto_deploy", "auto_retest", "cases_base",
              "fresh_prompt", "date_from", "date_to", "load_rerun", "lang"],
    "rounds": ["kind", "run_key"],
    "projects": ["model", "archived", "skill_understand", "skill_deploy", "skill_commit",
                 "skill_test", "skill_cases", "reasoning_effort", "permission_mode"],
    "board_cards": ["origin", "done_at", "trashed", "trashed_at", "worktree", "unread",
                    "lang"],
    "feishu_outbox": ["user_id"],
    "feishu_bindings": ["cur_sid", "cur_project_id", "cur_title", "cur_bound_at"],
    "wait_items": ["last_seen", "evidence"],
}

# 远古夹具里的索引降级：idx_wait_active 的旧口径（claimed 尚未被 starting 吸收）
ANCIENT_INDEX_OVERRIDES = {
    "idx_wait_active": (
        "CREATE UNIQUE INDEX idx_wait_active ON wait_items(kind, target_id)"
        " WHERE state IN ('waiting','claimed','running','finishing')"
    ),
}

# 远古夹具额外声明（目标 schema 里没有、只在老库里存在的东西）
ANCIENT_EXTRA_DDL = [
    """CREATE TABLE leases (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    kind      TEXT NOT NULL,
    target_id TEXT NOT NULL,
    acquired  REAL NOT NULL DEFAULT 0,
    note      TEXT NOT NULL DEFAULT '{}'
)""",
    "CREATE INDEX idx_leases_project ON leases(target_id)",
]


# --------------------------------------------------------------------------
# schema 快照
# --------------------------------------------------------------------------

def _strip_if_not_exists(sql):
    """去掉 CREATE 语句里的 IF NOT EXISTS（sqlite_master 本就不存它，这里做归一）。"""
    return (sql or "").replace("IF NOT EXISTS ", "").replace("IF NOT EXISTS", "").strip()


def _with_if_not_exists(sql):
    """给 CREATE 语句补上 IF NOT EXISTS（schema.sql 必须整段幂等可执行）。"""
    if "IF NOT EXISTS" in sql:
        return sql
    for head in ("CREATE UNIQUE INDEX ", "CREATE INDEX ", "CREATE TABLE "):
        if sql.startswith(head):
            return head + "IF NOT EXISTS " + sql[len(head):]
    raise ValueError(f"无法补 IF NOT EXISTS 的语句: {sql[:60]!r}")


def _quote_ident(name):
    return '"' + str(name).replace('"', '""') + '"'


def _columns_of(conn, table):
    return [{"name": r["name"], "type": r["type"], "notnull": int(r["notnull"]),
             "dflt": r["dflt_value"], "pk": int(r["pk"])}
            for r in conn.execute(f"PRAGMA table_info({_quote_ident(table)})")]


def _indexes_of(conn, table):
    out = []
    for r in conn.execute(f"PRAGMA index_list({_quote_ident(table)})"):
        cols = [c["name"] for c in
                conn.execute(f"PRAGMA index_info({_quote_ident(r['name'])})")]
        # PRAGMA index_list 不给 DDL 原文（只有 sqlite_master 有；自动索引恒为 NULL）
        row = conn.execute("SELECT sql FROM sqlite_master WHERE type='index'"
                           " AND name=?", (r["name"],)).fetchone()
        out.append({"name": r["name"], "unique": int(r["unique"]), "origin": r["origin"],
                    "partial": int(r["partial"]),
                    "sql": _strip_if_not_exists(row["sql"]) if row and row["sql"] else None,
                    "columns": cols})
    out.sort(key=lambda x: x["name"])
    return out


def snapshot(db_path):
    """结构快照：表（列集合 + 索引条目）按 sqlite_master 创建序。

    列顺序**不入契约**（老库 ALTER 补列序 ≠ 新库 DDL 序），比对时按列集合。
    """
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        tables = []
        for r in conn.execute(
                "SELECT name, sql FROM sqlite_master WHERE type='table'"
                " AND name NOT LIKE 'sqlite_%' ORDER BY rowid"):
            tables.append({"name": r["name"], "ddl": _strip_if_not_exists(r["sql"] or ""),
                           "columns": _columns_of(conn, r["name"]),
                           "indexes": _indexes_of(conn, r["name"])})
        return {"tables": tables}
    finally:
        conn.close()


def _norm_sql(sql):
    """SQL 文本归一：去 IF NOT EXISTS + 折叠空白（DDL 换行/缩进不算差异）。

    两侧执行的语句文本可能一个来自 SCHEMA（多行缩进）、一个来自 migrations.json
    （单行），折叠空白后应逐字符相同——这也是对拍时判「索引定义一致」的口径。
    """
    return " ".join(_strip_if_not_exists(sql).split())


def structure_view(snap):
    """结构视图：列集合 + 索引（名字/唯一性/列/WHERE 原文归一），用于收敛自检与对拍。"""
    view = {}
    for t in snap["tables"]:
        view[t["name"]] = {
            "columns": sorted((c["name"], c["type"].upper(), c["notnull"], c["dflt"],
                               c["pk"]) for c in t["columns"]),
            "indexes": {i["name"]: (i["unique"], tuple(i["columns"]),
                                    _norm_sql(i["sql"]) if i["sql"] else None)
                        for i in t["indexes"]},
        }
    return view


# --------------------------------------------------------------------------
# 夹具（旧库年代快照）
# --------------------------------------------------------------------------

def _ddl_from_columns(table, cols, pk_cols, unique_sets, extra_constraints=()):
    """按列元数据重建 CREATE TABLE（只用于夹具：丢掉目标 schema 里后来补的列）。"""
    lines = []
    composite_pk = [c["name"] for c in cols if c["pk"]] if len(pk_cols) > 1 else []
    for c in cols:
        piece = f"    {c['name']} {c['type'] or 'TEXT'}"
        if c["notnull"]:
            piece += " NOT NULL"
        if c["dflt"] is not None:
            d = c["dflt"]
            if not (d.startswith("'") or d.upper() in ("NULL", "TRUE", "FALSE")
                    or _is_number(d)):
                d = f"({d})"
            piece += f" DEFAULT {d}"
        if len(pk_cols) == 1 and c["pk"]:
            piece += " PRIMARY KEY"
        lines.append(piece)
    if composite_pk:
        lines.append("    PRIMARY KEY (" + ", ".join(composite_pk) + ")")
    for us in unique_sets:
        lines.append("    UNIQUE (" + ", ".join(us) + ")")
    lines.extend("    " + e for e in extra_constraints)
    body = ",\n".join(lines)
    return f"CREATE TABLE {table} (\n{body}\n)"


def _is_number(text):
    try:
        float(text)
        return True
    except (TypeError, ValueError):
        return False


def _legacy_ddl(conn, drops):
    """由目标 schema 生成「老库年代」DDL：每表去掉 drops 里的列，UNIQUE 约束照搬。"""
    ddl_list = []
    targets = {}
    for r in conn.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='table'"
            " AND name NOT LIKE 'sqlite_%' ORDER BY rowid"):
        targets[r["name"]] = r["sql"]
    for table, _sql in targets.items():
        cols = [c for c in _columns_of(conn, table) if c["name"] not in drops.get(table, [])]
        pk_cols = [c["name"] for c in cols if c["pk"]]
        unique_sets = [tuple(i["columns"]) for i in _indexes_of(conn, table)
                       if i["origin"] == "u" and i["columns"]]
        ddl_list.append(_ddl_from_columns(table, cols, pk_cols, unique_sets))
    # 目标 schema 里的普通索引逐条照搬（降级覆盖者用旧口径；migrate() 建的
    # idx_projects_user_name 不进夹具——夹具是「迁移前」状态）
    index_sql = []
    for r in conn.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='index'"
            " AND sql IS NOT NULL ORDER BY rowid"):
        if r["name"] == "idx_projects_user_name":
            continue
        if r["name"] in ANCIENT_INDEX_OVERRIDES:
            index_sql.append(ANCIENT_INDEX_OVERRIDES[r["name"]])
        else:
            index_sql.append(_strip_if_not_exists(r["sql"]))
    return ddl_list, index_sql


def _required_columns(conn, table):
    """NOT NULL 且无默认值、且非单列主键的列（INSERT 必须显式给值）。"""
    cols = _columns_of(conn, table)
    pk_count = sum(1 for c in cols if c["pk"])
    req = []
    for c in cols:
        if c["notnull"] and c["dflt"] is None and not (c["pk"] and pk_count == 1):
            req.append(c)
    return req


def _insert_sql(conn, table, explicit):
    """生成一条 INSERT（显式值 + 其余必填列按类型填空）——夹具数据自动可执行。"""
    req = _required_columns(conn, table)
    cols, vals = [], []
    for c in req:
        if c["name"] in explicit:
            continue
        cols.append(c["name"])
        vals.append("0" if (c["type"] or "").upper() in ("INTEGER", "REAL", "NUMERIC")
                    else "'x'")
    for name, value in explicit.items():
        cols.append(name)
        vals.append(value)
    if not cols:
        return f"-- {table}: 无必填列，跳过种子"
    return (f"INSERT INTO {table}(" + ", ".join(cols) + ") VALUES("
            + ", ".join(vals) + ")")


def _sql_literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def _fixture_text(title, ddl_list, index_sql, extra_ddl, seeds):
    parts = [SQL_HEADER, f"-- {title}", ""]
    parts += [s + ";" for s in ddl_list]
    parts += [s + ";" for s in extra_ddl]
    parts += [s + ";" for s in index_sql]
    parts += ["", "-- 种子数据"]
    parts += [s + ";" for s in seeds]
    return "\n".join(parts) + "\n"


# --------------------------------------------------------------------------
# 导出
# --------------------------------------------------------------------------

def _load_db(tmp_db_path):
    """导入 db 并把库指到临时路径（**绝不碰真实库**）。"""
    # Python 后端源码在 <仓库>/backend_py/（2026-10-19 起）
    backend_py = REPO_ROOT / "backend_py"
    if str(backend_py) not in sys.path:
        sys.path.insert(0, str(backend_py))
    os.environ["TS_ADMIN_PASSWORDLESS"] = "1"
    import db                                                    # noqa: PLC0415
    db.DB_OVERRIDE = str(tmp_db_path)
    return db


def _fresh_db(tmp_db_path):
    db = _load_db(tmp_db_path)
    db.init_db()
    return db


# 夹具自检结果（main 打印用；export_all 每次覆盖）
FIXTURE_CHECKS = []


def _build_legacy_fixture(tmp_base, db, target_conn, target_view, ancient):
    """造一个老库：目标结构去掉 ALTER 补列（ancient 另加更老的痕迹）。

    `target_conn` 是**目标库**（fresh.db）的只读连接——夹具的列元数据从它取；
    夹具自身另开连接（它缺列，元数据不同）。
    """
    path = Path(tmp_base) / ("ancient.db" if ancient else "pre_alter.db")
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    try:
        ddl_list, index_sql = _legacy_ddl(target_conn, ANCIENT_DROP_COLUMNS)
        if len(ddl_list) < 10:
            raise SystemExit(f"[export_schema] 夹具 DDL 异常（只有 {len(ddl_list)} 张表）")
        extra_ddl = []
        if ancient:
            extra_ddl = list(ANCIENT_EXTRA_DDL)
            # projects.name 从「用户内唯一索引」降级为「全局 UNIQUE 约束」（表约束必须
            # 写在列定义之后，故追加到右括号前）
            ddl_list = [d[:-2] + ",\n    UNIQUE (name)\n)"
                        if d.startswith("CREATE TABLE projects (") else d
                        for d in ddl_list]
        for stmt in ddl_list + extra_ddl + index_sql:
            conn.execute(stmt)
        # 夹具确实「老」：projects 缺 model 列、ancient 还带全局 UNIQUE 与 leases 表
        fixture_view = structure_view(snapshot(path))
        proj_cols = {c[0] for c in fixture_view["projects"]["columns"]}
        if "model" in proj_cols:
            raise SystemExit("[export_schema] 夹具没去掉 ALTER 补列（projects.model 仍在）")
        if ancient:
            if "leases" not in fixture_view:
                raise SystemExit("[export_schema] ancient 夹具缺 leases 表")
            has_name_unique = any(cols == ("name",) and uniq
                                  for uniq, cols, _sql in
                                  fixture_view["projects"]["indexes"].values())
            if not has_name_unique:
                raise SystemExit("[export_schema] ancient 夹具缺 projects.name 全局 UNIQUE")
        admin_hash = __import__("auth").md5_password("")[0]
        seeds = [s for s in [
            _insert_sql(conn, "users", {"id": "1", "username": "'admin'",
                                        "pass_hash": _sql_literal(admin_hash),
                                        "salt": "''",
                                        "created_at": "'2026-01-01 00:00:00'"}),
            _insert_sql(conn, "projects", {
                "id": "1", "name": "'proj_one'",
                "project_dir": "'/tmp/ts-fixture/proj'",
                "work_dir": ("'/tmp/ts-fixture/proj/free_style'" if ancient
                             else "'/tmp/ts-fixture/proj'"),
                "bug_dir": ("'/tmp/ts-fixture/proj/free_style/bug_report'" if ancient
                            else "''"),
                "commit_spec": ("'fix: 老规范'" if ancient else "''"),
                "deploy_spec": ("'部署：老说明'" if ancient else "''"),
                "created_at": "'2026-01-01 00:00:00'",
                **({"user_id": "0"} if ancient else {"user_id": "1"}),
            }),
            _insert_sql(conn, "tasks", {"id": "1", "project_id": "1", "name": "'t1'",
                                        "created_at": "'2026-01-01 00:00:00'"}),
            _insert_sql(conn, "board_cards", {
                "id": "1", "project_id": "1", "title": "'legacy card'",
                "created_at": "'2026-01-01 00:00:00'",
                **({"column_key": "'blocked'", "block_kind": "'queue'",
                    "block_text": "'提交中：老机器文案'",
                    "last_error": "'阻塞让行提交失败 x'"} if ancient
                   else {"column_key": "'todo'"}),
            }),
            _insert_sql(conn, "wait_items", {
                "kind": "'card'", "target_id": "'c:1'", "project_id": "1",
                "state": "'claimed'"}) if ancient else None,
            _insert_sql(conn, "leases", {"kind": "'card'", "target_id": "'c:old'"})
            if ancient else None,
            _insert_sql(conn, "app_settings", {
                "key": "'feishu'",
                "json": _sql_literal(json.dumps(
                    {"app_id": "cli_legacy", "app_secret": "sec_legacy",
                     "base_url": "https://open.feishu.cn"}))}) if ancient else None,
        ] if s and not s.startswith("--")]
        for stmt in seeds:                    # 夹具库也要落种子（自检跑的就是它）
            conn.execute(stmt)
        conn.commit()
        conn.close()
        checks = _verify_legacy_migration_effects(path, db, target_view, ancient)
        return seeds, extra_ddl, ddl_list, index_sql, checks
    finally:
        try:
            conn.close()
        except sqlite3.ProgrammingError:
            pass


def _row1(conn, sql):
    r = conn.execute(sql).fetchone()
    return tuple(r) if r is not None else None


def _verify_legacy_migration_effects(path, db, target_view, ancient):
    """自检（硬）：夹具必须在**真跑 init_db()** 后产生预期的迁移效果。

    ancient 需两轮才能完全收敛（重建表那步只搬 12 个老列，后加的 9 列 model/archived/
    skill_*5 列/reasoning_effort/permission_mode 会被丢掉，
    下次启动补列才加回；这是 Python 既有行为，两侧必须一致，对拍器同样按两轮快照）。
    返回检查项名单，写进导出日志便于人工复核。
    """
    check_path = Path(path).with_name(("check_ancient.db" if ancient else "check_pre.db"))
    shutil.copy(path, check_path)
    db.DB_OVERRIDE = str(check_path)
    names = []
    db.init_db()
    conn = sqlite3.connect(str(check_path))
    conn.row_factory = sqlite3.Row
    try:
        after1 = structure_view(snapshot(check_path))
        proj_cols = {c[0] for c in after1["projects"]["columns"]}
        if ancient:
            if "model" in proj_cols:
                raise SystemExit("[export_schema] ancient 未触发 projects 重建（model 列还在）")
            names.append("projects 重建触发（第一轮缺后加列）")
        else:
            if "model" not in proj_cols:
                raise SystemExit("[export_schema] pre_alter 未完成补列收敛")
            names.append("ALTER 补列收敛（第一轮补齐）")
        db.init_db()                                   # 第二轮（ancient 才需要）
        got = structure_view(snapshot(check_path))
        if got != target_view:
            bad = sorted(t for t in target_view if target_view[t] != got.get(t))
            raise SystemExit(f"[export_schema] 夹具自检失败（{path.name} 两轮 init_db "
                             f"未收敛回目标）：{bad}")
        names.append("两轮 init_db 后结构 == 目标 schema")
        if ancient:
            p = _row1(conn, "SELECT bug_dir, work_dir, user_id, guide_text, commit_spec"
                            " FROM projects WHERE id=1")
            if p[0] != "" or p[1] != "/tmp/ts-fixture/proj" or p[2] == 0:
                raise SystemExit(f"[export_schema] ancient 工作目录化/归属回填未生效：{p}")
            if "git commit message 规范：fix: 老规范" not in (p[3] or "") or p[4] != "":
                raise SystemExit(f"[export_schema] ancient guide_text 合并未生效：{p}")
            names.append("工作目录化 + 归属回填 + guide_text 合并生效")
            if _row1(conn, "SELECT state FROM wait_items WHERE kind='card'") != ("starting",):
                raise SystemExit("[export_schema] ancient claimed→starting 未生效")
            names.append("claimed→starting 生效")
            if _row1(conn, "SELECT count(*) FROM sqlite_master WHERE name='leases'") != (0,):
                raise SystemExit("[export_schema] ancient leases 表未 DROP")
            names.append("leases 表 DROP 生效")
            if _row1(conn, "SELECT count(*) FROM feishu_user_cfgs") != (1,):
                raise SystemExit("[export_schema] ancient 飞书旧配置桥接未生效")
            names.append("飞书旧配置桥接生效")
            if _row1(conn, "SELECT column_key, block_text, last_error FROM board_cards"
                           " WHERE id=1")[:1] != ("doing",):
                raise SystemExit("[export_schema] ancient 卡片列归位未生效")
            names.append("卡片 blocked+queue→doing 生效")
            idx_sql = _row1(conn, "SELECT sql FROM sqlite_master WHERE"
                                  " name='idx_wait_active'")[0]
            if "'starting'" not in idx_sql:
                raise SystemExit("[export_schema] ancient 活跃索引未重建")
            names.append("idx_wait_active 重建生效")
        if _row1(conn, "SELECT json FROM app_settings WHERE key='schema_version'") != ("1",):
            raise SystemExit("[export_schema] schema_version 未写入")
        names.append("schema_version=1 已写入")
        return names
    finally:
        conn.close()


def export_all(out_dir):
    """把全部契约文件渲染成 {相对路径: 文本}（不写盘，便于 --check 比对）。"""
    out_dir = Path(out_dir)
    files = {}
    del FIXTURE_CHECKS[:]
    with tempfile.TemporaryDirectory(prefix="ts-export-schema-") as tmp:
        base = Path(tmp)
        db = _fresh_db(base / "fresh.db")
        target_conn = sqlite3.connect(db.db_path())
        target_conn.row_factory = sqlite3.Row
        try:
            snap = snapshot(db.db_path())
            if not snap["tables"]:
                raise SystemExit("[export_schema] 目标 schema 为空，导出中止")
            target_view = structure_view(snap)

            schema_sql = [SQL_HEADER, ""]
            for t in snap["tables"]:
                schema_sql.append(_with_if_not_exists(t["ddl"]) + ";")
            for t in snap["tables"]:
                for i in t["indexes"]:
                    if i["sql"]:
                        schema_sql.append(_with_if_not_exists(i["sql"]) + ";")
            files["schema.sql"] = "\n".join(schema_sql) + "\n"

            files["schema.json"] = json.dumps({
                "format": 1,
                "schemaVersion": db.SCHEMA_VERSION,
                "generatedBy": "tools/export_schema.py",
                "note": "目标 schema（实测导出）。列顺序不入契约：老库经 ALTER 补列的顺序"
                        "与新库 DDL 顺序不同，比对按列集合。",
                "tables": snap["tables"],
            }, ensure_ascii=False, indent=2, sort_keys=False) + "\n"

            handlers = {}
            for step in db.MIGRATIONS:
                if step.get("handler"):
                    handlers[step["handler"]] = step["desc"]
            steps = [{k: step[k] for k in ("id", "desc", "when", "sql", "handler")
                      if k in step} for step in db.MIGRATIONS]
            files["migrations.json"] = json.dumps({
                "format": 1,
                "schemaVersion": db.SCHEMA_VERSION,
                "generatedBy": "tools/export_schema.py",
                "note": "数据级/结构重建迁移：两版执行**同一份**清单。when=null 表示无条件"
                        "执行（语句自身幂等）；kind=rows 的 sql 是只读 SELECT，返回 ≥1 行"
                        "才执行；kind=index_origin_unique 表示表上存在 UNIQUE 约束索引才执行。"
                        "handler 需宿主语言实现（未知 handler 必须报错退出，不得静默跳过）。",
                "guards": {
                    "rows": "SELECT 返回 ≥1 行才执行该步",
                    "index_origin_unique": "PRAGMA index_list(表) 里存在 origin='u' 的索引才执行",
                },
                "handlers": handlers,
                "handlerImpl": {"python": "db.py MIGRATION_HANDLERS",
                                "node": "backend/lib/db.js HANDLERS"},
                "steps": steps,
            }, ensure_ascii=False, indent=2) + "\n"

            for ancient, name, title in ((False, "pre_alter.sql", "旧库夹具①：缺 ALTER 补列"),
                                         (True, "ancient.sql", "旧库夹具②：更老的年代")):
                seeds, extra_ddl, ddl_list, index_sql, checks = _build_legacy_fixture(
                    base, db, target_conn, target_view, ancient)
                files[f"fixtures/{name}"] = _fixture_text(title, ddl_list, index_sql,
                                                          extra_ddl, seeds)
                FIXTURE_CHECKS.append((name, checks))
        finally:
            target_conn.close()
    return files


def write_files(files, out_dir):
    out_dir = Path(out_dir)
    written = []
    for rel, text in files.items():
        target = out_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        data = text.encode("utf-8")
        old = target.read_bytes() if target.exists() else None
        if old != data:
            target.write_bytes(data)
            written.append(rel)
    return written


def check_files(files, out_dir, stream=sys.stdout):
    """逐字节比对已提交文件与重新导出结果；一致返回 True。"""
    ok = True
    for rel, text in sorted(files.items()):
        target = Path(out_dir) / rel
        want = text.encode("utf-8")
        got = target.read_bytes() if target.exists() else b""
        if got == want:
            continue
        ok = False
        print(f"[export_schema] 漂移：{rel}"
              f"（已提交 {len(got)} B / 重新导出 {len(want)} B）", file=stream)
        diff = list(difflib.unified_diff(
            got.decode("utf-8", "replace").splitlines(),
            want.decode("utf-8", "replace").splitlines(),
            fromfile=f"{rel}（已提交）", tofile=f"{rel}（重新导出）", lineterm="", n=1))
        for line in diff[:40]:
            print("    " + line, file=stream)
    if not ok:
        print("[export_schema] 有漂移：请跑 `python3 tools/export_schema.py` 重新导出并提交。",
              file=stream)
    return ok


def main():
    ap = argparse.ArgumentParser(description="导出 backend/schema 数据层契约")
    ap.add_argument("--check", action="store_true",
                    help="只校验：重新导出与已提交文件必须逐字节一致（不一致退出码 1）")
    ap.add_argument("--print-snapshot", metavar="DB",
                    help="打印某个库文件的结构快照（调试用）")
    args = ap.parse_args()
    if args.print_snapshot:
        print(json.dumps(structure_view(snapshot(args.print_snapshot)),
                         ensure_ascii=False, indent=2, default=list))
        return 0
    if args.check:
        return 0 if check_files(export_all(SCHEMA_DIR), SCHEMA_DIR) else 1
    written = write_files(export_all(SCHEMA_DIR), SCHEMA_DIR)
    print(f"[export_schema] 已导出到 {SCHEMA_DIR.relative_to(REPO_ROOT)}/（本次变更："
          f"{', '.join(written) if written else '无'}）")
    for name, checks in FIXTURE_CHECKS:
        print(f"[export_schema] 夹具自检 {name}（{len(checks)} 项全过）："
              + "；".join(checks))
    return 0


if __name__ == "__main__":
    sys.exit(main())
