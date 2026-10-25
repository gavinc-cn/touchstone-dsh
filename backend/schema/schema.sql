-- 由 tools/export_schema.py 从 db.py 生成，请勿手改。改 db.py 后重跑导出。

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
, archived INTEGER NOT NULL DEFAULT 0);
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
    -- 界面语言（T13，2026-10-23）：任务创建时冻结（'zh'/'en'），存量行 DEFAULT 'zh'；
    -- 读侧一律经 i18n.task_lang 归一，创建后不可改（不在 update_task 白名单）。
    lang         TEXT NOT NULL DEFAULT 'zh',
    created_at   TEXT NOT NULL,
    started_at   TEXT,
    ended_at     TEXT,
    error        TEXT NOT NULL DEFAULT ''
);
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
    -- 界面语言（T13，2026-10-23）：卡片**新建时为 ''=未冻结**，首次 start 才写入
    -- 请求语言（之后不覆盖）；存量行 DEFAULT 'zh'。读侧一律经 i18n.card_lang 归一。
    lang           TEXT NOT NULL DEFAULT 'zh',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    -- 2026-10-07 起：卡片状态（列）被平台/agent 改动、而用户还没打开过卡片 ⇒ 1
    -- （前端卡面打「有更新」标记，用户打开卡片详情即清 0）。用户自己拖列/点按钮
    -- 造成的列变化不置位（见 update_board_card 的 mark_unread 形参）。
    unread         INTEGER NOT NULL DEFAULT 0
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
    bound_at           TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    cur_sid        TEXT    NOT NULL DEFAULT '',   -- 当前会话 id（空=未绑定会话）
    cur_project_id INTEGER NOT NULL DEFAULT 0,    -- 当前会话所属项目（投递队列归属）
    cur_title      TEXT    NOT NULL DEFAULT '',   -- 绑定时标题快照
    cur_bound_at   TEXT    NOT NULL DEFAULT ''    -- 绑定时刻（localtime）
);
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_user_name ON projects(user_id, name);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_rounds_task ON rounds(task_id);
CREATE INDEX IF NOT EXISTS idx_board_cards_project ON board_cards(project_id);
CREATE INDEX IF NOT EXISTS idx_board_comments_card ON board_comments(card_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wait_active ON wait_items(kind, target_id)
    WHERE state IN ('waiting','starting','running','finishing');
CREATE INDEX IF NOT EXISTS idx_wait_pick ON wait_items(state, project_id, seq);
CREATE INDEX IF NOT EXISTS idx_chat_msgs_sid ON chat_msgs(sid, created_at);
