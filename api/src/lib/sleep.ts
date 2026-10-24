/**
 * Shared helpers for the sleep API (阶段 1).
 *
 * Contract note (documented per 用户批准): POST /api/sessions requires the
 * client to supply BOTH `session_id` (UUID) and `client_op_id` (UUID).
 * sleepAPKprompt_v2 originally showed only client_op_id in the request body;
 * client-supplied session_id keeps offline-created records stable across
 * sync. One single contract is used everywhere; no second format exists.
 */

import type { SleepSession } from './types.js';
import { normalizeUtcIso, parseUtcIso, durationMinutes } from './time.js';

/** Guard: abort unless the previous DML changed exactly one row. */
export const GUARD_CHANGES_NE_1 =
  'INSERT INTO guard_abort (n) SELECT 1 WHERE (SELECT changes()) <> 1';

/**
 * Guard: abort if any active (unpaired) sleep event exists. Reads committed
 * state and uncommitted same-batch writes (verified in gate G3b).
 */
export const GUARD_ACTIVE_SLEEP_EXISTS = `
INSERT INTO guard_abort (n)
SELECT 1 WHERE EXISTS (
  SELECT 1 FROM sleep_events
  WHERE user_id = ? AND event_type = 'sleep' AND session_id IS NULL
)`;

/**
 * Guard: abort if any active (unpaired) wake event exists. Such rows cannot
 * be created through the paired flow; this fails loudly if one ever appears.
 */
export const GUARD_ACTIVE_WAKE_EXISTS = `
INSERT INTO guard_abort (n)
SELECT 1 WHERE EXISTS (
  SELECT 1 FROM sleep_events
  WHERE user_id = ? AND event_type = 'wake' AND session_id IS NULL
)`;

/**
 * Guard: abort if [start_at, end_at) overlaps any session other than the one
 * identified by excluded_id. Overlap rule:
 * existing.start_at < new.end_at AND existing.end_at > new.start_at
 * (canonical ISO strings compare lexicographically = chronologically).
 */
export const GUARD_SESSION_OVERLAP = `
INSERT INTO guard_abort (n)
SELECT 1 WHERE EXISTS (
  SELECT 1 FROM sleep_sessions
  WHERE user_id = ? AND id <> ?
    AND start_at < ? AND end_at > ?
)`;

export function conflict(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { error: { code, message }, ...extra };
}

/**
 * Session projection returned to clients. `last_op_id` is internal and never
 * exposed.
 */
export function sessionView(s: SleepSession) {
  return {
    id: s.id,
    start_at: s.start_at,
    end_at: s.end_at,
    duration_minutes: s.duration_minutes,
    quality: s.quality,
    version: s.version,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

export type ValidatedInterval = {
  startAt: string;
  endAt: string;
  duration: number;
};

/**
 * Validate + normalize a [start_at, end_at) pair. Returns an error code string
 * or null when valid: INVALID_TIMESTAMP / INVALID_SLEEP_INTERVAL.
 * duration_minutes = floor((end - start) / 60000); end must be strictly after
 * start (spec: 必须保证结束时间晚于开始时间).
 */
export function validateInterval(
  startRaw: string,
  endRaw: string
): { error: string } | ValidatedInterval {
  const startAt = normalizeUtcIso(startRaw);
  const endAt = normalizeUtcIso(endRaw);
  if (startAt === null || endAt === null) {
    return { error: 'INVALID_TIMESTAMP' };
  }
  const startMs = parseUtcIso(startAt);
  const endMs = parseUtcIso(endAt);
  if (startMs === null || endMs === null || endMs <= startMs) {
    return { error: 'INVALID_SLEEP_INTERVAL' };
  }
  return { startAt, endAt, duration: durationMinutes(startMs, endMs) };
}

export function validateQuality(quality: unknown): { error: string } | number | null | undefined {
  if (quality === undefined || quality === null) {
    return quality as null | undefined;
  }
  if (typeof quality !== 'number' || !Number.isInteger(quality) || quality < 1 || quality > 5) {
    return { error: 'INVALID_QUALITY' };
  }
  return quality;
}

/** True when a D1 error is a UNIQUE constraint violation. */
export function isUniqueError(message: string): boolean {
  return /UNIQUE constraint failed/i.test(message);
}

/** True when a D1 error is the guard_abort CHECK violation (business abort). */
export function isGuardError(message: string): boolean {
  return /CHECK constraint failed: 1 = 0/i.test(message);
}
