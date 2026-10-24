-- Guard-mechanism probe schema (阶段 1 前置 gate 测试专用，一次性用途).
-- 镜像正式方案的关键语义：guard_abort 任何插入必然违反 CHECK。
CREATE TABLE IF NOT EXISTS guard_abort (
  n INTEGER NOT NULL CHECK (1 = 0)
);

CREATE TABLE IF NOT EXISTS probe_rows (
  id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS probe_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  last_op_id TEXT NULL
);

CREATE TABLE IF NOT EXISTS probe_sync_ops (
  client_op_id TEXT PRIMARY KEY,
  result_json TEXT NULL
);
