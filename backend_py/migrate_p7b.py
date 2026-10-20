#!/usr/bin/env python3
"""P7b 存量数据迁移：legacy 智能体族 → dsh_plugin（默认 **dry-run**）。

为什么需要（P7b 硬前提）
------------------------
P7b 会删除 kimi / opencode / claude / hermes / deepseek 五族。删后仍绑这些族的
项目会走 dsh_plugin 分派，而它们的卡/任务还绑着 **kimi 会话 sid**——dsh 宿主里
没有这个会话，起跑时 `dshdriver.resume_session(<旧 sid>)` 必然 500
「会话恢复失败」，卡片/任务直接起不来。故本脚本做三件事：

  1) `projects.agent_path`：legacy → `dsh-plugin:<dsh 路径>`
     （探测不到 dsh 可执行文件时置空串＝走默认族，行为等价）；
  2) `board_cards.session_id` / `sessions` 清空（**仅 legacy 项目**的卡）；
  3) `tasks.session_id` 清空（**仅 legacy 项目**的任务）。

旧会话内容在 Touchstone 里不再可读（用户口径 2026-10-03：历史无所谓，原文件
`~/.kimi-code/sessions` 等不动，用户自行在对应工具里读）。

用法
----
    python3 migrate_p7b.py                      # dry-run：只打印将要改什么
    python3 migrate_p7b.py --apply              # 真写：先备份数据库，再改，写清单 JSON
    python3 migrate_p7b.py --db <path> --dsh-path /usr/bin/dsh --apply

备份：`<db>.bak-p7b-<UTC时间戳>`（SQLite online backup，运行中也安全）；
清单：`<db>.bak-p7b-<UTC时间戳>.manifest.json`（旧值→新值逐行可查）。
脚本**幂等**：迁移过的项目 agent_path 已是 `dsh-plugin:`，重跑为 no-op。
"""

import argparse
import json
import os
import shutil
import sqlite3
import sys
import time

DSH_PLUGIN_PREFIX = "dsh-plugin:"
# legacy 前缀（web 驱动虚拟条目）
LEGACY_PREFIXES = ("kimi-web:", "opencode-web:")
# legacy CLI 可执行名（basename 包含即视为已下线族）
LEGACY_NAME_HINTS = ("kimi", "opencode", "claude", "hermes", "deepseek")


def default_db():
    """默认库路径：环境变量 TOUCHSTONE_DB 优先，其次 ~/.touchstone/touchstone.db。"""
    return os.environ.get("TOUCHSTONE_DB") or os.path.expanduser(
        "~/.touchstone/touchstone.db")


def find_dsh():
    """探测 dsh 可执行文件（PATH 优先），找不到返回空串。"""
    import shutil as _sh
    return _sh.which("dsh") or ""


def is_legacy(agent_path):
    """该 agent_path 是否属于将被删除的族。

    空串＝未配置（默认族就是 dsh_plugin，**不动**）；`dsh-plugin:`＝已迁移（不动）；
    其余未知名（如测试夹具的 `/usr/bin/true`）同样落默认族，**不动**——只迁移
    「明确属于已下线族」的那批。
    """
    ap = (agent_path or "").strip()
    if not ap or ap.startswith(DSH_PLUGIN_PREFIX):
        return False
    if ap.startswith(LEGACY_PREFIXES):
        return True
    base = os.path.basename(ap).lower()
    return base == "dsh" or any(h in base for h in LEGACY_NAME_HINTS)


def _connect(db_path):
    """短连接（与平台同风格）；不存在则报错退出。"""
    if not os.path.isfile(db_path):
        raise SystemExit(f"错误：数据库不存在: {db_path}")
    conn = sqlite3.connect(db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def plan(db_path):
    """只读扫描：返回 {projects, cards, tasks, counts}（不改任何数据）。"""
    conn = _connect(db_path)
    try:
        projects = [dict(r) for r in conn.execute(
            "SELECT id, name, agent_path FROM projects ORDER BY id")]
        legacy = [p for p in projects if is_legacy(p["agent_path"])]
        ids = [p["id"] for p in legacy]
        cards = sum(1 for r in conn.execute(
            "SELECT 1 FROM board_cards WHERE project_id IN (%s) "
            "AND (COALESCE(session_id,'')<>'' OR COALESCE(sessions,'') NOT IN ('','[]'))"
            % ",".join("?" * len(ids)), ids)) if ids else 0
        tasks = sum(1 for r in conn.execute(
            "SELECT 1 FROM tasks WHERE project_id IN (%s) "
            "AND COALESCE(session_id,'')<>''" % ",".join("?" * len(ids)),
            ids)) if ids else 0
        return {"projects": legacy, "cards": cards, "tasks": tasks,
                "profile": [{"id": p["id"], "name": p["name"],
                             "agent_path": p["agent_path"]} for p in projects]}
    finally:
        conn.close()


def backup(db_path):
    """SQLite online backup（运行中也安全），返回备份路径。"""
    stamp = time.strftime("%Y%m%d_%H%M%S", time.gmtime())
    bak = f"{db_path}.bak-p7b-{stamp}"
    src = sqlite3.connect(db_path, timeout=30)
    try:
        dst = sqlite3.connect(bak)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    return bak


def apply(db_path, dsh_path=""):
    """执行迁移：备份 → 改 projects → 清 legacy 卡的会话绑定 → 清 legacy 任务的
    session_id → 写清单 JSON。返回结果 dict（含备份/清单路径与计数）。"""
    p = plan(db_path)
    if not p["projects"]:
        return {"changed": False, "reason": "没有 legacy 项目（已迁移或本就不需要）",
                "backup": "", "manifest": "", "projects": [], "cards": 0, "tasks": 0}
    target = (DSH_PLUGIN_PREFIX + (dsh_path or "")).strip()
    bak = backup(db_path)
    conn = _connect(db_path)
    changes = {"projects": [], "cards": 0, "tasks": 0}
    try:
        with conn:                      # 单事务：全成或全不成
            for row in p["projects"]:
                conn.execute("UPDATE projects SET agent_path=? WHERE id=?",
                             (target, row["id"]))
                changes["projects"].append({"id": row["id"], "name": row["name"],
                                            "old": row["agent_path"], "new": target})
                cur = conn.execute(
                    "UPDATE board_cards SET session_id='', sessions='[]' "
                    "WHERE project_id=? AND (COALESCE(session_id,'')<>'' "
                    "OR COALESCE(sessions,'') NOT IN ('','[]'))", (row["id"],))
                changes["cards"] += cur.rowcount
                cur = conn.execute(
                    "UPDATE tasks SET session_id='' WHERE project_id=? "
                    "AND COALESCE(session_id,'')<>''", (row["id"],))
                changes["tasks"] += cur.rowcount
    finally:
        conn.close()
    manifest = bak + ".manifest.json"
    with open(manifest, "w", encoding="utf-8") as f:
        json.dump({"db": db_path, "backup": bak, "target_agent_path": target,
                   "time_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                   **changes}, f, ensure_ascii=False, indent=2)
    return {"changed": True, "backup": bak, "manifest": manifest, **changes}


def main(argv=None):
    """CLI 入口：默认 dry-run；`--apply` 才写。返回退出码。"""
    ap = argparse.ArgumentParser(
        description="P7b 存量数据迁移（legacy 族 → dsh_plugin；默认 dry-run）")
    ap.add_argument("--db", default=default_db(), help="SQLite 路径（默认 TOUCHSTONE_DB）")
    ap.add_argument("--dsh-path", default="", help="dsh 可执行路径（默认自动探测）")
    ap.add_argument("--apply", action="store_true", help="真正写入（默认只打印计划）")
    args = ap.parse_args(argv)

    dsh_path = args.dsh_path or find_dsh()
    p = plan(args.db)
    print(f"库: {args.db}")
    print(f"dsh 可执行: {dsh_path or '(未探测到，将置空串=默认族)'}")
    print(f"legacy 项目 {len(p['projects'])} 个 / 待清会话绑定的卡 {p['cards']} 张 / "
          f"任务 {p['tasks']} 个")
    for row in p["projects"]:
        print(f"  - #{row['id']} {row['name']}: {row['agent_path']!r} → "
              f"{DSH_PLUGIN_PREFIX + dsh_path!r}")
    if not args.apply:
        print("\n[dry-run] 未改任何数据；加 --apply 执行（执行前会自动备份）")
        return 0
    res = apply(args.db, dsh_path)
    if not res["changed"]:
        print(f"\n无需迁移：{res['reason']}")
        return 0
    print(f"\n✅ 已迁移：项目 {len(res['projects'])} 个，清卡会话 {res['cards']} 张、"
          f"任务会话 {res['tasks']} 个")
    print(f"   备份: {res['backup']}")
    print(f"   清单: {res['manifest']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
