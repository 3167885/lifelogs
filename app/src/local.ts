/**
 * 阶段 3：本地 SQLite 存储 + 同步队列（个人自用 MVP）。
 *
 * 关键不变量：
 * - 业务行与 local_ops 队列项在同一事务写入：强杀进程不会留下
 *   「有记录但没排队」或反之的半成品。
 * - local_sessions.version 只表示「最后一次服务端确认的版本」；本地编辑
 *   不自增 version，只把 sync_state 置 'local'。首次编辑把该确认版本冻结
 *   到 base_version，后续离线编辑和重试都复用它（见 sync.ts）。
 * - local_ops 推送前标记 in_flight；异常退出留下的项在 30 秒后恢复 pending，
 *   由幂等键保证可安全重放。
 * - 原生平台若数据库不可用（初始化失败），写操作直接抛错并由 UI 显示；
 *   绝不静默退回内存表（否则用户以为已保存，重启全丢）。
 * - 浏览器开发环境没有原生 SQLite：内存表 + 明确提示「重启即丢」。
 *
 * 插件语义（已读 @capacitor-community/sqlite 8.1.1 Android 源码确认）：
 * executeSet(transaction=true) 任一语句失败 → finally rollbackTransaction +
 * call.reject → Promise reject；NULL 与空绑定值正确传递。
 */
import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import type { SQLiteDBConnection } from '@capacitor-community/sqlite';

const DB_NAME = 'sleepdb';
const SCHEMA_VERSION = 3;

export type SessionSource = 'paired' | 'backfill' | 'server';
export type SyncState = 'local' | 'synced';
export type OpKind = 'sleep' | 'wake' | 'backfill' | 'edit';
export type OpStatus = 'pending' | 'in_flight' | 'failed';

export interface LocalSession {
  id: string;
  start_at: string;
  end_at: string;
  duration_minutes: number;
  quality: number | null;
  version: number;
  base_version: number | null;
  source: SessionSource;
  sync_state: SyncState;
  conflict_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface QueuedOp {
  id: number;
  kind: OpKind;
  ref_id: string;
  payload: string;
  created_at: string;
  status: OpStatus;
  attempts: number;
  last_error: string | null;
  in_flight_since: string | null;
}

export interface SleepPayload {
  client_event_id: string;
  occurred_at: string;
}
export interface WakePayload {
  client_event_id: string;
  occurred_at: string;
  local_session_id: string;
  start_at: string;
}
export interface BackfillPayload {
  session_id: string;
  client_op_id: string;
  start_at: string;
  end_at: string;
  quality: number | null;
}
export interface EditPayload {
  session_id: string;
  client_op_id: string;
  base_version: number;
  start_at: string;
  end_at: string;
  quality: number | null;
}

export type WriteFailure =
  | 'SLEEP_ALREADY_OPEN'
  | 'NO_OPEN_SLEEP'
  | 'INVALID_INTERVAL'
  | 'SESSION_OVERLAP'
  | 'INVALID_QUALITY'
  | 'NOT_FOUND';

/** quality 只接受 null 或 1–5 整数（NaN/小数会被原生层静默变 NULL 或撞 CHECK）。 */
export function validQuality(q: unknown): q is number | null {
  if (q === null || q === undefined) return true;
  return typeof q === 'number' && Number.isInteger(q) && q >= 1 && q <= 5;
}

/** 与后端 durationMinutes 一致：floor((end - start) / 60000)。 */
export function durationMinutes(startMs: number, endMs: number): number {
  return Math.floor((endMs - startMs) / 60000);
}

/** 规范化 UTC ISO（YYYY-MM-DDTHH:mm:ss.sssZ）；字符串序即时间序。 */
export function normalizeIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ---------------------------------------------------------------------------
// 行值收敛（插件返回宽松数组，统一转成受控类型）
// ---------------------------------------------------------------------------
type Cell = string | number | null;
type Row = Record<string, Cell>;

function asRows(values: unknown): Row[] {
  if (!Array.isArray(values)) return [];
  return values.filter((v): v is Row => typeof v === 'object' && v !== null);
}

function cellStr(row: Row, key: string): string {
  const v = row[key];
  return typeof v === 'string' ? v : '';
}

function cellNum(row: Row, key: string): number {
  const v = row[key];
  return typeof v === 'number' ? v : Number(v ?? 0);
}

function cellNumOrNull(row: Row, key: string): number | null {
  const v = row[key];
  if (v === null || v === undefined || v === '') return null;
  return typeof v === 'number' ? v : Number(v);
}

function cellStrOrNull(row: Row, key: string): string | null {
  const v = row[key];
  return typeof v === 'string' ? v : null;
}

// ---------------------------------------------------------------------------
// 连接与 schema
// ---------------------------------------------------------------------------
const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS local_events (
     id TEXT PRIMARY KEY,
     type TEXT NOT NULL CHECK (type IN ('sleep','wake')),
     occurred_at TEXT NOT NULL,
     session_id TEXT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_local_open_sleep
     ON local_events (type) WHERE type = 'sleep' AND session_id IS NULL`,
  `CREATE TABLE IF NOT EXISTS local_sessions (
     id TEXT PRIMARY KEY,
     start_at TEXT NOT NULL,
     end_at TEXT NOT NULL,
     duration_minutes INTEGER NOT NULL,
     quality INTEGER NULL CHECK (quality BETWEEN 1 AND 5),
     version INTEGER NOT NULL DEFAULT 1,
     base_version INTEGER NULL,
     source TEXT NOT NULL CHECK (source IN ('paired','backfill','server')),
     sync_state TEXT NOT NULL DEFAULT 'local' CHECK (sync_state IN ('local','synced')),
     conflict_note TEXT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS ix_local_sessions_start ON local_sessions (start_at DESC)`,
  `CREATE TABLE IF NOT EXISTS local_ops (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL CHECK (kind IN ('sleep','wake','backfill','edit')),
     ref_id TEXT NOT NULL,
     payload TEXT NOT NULL,
     created_at TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_flight','failed')),
     attempts INTEGER NOT NULL DEFAULT 0,
     last_error TEXT NULL,
     in_flight_since TEXT NULL
   )`,
];

let conn: SQLiteDBConnection | null = null;
let storageError: string | null = null;
let connectionFactory: SQLiteConnection | null = null;

export function storageErrorMessage(): string | null {
  return storageError;
}

export function isPersistent(): boolean {
  return Capacitor.isNativePlatform() && conn !== null;
}

/** 当前平台存储是否可用（浏览器内存表也算可用，但重启即丢）。 */
export function isReady(): boolean {
  return conn !== null || !Capacitor.isNativePlatform();
}

export async function initLocal(): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) {
    storageError = '浏览器环境：本地表仅存内存，重启即丢（仅开发用）';
    return storageError;
  }
  if (conn !== null) return null;
  try {
    if (connectionFactory === null) connectionFactory = new SQLiteConnection(CapacitorSQLite);
    const exists = await connectionFactory.isConnection(DB_NAME, false);
    let c: SQLiteDBConnection;
    if (exists.result === true) {
      c = await connectionFactory.retrieveConnection(DB_NAME, false);
    } else {
      try {
        c = await connectionFactory.createConnection(DB_NAME, false, 'no-encryption', SCHEMA_VERSION, false);
      } catch {
        // WebView 重载后 JS 连接表清空但原生连接仍在 → 回退 retrieve。
        c = await connectionFactory.retrieveConnection(DB_NAME, false);
      }
    }
    await c.open();
    // 先无条件跑幂等 DDL，避免全新库上 meta 不存在；再补列迁移。
    const stmts = DDL.map((statement) => ({ statement, values: [] as Cell[] }));
    stmts.push({
      statement: `INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')`,
      values: [],
    });
    await c.executeSet(stmts, true, 'no', true);
    await migrateToV3(c);
    conn = c;
    storageError = null;
    return null;
  } catch (e) {
    conn = null;
    storageError = e instanceof Error ? e.message : String(e);
    return storageError;
  }
}

/** 旧库 → v3：补列并允许 in_flight；SQLite 不能改 CHECK，故原子重建表。 */
async function migrateToV3(c: SQLiteDBConnection): Promise<void> {
  const sessionInfo = asRows((await c.query(`PRAGMA table_info(local_sessions)`, [], true)).values);
  const sessionColumns = sessionInfo.map((r) => cellStr(r, 'name'));
  if (sessionColumns.length > 0 && !sessionColumns.includes('base_version')) {
    await c.executeSet([
      { statement: `ALTER TABLE local_sessions ADD COLUMN base_version INTEGER NULL`, values: [] },
    ], true, 'no', true);
  }

  const info = asRows((await c.query(`PRAGMA table_info(local_ops)`, [], true)).values);
  const names = info.map((r) => cellStr(r, 'name'));
  const schemaRows = asRows(
    (await c.query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'local_ops'`,
      [],
      true,
    )).values,
  );
  const tableSql = schemaRows[0] ? cellStr(schemaRows[0], 'sql') : '';
  if (names.length === 0 || tableSql.includes(`'in_flight'`)) return;

  const value = (column: string, fallback: string): string =>
    names.includes(column) ? column : fallback;
  const selectColumns = [
    'id',
    'kind',
    'ref_id',
    'payload',
    'created_at',
    value('status', `'pending'`),
    value('attempts', '0'),
    value('last_error', 'NULL'),
    value('in_flight_since', 'NULL'),
  ].join(', ');

  await c.executeSet([
    {
      statement: `CREATE TABLE local_ops_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('sleep','wake','backfill','edit')),
        ref_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_flight','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NULL,
        in_flight_since TEXT NULL
      )`,
      values: [],
    },
    {
      statement: `INSERT INTO local_ops_v3
        (id, kind, ref_id, payload, created_at, status, attempts, last_error, in_flight_since)
        SELECT ${selectColumns} FROM local_ops`,
      values: [],
    },
    { statement: `DROP TABLE local_ops`, values: [] },
    { statement: `ALTER TABLE local_ops_v3 RENAME TO local_ops`, values: [] },
    {
      statement: `INSERT INTO meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')
                  ON CONFLICT(key) DO UPDATE SET value = '${SCHEMA_VERSION}'`,
      values: [],
    },
  ], true, 'no', true);
}

/** 原生平台守卫：DB 不可用直接抛错，由 UI 显示；绝不静默走内存分支。 */
function nativeGuard(): void {
  if (Capacitor.isNativePlatform() && conn === null) {
    throw new Error(storageError ?? '本地数据库不可用');
  }
}

async function transact(set: { statement: string; values: Cell[] }[]): Promise<void> {
  nativeGuard();
  if (conn === null) return; // 浏览器：调用方已在内存分支处理
  await conn.executeSet(set, true, 'no', true);
}

async function runSql(statement: string, values: Cell[] = []): Promise<void> {
  nativeGuard();
  if (conn === null) return;
  await conn.run(statement, values, false, 'no', true);
}

async function queryRows(statement: string, values: Cell[] = []): Promise<Row[]> {
  nativeGuard();
  if (conn === null) return [];
  return asRows((await conn.query(statement, values, true)).values);
}

// ---------------------------------------------------------------------------
// 浏览器退化内存表
// ---------------------------------------------------------------------------
let memEvents: Row[] = [];
let memSessions: Row[] = [];
let memOps: Row[] = [];
let memOpSeq = 0;
const memMeta = new Map<string, string>();

function memOpRow(kind: OpKind, refId: string, payload: object, now: string): Row {
  memOpSeq += 1;
  return {
    id: memOpSeq,
    kind,
    ref_id: refId,
    payload: JSON.stringify(payload),
    created_at: now,
    status: 'pending',
    attempts: 0,
    last_error: null,
    in_flight_since: null,
  };
}

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------
export async function getMeta(key: string): Promise<string | null> {
  if (conn !== null) {
    const rows = await queryRows(`SELECT value FROM meta WHERE key = ?`, [key]);
    return rows[0] ? cellStr(rows[0], 'value') : null;
  }
  const r = memMeta.get(key);
  return r === undefined ? null : r;
}

export async function setMeta(key: string, value: string): Promise<void> {
  if (conn !== null) {
    await runSql(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
    return;
  }
  memMeta.set(key, value);
}

export async function deleteMeta(key: string): Promise<void> {
  if (conn !== null) {
    await runSql(`DELETE FROM meta WHERE key = ?`, [key]);
    return;
  }
  memMeta.delete(key);
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------
export async function getOpenSleep(): Promise<{ id: string; occurred_at: string } | null> {
  if (conn !== null) {
    const rows = await queryRows(
      `SELECT id, occurred_at FROM local_events WHERE type = 'sleep' AND session_id IS NULL LIMIT 1`,
    );
    const r = rows[0];
    return r ? { id: cellStr(r, 'id'), occurred_at: cellStr(r, 'occurred_at') } : null;
  }
  nativeGuard();
  const r = memEvents.find((e) => e.type === 'sleep' && (e.session_id ?? null) === null);
  return r ? { id: String(r.id), occurred_at: String(r.occurred_at) } : null;
}

function toSession(row: Row): LocalSession {
  return {
    id: cellStr(row, 'id'),
    start_at: cellStr(row, 'start_at'),
    end_at: cellStr(row, 'end_at'),
    duration_minutes: cellNum(row, 'duration_minutes'),
    quality: cellNumOrNull(row, 'quality'),
    version: cellNum(row, 'version'),
    base_version: cellNumOrNull(row, 'base_version'),
    source: cellStr(row, 'source') as SessionSource,
    sync_state: cellStr(row, 'sync_state') as SyncState,
    conflict_note: cellStrOrNull(row, 'conflict_note'),
    created_at: cellStr(row, 'created_at'),
    updated_at: cellStr(row, 'updated_at'),
  };
}

export async function listSessions(): Promise<LocalSession[]> {
  if (conn !== null) return (await queryRows(`SELECT * FROM local_sessions ORDER BY start_at DESC`)).map(toSession);
  nativeGuard();
  return memSessions
    .slice()
    .sort((a, b) => (String(b.start_at ?? '') < String(a.start_at ?? '') ? -1 : 1))
    .map(toSession);
}

export async function getSession(id: string): Promise<LocalSession | null> {
  if (conn !== null) {
    const rows = await queryRows(`SELECT * FROM local_sessions WHERE id = ?`, [id]);
    return rows[0] ? toSession(rows[0]) : null;
  }
  nativeGuard();
  const r = memSessions.find((s) => String(s.id) === id);
  return r ? toSession(r) : null;
}

// ---------------------------------------------------------------------------
// 写（业务行 + 队列在同一事务 / 同一内存操作中完成）
// ---------------------------------------------------------------------------
async function hasOverlap(id: string, startAt: string, endAt: string): Promise<boolean> {
  if (conn !== null) {
    const rows = await queryRows(
      `SELECT id FROM local_sessions WHERE id <> ? AND start_at < ? AND end_at > ? LIMIT 1`,
      [id, endAt, startAt],
    );
    return rows.length > 0;
  }
  nativeGuard();
  return memSessions.some((s) => String(s.id) !== id && String(s.start_at) < endAt && String(s.end_at) > startAt);
}

const SESSION_INSERT_SQL = `INSERT INTO local_sessions (id, start_at, end_at, duration_minutes, quality, version, base_version, source, sync_state, conflict_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function sessionValues(s: LocalSession): Cell[] {
  return [s.id, s.start_at, s.end_at, s.duration_minutes, s.quality, s.version, s.base_version, s.source, s.sync_state, s.conflict_note, s.created_at, s.updated_at];
}

function opStmt(kind: OpKind, refId: string, payload: object, now: string): { statement: string; values: Cell[] } {
  return {
    statement: `INSERT INTO local_ops (kind, ref_id, payload, created_at, status, attempts) VALUES (?, ?, ?, ?, 'pending', 0)`,
    values: [kind, refId, JSON.stringify(payload), now],
  };
}

/** 睡了：未配对入睡事件 + sleep 队列（同一事务）。 */
export async function recordSleep(occurredAt: string): Promise<{ id: string; occurred_at: string } | WriteFailure> {
  const occurredMs = Date.parse(occurredAt);
  if (Number.isNaN(occurredMs)) return 'INVALID_INTERVAL';
  const iso = normalizeIso(occurredMs);
  const open = await getOpenSleep();
  if (open !== null) return 'SLEEP_ALREADY_OPEN';
  const id = newId();
  const now = new Date().toISOString();
  const payload: SleepPayload = { client_event_id: newId(), occurred_at: iso };
  if (conn !== null) {
    try {
      await transact([
        { statement: `INSERT INTO local_events (id, type, occurred_at, session_id) VALUES (?, 'sleep', ?, NULL)`, values: [id, iso] },
        opStmt('sleep', id, payload, now),
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/UNIQUE constraint failed/i.test(msg)) return 'SLEEP_ALREADY_OPEN';
      throw e;
    }
  } else {
    nativeGuard();
    memEvents.push({ id, type: 'sleep', occurred_at: iso, session_id: null });
    memOps.push(memOpRow('sleep', id, payload, now));
  }
  return { id, occurred_at: iso };
}

/** 醒了：认领 sleep + born-paired wake + 临时 paired 记录 + wake 队列（同一事务）。 */
export async function recordWake(occurredAt: string): Promise<{ session: LocalSession } | WriteFailure> {
  const open = await getOpenSleep();
  if (open === null) return 'NO_OPEN_SLEEP';
  const startMs = Date.parse(open.occurred_at);
  const endMs = Date.parse(occurredAt);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return 'INVALID_INTERVAL';
  const end = normalizeIso(endMs);
  const now = new Date().toISOString();
  const sessionId = newId();
  const wakeId = newId();
  const session: LocalSession = {
    id: sessionId,
    start_at: open.occurred_at,
    end_at: end,
    duration_minutes: durationMinutes(startMs, endMs),
    quality: null,
    version: 1,
    base_version: null,
    source: 'paired',
    sync_state: 'local',
    conflict_note: null,
    created_at: now,
    updated_at: now,
  };
  const payload: WakePayload = {
    client_event_id: newId(),
    occurred_at: end,
    local_session_id: sessionId,
    start_at: open.occurred_at,
  };
  if (conn !== null) {
    await transact([
      { statement: `UPDATE local_events SET session_id = ? WHERE id = ? AND session_id IS NULL`, values: [sessionId, open.id] },
      { statement: `INSERT INTO local_events (id, type, occurred_at, session_id) VALUES (?, 'wake', ?, ?)`, values: [wakeId, end, sessionId] },
      { statement: SESSION_INSERT_SQL, values: sessionValues(session) },
      opStmt('wake', sessionId, payload, now),
    ]);
  } else {
    nativeGuard();
    const ev = memEvents.find((e) => String(e.id) === open.id);
    if (ev !== undefined) ev.session_id = sessionId;
    memEvents.push({ id: wakeId, type: 'wake', occurred_at: end, session_id: sessionId });
    memSessions.push({ ...session });
    memOps.push(memOpRow('wake', sessionId, payload, now));
  }
  return { session };
}

/** 补录：客户端 UUID 即正式记录 id + backfill 队列（同一事务）。 */
export async function addBackfill(
  startAt: string,
  endAt: string,
  quality: number | null,
): Promise<{ session: LocalSession } | WriteFailure> {
  if (!validQuality(quality)) return 'INVALID_QUALITY';
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return 'INVALID_INTERVAL';
  const s = normalizeIso(startMs);
  const e = normalizeIso(endMs);
  if (await hasOverlap('__new__', s, e)) return 'SESSION_OVERLAP';
  const now = new Date().toISOString();
  const session: LocalSession = {
    id: newId(),
    start_at: s,
    end_at: e,
    duration_minutes: durationMinutes(startMs, endMs),
    quality,
    version: 1,
    base_version: null,
    source: 'backfill',
    sync_state: 'local',
    conflict_note: null,
    created_at: now,
    updated_at: now,
  };
  const payload: BackfillPayload = { session_id: session.id, client_op_id: newId(), start_at: s, end_at: e, quality };
  if (conn !== null) {
    await transact([
      { statement: SESSION_INSERT_SQL, values: sessionValues(session) },
      opStmt('backfill', session.id, payload, now),
    ]);
  } else {
    nativeGuard();
    memSessions.push({ ...session });
    memOps.push(memOpRow('backfill', session.id, payload, now));
  }
  return { session };
}

/**
 * 编辑本地记录（同一事务）。version 不自增；同一记录若已有「从未发送过」
 * 的 pending edit 队列项，合并并复用其 client_op_id，否则新建。
 */
export async function editLocal(
  id: string,
  patch: { start_at?: string; end_at?: string; quality?: number | null },
): Promise<LocalSession | WriteFailure> {
  if (!validQuality(patch.quality)) return 'INVALID_QUALITY';
  const current = await getSession(id);
  if (current === null) return 'NOT_FOUND';
  const startAt = patch.start_at ?? current.start_at;
  const endAt = patch.end_at ?? current.end_at;
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return 'INVALID_INTERVAL';
  const s = normalizeIso(startMs);
  const e = normalizeIso(endMs);
  if (await hasOverlap(id, s, e)) return 'SESSION_OVERLAP';

  const next: LocalSession = {
    ...current,
    start_at: s,
    end_at: e,
    duration_minutes: durationMinutes(startMs, endMs),
    quality: patch.quality === undefined ? current.quality : patch.quality,
    base_version: current.base_version ?? current.version,
    sync_state: 'local',
    conflict_note: null,
    updated_at: new Date().toISOString(),
  };
  const payload: EditPayload = {
    session_id: id,
    client_op_id: newId(),
    base_version: next.base_version ?? next.version,
    start_at: s,
    end_at: e,
    quality: next.quality,
  };

  if (conn !== null) {
    const rows = await queryRows(
      `SELECT payload FROM local_ops WHERE kind = 'edit' AND ref_id = ? AND status = 'pending' AND attempts = 0 ORDER BY id DESC LIMIT 1`,
      [id],
    );
    if (rows.length > 0) {
      try {
        const old = JSON.parse(cellStr(rows[0], 'payload')) as Partial<EditPayload>;
        if (typeof old.client_op_id === 'string') payload.client_op_id = old.client_op_id;
      } catch {
        /* 旧 payload 损坏 → 用新 key */
      }
    }
    await transact([
      {
        statement: `UPDATE local_sessions SET start_at = ?, end_at = ?, duration_minutes = ?, quality = ?,
          base_version = COALESCE(base_version, version), sync_state = 'local',
          conflict_note = NULL, updated_at = ? WHERE id = ?`,
        values: [next.start_at, next.end_at, next.duration_minutes, next.quality, next.updated_at, id],
      },
      { statement: `DELETE FROM local_ops WHERE kind = 'edit' AND ref_id = ? AND status = 'pending' AND attempts = 0`, values: [id] },
      opStmt('edit', id, payload, new Date().toISOString()),
    ]);
  } else {
    nativeGuard();
    const idx = memSessions.findIndex((x) => String(x.id) === id);
    if (idx >= 0) {
      const prev = memSessions[idx];
      memSessions[idx] = { ...next, version: cellNum(prev, 'version') };
    }
    const reusable = memOps.find(
      (o) => o.kind === 'edit' && String(o.ref_id) === id && String(o.status) === 'pending' && Number(o.attempts) === 0,
    );
    if (reusable !== undefined) {
      try {
        const old = JSON.parse(String(reusable.payload)) as Partial<EditPayload>;
        if (typeof old.client_op_id === 'string') payload.client_op_id = old.client_op_id;
      } catch {
        /* ignore */
      }
      memOps = memOps.filter((o) => o !== reusable);
    }
    memOps.push(memOpRow('edit', id, payload, new Date().toISOString()));
  }
  return next;
}

// ---------------------------------------------------------------------------
// 队列消费接口（sync.ts）
// ---------------------------------------------------------------------------
function toOp(row: Row): QueuedOp {
  return {
    id: cellNum(row, 'id'),
    kind: cellStr(row, 'kind') as OpKind,
    ref_id: cellStr(row, 'ref_id'),
    payload: cellStr(row, 'payload'),
    created_at: cellStr(row, 'created_at'),
    status: cellStr(row, 'status') as OpStatus,
    attempts: cellNum(row, 'attempts'),
    last_error: cellStrOrNull(row, 'last_error'),
    in_flight_since: cellStrOrNull(row, 'in_flight_since'),
  };
}

function memToOp(row: Row): QueuedOp {
  return {
    id: Number(row.id),
    kind: String(row.kind) as OpKind,
    ref_id: String(row.ref_id),
    payload: String(row.payload),
    created_at: String(row.created_at),
    status: String(row.status ?? 'pending') as OpStatus,
    attempts: Number(row.attempts ?? 0),
    last_error: row.last_error == null ? null : String(row.last_error),
    in_flight_since: row.in_flight_since == null ? null : String(row.in_flight_since),
  };
}

/** FIFO 取第一条 pending。 */
export async function nextPendingOp(): Promise<QueuedOp | null> {
  if (conn !== null) {
    const rows = await queryRows(`SELECT * FROM local_ops WHERE status = 'pending' ORDER BY id LIMIT 1`);
    return rows[0] ? toOp(rows[0]) : null;
  }
  nativeGuard();
  const r = memOps.slice().sort((a, b) => Number(a.id) - Number(b.id)).find((o) => String(o.status) === 'pending');
  return r ? memToOp(r) : null;
}

export async function firstFailedOp(): Promise<QueuedOp | null> {
  if (conn !== null) {
    const rows = await queryRows(`SELECT * FROM local_ops WHERE status = 'failed' ORDER BY id LIMIT 1`);
    return rows[0] ? toOp(rows[0]) : null;
  }
  nativeGuard();
  const r = memOps.slice().sort((a, b) => Number(a.id) - Number(b.id)).find((o) => String(o.status) === 'failed');
  return r ? memToOp(r) : null;
}

/** 超过 30 秒仍未完成的 in_flight 项恢复为 pending；幂等键保证重试安全。 */
export async function recoverStaleInFlightOps(): Promise<void> {
  const cutoff = new Date(Date.now() - 30_000).toISOString();
  if (conn !== null) {
    await runSql(
      `UPDATE local_ops SET status = 'pending', in_flight_since = NULL
       WHERE status = 'in_flight' AND (in_flight_since IS NULL OR in_flight_since < ?)`,
      [cutoff],
    );
    return;
  }
  nativeGuard();
  for (const o of memOps) {
    if (String(o.status) === 'in_flight' && (o.in_flight_since == null || String(o.in_flight_since) < cutoff)) {
      o.status = 'pending';
      o.in_flight_since = null;
    }
  }
}

export async function markOpInFlight(id: number): Promise<void> {
  const now = new Date().toISOString();
  if (conn !== null) {
    await runSql(
      `UPDATE local_ops SET status = 'in_flight', in_flight_since = ? WHERE id = ? AND status = 'pending'`,
      [now, id],
    );
    return;
  }
  nativeGuard();
  const o = memOps.find((x) => Number(x.id) === id);
  if (o !== undefined && String(o.status) === 'pending') {
    o.status = 'in_flight';
    o.in_flight_since = now;
  }
}

export async function countPendingOps(): Promise<number> {
  if (conn !== null) {
    const rows = await queryRows(`SELECT COUNT(*) AS n FROM local_ops`);
    return rows[0] ? cellNum(rows[0], 'n') : 0;
  }
  nativeGuard();
  return memOps.length;
}

export async function bumpOpAttempts(id: number, error: string): Promise<void> {
  if (conn !== null) {
    await runSql(
      `UPDATE local_ops SET status = 'pending', in_flight_since = NULL,
       attempts = attempts + 1, last_error = ? WHERE id = ?`,
      [error, id],
    );
    return;
  }
  nativeGuard();
  const o = memOps.find((x) => Number(x.id) === id);
  if (o !== undefined) {
    o.status = 'pending';
    o.in_flight_since = null;
    o.attempts = Number(o.attempts ?? 0) + 1;
    o.last_error = error;
  }
}

export async function markOpFailed(id: number, error: string): Promise<void> {
  if (conn !== null) {
    await runSql(
      `UPDATE local_ops SET status = 'failed', in_flight_since = NULL,
       attempts = attempts + 1, last_error = ? WHERE id = ?`,
      [error, id],
    );
    return;
  }
  nativeGuard();
  const o = memOps.find((x) => Number(x.id) === id);
  if (o !== undefined) {
    o.status = 'failed';
    o.in_flight_since = null;
    o.attempts = Number(o.attempts ?? 0) + 1;
    o.last_error = error;
  }
}

/** 手动重试：failed → pending。 */
export async function resetFailedOps(): Promise<void> {
  if (conn !== null) {
    await runSql(`UPDATE local_ops SET status = 'pending', last_error = NULL WHERE status = 'failed'`);
    return;
  }
  nativeGuard();
  for (const o of memOps) {
    if (String(o.status) === 'failed') {
      o.status = 'pending';
      o.last_error = null;
    }
  }
}

export async function deleteOp(id: number): Promise<void> {
  if (conn !== null) {
    await runSql(`DELETE FROM local_ops WHERE id = ?`, [id]);
    return;
  }
  nativeGuard();
  memOps = memOps.filter((o) => Number(o.id) !== id);
}

/** 发送前把（v1 遗留）缺 client_op_id 的 payload 补全并冻结落盘。 */
export async function persistOpPayload(id: number, payload: object): Promise<void> {
  const json = JSON.stringify(payload);
  if (conn !== null) {
    await runSql(`UPDATE local_ops SET payload = ? WHERE id = ?`, [json, id]);
    return;
  }
  nativeGuard();
  const o = memOps.find((x) => Number(x.id) === id);
  if (o !== undefined) o.payload = json;
}

/** wake 成功后：把仍指向临时 paired id 的 edit 队列改绑到正式 id。 */
export async function rebindEditOps(fromId: string, toId: string): Promise<void> {
  if (conn !== null) {
    const rows = await queryRows(`SELECT id, payload FROM local_ops WHERE kind = 'edit' AND ref_id = ?`, [fromId]);
    for (const r of rows) {
      try {
        const p = JSON.parse(cellStr(r, 'payload')) as Partial<EditPayload>;
        p.session_id = toId;
        await runSql(`UPDATE local_ops SET ref_id = ?, payload = ? WHERE id = ?`, [toId, JSON.stringify(p), cellNum(r, 'id')]);
      } catch {
        await deleteOp(cellNum(r, 'id'));
      }
    }
    return;
  }
  nativeGuard();
  for (const o of memOps) {
    if (String(o.kind) === 'edit' && String(o.ref_id) === fromId) {
      try {
        const p = JSON.parse(String(o.payload)) as Partial<EditPayload>;
        p.session_id = toId;
        o.payload = JSON.stringify(p);
        o.ref_id = toId;
      } catch {
        memOps = memOps.filter((x) => x !== o);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 服务端数据合并
// ---------------------------------------------------------------------------

/**
 * 应用一条服务端 session（拉取 / wake、backfill 成功响应）。
 * 本地有未推送修改（sync_state='local'）时：不覆盖业务字段，只更新
 * version（最后服务端确认版本）与冲突提示。
 */
export async function applyServerSession(s: LocalSession, confirmed = false): Promise<void> {
  const existing = await getSession(s.id);
  const conflictKey = `conflict.${s.id}`;
  if (!confirmed && existing !== null && existing.sync_state === 'local') {
    const note = s.version > existing.version ? `服务器已有更新（v${s.version}），本地修改已保留` : existing.conflict_note;
    if (s.version > existing.version) {
      // Keep the authoritative server row so the UI can resolve the conflict
      // offline, after the failed push has stopped.
      await setMeta(conflictKey, JSON.stringify(s));
    }
    if (conn !== null) {
      // A local edit keeps its own base_version; only the informational
      // "last confirmed" version advances. The push still uses base_version.
      await runSql(`UPDATE local_sessions SET version = ?, conflict_note = ? WHERE id = ?`, [s.version, note, s.id]);
    } else {
      nativeGuard();
      const r = memSessions.find((x) => String(x.id) === s.id);
      if (r !== undefined) {
        r.version = s.version;
        r.conflict_note = note;
      }
    }
    return;
  }
  const source: SessionSource = existing !== null && existing.source === 'backfill' ? 'backfill' : 'server';
  const row: LocalSession = { ...s, source, base_version: null, sync_state: 'synced', conflict_note: null };
  if (conn !== null) {
    const statements = [
      {
        statement: `INSERT INTO local_sessions (id, start_at, end_at, duration_minutes, quality, version, base_version, source, sync_state, conflict_note, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'synced', NULL, ?, ?)
          ON CONFLICT(id) DO UPDATE SET start_at = excluded.start_at, end_at = excluded.end_at,
            duration_minutes = excluded.duration_minutes, quality = excluded.quality, version = excluded.version,
            base_version = NULL, sync_state = 'synced', conflict_note = NULL, updated_at = excluded.updated_at`,
        values: [row.id, row.start_at, row.end_at, row.duration_minutes, row.quality, row.version, row.source, row.created_at, row.updated_at] as Cell[],
      },
    ];
    if (confirmed) {
      statements.push(
        { statement: `DELETE FROM local_ops WHERE kind = 'edit' AND ref_id = ?`, values: [s.id] },
        { statement: `DELETE FROM meta WHERE key = ?`, values: [conflictKey] },
      );
    }
    await transact(statements);
    return;
  }
  nativeGuard();
  const idx = memSessions.findIndex((x) => String(x.id) === row.id);
  if (idx >= 0) memSessions[idx] = { ...row };
  else memSessions.push({ ...row });
  if (confirmed) {
    memOps = memOps.filter((o) => !(String(o.kind) === 'edit' && String(o.ref_id) === s.id));
    memMeta.delete(conflictKey);
  }
}

/**
 * wake 成功：正式行插入 + 删除临时 paired 行 + 清本地事件 + 改绑 edit 队列
 * （同一事务）。若临时行被本地编辑过，保留本地内容并维持 sync_state='local'，
 * 由后续 edit 队列项推送。
 */
export async function replacePairedWithServer(pairedId: string, server: LocalSession): Promise<void> {
  const paired = await getSession(pairedId);
  if (paired !== null && paired.sync_state === 'local' && paired.updated_at > paired.created_at) {
    // 临时行在配对后被编辑过：正式行采用本地内容，继续待推送。
    const merged: LocalSession = {
      ...server,
      start_at: paired.start_at,
      end_at: paired.end_at,
      duration_minutes: paired.duration_minutes,
      quality: paired.quality,
      base_version: paired.base_version ?? server.version,
      sync_state: 'local',
      version: server.version,
      updated_at: paired.updated_at,
      conflict_note: paired.conflict_note,
    };
    await deleteLocalSessionRow(pairedId);
    await insertSessionRow(merged);
    await rebindEditOps(pairedId, merged.id);
    return;
  }
  const row: LocalSession = { ...server, source: 'server', base_version: null, sync_state: 'synced', conflict_note: null };
  if (conn !== null) {
    await transact([
      { statement: SESSION_INSERT_SQL, values: sessionValues(row) },
      { statement: `DELETE FROM local_sessions WHERE id = ?`, values: [pairedId] },
    ]);
  } else {
    nativeGuard();
    memSessions.push({ ...row });
    memSessions = memSessions.filter((x) => String(x.id) !== pairedId);
  }
  await rebindEditOps(pairedId, row.id);
}

async function insertSessionRow(s: LocalSession): Promise<void> {
  if (conn !== null) {
    await runSql(SESSION_INSERT_SQL, sessionValues(s));
    return;
  }
  nativeGuard();
  memSessions.push({ ...s });
}

async function deleteLocalSessionRow(id: string): Promise<void> {
  if (conn !== null) {
    await runSql(`DELETE FROM local_sessions WHERE id = ?`, [id]);
    return;
  }
  nativeGuard();
  memSessions = memSessions.filter((x) => String(x.id) !== id);
}

export async function markSynced(id: string, version: number): Promise<void> {
  const now = new Date().toISOString();
  if (conn !== null) {
    await runSql(
      `UPDATE local_sessions SET sync_state = 'synced', conflict_note = NULL,
       base_version = NULL, version = ?, updated_at = ? WHERE id = ?`,
      [version, now, id],
    );
    return;
  }
  nativeGuard();
  const r = memSessions.find((x) => String(x.id) === id);
  if (r !== undefined) {
    r.sync_state = 'synced';
    r.version = version;
    r.base_version = null;
    r.updated_at = now;
    r.conflict_note = null;
  }
}

export async function setConflictNote(id: string, note: string): Promise<void> {
  if (conn !== null) {
    await runSql(`UPDATE local_sessions SET conflict_note = ? WHERE id = ?`, [note, id]);
    return;
  }
  nativeGuard();
  const r = memSessions.find((x) => String(x.id) === id);
  if (r !== undefined) r.conflict_note = note;
}

export interface ConflictRecord {
  local: LocalSession;
  server: LocalSession | null;
}

/** 409 响应携带的权威服务端记录：只记录冲突，不覆盖本地待推送内容。 */
export async function recordVersionConflict(id: string, server: LocalSession): Promise<void> {
  const note = `服务器已有更新（v${server.version}），本地修改已保留`;
  if (conn !== null) {
    await transact([
      {
        statement: `UPDATE local_sessions SET version = ?, conflict_note = ?
          WHERE id = ? AND sync_state = 'local'`,
        values: [server.version, note, id],
      },
      {
        statement: `INSERT INTO meta (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        values: [`conflict.${id}`, JSON.stringify(server)],
      },
    ]);
    return;
  }
  nativeGuard();
  const local = memSessions.find((s) => String(s.id) === id);
  if (local !== undefined && String(local.sync_state) === 'local') {
    local.version = server.version;
    local.conflict_note = note;
  }
  memMeta.set(`conflict.${id}`, JSON.stringify(server));
}

export async function conflictFor(id: string): Promise<ConflictRecord | null> {
  const local = await getSession(id);
  if (local === null || local.conflict_note === null) return null;
  const raw = await getMeta(`conflict.${id}`);
  let server: LocalSession | null = null;
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Partial<LocalSession>;
      if (
        typeof parsed.id === 'string' &&
        typeof parsed.start_at === 'string' &&
        typeof parsed.end_at === 'string' &&
        typeof parsed.duration_minutes === 'number' &&
        typeof parsed.version === 'number' &&
        typeof parsed.created_at === 'string' &&
        typeof parsed.updated_at === 'string'
      ) {
        server = {
          id: parsed.id,
          start_at: parsed.start_at,
          end_at: parsed.end_at,
          duration_minutes: parsed.duration_minutes,
          quality: typeof parsed.quality === 'number' ? parsed.quality : null,
          version: parsed.version,
          base_version: null,
          source: 'server',
          sync_state: 'synced',
          conflict_note: null,
          created_at: parsed.created_at,
          updated_at: parsed.updated_at,
        };
      }
    } catch {
      server = null;
    }
  }
  return { local, server };
}

/** 用户选择采用服务端版本：丢弃该记录的本地 edit 队列与冲突快照。 */
export async function resolveConflictWithServer(id: string): Promise<boolean> {
  const conflict = await conflictFor(id);
  if (conflict === null || conflict.server === null) return false;
  await applyServerSession(conflict.server, true);
  return true;
}

/** 用户选择保留本地修改：以最新服务端版本为新基准重新排队。 */
export async function resolveConflictWithLocal(id: string): Promise<boolean> {
  const conflict = await conflictFor(id);
  if (conflict === null || conflict.server === null) return false;
  const local = conflict.local;
  const server = conflict.server;
  const payload: EditPayload = {
    session_id: id,
    client_op_id: newId(),
    base_version: server.version,
    start_at: local.start_at,
    end_at: local.end_at,
    quality: local.quality,
  };
  const now = new Date().toISOString();
  if (conn !== null) {
    await transact([
      {
        statement: `UPDATE local_sessions SET version = ?, base_version = ?, sync_state = 'local',
          conflict_note = NULL, updated_at = ? WHERE id = ?`,
        values: [server.version, server.version, now, id],
      },
      { statement: `DELETE FROM local_ops WHERE kind = 'edit' AND ref_id = ?`, values: [id] },
      opStmt('edit', id, payload, now),
      { statement: `DELETE FROM meta WHERE key = ?`, values: [`conflict.${id}`] },
    ]);
    return true;
  }
  nativeGuard();
  const row = memSessions.find((s) => String(s.id) === id);
  if (row === undefined) return false;
  row.version = server.version;
  row.base_version = server.version;
  row.sync_state = 'local';
  row.conflict_note = null;
  row.updated_at = now;
  memOps = memOps.filter((o) => !(String(o.kind) === 'edit' && String(o.ref_id) === id));
  memOps.push(memOpRow('edit', id, payload, now));
  memMeta.delete(`conflict.${id}`);
  return true;
}

/** 待推送 wake 的原始区间：拉取合并时若正式记录与之重合但 wake 还没推，交给 wake 流程替换，避免重复行。 */
export async function pendingWakeIntervals(): Promise<{ start_at: string; end_at: string; local_session_id: string }[]> {
  const out: { start_at: string; end_at: string; local_session_id: string }[] = [];
  const collect = (payloadText: string): void => {
    try {
      const p = JSON.parse(payloadText) as Partial<WakePayload>;
      if (typeof p.start_at === 'string' && typeof p.occurred_at === 'string' && typeof p.local_session_id === 'string') {
        out.push({ start_at: p.start_at, end_at: p.occurred_at, local_session_id: p.local_session_id });
      }
    } catch {
      /* ignore */
    }
  };
  if (conn !== null) {
    for (const r of await queryRows(`SELECT payload FROM local_ops WHERE kind = 'wake' AND status = 'pending'`)) {
      collect(cellStr(r, 'payload'));
    }
    return out;
  }
  nativeGuard();
  for (const o of memOps) {
    if (String(o.kind) === 'wake' && String(o.status) === 'pending') collect(String(o.payload));
  }
  return out;
}

/** 本地是否已存在覆盖该区间的 paired 临时行（wake 成功响应的幂等重放判断）。 */
export async function hasPairedCovering(startAt: string, endAt: string): Promise<boolean> {
  const all = await listSessions();
  return all.some((s) => s.source === 'paired' && s.start_at === startAt && s.end_at === endAt);
}

/** 退出/切换用户：清空业务数据、队列与同步 meta（保留 schema 版本）。 */
export async function clearLocalData(): Promise<void> {
  if (conn !== null) {
    await transact([
      { statement: `DELETE FROM local_ops`, values: [] },
      { statement: `DELETE FROM local_sessions`, values: [] },
      { statement: `DELETE FROM local_events`, values: [] },
      { statement: `DELETE FROM meta WHERE key = 'owner.user_id' OR key = 'owner.email' OR key = 'sync.cursor'`, values: [] },
    ]);
    return;
  }
  nativeGuard();
  memOps = [];
  memSessions = [];
  memEvents = [];
  memMeta.delete('owner.user_id');
  memMeta.delete('owner.email');
  memMeta.delete('sync.cursor');
}
