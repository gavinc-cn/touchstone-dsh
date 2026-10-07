#!/usr/bin/env python3
"""Touchstone 站点 SQLite 数据层：schema、种子、通用访问。

仅用标准库；每个调用短连接（http.server 每请求一线程，函数内连接不跨线程）。
数据库默认 ~/.touchstone/touchstone.db（环境变量 TOUCHSTONE_DB 覆盖），运行时自动建目录。
"""

import json
import os
import secrets
import sqlite3

import localbus
import time

DB_REL = os.path.join("data", "touchstone.db")

# SQLite 不能放在 CIFS/网盘同步目录（这类挂载上文件锁不可用，
# 会报 database is locked）。数据库固定放本地盘 ~/.touchstone/，可用环境变量覆盖。
DB_OVERRIDE = os.path.expanduser(os.environ.get("TOUCHSTONE_DB",
                                                "~/.touchstone/touchstone.db"))


def db_path():
    """数据库文件绝对路径（本地盘，避免 CIFS 锁问题）。"""
    return DB_OVERRIDE


def connect():
    """打开一个新连接（无锁设计：短连接 + busy timeout）。

    数据库功能上保持默认 rollback journal 模式，避免并发连接设置
    journal_mode 时的锁冲突；row_factory 设为 sqlite3.Row（按列名取值）。
    """
    os.makedirs(os.path.dirname(db_path()), exist_ok=True)
    conn = sqlite3.connect(db_path(), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT UNIQUE NOT NULL,
    pass_hash      TEXT NOT NULL,
    salt           TEXT NOT NULL,
    must_change_pw INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL DEFAULT 0,
    name        TEXT NOT NULL,
    project_dir TEXT NOT NULL,
    agent_path  TEXT NOT NULL DEFAULT '',
    work_dir    TEXT NOT NULL,
    bug_dir     TEXT NOT NULL,
    guide_text  TEXT NOT NULL DEFAULT '',
    commit_spec TEXT NOT NULL DEFAULT '',
    deploy_spec TEXT NOT NULL DEFAULT '',
    env_label   TEXT NOT NULL DEFAULT '',
    model       TEXT NOT NULL DEFAULT '',
    skill_understand TEXT NOT NULL DEFAULT '',
    skill_deploy TEXT NOT NULL DEFAULT '',
    skill_commit TEXT NOT NULL DEFAULT '',
    skill_test TEXT NOT NULL DEFAULT '',
    skill_cases TEXT NOT NULL DEFAULT '',
    reasoning_effort TEXT NOT NULL DEFAULT '',
    permission_mode TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   INTEGER NOT NULL,
    name         TEXT NOT NULL,
    auto_fix     INTEGER NOT NULL DEFAULT 0,
    retest       TEXT NOT NULL DEFAULT '不复测',
    stop_type    TEXT NOT NULL DEFAULT 'rounds',
    stop_value   TEXT NOT NULL DEFAULT '1',
    task_type    TEXT NOT NULL DEFAULT 'normal',
    start_stage  TEXT NOT NULL DEFAULT '',
    end_stage    TEXT NOT NULL DEFAULT '',
    payload      TEXT NOT NULL DEFAULT '',
    extra        TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'queued',
    session_id   TEXT NOT NULL DEFAULT '',
    model        TEXT NOT NULL DEFAULT '',
    permission   TEXT NOT NULL DEFAULT '',
    auto_commit  INTEGER NOT NULL DEFAULT 0,
    auto_deploy  INTEGER NOT NULL DEFAULT 0,
    auto_retest  INTEGER NOT NULL DEFAULT 0,
    cases_base   INTEGER NOT NULL DEFAULT 0,
    fresh_prompt INTEGER NOT NULL DEFAULT 0,
    current_round INTEGER NOT NULL DEFAULT 0,
    new_bugs     INTEGER NOT NULL DEFAULT 0,
    date_from    TEXT NOT NULL DEFAULT '',
    date_to      TEXT NOT NULL DEFAULT '',
    -- 复压标记（2026-10-06）：1=下一次执行只跑发压运行（跳过 agent 轮），用后即清
    load_rerun   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    started_at   TEXT,
    ended_at     TEXT,
    error        TEXT NOT NULL DEFAULT ''
);
-- rounds 同时承载「agent 轮次」与「发压运行」（2026-10-06 复压批次）：
--   kind='agent' 一次 agent 会话调用（压测任务恒 1 轮：出方案包）
--   kind='load'  一次平台托管的发压运行（同一方案包可多次，run_key 标识）
CREATE TABLE IF NOT EXISTS rounds (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL,
    round_no   INTEGER NOT NULL,
    status     TEXT NOT NULL DEFAULT 'running',
    exit_code  INTEGER,
    log_path   TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    ended_at   TEXT,
    summary    TEXT NOT NULL DEFAULT '',
    kind       TEXT NOT NULL DEFAULT 'agent',
    run_key    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_rounds_task ON rounds(task_id);
CREATE TABLE IF NOT EXISTS board_cards (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id     INTEGER NOT NULL,
    title          TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    column_key     TEXT NOT NULL DEFAULT 'todo',
    sort_order     INTEGER NOT NULL DEFAULT 0,
    session_id     TEXT NOT NULL DEFAULT '',
    sessions       TEXT NOT NULL DEFAULT '[]',
    block_kind     TEXT,
    block_text     TEXT NOT NULL DEFAULT '',
    parent_card_id INTEGER,
    readonly       INTEGER NOT NULL DEFAULT 0,
    model          TEXT NOT NULL DEFAULT '',
    scheduled_at   INTEGER,
    worktree       TEXT NOT NULL DEFAULT '',
    jira_key       TEXT NOT NULL DEFAULT '',
    last_error     TEXT NOT NULL DEFAULT '',
    last_error_at  INTEGER,
    origin         TEXT,
    done_at        TEXT,
    trashed        INTEGER NOT NULL DEFAULT 0,
    trashed_at     TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS board_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id    INTEGER NOT NULL,
    text       TEXT NOT NULL,
    sent       INTEGER NOT NULL DEFAULT 0,
    session_id TEXT NOT NULL DEFAULT '',
    sent_text  TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS board_settings (
    project_id INTEGER PRIMARY KEY,
    json       TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS app_settings (
    key  TEXT PRIMARY KEY,
    json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS user_prefs (
    user_id    INTEGER NOT NULL,
    project_id INTEGER NOT NULL DEFAULT 0,  -- 0=跨项目全局偏好（预留）
    key        TEXT NOT NULL,
    value      TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, project_id, key)
);
CREATE TABLE IF NOT EXISTS feishu_hooks (
    project_id     INTEGER PRIMARY KEY,
    webhook_url    TEXT NOT NULL DEFAULT '',
    webhook_secret TEXT NOT NULL DEFAULT '',
    events         TEXT NOT NULL DEFAULT 'blocked_interaction,task_failed',
    enabled        INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS feishu_outbox (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL DEFAULT 0,  -- 投递归属用户（0=系统/遗留，设置页按用户过滤）
    target     TEXT NOT NULL,
    secret     TEXT NOT NULL DEFAULT '',
    payload    TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    retries    INTEGER NOT NULL DEFAULT 0,
    next_at    REAL NOT NULL DEFAULT 0,
    dedup_key  TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feishu_user_cfgs (
    user_id INTEGER PRIMARY KEY,
    json    TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS feishu_bindings (
    open_id            TEXT PRIMARY KEY,
    user_id            INTEGER NOT NULL UNIQUE,
    default_project_id INTEGER NOT NULL DEFAULT 0,
    bound_at           TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_board_cards_project ON board_cards(project_id);
CREATE INDEX IF NOT EXISTS idx_board_comments_card ON board_comments(card_id);

-- 统一队列模型（2026-09-18；设计见 doc_ai/plan/202609/20260917_0718）
-- wait_items = 排队语义唯一权威（行即条目，v3a 起调度权威；v3d 起为唯一权威，
-- 占用/让行概念随租约层一并退场）；chat_msgs = 会话消息从内存转正（P3 切权威）
CREATE TABLE IF NOT EXISTS wait_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    target_id   TEXT NOT NULL,
    state       TEXT NOT NULL DEFAULT 'waiting',
    seq         INTEGER NOT NULL,
    created_at  TEXT NOT NULL,
    claimed_at  TEXT,
    claimed_by  TEXT,
    ended_at    TEXT,
    not_before  REAL NOT NULL DEFAULT 0,
    retries     INTEGER NOT NULL DEFAULT 0,
    meta        TEXT NOT NULL DEFAULT '{}',
    -- v3c（2026-09-23）：证据与心跳迁到行（v3 §2.4）——last_seen=最近一次心跳
    -- 时间戳（epoch 秒，waitq.touch_unit 写）；evidence=证据 JSON 文本
    -- （desc/reason/pid 登记证据 + busy=…(poll|sse) 心跳证据，判活读口同此处）
    last_seen   REAL NOT NULL DEFAULT 0,
    evidence    TEXT NOT NULL DEFAULT ''
);
-- v2a T1（2026-09-21，裁决 R3）：活跃唯一索引覆盖四活跃态（claimed 已被
-- starting 吸收；starting/running/finishing 行留队构成运行前缀）
CREATE UNIQUE INDEX IF NOT EXISTS idx_wait_active ON wait_items(kind, target_id)
    WHERE state IN ('waiting','starting','running','finishing');
CREATE INDEX IF NOT EXISTS idx_wait_pick ON wait_items(state, project_id, seq);

CREATE TABLE IF NOT EXISTS chat_msgs (
    id          TEXT PRIMARY KEY,
    project_id  INTEGER NOT NULL,
    sid         TEXT NOT NULL,
    task_id     INTEGER,
    card_id     INTEGER,
    message     TEXT NOT NULL,
    state       TEXT NOT NULL,
    error       TEXT NOT NULL DEFAULT '',
    inject      INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    started_at  INTEGER,
    ended_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chat_msgs_sid ON chat_msgs(sid, created_at);

"""


def now_str():
    """当前时间字符串（YYYY-MM-DD HH:MM:SS）。"""
    return time.strftime("%Y-%m-%d %H:%M:%S")


def init_db():
    """建表 + 种子（仅 admin 用户）。返回是否本次新建了默认账号（透传 seed_admin，
    server 启动横幅据此决定是否提示初始口令）。

    项目不再种子默认项，一律由用户手动添加；admin 种子幂等
    （无任何用户时才插入）。
    """
    with connect() as conn:
        conn.executescript(SCHEMA)
    # 先种子 admin：migrate 要把存量项目归 admin，依赖 admin id 已存在
    seeded = seed_admin()
    migrate()
    return seeded


def migrate():
    """旧库补列（ALTER TABLE ADD COLUMN，幂等：列已存在则跳过）。"""
    # users 补列：老库已存在的 users 表不会被 SCHEMA 的 CREATE IF NOT EXISTS 改动
    with connect() as conn:
        _ensure_users_columns(conn)
    with connect() as conn:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(tasks)")}
        if "task_type" not in cols:
            conn.execute("ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'normal'")
        if "start_stage" not in cols:
            conn.execute("ALTER TABLE tasks ADD COLUMN start_stage TEXT NOT NULL DEFAULT ''")
        if "end_stage" not in cols:
            conn.execute("ALTER TABLE tasks ADD COLUMN end_stage TEXT NOT NULL DEFAULT ''")
        if "payload" not in cols:
            conn.execute("ALTER TABLE tasks ADD COLUMN payload TEXT NOT NULL DEFAULT ''")
        if "extra" not in cols:
            conn.execute("ALTER TABLE tasks ADD COLUMN extra TEXT NOT NULL DEFAULT ''")
        if "model" not in cols:
            conn.execute("ALTER TABLE tasks ADD COLUMN model TEXT NOT NULL DEFAULT ''")
        if "permission" not in cols:
            conn.execute("ALTER TABLE tasks ADD COLUMN permission TEXT NOT NULL DEFAULT ''")
        if "auto_commit" not in cols:
            conn.execute("ALTER TABLE tasks ADD COLUMN auto_commit INTEGER NOT NULL DEFAULT 0")
        if "auto_deploy" not in cols:
            conn.execute("ALTER TABLE tasks ADD COLUMN auto_deploy INTEGER NOT NULL DEFAULT 0")
        if "auto_retest" not in cols:
            conn.execute("ALTER TABLE tasks ADD COLUMN auto_retest INTEGER NOT NULL DEFAULT 0")
        if "cases_base" not in cols:
            conn.execute("ALTER TABLE tasks ADD COLUMN cases_base INTEGER NOT NULL DEFAULT 0")
        # 续跑标记: 「继续」置 1, 下一轮用完整首轮提示词(携带新参数)而非续轮短提示
        if "fresh_prompt" not in cols:
            conn.execute("ALTER TABLE tasks ADD COLUMN fresh_prompt INTEGER NOT NULL DEFAULT 0")
        # 日期范围（2026-09-02，复测/探索按提交范围优先）：YYYY-MM-DD，空=不限
        if "date_from" not in cols:
            conn.execute("ALTER TABLE tasks ADD COLUMN date_from TEXT NOT NULL DEFAULT ''")
        if "date_to" not in cols:
            conn.execute("ALTER TABLE tasks ADD COLUMN date_to TEXT NOT NULL DEFAULT ''")
        # 复压标记（2026-10-06 复压批次）：1=下一次执行只跑发压运行（跳过 agent 轮）。
        # 必须落库：排队行可跨服务重启存活（recover 会放回 waiting），内存标记会丢。
        if "load_rerun" not in cols:
            conn.execute("ALTER TABLE tasks ADD COLUMN load_rerun INTEGER NOT NULL DEFAULT 0")
    # rounds 表补列（旧库升级；2026-10-06 复压批次）
    with connect() as conn:
        rcols = {r["name"] for r in conn.execute("PRAGMA table_info(rounds)")}
        # 轮次种类：agent=agent 会话轮次 / load=发压运行（存量行一律视为 agent）
        if "kind" not in rcols:
            conn.execute("ALTER TABLE rounds ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent'")
        # 发压运行键（该次运行开始时刻 YYYYmmdd_HHMMSS；仅 kind='load' 非空）
        if "run_key" not in rcols:
            conn.execute("ALTER TABLE rounds ADD COLUMN run_key TEXT NOT NULL DEFAULT ''")
    # projects 表补列（旧库升级）
    with connect() as conn:
        pcols = {r["name"] for r in conn.execute("PRAGMA table_info(projects)")}
        if "guide_text" not in pcols:
            conn.execute("ALTER TABLE projects ADD COLUMN guide_text TEXT NOT NULL DEFAULT ''")
        if "commit_spec" not in pcols:
            conn.execute("ALTER TABLE projects ADD COLUMN commit_spec TEXT NOT NULL DEFAULT ''")
        if "deploy_spec" not in pcols:
            conn.execute("ALTER TABLE projects ADD COLUMN deploy_spec TEXT NOT NULL DEFAULT ''")
        if "env_label" not in pcols:
            conn.execute("ALTER TABLE projects ADD COLUMN env_label TEXT NOT NULL DEFAULT ''")
        # 项目级模型：新建任务未显式指定模型时回落到该值
        if "model" not in pcols:
            conn.execute("ALTER TABLE projects ADD COLUMN model TEXT NOT NULL DEFAULT ''")
        # 多用户隔离：项目归属 user_id；存量项目（历史种子项目等）归 admin
        if "user_id" not in pcols:
            conn.execute("ALTER TABLE projects ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0")
        # 项目归档标记：1=已归档（前端列表默认隐藏，可恢复）；只改标记不删数据
        if "archived" not in pcols:
            conn.execute("ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
        # 项目能力 skill 绑定：理解/部署/提交三项能力各自选用的 skill 名（空=未配置）
        if "skill_understand" not in pcols:
            conn.execute("ALTER TABLE projects ADD COLUMN skill_understand TEXT NOT NULL DEFAULT ''")
        if "skill_deploy" not in pcols:
            conn.execute("ALTER TABLE projects ADD COLUMN skill_deploy TEXT NOT NULL DEFAULT ''")
        if "skill_commit" not in pcols:
            conn.execute("ALTER TABLE projects ADD COLUMN skill_commit TEXT NOT NULL DEFAULT ''")
        # 项目能力 skill 绑定扩展：测试项目/用例规范（2026-09-04，与理解/部署/提交同款）
        if "skill_test" not in pcols:
            conn.execute("ALTER TABLE projects ADD COLUMN skill_test TEXT NOT NULL DEFAULT ''")
        if "skill_cases" not in pcols:
            conn.execute("ALTER TABLE projects ADD COLUMN skill_cases TEXT NOT NULL DEFAULT ''")
        # 项目级会话默认值（2026-10-04）：思考等级（dsh reasoningEffort id，空=智能体默认）
        # 与权限档（平台三档 manual/yolo/auto，空=不指定/宿主默认）。起会话/续轮时应用，
        # 见 dshdriver.apply_session_defaults 与 board._start_web / runner。
        if "reasoning_effort" not in pcols:
            conn.execute("ALTER TABLE projects ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT ''")
        if "permission_mode" not in pcols:
            conn.execute("ALTER TABLE projects ADD COLUMN permission_mode TEXT NOT NULL DEFAULT ''")
        # 提交规范/部署说明字段废弃（信息并入项目附加提示词）：存量内容迁移到
        # guide_text 后清空两列；幂等——只处理非空行，迁移完即空
        rows = conn.execute(
            "SELECT id, guide_text, commit_spec, deploy_spec FROM projects").fetchall()
        for r in rows:
            extra = []
            if (r["commit_spec"] or "").strip():
                extra.append("git commit message 规范：" + r["commit_spec"].strip())
            if (r["deploy_spec"] or "").strip():
                extra.append("部署说明：" + r["deploy_spec"].strip())
            if extra:
                merged = (r["guide_text"] or "").rstrip()
                merged = merged + "\n\n" + "\n".join(extra) if merged else "\n".join(extra)
                conn.execute(
                    "UPDATE projects SET guide_text=?, commit_spec='', deploy_spec=''"
                    " WHERE id=?", (merged, r["id"]))
        conn.execute(
            "UPDATE projects SET user_id="
            " COALESCE((SELECT id FROM users WHERE username='admin'), 0)"
            " WHERE user_id=0")
        # 阻塞让行提交退场（2026-09-13）：平台不再自动提交（移交 kimi hook 扩展
        # extensions/kimi-hooks），清理存量卡片上的机器文案。幂等：只命中机器
        # 文案行，清完即空。
        conn.execute(
            "UPDATE board_cards SET block_text=''"
            " WHERE block_text LIKE '提交中：%' OR block_text LIKE '提交失败：%'")
        conn.execute(
            "UPDATE board_cards SET last_error='', last_error_at=NULL"
            " WHERE last_error LIKE '阻塞让行提交失败%'"
            "    OR last_error LIKE '阻塞让行提交异常%'")
        # 旧库 projects.name 是全局 UNIQUE；多用户下改为 (user_id, name) 用户内唯一。
        # SQLite 无法直接删除列约束，重建表（重建后同一语句块内建唯一索引）。
        unique_old = [r for r in conn.execute("PRAGMA index_list(projects)")
                      if r["origin"] == "u"]
        if unique_old:
            conn.execute("ALTER TABLE projects RENAME TO projects_old")
            conn.executescript("""
CREATE TABLE projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL DEFAULT 0,
    name        TEXT NOT NULL,
    project_dir TEXT NOT NULL,
    agent_path  TEXT NOT NULL DEFAULT '',
    work_dir    TEXT NOT NULL,
    bug_dir     TEXT NOT NULL,
    guide_text  TEXT NOT NULL DEFAULT '',
    commit_spec TEXT NOT NULL DEFAULT '',
    deploy_spec TEXT NOT NULL DEFAULT '',
    env_label   TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
);
INSERT INTO projects(id, user_id, name, project_dir, agent_path, work_dir, bug_dir,
                     guide_text, commit_spec, deploy_spec, env_label, created_at)
SELECT id, user_id, name, project_dir, agent_path, work_dir, bug_dir,
       guide_text, commit_spec, deploy_spec, env_label, created_at
FROM projects_old;
DROP TABLE projects_old;
CREATE UNIQUE INDEX idx_projects_user_name ON projects(user_id, name);
""")
        else:
            # 新库（或非 UNIQUE 库）：补建用户内唯一索引（幂等）
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_user_name"
                " ON projects(user_id, name)")
        # 工作目录化迁移（2026-08-30，一次性；幂等标记=bug_dir 非空）：
        # 旧版 work_dir 语义为案例库根（项目目录下旧版默认数据目录的 free_style 子目录），
        # 改存工作目录（<项目目录>/.touchstone）；bug_dir 列废弃置空（bug 报告目录改由
        # work_dir 派生）。旧 work_dir 以 free_style 结尾则取其父目录，否则回落
        # <项目目录>/.touchstone；磁盘文件一律不动。取父目录分支派生路径与原值一致；
        # 回落分支按新版默认目录（<项目目录>/.touchstone）派生。
        for r in conn.execute(
                "SELECT id, project_dir, work_dir FROM projects"
                " WHERE bug_dir != ''").fetchall():
            old = (r["work_dir"] or "").strip().rstrip("/")
            if old.endswith("/" + CASES_SUBDIR):
                new_w = os.path.dirname(old)
            else:
                new_w = os.path.join(r["project_dir"] or "~", ".touchstone")
            conn.execute("UPDATE projects SET work_dir=?, bug_dir='' WHERE id=?",
                         (new_w, r["id"]))
    # board_cards 表补列（旧库升级）
    with connect() as conn:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(board_cards)")}
        if "origin" not in cols:  # 2026-09-01 起：NULL=人工卡 / 'sync'=session 自动同步建卡
            conn.execute("ALTER TABLE board_cards ADD COLUMN origin TEXT")
        if "done_at" not in cols:
            conn.execute("ALTER TABLE board_cards ADD COLUMN done_at TEXT")
        # 2026-09-09 起：回收站（软删除）——trashed=1 的卡片不进看板/依赖树/队列，
        # 还原清标记、真删才删行；旧库无此列补加（存量卡片默认 0=正常）
        if "trashed" not in cols:
            conn.execute("ALTER TABLE board_cards"
                         " ADD COLUMN trashed INTEGER NOT NULL DEFAULT 0")
        if "trashed_at" not in cols:
            conn.execute("ALTER TABLE board_cards ADD COLUMN trashed_at TEXT")
        # 2026-10-06 起：独立 worktree（看板卡片「在新 worktree 中开始」）——该列
        # 自 kanban 一期建表就有（`CREATE TABLE board_cards`），但 `migrate()` 一直
        # 没补：比一期更早建的旧库缺列，读 `row["worktree"]` 会 IndexError
        # （plan/202610/20261006_0115 看板卡片独立worktree执行 §2.3）。幂等补列。
        if "worktree" not in cols:
            conn.execute("ALTER TABLE board_cards"
                         " ADD COLUMN worktree TEXT NOT NULL DEFAULT ''")
    # P4 排队占位单态化迁移（2026-09-19，一次性；幂等：迁移后无 blocked+queue 行）：
    # 占位列 2026-09-10 起已落 doing，blocked+queue 仅存量兼容；P4 删除全部双态
    # 判定后该形态无人认领，先归位 doing+queue（磁盘/列语义等价，设计 §5.2）
    with connect() as conn:
        conn.execute("UPDATE board_cards SET column_key='doing'"
                     " WHERE block_kind='queue' AND column_key='blocked'")
    # feishu_outbox 补 user_id 列（2026-09-09 起投递归属用户，设置页按用户过滤）
    with connect() as conn:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(feishu_outbox)")}
        if "user_id" not in cols:
            conn.execute("ALTER TABLE feishu_outbox"
                         " ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0")
    # 旧全局飞书配置迁移（2026-09-09 起飞书设置用户级）：旧的 app_settings['feishu']
    # 由 admin 在后台管理页配置，迁移给 admin 自己的用户配置（已有私户配置则不覆盖）
    with connect() as conn:
        row = conn.execute(
            "SELECT json FROM app_settings WHERE key='feishu'").fetchone()
        if row is not None:
            try:
                legacy = json.loads(row["json"])
            except ValueError:
                legacy = {}
            if legacy and legacy.get("app_id") or legacy.get("default_webhook") \
                    or legacy.get("base_url") or legacy.get("app_secret") \
                    or legacy.get("default_secret"):
                admin = conn.execute(
                    "SELECT id FROM users WHERE username='admin'").fetchone()
                if admin is not None and not conn.execute(
                        "SELECT 1 FROM feishu_user_cfgs WHERE user_id=?",
                        (admin["id"],)).fetchone():
                    conn.execute(
                        "INSERT INTO feishu_user_cfgs(user_id, json) VALUES(?,?)",
                        (admin["id"], json.dumps(legacy, ensure_ascii=False)))
    # v3d（2026-09-24）：租约层删除——`leases` 表（P5 建、v3a 起只写不读的镜像）
    # 随「占用 / 让行」概念一并退场：占用 = 该单元在「正在开发」队列里有活跃行
    # （wait_items.state），无需第二表征。幂等 DROP：表已不在则零改写；
    # 存量库中的历史行无读口（v3a 起读侧全切行），直接丢弃。
    with connect() as conn:
        conn.execute("DROP TABLE IF EXISTS leases")
        conn.execute("DROP INDEX IF EXISTS idx_leases_project")
    # v2a T1（2026-09-21，裁决 R3）：wait_items 状态机扩七枚举，claimed 被
    # starting 吸收。① 存量 claimed 行归一 starting（幂等：改完即无 claimed 行）；
    # ② 活跃唯一索引口径扩到四活跃态——旧库索引 WHERE 仍含 'claimed' 时重建
    # （重复启动看索引定义已含 'starting' 即跳过，零改写）。state 列无 CHECK
    # 约束（建表 DDL 复核），无需表重建。
    with connect() as conn:
        conn.execute("UPDATE wait_items SET state='starting' WHERE state='claimed'")
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='index'"
            " AND name='idx_wait_active'").fetchone()
        if row is not None and "'starting'" not in (row["sql"] or ""):
            conn.execute("DROP INDEX idx_wait_active")
            conn.execute(
                "CREATE UNIQUE INDEX idx_wait_active ON wait_items(kind, target_id)"
                " WHERE state IN ('waiting','starting','running','finishing')")
    # v3c（2026-09-23）：证据与心跳迁到行（v3 §2.4，裁决 R2/R11）——wait_items
    # 补 last_seen（心跳时间戳）/evidence（证据 JSON 文本），承载登记证据
    # （desc/reason/pid）与心跳证据（busy=…(poll|sse)）。幂等：PRAGMA table_info
    # 守卫式加列（同 tasks/projects 段风格）；存量行取列默认值（0 / 空串），
    # 由对账/自检按其证据面裁活。
    with connect() as conn:
        wcols = {r["name"] for r in conn.execute("PRAGMA table_info(wait_items)")}
        if "last_seen" not in wcols:
            conn.execute("ALTER TABLE wait_items ADD COLUMN"
                         " last_seen REAL NOT NULL DEFAULT 0")
        if "evidence" not in wcols:
            conn.execute("ALTER TABLE wait_items ADD COLUMN"
                         " evidence TEXT NOT NULL DEFAULT ''")


# 本次进程随机生成的一次性初始口令（仅「未设 TS_ADMIN_PASSWORD 且实际发生种子」时非空），
# 由 take_seed_password() 取走打印一次；不落库、不常驻（读后即清）
_SEED_PASSWORD = ""


def _ensure_users_columns(conn):
    """users 表补列（幂等：列已存在则跳过）。

    2026-10-02：must_change_pw=1 表示该账号仍持一次性初始口令，登录后在改密之前
    只放行 me / change_password / logout 三个端点（见 server 的统一鉴权门）。
    seed_admin 与 migrate 共用：老库 users 表已存在时 seed_admin 的 INSERT 会带该列，
    必须先行补齐（「表已存在但零用户」的边界，此时 SCHEMA 的 CREATE IF NOT EXISTS 不生效）。
    """
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
    if "must_change_pw" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0")


def seed_admin():
    """无任何用户时插入 admin，返回是否实际创建（bool，供启动横幅决定是否提示）。

    口令来源（2026-10-02 起）：
      - 环境变量 TS_ADMIN_PASSWORD 非空：用之（部署方自定义初始口令，视为有意设定，
        不强制改密）——保持 CI/隔离实例夹具的既有行为；
      - 未设置：用 secrets 随机生成 16 位一次性初始口令（URL-safe），并置
        must_change_pw=1，登录后必须先改密才能调用其他 API。
    随机口令经 take_seed_password() 交启动横幅打印一次，不落库明文、不常态打印。
    PBKDF2 哈希 + 随机盐（哈希算法为需求约定，勿改）。
    """
    global _SEED_PASSWORD
    import auth
    with connect() as conn:
        cur = conn.execute("SELECT COUNT(*) AS n FROM users")
        if cur.fetchone()["n"] > 0:
            return False
        _ensure_users_columns(conn)
        env_pw = os.environ.get("TS_ADMIN_PASSWORD")
        if env_pw:
            password, must_change = env_pw, 0
        else:
            password, must_change = secrets.token_urlsafe(12), 1
        pw_hash, salt = auth.hash_password(password)
        conn.execute(
            "INSERT INTO users(username, pass_hash, salt, must_change_pw, created_at)"
            " VALUES(?,?,?,?,?)",
            ("admin", pw_hash, salt, must_change, now_str()))
        _SEED_PASSWORD = password if must_change else ""
        return True


def take_seed_password():
    """取走本次进程随机生成的一次性初始口令（读后即清；未随机种子时返回空串）。

    调用方只有启动横幅：打印一次后内存与调用点都不再持有，避免口令被反复打印。
    """
    global _SEED_PASSWORD
    pw, _SEED_PASSWORD = _SEED_PASSWORD, ""
    return pw


# ---------- users ----------

def get_user_by_name(username):
    """按用户名查用户行，未命中返回 None。"""
    with connect() as conn:
        cur = conn.execute("SELECT * FROM users WHERE username=?", (username,))
        return cur.fetchone()


def get_user_by_id(user_id):
    with connect() as conn:
        cur = conn.execute("SELECT * FROM users WHERE id=?", (user_id,))
        return cur.fetchone()


def list_users():
    """全部用户（后台管理用），按 id 升序。"""
    with connect() as conn:
        cur = conn.execute("SELECT id, username, created_at FROM users ORDER BY id")
        return cur.fetchall()


def insert_user(username, pass_hash, salt=""):
    """插入新用户，返回新 id；用户名唯一冲突抛 sqlite3.IntegrityError。"""
    with connect() as conn:
        cur = conn.execute("INSERT INTO users(username, pass_hash, salt, created_at)"
                           " VALUES(?,?,?,?)", (username, pass_hash, salt, now_str()))
        return cur.lastrowid


def update_user(user_id, username, pass_hash, salt):
    """更新用户名与密码哈希（后台管理重置）。"""
    with connect() as conn:
        conn.execute("UPDATE users SET username=?, pass_hash=?, salt=? WHERE id=?",
                     (username, pass_hash, salt, user_id))


def delete_user(user_id):
    """删除用户及其会话。"""
    with connect() as conn:
        conn.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
        conn.execute("DELETE FROM users WHERE id=?", (user_id,))


def change_password(user_id, pass_hash, salt):
    """更新密码哈希并清除「强制改密」标记（改密成功后不再拦截其他端点）。"""
    with connect() as conn:
        conn.execute("UPDATE users SET pass_hash=?, salt=?, must_change_pw=0 WHERE id=?",
                     (pass_hash, salt, user_id))


# ---------- sessions ----------

def create_session(user_id, token, expires_at):
    with connect() as conn:
        conn.execute("INSERT INTO sessions(token, user_id, created_at, expires_at)"
                     " VALUES(?,?,?,?)", (token, user_id, now_str(), expires_at))


def get_session(token):
    """取未过期会话行，命中返回 {user_id, expires_at}，否则 None。"""
    if not token:
        return None
    with connect() as conn:
        cur = conn.execute("SELECT * FROM sessions WHERE token=?", (token,))
        row = cur.fetchone()
    if row is None:
        return None
    if row["expires_at"] < now_str():
        return None
    return row


def delete_session(token):
    with connect() as conn:
        conn.execute("DELETE FROM sessions WHERE token=?", (token,))


def purge_expired_sessions():
    with connect() as conn:
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now_str(),))


# ---------- projects ----------

# 项目设置只填一个工作目录，案例库根与 bug 报告目录按固定子目录派生、自动生成
CASES_SUBDIR = "free_style"
BUG_SUBDIR = "bug_report"


def cases_root_of(work_dir):
    """案例库根 = <工作目录>/free_style。"""
    return os.path.join(work_dir, CASES_SUBDIR)


def bug_root_of(work_dir):
    """bug 报告目录 = <工作目录>/bug_report。"""
    return os.path.join(work_dir, BUG_SUBDIR)


def row_opt(row, key, default=""):
    """行取值容错：列在则取值，缺列/None 回落 default。

    用途：起会话路径要读**新加列**（项目的 reasoning_effort / permission_mode），
    而 sqlite3.Row 没有 `.get`，单测里手工构造的 dict 也可能缺这些键——
    读一个可选默认值不该让起会话抛 KeyError。
    """
    try:
        val = row[key]
    except (KeyError, IndexError, TypeError):
        return default
    return default if val is None else val


def project_view(row):
    """projects 行 → dict，注入派生路径键（读取层统一派生，下游直接取用）。

    - cases_root：案例库根 = <工作目录>/free_style
    - bug_dir：bug 报告目录 = <工作目录>/bug_report（覆盖已废弃的同名存量列值）
    sqlite3.Row 不允许追加键，故统一转 dict；row["x"] 下标访问语义不变。
    """
    d = dict(row)
    d["cases_root"] = cases_root_of(d["work_dir"])
    d["bug_dir"] = bug_root_of(d["work_dir"])
    return d


def list_projects(user_id):
    """按用户列出项目（多用户隔离），仅返回归属该用户的项目。"""
    with connect() as conn:
        cur = conn.execute("SELECT * FROM projects WHERE user_id=? ORDER BY id", (user_id,))
        return [project_view(r) for r in cur.fetchall()]


def list_projects_all():
    """全部项目（目录重复检测用，跨用户扫描）。"""
    with connect() as conn:
        cur = conn.execute("SELECT * FROM projects ORDER BY id")
        return [project_view(r) for r in cur.fetchall()]


def get_project(project_id):
    """按 id 取项目（不校验归属；归属校验在 server 层按当前用户进行）。"""
    with connect() as conn:
        cur = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,))
        row = cur.fetchone()
    return project_view(row) if row is not None else None


def insert_project(user_id, name, project_dir, agent_path, work_dir,
                   guide_text="", commit_spec="", deploy_spec="", env_label="",
                   model="", skill_understand="", skill_deploy="", skill_commit="",
                   skill_test="", skill_cases="",
                   reasoning_effort="", permission_mode=""):
    """插入项目（归属 user_id），返回新 id（name 冲突时抛 sqlite3.IntegrityError）。

    bug_dir 列已废弃（bug 报告目录由 work_dir 派生），恒写空串
    （旧库该列 NOT NULL 无默认值，不能省略不写）。
    reasoning_effort/permission_mode＝项目级会话默认值（空=不指定，见 dshdriver）。
    """
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO projects(name, user_id, project_dir, agent_path, work_dir, bug_dir,"
            " guide_text, commit_spec, deploy_spec, env_label, model,"
            " skill_understand, skill_deploy, skill_commit, skill_test, skill_cases,"
            " reasoning_effort, permission_mode, created_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (name, user_id, project_dir, agent_path, work_dir, "",
             guide_text, commit_spec, deploy_spec, env_label, model,
             skill_understand, skill_deploy, skill_commit, skill_test, skill_cases,
             reasoning_effort, permission_mode, now_str()))
        return cur.lastrowid


def update_project(project_id, name, project_dir, agent_path, work_dir,
                   guide_text="", commit_spec="", deploy_spec="", env_label="",
                   model="", skill_understand="", skill_deploy="", skill_commit="",
                   skill_test="", skill_cases="",
                   reasoning_effort="", permission_mode=""):
    """更新项目（bug_dir 列已废弃，不再更新）。"""
    with connect() as conn:
        conn.execute(
            "UPDATE projects SET name=?, project_dir=?, agent_path=?, work_dir=?,"
            " guide_text=?, commit_spec=?, deploy_spec=?, env_label=?, model=?,"
            " skill_understand=?, skill_deploy=?, skill_commit=?, skill_test=?,"
            " skill_cases=?, reasoning_effort=?, permission_mode=? WHERE id=?",
            (name, project_dir, agent_path, work_dir,
             guide_text, commit_spec, deploy_spec, env_label, model,
             skill_understand, skill_deploy, skill_commit, skill_test, skill_cases,
             reasoning_effort, permission_mode,
             project_id))


def delete_project(project_id):
    """删除项目及其任务/轮次（外键级联由应用层执行）。"""
    with connect() as conn:
        conn.execute("DELETE FROM rounds WHERE task_id IN (SELECT id FROM tasks"
                     " WHERE project_id=?)", (project_id,))
        conn.execute("DELETE FROM tasks WHERE project_id=?", (project_id,))
        conn.execute("DELETE FROM projects WHERE id=?", (project_id,))


def set_project_archived(project_id, archived):
    """设置项目归档标记（True=归档 False=恢复）；只改标记，不动任务与文件。"""
    with connect() as conn:
        conn.execute("UPDATE projects SET archived=? WHERE id=?",
                     (1 if archived else 0, project_id))


# ---------- tasks ----------

def insert_task(project_id, name, auto_fix, retest, stop_type, stop_value,
                task_type="normal", payload="", extra="", model="", permission="",
                auto_commit=0, auto_deploy=0, auto_retest=0, cases_base=0,
                start_stage="", end_stage="", date_from="", date_to=""):
    """插入任务行，返回新 id。

    start_stage/end_stage 为生命周期阶段 key（见 server.STAGES），空串表示
    不涉及阶段（reject/script_retest/stress/存量行）；date_from/date_to 为
    提交日期范围（YYYY-MM-DD，空=不限，复测/探索优先覆盖该范围提交）。
    """
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO tasks(project_id, name, auto_fix, retest, stop_type, stop_value,"
            " task_type, payload, extra, model, permission, auto_commit, auto_deploy,"
            " auto_retest, cases_base, start_stage, end_stage, date_from, date_to,"
            " created_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (project_id, name, 1 if auto_fix else 0, retest, stop_type, stop_value,
             task_type, payload, extra, model, permission,
             1 if auto_commit else 0, 1 if auto_deploy else 0,
             1 if auto_retest else 0, int(cases_base or 0),
             start_stage or "", end_stage or "", date_from or "", date_to or "",
             now_str()))
        return cur.lastrowid


def get_task(task_id):
    with connect() as conn:
        cur = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,))
        return cur.fetchone()


def list_tasks(project_id):
    with connect() as conn:
        cur = conn.execute("SELECT * FROM tasks WHERE project_id=? ORDER BY id DESC",
                           (project_id,))
        return cur.fetchall()


def list_all_tasks():
    """全部任务（服务启动恢复时用）。"""
    with connect() as conn:
        cur = conn.execute("SELECT * FROM tasks ORDER BY id")
        return cur.fetchall()


def update_task(task_id, **fields):
    """按字段名更新任务（白名单字段防注入）。"""
    allowed = {"name", "auto_fix", "retest", "stop_type", "stop_value", "status",
               "session_id", "current_round", "new_bugs", "started_at", "ended_at",
               "error", "task_type", "payload", "extra", "model", "permission",
               "auto_commit", "auto_deploy", "auto_retest", "cases_base",
               "fresh_prompt", "start_stage", "end_stage", "date_from", "date_to",
               "load_rerun"}
    cols = [k for k in fields if k in allowed]
    if not cols:
        return
    sql = "UPDATE tasks SET " + ",".join(f"{c}=?" for c in cols) + " WHERE id=?"
    with connect() as conn:
        conn.execute(sql, [fields[c] for c in cols] + [task_id])


# ---------- rounds ----------

def insert_round(task_id, round_no, log_path, kind="agent", run_key=""):
    """开一轮：落一行 running 轮次。

    kind='agent'（缺省）为 agent 会话轮次；kind='load' 为压测的一次发压运行，
    此时 run_key 是该运行的唯一标识（开始时刻 YYYYmmdd_HHMMSS），发压产物
    （日志/指标/报告）全部按它命名。
    """
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO rounds(task_id, round_no, status, log_path, started_at,"
            " kind, run_key) VALUES(?,?,?,?,?,?,?)",
            (task_id, round_no, "running", log_path, now_str(), kind, run_key))
        return cur.lastrowid


def finish_round(round_id, status, exit_code, summary, log_path=None):
    """结束一轮：状态/退出码/摘要。log_path 用于进程离线时补写日志路径。"""
    with connect() as conn:
        if log_path:
            conn.execute("UPDATE rounds SET log_path=? WHERE id=?",
                         (log_path, round_id))
        conn.execute("UPDATE rounds SET status=?, exit_code=?, summary=?, ended_at=?"
                     " WHERE id=?",
                     (status, exit_code, summary, now_str(), round_id))


def list_rounds(task_id):
    with connect() as conn:
        cur = conn.execute("SELECT * FROM rounds WHERE task_id=? ORDER BY round_no",
                           (task_id,))
        return cur.fetchall()


def delete_rounds(task_id):
    """清空任务的轮次记录（restart 时调用，避免重启后 round_no 重复）。"""
    with connect() as conn:
        conn.execute("DELETE FROM rounds WHERE task_id=?", (task_id,))


def delete_task(task_id):
    """删除任务及其轮次记录（.web 下的轮次日志文件保留在磁盘，不清理）。"""
    with connect() as conn:
        conn.execute("DELETE FROM rounds WHERE task_id=?", (task_id,))
        conn.execute("DELETE FROM tasks WHERE id=?", (task_id,))


def get_round(round_id):
    with connect() as conn:
        cur = conn.execute("SELECT * FROM rounds WHERE id=?", (round_id,))
        return cur.fetchone()


def get_log_round(task_id, round_no):
    """按任务+轮次取 round 行（日志查询用）。"""
    with connect() as conn:
        cur = conn.execute("SELECT * FROM rounds WHERE task_id=? AND round_no=?",
                           (task_id, round_no))
        return cur.fetchone()



# ---------- board（看板） ----------

# update_board_card 的可更新字段白名单（防注入）
BOARD_CARD_FIELDS = {
    "title", "description", "column_key", "sort_order", "session_id", "sessions",
    "block_kind", "block_text", "parent_card_id", "readonly", "model",
    "scheduled_at", "worktree", "jira_key", "last_error", "last_error_at",
    "done_at", "origin",
}


def insert_board_card(project_id, title, description="", jira_key=""):
    """新建看板卡片（默认落 todo 列尾）。返回卡片 id。"""
    with connect() as conn:
        cur = conn.execute(
            "SELECT COALESCE(MAX(sort_order),0)+1 FROM board_cards"
            " WHERE project_id=? AND column_key='todo'", (project_id,))
        sort_order = cur.fetchone()[0]
        cur = conn.execute(
            "INSERT INTO board_cards(project_id, title, description, column_key,"
            " sort_order, jira_key, created_at, updated_at)"
            " VALUES(?,?,?,'todo',?,?,?,?)",
            (project_id, title, description, sort_order, jira_key,
             now_str(), now_str()))
        card_id = cur.lastrowid
        # P4 看板事件化：新建卡片也发一次变更信号（前端重取即见）
        localbus.publish(localbus.board_topic(project_id))
        return card_id


def get_board_card(card_id):
    """按 id 取卡片（不校验项目归属，归属由 server 层 _owned_project 保证）。"""
    with connect() as conn:
        cur = conn.execute("SELECT * FROM board_cards WHERE id=?", (card_id,))
        return cur.fetchone()


def list_board_cards(project_id):
    """项目全部有效卡片（回收站外，按列+列内序号排序）。"""
    with connect() as conn:
        cur = conn.execute(
            "SELECT * FROM board_cards WHERE project_id=? AND trashed=0"
            " ORDER BY column_key, sort_order, id", (project_id,))
        return cur.fetchall()


def list_trashed_cards(project_id):
    """项目回收站卡片（按删除时间倒序，新删在前）。"""
    with connect() as conn:
        cur = conn.execute(
            "SELECT * FROM board_cards WHERE project_id=? AND trashed=1"
            " ORDER BY trashed_at DESC, id DESC", (project_id,))
        return cur.fetchall()


def board_counts_many(project_ids):
    """批量统计各项目看板三列（doing/blocked/review）的卡片数量。

    只统计回收站外卡片（trashed=0）；排队占位卡（block_kind='queue'）同样落在
    doing 列一并计入。返回 {project_id: {"doing": n, "blocked": n, "review": n}}，
    无卡片的列记 0。项目列表端点用它一次 GROUP BY 查询算全量，避免逐项目查库。
    """
    out = {pid: {"doing": 0, "blocked": 0, "review": 0} for pid in project_ids}
    if not project_ids:
        return out
    marks = ", ".join("?" * len(project_ids))
    with connect() as conn:
        cur = conn.execute(
            "SELECT project_id, column_key, COUNT(*) FROM board_cards"
            " WHERE trashed=0 AND column_key IN ('doing','blocked','review')"
            f" AND project_id IN ({marks}) GROUP BY project_id, column_key",
            tuple(project_ids))
        for pid, col, n in cur.fetchall():
            if pid in out:
                out[pid][col] = n
    return out


def list_queued_board_cards():
    """全部项目的排队看板卡片（P4 单态：doing + queue，按 updated_at,id 升序）——runner recover 重建队列用。"""
    with connect() as conn:
        cur = conn.execute(
            "SELECT * FROM board_cards WHERE block_kind='queue' AND trashed=0"
            " AND column_key='doing'"
            " ORDER BY updated_at, id")
        return cur.fetchall()


def _notify_card_change(conn, card_id):
    """卡片写路径的进程内变更信号（P4 看板事件化）。

    看板前端从 5s 轮询改成事件唤醒后，「谁改了卡片」必须都能通知到——写路径
    集中在 db 层（update/insert/trash/restore/purge），故在此统一发信号，
    调用方无需逐处补。查 project_id 走主键行（带索引，微秒级）；异常吞掉
    （通知失败绝不影响业务写）。
    """
    try:
        row = conn.execute("SELECT project_id FROM board_cards WHERE id=?",
                           (card_id,)).fetchone()
        if row:
            localbus.publish(localbus.board_topic(row["project_id"]))
    except Exception:                        # noqa: BLE001
        pass


def update_board_card(card_id, **fields):
    """按白名单字段更新卡片，并自动刷新 updated_at。

    done_at 派生维护：column_key 落 'done' 且未显式给 done_at → 盖当前时间
    （= 最近一次进入已完成，前端 done 列默认排序用）；column_key 为其它列且
    未显式给 → 清空。集中在此维护可覆盖所有置 done 的写路径（手动移列 /
    sync 归档 / 定时批量），调用方无需逐处补。"""
    cols = [k for k in fields if k in BOARD_CARD_FIELDS]
    if not cols:
        return
    if "column_key" in fields and "done_at" not in fields:
        fields["done_at"] = now_str() if fields["column_key"] == "done" else None
        cols.append("done_at")
    sql = ("UPDATE board_cards SET " + ",".join(f"{c}=?" for c in cols)
           + ", updated_at=? WHERE id=?")
    with connect() as conn:
        conn.execute(sql, [fields[c] for c in cols] + [now_str(), card_id])
        _notify_card_change(conn, card_id)


def trash_board_card(card_id):
    """卡片移入回收站（软删除）：置 trashed=1 + trashed_at。
    此时卡片从看板列表消失（读板路径统一 trashed=0 过滤），行与评论保留待还原。"""
    with connect() as conn:
        conn.execute(
            "UPDATE board_cards SET trashed=1, trashed_at=?, updated_at=? WHERE id=?",
            (now_str(), now_str(), card_id))
        _notify_card_change(conn, card_id)


def restore_board_card(card_id):
    """回收站还原：清 trashed 标记（回原列原位置，sort_order 保留），看板重新可见。"""
    with connect() as conn:
        conn.execute(
            "UPDATE board_cards SET trashed=0, trashed_at=NULL, updated_at=? WHERE id=?",
            (now_str(), card_id))
        _notify_card_change(conn, card_id)


def purge_board_card(card_id):
    """彻底删除卡片并连带删其评论（回收站真删；不可恢复）。"""
    with connect() as conn:
        pid_row = conn.execute("SELECT project_id FROM board_cards WHERE id=?",
                               (card_id,)).fetchone()
        conn.execute("DELETE FROM board_comments WHERE card_id=?", (card_id,))
        conn.execute("DELETE FROM board_cards WHERE id=?", (card_id,))
        if pid_row:
            localbus.publish(localbus.board_topic(pid_row["project_id"]))


def purge_trashed_cards(project_id):
    """清空项目回收站：真删全部已删卡及其评论（不可恢复）。"""
    with connect() as conn:
        rows = conn.execute(
            "SELECT id FROM board_cards WHERE project_id=? AND trashed=1",
            (project_id,)).fetchall()
        ids = [r["id"] for r in rows]
        if not ids:
            return
        marks = ",".join("?" * len(ids))
        conn.execute(f"DELETE FROM board_comments WHERE card_id IN ({marks})", ids)
        conn.execute(f"DELETE FROM board_cards WHERE id IN ({marks})", ids)


def insert_board_comment(card_id, text):
    """给卡片加评论。返回评论 id。"""
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO board_comments(card_id, text, created_at) VALUES(?,?,?)",
            (card_id, text, now_str()))
        return cur.lastrowid


def list_board_comments(project_id):
    """项目全部卡片的评论（JOIN 限定项目，前端按 card_id 分组）。"""
    with connect() as conn:
        cur = conn.execute(
            "SELECT c.* FROM board_comments c"
            " JOIN board_cards k ON k.id=c.card_id"
            " WHERE k.project_id=? ORDER BY c.id", (project_id,))
        return cur.fetchall()


def update_board_comment(comment_id, **fields):
    """按白名单字段更新评论（投递状态/投递文本/投递会话）。"""
    allowed = {"sent", "session_id", "sent_text"}
    cols = [k for k in fields if k in allowed]
    if not cols:
        return
    sql = "UPDATE board_comments SET " + ",".join(f"{c}=?" for c in cols) + " WHERE id=?"
    with connect() as conn:
        conn.execute(sql, [fields[c] for c in cols] + [comment_id])


def delete_board_comment(comment_id):
    with connect() as conn:
        conn.execute("DELETE FROM board_comments WHERE id=?", (comment_id,))


def get_board_settings(project_id):
    """看板设置 dict（无记录返回 {}）。json 字段结构见 board.py SETTINGS 默认。"""
    with connect() as conn:
        cur = conn.execute("SELECT json FROM board_settings WHERE project_id=?",
                           (project_id,))
        row = cur.fetchone()
    if row is None:
        return {}
    try:
        return json.loads(row["json"])
    except ValueError:
        return {}


def set_board_settings(project_id, settings):
    """覆盖写看板设置（dict 序列化为 json 列）。"""
    with connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO board_settings(project_id, json) VALUES(?,?)",
            (project_id, json.dumps(settings, ensure_ascii=False)))


# ---------- 飞书集成（M1 出站推送）：用户级配置 / 项目推送绑定 / 投递队列 ----------

def get_app_setting(key):
    """全局 KV 设置（app_settings 表，json 列）：dict 或 {}（无记录/坏 JSON 降级）。

    2026-09-09 起飞书配置用户级化，feishu.py 不再读 app_settings['feishu']
    （旧值在 migrate 时已迁给 admin），本函数仍供其他全局键使用。"""
    with connect() as conn:
        row = conn.execute("SELECT json FROM app_settings WHERE key=?", (key,)).fetchone()
    if row is None:
        return {}
    try:
        return json.loads(row["json"])
    except ValueError:
        return {}


def set_app_setting(key, obj):
    """UPSERT 全局 KV 设置（dict 序列化为 json 列，整对象覆盖）。"""
    with connect() as conn:
        conn.execute(
            "INSERT INTO app_settings(key, json) VALUES(?, ?)"
            " ON CONFLICT(key) DO UPDATE SET json=excluded.json",
            (key, json.dumps(obj, ensure_ascii=False)))


def get_feishu_user_cfg(user_id):
    """用户飞书配置 dict（feishu_user_cfgs 表 json 列）：dict 或 {}（无记录降级）。"""
    with connect() as conn:
        row = conn.execute(
            "SELECT json FROM feishu_user_cfgs WHERE user_id=?", (user_id,)).fetchone()
    if row is None:
        return {}
    try:
        return json.loads(row["json"])
    except ValueError:
        return {}


def set_feishu_user_cfg(user_id, obj):
    """UPSERT 用户飞书配置（整对象覆盖；secret 以明文落库同旧全局语义）。"""
    with connect() as conn:
        conn.execute(
            "INSERT INTO feishu_user_cfgs(user_id, json) VALUES(?,?)"
            " ON CONFLICT(user_id) DO UPDATE SET json=excluded.json",
            (user_id, json.dumps(obj, ensure_ascii=False)))


def list_feishu_user_cfgs():
    """全部用户的飞书配置 [(user_id, dict)]（服务启动遍历入站长连接用）。"""
    with connect() as conn:
        rows = conn.execute("SELECT user_id, json FROM feishu_user_cfgs").fetchall()
    out = []
    for r in rows:
        try:
            out.append((r["user_id"], json.loads(r["json"])))
        except ValueError:
            continue  # 坏 JSON 行跳过（视同无配置）
    return out


# ---------- 用户 UI 偏好（按 用户+项目 维度，标签页布局/看板列过滤等前端记忆） ----------

def get_user_prefs(user_id, project_id):
    """某用户在某项目下的全部 UI 偏好：{key: value_dict}（坏 JSON 的键降级跳过）。"""
    with connect() as conn:
        rows = conn.execute(
            "SELECT key, value FROM user_prefs WHERE user_id=? AND project_id=?",
            (user_id, project_id)).fetchall()
    out = {}
    for r in rows:
        try:
            out[r["key"]] = json.loads(r["value"])
        except ValueError:
            continue  # 坏 JSON（手工改库等）不炸接口，视同无此偏好
    return out


def set_user_pref(user_id, project_id, key, value):
    """UPSERT 一条 UI 偏好（value 为可 JSON 序列化对象，整对象覆盖）。"""
    with connect() as conn:
        conn.execute(
            "INSERT INTO user_prefs(user_id, project_id, key, value, updated_at)"
            " VALUES(?, ?, ?, ?, ?)"
            " ON CONFLICT(user_id, project_id, key)"
            " DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (user_id, project_id, key,
             json.dumps(value, ensure_ascii=False), now_str()))


def get_feishu_hook(project_id):
    """项目飞书推送绑定行（webhook/secret/事件开关），无记录返回 None。"""
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM feishu_hooks WHERE project_id=?", (project_id,)).fetchone()


def set_feishu_hook(project_id, webhook_url, webhook_secret, events, enabled):
    """UPSERT 项目推送绑定（events 为逗号拼接串，合法性由调用方保证）。"""
    with connect() as conn:
        conn.execute(
            "INSERT INTO feishu_hooks(project_id, webhook_url, webhook_secret,"
            " events, enabled) VALUES(?,?,?,?,?)"
            " ON CONFLICT(project_id) DO UPDATE SET webhook_url=excluded.webhook_url,"
            " webhook_secret=excluded.webhook_secret, events=excluded.events,"
            " enabled=excluded.enabled",
            (project_id, webhook_url, webhook_secret, events, enabled))


def feishu_outbox_push(target, secret, payload, dedup_key="", user_id=0):
    """投递入队（飞书事件唯一入口）：同 dedup_key 已有 pending 行时幂等跳过
    （返回 None），防阻塞卡在多写点重复推送；否则插入并返回新行 id。
    user_id = 投递归属用户（项目所有者，供用户设置页过滤自己的记录）。"""
    if dedup_key:
        with connect() as conn:
            dup = conn.execute(
                "SELECT id FROM feishu_outbox WHERE dedup_key=? AND status='pending'",
                (dedup_key,)).fetchone()
        if dup is not None:
            return None
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO feishu_outbox(user_id, target, secret, payload, dedup_key,"
            " next_at, created_at) VALUES(?,?,?,?,?,0,?)",
            (user_id, target, secret, payload, dedup_key, now_str()))
        return cur.lastrowid


def feishu_outbox_due(now_ts, limit=5):
    """到期待投递行（pending 且 next_at<=now_ts，按 id 稳定序限量）。"""
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM feishu_outbox WHERE status='pending' AND next_at<=?"
            " ORDER BY id LIMIT ?", (now_ts, limit)).fetchall()


def feishu_outbox_mark(oid, status, retries, next_at, last_error=""):
    """投递结果落账（发送线程专用：状态/重试数/下次重试时刻/末次错误摘要）。"""
    with connect() as conn:
        conn.execute(
            "UPDATE feishu_outbox SET status=?, retries=?, next_at=?, last_error=?"
            " WHERE id=?", (status, retries, next_at, last_error, oid))


def feishu_outbox_recent(limit=50, user_id=None):
    """最近投递记录（新→旧）；user_id 非 None 时仅返回该用户的（设置页过滤）。"""
    with connect() as conn:
        if user_id is None:
            return conn.execute(
                "SELECT * FROM feishu_outbox ORDER BY id DESC LIMIT ?",
                (limit,)).fetchall()
        return conn.execute(
            "SELECT * FROM feishu_outbox WHERE user_id=? ORDER BY id DESC LIMIT ?",
            (user_id, limit)).fetchall()


def get_feishu_binding_by_open(open_id):
    """飞书号绑定行（open_id → Touchstone 用户），未绑返回 None。"""
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM feishu_bindings WHERE open_id=?", (open_id,)).fetchone()


def get_feishu_binding_by_user(user_id):
    """用户绑定行（Touchstone 用户 → 飞书号），未绑返回 None。"""
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM feishu_bindings WHERE user_id=?", (user_id,)).fetchone()


def set_feishu_binding(open_id, user_id, default_project_id=0):
    """绑定飞书号 ↔ 用户（双向一对一）：user_id 已绑其他 open_id 时先清旧绑
    （换号重绑语义）；open_id 重绑直接覆盖（UPDATE）。"""
    with connect() as conn:
        conn.execute("DELETE FROM feishu_bindings WHERE user_id=?", (user_id,))
        conn.execute(
            "INSERT INTO feishu_bindings(open_id, user_id, default_project_id)"
            " VALUES(?,?,?) ON CONFLICT(open_id) DO UPDATE SET"
            " user_id=excluded.user_id, default_project_id=excluded.default_project_id",
            (open_id, user_id, default_project_id))


def del_feishu_binding_by_open(open_id):
    """按飞书号解绑。"""
    with connect() as conn:
        conn.execute("DELETE FROM feishu_bindings WHERE open_id=?", (open_id,))


def del_feishu_binding_by_user(user_id):
    """按用户解绑（用户主动解绑/admin 强制解绑）。"""
    with connect() as conn:
        conn.execute("DELETE FROM feishu_bindings WHERE user_id=?", (user_id,))


def set_feishu_default_project(open_id, project_id):
    """设置单聊默认项目（0=无；归属校验由调用方保证）。"""
    with connect() as conn:
        conn.execute(
            "UPDATE feishu_bindings SET default_project_id=? WHERE open_id=?",
            (project_id, open_id))
