-- 由 tools/export_schema.py 从 db.py 生成，请勿手改。改 db.py 后重跑导出。
-- 旧库夹具②：更老的年代

CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (username)
);
CREATE TABLE sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    project_dir TEXT NOT NULL,
    agent_path TEXT NOT NULL DEFAULT '',
    work_dir TEXT NOT NULL,
    bug_dir TEXT NOT NULL,
    guide_text TEXT NOT NULL DEFAULT '',
    commit_spec TEXT NOT NULL DEFAULT '',
    deploy_spec TEXT NOT NULL DEFAULT '',
    env_label TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (name)
);
CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    auto_fix INTEGER NOT NULL DEFAULT 0,
    retest TEXT NOT NULL DEFAULT '不复测',
    stop_type TEXT NOT NULL DEFAULT 'rounds',
    stop_value TEXT NOT NULL DEFAULT '1',
    status TEXT NOT NULL DEFAULT 'queued',
    session_id TEXT NOT NULL DEFAULT '',
    current_round INTEGER NOT NULL DEFAULT 0,
    new_bugs INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE rounds (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL,
    round_no INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    exit_code INTEGER,
    log_path TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    ended_at TEXT,
    summary TEXT NOT NULL DEFAULT ''
);
CREATE TABLE board_cards (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    column_key TEXT NOT NULL DEFAULT 'todo',
    sort_order INTEGER NOT NULL DEFAULT 0,
    session_id TEXT NOT NULL DEFAULT '',
    sessions TEXT NOT NULL DEFAULT '[]',
    block_kind TEXT,
    block_text TEXT NOT NULL DEFAULT '',
    parent_card_id INTEGER,
    readonly INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL DEFAULT '',
    scheduled_at INTEGER,
    jira_key TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',
    last_error_at INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE board_comments (
    id INTEGER PRIMARY KEY,
    card_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0,
    session_id TEXT NOT NULL DEFAULT '',
    sent_text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE board_settings (
    project_id INTEGER PRIMARY KEY,
    json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE user_prefs (
    user_id INTEGER NOT NULL,
    project_id INTEGER NOT NULL DEFAULT 0,
    key TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, project_id, key)
);
CREATE TABLE feishu_hooks (
    project_id INTEGER PRIMARY KEY,
    webhook_url TEXT NOT NULL DEFAULT '',
    webhook_secret TEXT NOT NULL DEFAULT '',
    events TEXT NOT NULL DEFAULT 'blocked_interaction,task_failed',
    enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE feishu_outbox (
    id INTEGER PRIMARY KEY,
    target TEXT NOT NULL,
    secret TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    retries INTEGER NOT NULL DEFAULT 0,
    next_at REAL NOT NULL DEFAULT 0,
    dedup_key TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE feishu_user_cfgs (
    user_id INTEGER PRIMARY KEY,
    json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE feishu_bindings (
    open_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    default_project_id INTEGER NOT NULL DEFAULT 0,
    bound_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE (user_id)
);
CREATE TABLE wait_items (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'waiting',
    seq INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    claimed_at TEXT,
    claimed_by TEXT,
    ended_at TEXT,
    not_before REAL NOT NULL DEFAULT 0,
    retries INTEGER NOT NULL DEFAULT 0,
    meta TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE chat_msgs (
    id TEXT PRIMARY KEY,
    project_id INTEGER NOT NULL,
    sid TEXT NOT NULL,
    task_id INTEGER,
    card_id INTEGER,
    message TEXT NOT NULL,
    state TEXT NOT NULL,
    error TEXT NOT NULL DEFAULT '',
    inject INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    ended_at INTEGER
);
CREATE TABLE leases (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    kind      TEXT NOT NULL,
    target_id TEXT NOT NULL,
    acquired  REAL NOT NULL DEFAULT 0,
    note      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_leases_project ON leases(target_id);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_rounds_task ON rounds(task_id);
CREATE INDEX idx_board_cards_project ON board_cards(project_id);
CREATE INDEX idx_board_comments_card ON board_comments(card_id);
CREATE UNIQUE INDEX idx_wait_active ON wait_items(kind, target_id) WHERE state IN ('waiting','claimed','running','finishing');
CREATE INDEX idx_wait_pick ON wait_items(state, project_id, seq);
CREATE INDEX idx_chat_msgs_sid ON chat_msgs(sid, created_at);

-- 种子数据
INSERT INTO users(id, username, pass_hash, salt, created_at) VALUES(1, 'admin', 'd41d8cd98f00b204e9800998ecf8427e', '', '2026-01-01 00:00:00');
INSERT INTO projects(id, name, project_dir, work_dir, bug_dir, commit_spec, deploy_spec, created_at, user_id) VALUES(1, 'proj_one', '/tmp/ts-fixture/proj', '/tmp/ts-fixture/proj/free_style', '/tmp/ts-fixture/proj/free_style/bug_report', 'fix: 老规范', '部署：老说明', '2026-01-01 00:00:00', 0);
INSERT INTO tasks(id, project_id, name, created_at) VALUES(1, 1, 't1', '2026-01-01 00:00:00');
INSERT INTO board_cards(updated_at, id, project_id, title, created_at, column_key, block_kind, block_text, last_error) VALUES('x', 1, 1, 'legacy card', '2026-01-01 00:00:00', 'blocked', 'queue', '提交中：老机器文案', '阻塞让行提交失败 x');
INSERT INTO wait_items(seq, created_at, kind, target_id, project_id, state) VALUES(0, 'x', 'card', 'c:1', 1, 'claimed');
INSERT INTO leases(kind, target_id) VALUES('card', 'c:old');
INSERT INTO app_settings(key, json) VALUES('feishu', '{"app_id": "cli_legacy", "app_secret": "sec_legacy", "base_url": "https://open.feishu.cn"}');
