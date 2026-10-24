/**
 * Guard-mechanism probe Worker (阶段 1 前置 gate 测试，一次性用途).
 *
 * 目的：验证正式补录/编辑/配对方案依赖的三个 SQLite/D1 语义：
 *   1. INSERT INTO guard_abort SELECT 1 WHERE <cond>：cond 假→0 行成功；
 *      cond 真→CHECK (1 = 0) 约束错误。
 *   2. db.batch() 中任一语句以约束错误失败 → 整批原子回滚（前序写入不可见）。
 *   3. SELECT changes() 在同一 batch 内反映上一条 DML 的影响行数。
 *
 * 表结构镜像正式方案的关键列，但不依赖正式 schema。
 * 每个端点返回 { ok, error?, meta? }，随后由 harness 调用 /dump
 * 检查数据库最终状态，两者共同构成验收证据。
 */

interface Env {
  DB: D1Database;
}

type BatchResult = {
  ok: boolean;
  error?: string;
  meta?: unknown[];
};

async function runBatch(db: D1Database, statements: D1PreparedStatement[]): Promise<BatchResult> {
  try {
    const results = await db.batch(statements);
    return {
      ok: true,
      meta: results.map((r) => r.meta),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

async function dump(db: D1Database): Promise<Record<string, unknown>> {
  const [guard, rows, sessions, ops] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS c FROM guard_abort').first<{ c: number }>(),
    db.prepare('SELECT id FROM probe_rows ORDER BY id').all(),
    db.prepare('SELECT id, start_at, end_at, version, last_op_id FROM probe_sessions ORDER BY id').all(),
    db.prepare('SELECT client_op_id, result_json FROM probe_sync_ops ORDER BY client_op_id').all(),
  ]);
  return {
    guard_abort_count: guard?.c ?? -1,
    probe_rows: rows.results,
    probe_sessions: sessions.results,
    probe_sync_ops: ops.results,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const db = env.DB;

    if (url.pathname === '/reset' && request.method === 'POST') {
      await db.batch([
        db.prepare('DELETE FROM guard_abort'),
        db.prepare('DELETE FROM probe_rows'),
        db.prepare('DELETE FROM probe_sessions'),
        db.prepare('DELETE FROM probe_sync_ops'),
        // 固定基线行：g2 需要一条真实存在且 version=1 的行做 UPDATE 命中测试
        db.prepare("INSERT INTO probe_rows (id) VALUES ('r1')"),
      ]);
      return json({ ok: true });
    }

    if (url.pathname === '/dump') {
      return json(await dump(db));
    }

    // ---- G1: UPDATE 影响 0 行 → changes 守卫必须中止整批 ----
    if (url.pathname === '/g1' && request.method === 'POST') {
      const result = await runBatch(db, [
        // 前序写入：若批被正确回滚，这行不应存在
        db.prepare("INSERT INTO probe_rows (id) VALUES ('g1-persist')"),
        // UPDATE 目标不存在 → changes() = 0
        db.prepare("UPDATE probe_rows SET id = id WHERE id = 'nonexistent'"),
        // 守卫：changes() <> 1 → 应插入 1 行 → CHECK 失败
        db.prepare('INSERT INTO guard_abort (n) SELECT 1 WHERE (SELECT changes()) <> 1'),
        // 前序写入 2：守卫失败后不应生效
        db.prepare("INSERT INTO probe_sync_ops (client_op_id, result_json) VALUES ('g1-op', '{\"cached\":true}')"),
      ]);
      return json(result);
    }

    // ---- G2: UPDATE 影响 1 行 → changes 守卫应通过（0 行插入），批成功 ----
    if (url.pathname === '/g2' && request.method === 'POST') {
      const result = await runBatch(db, [
        db.prepare("UPDATE probe_rows SET id = id WHERE id = 'r1'"),
        db.prepare('INSERT INTO guard_abort (n) SELECT 1 WHERE (SELECT changes()) <> 1'),
        db.prepare("INSERT INTO probe_sync_ops (client_op_id, result_json) VALUES ('g2-op', '{\"ok\":true}')"),
      ]);
      return json(result);
    }

    // ---- G3a: 已有 session 与新 session 重叠 → 重叠守卫应中止 ----
    if (url.pathname === '/g3a' && request.method === 'POST') {
      const overlapGuard = db.prepare(`
        INSERT INTO guard_abort (n)
        SELECT 1 WHERE EXISTS (
          SELECT 1 FROM probe_sessions
          WHERE user_id = ?1 AND id <> ?2
            AND start_at < ?3 AND end_at > ?4
        )`).bind('u1', 'overlap1', '2026-10-20T09:00:00.000Z', '2026-10-20T07:00:00.000Z');
      const result = await runBatch(db, [
        // 已存在的 session（基线数据，模拟先行提交）
        db.prepare(`INSERT INTO probe_sessions (id, user_id, start_at, end_at, version)
          VALUES ('base', 'u1', '2026-10-20T01:00:00.000Z', '2026-10-20T08:00:00.000Z', 1)`),
        // 前序占位写入（模拟 sync_ops 占位）
        db.prepare("INSERT INTO probe_sync_ops (client_op_id, result_json) VALUES ('g3a-op', NULL)"),
        overlapGuard,
        // 守卫失败后不应生效
        db.prepare(`INSERT INTO probe_sessions (id, user_id, start_at, end_at, version)
          VALUES ('overlap1', 'u1', '2026-10-20T07:00:00.000Z', '2026-10-20T09:00:00.000Z', 1)`),
      ]);
      return json(result);
    }

    // ---- G3b: 同批内前序 INSERT 的 session 必须对重叠守卫可见（批内读己方写）----
    if (url.pathname === '/g3b' && request.method === 'POST') {
      const result = await runBatch(db, [
        db.prepare(`INSERT INTO probe_sessions (id, user_id, start_at, end_at, version)
          VALUES ('g3b-first', 'u1', '2026-10-20T01:00:00.000Z', '2026-10-20T08:00:00.000Z', 1)`),
        db.prepare(`INSERT INTO guard_abort (n)
          SELECT 1 WHERE EXISTS (
            SELECT 1 FROM probe_sessions
            WHERE user_id = 'u1' AND id <> 'g3b-second'
              AND start_at < '2026-10-20T09:00:00.000Z' AND end_at > '2026-10-20T07:00:00.000Z'
          )`),
        db.prepare(`INSERT INTO probe_sessions (id, user_id, start_at, end_at, version)
          VALUES ('g3b-second', 'u1', '2026-10-20T07:00:00.000Z', '2026-10-20T09:00:00.000Z', 1)`),
      ]);
      return json(result);
    }

    // ---- G4: 无重叠 → 守卫通过（0 行），批成功且 guard 表保持空 ----
    if (url.pathname === '/g4' && request.method === 'POST') {
      const result = await runBatch(db, [
        db.prepare(`INSERT INTO probe_sessions (id, user_id, start_at, end_at, version)
          VALUES ('g4-base', 'u1', '2026-10-20T01:00:00.000Z', '2026-10-20T08:00:00.000Z', 1)`),
        db.prepare(`INSERT INTO guard_abort (n)
          SELECT 1 WHERE EXISTS (
            SELECT 1 FROM probe_sessions
            WHERE user_id = 'u1' AND id <> 'g4-new'
              AND start_at < '2026-10-21T08:00:00.000Z' AND end_at > '2026-10-21T01:00:00.000Z'
          )`),
        db.prepare(`INSERT INTO probe_sessions (id, user_id, start_at, end_at, version)
          VALUES ('g4-new', 'u1', '2026-10-21T01:00:00.000Z', '2026-10-21T08:00:00.000Z', 1)`),
        db.prepare("INSERT INTO probe_sync_ops (client_op_id, result_json) VALUES ('g4-op', '{\"ok\":true}')"),
      ]);
      return json(result);
    }

    // ---- G5: 两个并发请求，各自执行与正式补录相同顺序的批 ----
    // body: { op_id, session_id }；区间固定重叠（10-20 07:00 → 09:00）
    if (url.pathname === '/g5' && request.method === 'POST') {
      const body = (await request.json()) as { op_id: string; session_id: string };
      const start = '2026-10-20T07:00:00.000Z';
      const end = '2026-10-20T09:00:00.000Z';
      const result = await runBatch(db, [
        db.prepare('INSERT INTO probe_sync_ops (client_op_id, result_json) VALUES (?, NULL)').bind(body.op_id),
        db.prepare(`INSERT INTO guard_abort (n)
          SELECT 1 WHERE EXISTS (
            SELECT 1 FROM probe_sessions
            WHERE user_id = 'u1' AND id <> ?
              AND start_at < ? AND end_at > ?
          )`).bind(body.session_id, end, start),
        db.prepare(`INSERT INTO probe_sessions (id, user_id, start_at, end_at, version, last_op_id)
          VALUES (?, 'u1', ?, ?, 1, ?)`).bind(body.session_id, start, end, body.op_id),
        db.prepare('UPDATE probe_sessions SET last_op_id = last_op_id WHERE id = ? AND version = 1').bind(body.session_id),
        db.prepare('INSERT INTO guard_abort (n) SELECT 1 WHERE (SELECT changes()) <> 1'),
        db.prepare('UPDATE probe_sync_ops SET result_json = ? WHERE client_op_id = ? AND result_json IS NULL')
          .bind(`{\"session_id\":\"${body.session_id}\"}`, body.op_id),
        db.prepare('INSERT INTO guard_abort (n) SELECT 1 WHERE (SELECT changes()) <> 1'),
      ]);
      return json(result);
    }

    return json({ error: 'not found' }, 404);
  },
};
