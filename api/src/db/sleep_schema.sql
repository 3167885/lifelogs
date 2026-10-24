-- Sleep tracking schema (阶段 1).
-- All timestamps in these tables are UTC ISO 8601 strings: YYYY-MM-DDTHH:mm:ss.sssZ.
-- Legacy lifelogs tables keep INTEGER ms timestamps by design; no migration of them.

CREATE TABLE IF NOT EXISTS sleep_events (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    client_event_id TEXT NOT NULL,
    event_type      TEXT NOT NULL CHECK (event_type IN ('sleep', 'wake')),
    occurred_at     TEXT NOT NULL,
    session_id      TEXT NULL,
    created_at      TEXT NOT NULL,
    UNIQUE (user_id, client_event_id)
);

CREATE INDEX IF NOT EXISTS idx_sleep_events_user_type_time
    ON sleep_events (user_id, event_type, occurred_at);

-- At most one unpaired sleep event per user (structural guarantee).
CREATE UNIQUE INDEX IF NOT EXISTS idx_sleep_events_open_sleep
    ON sleep_events (user_id)
    WHERE event_type = 'sleep' AND session_id IS NULL;

CREATE TABLE IF NOT EXISTS sleep_sessions (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL,
    sleep_event_id   TEXT NULL,
    wake_event_id    TEXT NULL,
    start_at         TEXT NOT NULL,
    end_at           TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    quality          INTEGER NULL CHECK (quality BETWEEN 1 AND 5),
    version          INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    -- Internal field: client_op_id of the op that last confirmed this row.
    -- Used to reconcile an idempotent replay whose sync_ops result row could not
    -- be persisted, and to assert that an UPDATE truly applied.
    last_op_id       TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_sleep_sessions_user_start
    ON sleep_sessions (user_id, start_at);

-- Composite cursor ordering for incremental pulls.
CREATE INDEX IF NOT EXISTS idx_sleep_sessions_user_updated_id
    ON sleep_sessions (user_id, updated_at, id);

CREATE TABLE IF NOT EXISTS sync_ops (
    user_id      TEXT NOT NULL,
    client_op_id TEXT NOT NULL,
    op_type      TEXT NOT NULL,
    -- NULL = placeholder row (op not yet confirmed); non-NULL = cached success result.
    result_json  TEXT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (user_id, client_op_id)
);

-- Guard table for the CHECK-guard mechanism validated in api/test/guard-probe
-- (gates G1-G5). Any row insert always violates CHECK (1 = 0); business
-- batches write "INSERT INTO guard_abort SELECT 1 WHERE <failure condition>"
-- so success inserts 0 rows (table stays empty) and business failure raises a
-- constraint error that aborts and rolls back the whole db.batch().
CREATE TABLE IF NOT EXISTS guard_abort (
    n INTEGER NOT NULL CHECK (1 = 0)
);
