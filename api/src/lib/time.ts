/**
 * Shared time helpers for the sleep API (阶段 1).
 *
 * Canonical representation is UTC ISO 8601 with millisecond precision:
 *   YYYY-MM-DDTHH:mm:ss.sssZ
 * Lexicographic comparison of canonical strings equals chronological
 * comparison, so SQL range checks rely on string operators.
 */

export function parseUtcIso(value: string): number | null {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    return null;
  }
  return ms;
}

/** Parse and normalize to canonical YYYY-MM-DDTHH:mm:ss.sssZ, or null. */
export function normalizeUtcIso(value: string): string | null {
  const ms = parseUtcIso(value);
  if (ms === null) {
    return null;
  }
  return new Date(ms).toISOString();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function durationMinutes(startMs: number, endMs: number): number {
  return Math.floor((endMs - startMs) / 60000);
}
