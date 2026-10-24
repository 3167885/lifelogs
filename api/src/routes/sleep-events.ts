/**
 * Sleep event API (阶段 1): POST /api/events and GET /api/events/pending.
 *
 * Paired flow guarantees (validated by gate tests G1–G5 in
 * api/test/guard-probe before this file was written):
 * - The pairing batch claims the open sleep first (conditional UPDATE
 *   session_id IS NULL → :session_id). The claim is the mutual-exclusion
 *   point: a concurrent second wake fails the guard and the WHOLE batch
 *   rolls back, so one open sleep pairs at most once.
 * - Wake events are inserted already carrying session_id: an orphan wake
 *   can never be created by this flow.
 * - Time-overlap enforcement happens INSIDE the batch via the guard table:
 *   overlap detected → constraint error → no wake row, no session row.
 * - Pre-reads are only fast paths for friendly errors and idempotent
 *   replays; correctness never depends on them.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import type { Env, SleepEvent, SleepSession, Variables } from '../lib/types.js';
import { normalizeUtcIso, parseUtcIso, nowIso, durationMinutes } from '../lib/time.js';
import {
  GUARD_ACTIVE_WAKE_EXISTS,
  GUARD_CHANGES_NE_1,
  GUARD_SESSION_OVERLAP,
  sessionView,
  isUniqueError,
} from '../lib/sleep.js';

const events = new Hono<{ Bindings: Env; Variables: Variables }>();

events.use('*', requireAuth);

const createSchema = z.object({
  client_event_id: z.string().uuid(),
  event_type: z.enum(['sleep', 'wake']),
  occurred_at: z.string().min(1).optional(),
});

function err(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { error: { code, message }, ...extra };
}

async function findEventByClientId(
  db: D1Database,
  userId: string,
  clientEventId: string
): Promise<SleepEvent | null> {
  return db
    .prepare('SELECT * FROM sleep_events WHERE user_id = ? AND client_event_id = ?')
    .bind(userId, clientEventId)
    .first<SleepEvent>();
}

async function readSession(db: D1Database, userId: string, sessionId: string) {
  const row = await db
    .prepare('SELECT * FROM sleep_sessions WHERE id = ? AND user_id = ?')
    .bind(sessionId, userId)
    .first<SleepSession>();
  return row ? sessionView(row) : null;
}

async function eventResponse(db: D1Database, event: SleepEvent) {
  const session = event.session_id ? await readSession(db, event.user_id, event.session_id) : null;
  return {
    event: {
      id: event.id,
      client_event_id: event.client_event_id,
      event_type: event.event_type,
      occurred_at: event.occurred_at,
      session_id: event.session_id,
    },
    status: event.session_id ? 'paired' : 'open',
    session,
  };
}

// POST /api/events
events.post('/', zValidator('json', createSchema), async (c) => {
  const db = c.env.DB;
  const user = c.get('user')!;
  const { client_event_id, event_type, occurred_at } = c.req.valid('json');

  // Normalize client click time; fall back to server time only when absent.
  let occurredAt: string;
  if (occurred_at === undefined) {
    occurredAt = nowIso();
  } else {
    const normalized = normalizeUtcIso(occurred_at);
    if (normalized === null) {
      return c.json(err('INVALID_TIMESTAMP', 'occurred_at must be an ISO 8601 timestamp'), 400);
    }
    occurredAt = normalized;
  }

  // Idempotent replay fast path.
  const existing = await findEventByClientId(db, user.id, client_event_id);
  if (existing) {
    return c.json(await eventResponse(db, existing), 200);
  }

  const now = nowIso();
  const eventId = crypto.randomUUID();

  if (event_type === 'sleep') {
    // Fast path for the orphan-wake conflict (structural guard follows).
    const orphanWake = await db
      .prepare(
        "SELECT id FROM sleep_events WHERE user_id = ? AND event_type = 'wake' AND session_id IS NULL LIMIT 1"
      )
      .bind(user.id)
      .first();
    if (orphanWake) {
      return c.json(err('ORPHAN_WAKE_EXISTS', 'An unpaired wake event exists for this user'), 409);
    }

    try {
      await db.batch([
        // Abort if an unpaired wake exists (committed + same-batch state).
        db.prepare(GUARD_ACTIVE_WAKE_EXISTS).bind(user.id),
        // The partial unique index enforces at most one open sleep per user;
        // concurrent duplicate sleeps collide here instead of check-then-write.
        db.prepare(
          `INSERT INTO sleep_events (id, user_id, client_event_id, event_type, occurred_at, session_id, created_at)
           VALUES (?, ?, ?, 'sleep', ?, NULL, ?)`
        ).bind(eventId, user.id, client_event_id, occurredAt, now),
      ]);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Another request with the same client_event_id may have just committed.
      const raced = await findEventByClientId(db, user.id, client_event_id);
      if (raced) {
        return c.json(await eventResponse(db, raced), 200);
      }
      if (isUniqueError(message)) {
        return c.json(err('SLEEP_ALREADY_OPEN', 'An unpaired sleep event already exists'), 409);
      }
      throw e;
    }

    return c.json({
      event: {
        id: eventId,
        client_event_id,
        event_type: 'sleep',
        occurred_at: occurredAt,
        session_id: null,
      },
      status: 'open',
      session: null,
    }, 201);
  }

  // ---- wake ----
  const openSleep = await db
    .prepare(
      "SELECT * FROM sleep_events WHERE user_id = ? AND event_type = 'sleep' AND session_id IS NULL LIMIT 2"
    )
    .bind(user.id)
    .all<SleepEvent>();

  if (openSleep.results.length === 0) {
    return c.json(err('NO_OPEN_SLEEP', 'No unpaired sleep event exists to wake against'), 409);
  }
  if (openSleep.results.length > 1) {
    return c.json(
      err('DATA_INTEGRITY_ERROR', 'Multiple unpaired sleep events exist; refusing to pair'),
      422
    );
  }

  const sleep = openSleep.results[0];
  const sleepMs = parseUtcIso(sleep.occurred_at);
  const wakeMs = parseUtcIso(occurredAt);
  if (sleepMs === null || wakeMs === null) {
    return c.json(err('INVALID_TIMESTAMP', 'Stored or submitted timestamps are not valid ISO 8601'), 400);
  }
  if (wakeMs <= sleepMs) {
    return c.json(err('INVALID_SLEEP_INTERVAL', 'wake occurred_at must be after the open sleep'), 400);
  }

  const startAt = sleep.occurred_at;
  const endAt = occurredAt;
  const duration = durationMinutes(sleepMs, wakeMs);
  const sessionId = crypto.randomUUID();
  const wakeId = crypto.randomUUID();

  try {
    await db.batch([
      // 1. Overlap guard: canonical ISO strings compare chronologically.
      db.prepare(GUARD_SESSION_OVERLAP).bind(user.id, sessionId, endAt, startAt),
      // 2. Claim the open sleep (mutual-exclusion point for pairing).
      db.prepare(
        "UPDATE sleep_events SET session_id = ? WHERE id = ? AND user_id = ? AND event_type = 'sleep' AND session_id IS NULL"
      ).bind(sessionId, sleep.id, user.id),
      // 3. Abort unless the claim changed exactly one row.
      db.prepare(GUARD_CHANGES_NE_1),
      // 4. Wake event, born paired (no orphan-wake window).
      db.prepare(
        `INSERT INTO sleep_events (id, user_id, client_event_id, event_type, occurred_at, session_id, created_at)
         VALUES (?, ?, ?, 'wake', ?, ?, ?)`
      ).bind(wakeId, user.id, client_event_id, endAt, sessionId, now),
      // 5. Session row.
      db.prepare(
        `INSERT INTO sleep_sessions (id, user_id, sleep_event_id, wake_event_id, start_at, end_at,
             duration_minutes, quality, version, created_at, updated_at, last_op_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, NULL)`
      ).bind(sessionId, user.id, sleep.id, wakeId, startAt, endAt, duration, now, now),
      // 6. Abort unless the session row really exists in this batch.
      db.prepare(
        'UPDATE sleep_sessions SET updated_at = updated_at WHERE id = ? AND user_id = ?'
      ).bind(sessionId, user.id),
      db.prepare(GUARD_CHANGES_NE_1),
      // 7. Back-fill event links (spec: sleep/wake session_id = session id).
      db.prepare(
        'UPDATE sleep_events SET session_id = ? WHERE id = ? AND user_id = ? AND session_id = ?'
      ).bind(sessionId, sleep.id, user.id, sessionId),
      db.prepare(GUARD_CHANGES_NE_1),
      db.prepare(
        'UPDATE sleep_events SET session_id = ? WHERE id = ? AND user_id = ? AND session_id = ?'
      ).bind(sessionId, wakeId, user.id, sessionId),
      db.prepare(GUARD_CHANGES_NE_1),
    ]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Same client_event_id raced and committed → idempotent replay.
    const raced = await findEventByClientId(db, user.id, client_event_id);
    if (raced) {
      return c.json(await eventResponse(db, raced), 200);
    }
    // Claim failed → another wake paired first (or the sleep vanished).
    const sessionNow = await db
      .prepare('SELECT session_id FROM sleep_events WHERE id = ? AND user_id = ?')
      .bind(sleep.id, user.id)
      .first<{ session_id: string | null }>();
    if (sessionNow?.session_id) {
      const pairedSession = await readSession(db, user.id, sessionNow.session_id);
      return c.json(
        err('NO_OPEN_SLEEP', 'The open sleep was already paired by an earlier request', {
          session: pairedSession,
        }),
        409
      );
    }
    // Overlap guard fired → the whole batch rolled back; confirm for the code.
    const overlaps = await db
      .prepare(
        `SELECT id FROM sleep_sessions
         WHERE user_id = ? AND id <> ? AND start_at < ? AND end_at > ? LIMIT 1`
      )
      .bind(user.id, sessionId, endAt, startAt)
      .first();
    if (overlaps) {
      return c.json(err('SESSION_OVERLAP', 'The new session interval overlaps an existing session'), 409);
    }
    throw e;
  }

  const session = await readSession(db, user.id, sessionId);
  return c.json({
    event: {
      id: wakeId,
      client_event_id,
      event_type: 'wake',
      occurred_at: endAt,
      session_id: sessionId,
    },
    status: 'paired',
    session,
  }, 201);
});

// GET /api/events/pending — must be registered before legacy routes capture it.
events.get('/pending', async (c) => {
  const user = c.get('user')!;
  const rows = await c.env.DB
    .prepare(
      'SELECT * FROM sleep_events WHERE user_id = ? AND session_id IS NULL ORDER BY occurred_at ASC'
    )
    .bind(user.id)
    .all<SleepEvent>();

  const hasOrphanWake = rows.results.some((e) => e.event_type === 'wake');
  return c.json({
    events: rows.results.map((e) => ({
      id: e.id,
      client_event_id: e.client_event_id,
      event_type: e.event_type,
      occurred_at: e.occurred_at,
      session_id: e.session_id,
    })),
    warning: hasOrphanWake ? 'ORPHAN_WAKE' : null,
  });
});

export default events;
