/**
 * Sleep sessions API (阶段 1): POST /api/sessions, PATCH /api/sessions/:id,
 * GET /api/sessions.
 *
 * Contract (approved, single format everywhere): POST /api/sessions requires
 * the client to supply BOTH session_id (UUID) and client_op_id (UUID); the
 * server stores the client UUID as the authoritative row id so offline
 * records keep stable ids after sync. (sleepAPKprompt_v2 §7.2 originally
 * listed only client_op_id — recorded as an approved contract difference.)
 *
 * Atomicity model (validated by gates G1–G5 before implementation):
 * - Every mutating op runs in ONE db.batch(). Business failures are turned
 *   into constraint violations via the guard_abort table (CHECK (1 = 0)),
 *   which makes D1 roll back the WHOLE batch — no half-written sessions,
 *   no placeholder rows, no successful sync_ops for failed ops.
 * - sync_ops rows with result_json = NULL are placeholders created inside
 *   the same batch; result_json is only filled by a conditional UPDATE
 *   guarded by changes().
 * - The sync_ops PRIMARY KEY doubles as the idempotency claim: a repeated
 *   client_op_id collides with the committed row instead of racing.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import type { Env, SleepSession, SyncOp, Variables } from '../lib/types.js';
import { normalizeUtcIso, parseUtcIso, nowIso, durationMinutes } from '../lib/time.js';
import {
  GUARD_CHANGES_NE_1,
  GUARD_SESSION_OVERLAP,
  sessionView,
  validateInterval,
  isUniqueError,
} from '../lib/sleep.js';

const sessions = new Hono<{ Bindings: Env; Variables: Variables }>();

sessions.use('*', requireAuth);

function err(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { error: { code, message }, ...extra };
}

async function readSession(db: D1Database, userId: string, sessionId: string) {
  const row = await db
    .prepare('SELECT * FROM sleep_sessions WHERE id = ? AND user_id = ?')
    .bind(sessionId, userId)
    .first<SleepSession>();
  return row ? sessionView(row) : null;
}

async function cachedResult(db: D1Database, userId: string, clientOpId: string) {
  const op = await db
    .prepare('SELECT * FROM sync_ops WHERE user_id = ? AND client_op_id = ?')
    .bind(userId, clientOpId)
    .first<SyncOp>();
  if (!op || op.result_json === null) {
    return null;
  }
  // Only successfully completed ops are cached; replay returns the original result.
  return JSON.parse(op.result_json) as Record<string, unknown>;
}

const insertSchema = z.object({
  session_id: z.string().uuid(),
  client_op_id: z.string().uuid(),
  start_at: z.string().min(1),
  end_at: z.string().min(1),
  quality: z.number().int().min(1).max(5).optional().nullable(),
});

// POST /api/sessions — insert a complete record (backfill)
sessions.post('/', zValidator('json', insertSchema), async (c) => {
  const db = c.env.DB;
  const user = c.get('user')!;
  const body = c.req.valid('json');

  const replay = await cachedResult(db, user.id, body.client_op_id);
  if (replay) {
    return c.json(replay, 200);
  }

  const interval = validateInterval(body.start_at, body.end_at);
  if ('error' in interval) {
    const code = interval.error === 'INVALID_SLEEP_INTERVAL'
      ? 'INVALID_SLEEP_INTERVAL'
      : 'INVALID_TIMESTAMP';
    return c.json(err(code, 'start_at/end_at must be valid ISO 8601 with end strictly after start'), 400);
  }

  const now = nowIso();
  const { startAt, endAt, duration } = interval;
  const session = {
    id: body.session_id,
    start_at: startAt,
    end_at: endAt,
    duration_minutes: duration,
    quality: body.quality ?? null,
    version: 1,
    created_at: now,
    updated_at: now,
  };
  const resultJson = JSON.stringify({ session });

  try {
    await db.batch([
      // Idempotency claim: PK collision = already processed (or racing twin).
      db.prepare(
        'INSERT INTO sync_ops (user_id, client_op_id, op_type, result_json, created_at) VALUES (?, ?, ?, NULL, ?)'
      ).bind(user.id, body.client_op_id, 'insert_session', now),
      // Ownership guard: session id must not exist under another user.
      db.prepare(
        `INSERT INTO guard_abort (n)
         SELECT 1 WHERE EXISTS (
           SELECT 1 FROM sleep_sessions WHERE id = ? AND user_id <> ?
         )`
      ).bind(body.session_id, user.id),
      // Create the session (client-provided id).
      db.prepare(
        `INSERT INTO sleep_sessions (id, user_id, sleep_event_id, wake_event_id, start_at, end_at,
             duration_minutes, quality, version, created_at, updated_at, last_op_id)
         VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, 1, ?, ?, ?)`
      ).bind(body.session_id, user.id, startAt, endAt, duration, session.quality, now, now, body.client_op_id),
      // In-batch overlap guard: sees committed rows AND the row just inserted
      // by a concurrent batch's claim below; self is excluded by id.
      db.prepare(GUARD_SESSION_OVERLAP).bind(user.id, body.session_id, endAt, startAt),
      // Confirm the row exists in this batch, then record the op as done.
      db.prepare(
        'UPDATE sleep_sessions SET version = version WHERE id = ? AND user_id = ? AND version = 1'
      ).bind(body.session_id, user.id),
      db.prepare(GUARD_CHANGES_NE_1),
      db.prepare(
        'UPDATE sync_ops SET result_json = ? WHERE user_id = ? AND client_op_id = ? AND result_json IS NULL'
      ).bind(resultJson, user.id, body.client_op_id),
      db.prepare(GUARD_CHANGES_NE_1),
    ]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (isUniqueError(message)) {
      // Racing duplicate claim for the same op → return the committed result.
      const replay = await cachedResult(db, user.id, body.client_op_id);
      if (replay) {
        return c.json(replay, 200);
      }
      // PK(user_id, client_op_id) matched but no result → still-processing twin
      // cannot exist under batch atomicity; treat as duplicate op id.
      return c.json(err('DUPLICATE_OP', 'A different operation already used this client_op_id'), 409);
    }
    if (/CHECK constraint failed: 1 = 0/.test(message)) {
      // Some guard aborted the batch; classify which one (read-only diagnosis).
      const foreign = await db
        .prepare('SELECT user_id FROM sleep_sessions WHERE id = ?')
        .bind(body.session_id)
        .first<{ user_id: string }>();
      if (foreign && foreign.user_id !== user.id) {
        return c.json(err('SESSION_ID_TAKEN', 'This session id belongs to another user'), 403);
      }
      const exists = await db
        .prepare('SELECT id FROM sleep_sessions WHERE id = ? AND user_id = ?')
        .bind(body.session_id, user.id)
        .first();
      if (exists) {
        return c.json(err('DUPLICATE_SESSION', 'This session id already exists'), 409);
      }
      const overlaps = await db
        .prepare(
          `SELECT id FROM sleep_sessions
           WHERE user_id = ? AND id <> ? AND start_at < ? AND end_at > ? LIMIT 1`
        )
        .bind(user.id, body.session_id, endAt, startAt)
        .first();
      if (overlaps) {
        return c.json(err('SESSION_OVERLAP', 'The new session interval overlaps an existing session'), 409);
      }
      return c.json(err('INTERNAL_ERROR', 'The operation was rolled back by a guard'), 500);
    }
    throw e;
  }

  return c.json({ session }, 201);
});

const patchSchema = z.object({
  client_op_id: z.string().uuid(),
  base_version: z.number().int().min(1),
  start_at: z.string().min(1).optional(),
  end_at: z.string().min(1).optional(),
  quality: z.number().int().min(1).max(5).optional().nullable(),
});

// PATCH /api/sessions/:id — optimistic-lock edit
sessions.patch('/:id', zValidator('json', patchSchema), async (c) => {
  const db = c.env.DB;
  const user = c.get('user')!;
  const sessionId = c.req.param('id');
  const body = c.req.valid('json');

  const replay = await cachedResult(db, user.id, body.client_op_id);
  if (replay) {
    return c.json(replay, 200);
  }

  const current = await db
    .prepare('SELECT * FROM sleep_sessions WHERE id = ? AND user_id = ?')
    .bind(sessionId, user.id)
    .first<SleepSession>();
  if (!current) {
    return c.json(err('SESSION_NOT_FOUND', 'No such session for this user'), 404);
  }
  if (body.base_version !== current.version) {
    return c.json(
      err('VERSION_CONFLICT', 'base_version does not match the server version', {
        session: sessionView(current),
      }),
      409
    );
  }

  // Merge optional fields onto the current row.
  let startAt = current.start_at;
  let endAt = current.end_at;
  if (body.start_at !== undefined) {
    const n = normalizeUtcIso(body.start_at);
    if (n === null) {
      return c.json(err('INVALID_TIMESTAMP', 'start_at is not valid ISO 8601'), 400);
    }
    startAt = n;
  }
  if (body.end_at !== undefined) {
    const n = normalizeUtcIso(body.end_at);
    if (n === null) {
      return c.json(err('INVALID_TIMESTAMP', 'end_at is not valid ISO 8601'), 400);
    }
    endAt = n;
  }
  const startMs = parseUtcIso(startAt);
  const endMs = parseUtcIso(endAt);
  if (startMs === null || endMs === null || endMs <= startMs) {
    return c.json(err('INVALID_SLEEP_INTERVAL', 'end_at must be after start_at'), 400);
  }
  const duration = durationMinutes(startMs, endMs);
  const quality = body.quality === undefined ? current.quality : body.quality;
  const now = nowIso();
  const newVersion = current.version + 1;

  const session = {
    id: sessionId,
    start_at: startAt,
    end_at: endAt,
    duration_minutes: duration,
    quality,
    version: newVersion,
    created_at: current.created_at,
    updated_at: now,
  };
  const resultJson = JSON.stringify({ session });

  try {
    await db.batch([
      db.prepare(
        'INSERT INTO sync_ops (user_id, client_op_id, op_type, result_json, created_at) VALUES (?, ?, ?, NULL, ?)'
      ).bind(user.id, body.client_op_id, 'edit_session', now),
      // Conditional update: owner + optimistic lock only. Time fields may
      // change; overlap is judged by the guard immediately after, which
      // observes committed state AND the same-batch write (gate-verified),
      // so two racing edits can never both pass (G5 pattern).
      db.prepare(
        `UPDATE sleep_sessions
            SET start_at = ?, end_at = ?, duration_minutes = ?, quality = ?,
                version = version + 1, updated_at = ?, last_op_id = ?
          WHERE id = ? AND user_id = ? AND version = ?
       `
      ).bind(startAt, endAt, duration, quality, now, body.client_op_id, sessionId, user.id, body.base_version),
      db.prepare(GUARD_CHANGES_NE_1),
      // Overlap guard AFTER the update, excluding this row (which now holds
      // the merged interval): any other overlapping session aborts the batch.
      db.prepare(GUARD_SESSION_OVERLAP).bind(user.id, sessionId, endAt, startAt),
      db.prepare(
        'UPDATE sync_ops SET result_json = ? WHERE user_id = ? AND client_op_id = ? AND result_json IS NULL'
      ).bind(resultJson, user.id, body.client_op_id),
      db.prepare(GUARD_CHANGES_NE_1),
    ]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (isUniqueError(message)) {
      const replay = await cachedResult(db, user.id, body.client_op_id);
      if (replay) {
        return c.json(replay, 200);
      }
      return c.json(err('DUPLICATE_OP', 'A different operation already used this client_op_id'), 409);
    }
    if (/CHECK constraint failed: 1 = 0/.test(message)) {
      // Batch rolled back with zero residue; classify the cause (read-only).
      const fresh = await db
        .prepare('SELECT * FROM sleep_sessions WHERE id = ? AND user_id = ?')
        .bind(sessionId, user.id)
        .first<SleepSession>();
      if (!fresh) {
        return c.json(err('SESSION_NOT_FOUND', 'No such session for this user'), 404);
      }
      if (fresh.version !== body.base_version) {
        return c.json(
          err('VERSION_CONFLICT', 'base_version does not match the server version', {
            session: sessionView(fresh),
          }),
          409
        );
      }
      const overlaps = await db
        .prepare(
          `SELECT id FROM sleep_sessions
           WHERE user_id = ? AND id <> ? AND start_at < ? AND end_at > ? LIMIT 1`
        )
        .bind(user.id, sessionId, endAt, startAt)
        .first();
      if (overlaps) {
        return c.json(err('SESSION_OVERLAP', 'The edited interval overlaps an existing session'), 409);
      }
      return c.json(err('INTERNAL_ERROR', 'The operation was rolled back by a guard'), 500);
    }
    throw e;
  }

  return c.json({ session }, 200);
});

const listQuerySchema = z.object({
  since_updated_at: z.string().min(1).optional(),
  since_id: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

// GET /api/sessions — stable composite cursor (updated_at, id)
sessions.get('/', zValidator('query', listQuerySchema), async (c) => {
  const db = c.env.DB;
  const user = c.get('user')!;
  const { since_updated_at, since_id, limit } = c.req.valid('query');

  let cursorTs: string | null = null;
  if (since_updated_at !== undefined) {
    cursorTs = normalizeUtcIso(since_updated_at);
    if (cursorTs === null) {
      return c.json(err('INVALID_TIMESTAMP', 'since_updated_at is not valid ISO 8601'), 400);
    }
  }

  let sessionsRows: SleepSession[];
  if (cursorTs !== null && since_id !== undefined) {
    const res = await db
      .prepare(
        `SELECT * FROM sleep_sessions
          WHERE user_id = ?
            AND (updated_at > ? OR (updated_at = ? AND id > ?))
          ORDER BY updated_at ASC, id ASC
            LIMIT ?`
      )
      .bind(user.id, cursorTs, cursorTs, since_id, limit)
      .all<SleepSession>();
    sessionsRows = res.results;
  } else {
    const res = await db
      .prepare(
        'SELECT * FROM sleep_sessions WHERE user_id = ? ORDER BY updated_at ASC, id ASC LIMIT ?'
      )
      .bind(user.id, limit)
      .all<SleepSession>();
    sessionsRows = res.results;
  }

  // Cursor advances only over rows returned here; the client persists it after
  // applying the batch locally (本地推进由 APK 侧 sync_state 负责).
  const last = sessionsRows[sessionsRows.length - 1];
  return c.json({
    sessions: sessionsRows.map(sessionView),
    next_since_updated_at: last ? last.updated_at : (cursorTs ?? null),
    next_since_id: last ? last.id : (since_id ?? null),
    has_more: sessionsRows.length === limit,
  });
});

export default sessions;
