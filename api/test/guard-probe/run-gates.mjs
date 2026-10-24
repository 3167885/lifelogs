/**
 * 阶段 1 前置 gate 测试驱动脚本（Node 原生 fetch/assert，零额外依赖）。
 *
 * 前置：wrangler dev --local --port <PORT> --persist-to <DIR> 已在运行，
 *       且已对该目录的本地 D1 应用过 schema.sql。
 *
 * 每个 gate 同时断言两件事（验收要求）：
 *   A. db.batch() 的调用结果（成功/约束错误及错误文本）
 *   B. /dump 返回的数据库最终状态（业务行 + guard_abort 行数）
 */
import assert from 'node:assert/strict';

const BASE = process.env.PROBE_BASE ?? 'http://127.0.0.1:8791';

async function call(path, method = 'POST', body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

const results = [];
function record(gate, pass, detail) {
  results.push({ gate, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${gate} :: ${detail}`);
}

const isCheckError = (e) => typeof e === 'string' && /CHECK constraint failed/i.test(e);

async function reset() {
  const r = await call('/reset');
  assert.equal(r.json.ok, true, 'reset failed');
  return call('/dump');
}

// ---------- G1: UPDATE 0 行 → changes 守卫中止整批 ----------
{
  const before = await reset();
  const g1 = await call('/g1');
  const after = (await call('/dump')).json;
  const batchFailed = g1.json.ok === false && isCheckError(g1.json.error);
  const rolledBack =
    after.guard_abort_count === 0 &&
    !after.probe_rows.some((r) => r.id === 'g1-persist') &&
    !after.probe_sync_ops.some((o) => o.client_op_id === 'g1-op');
  record(
    'G1',
    batchFailed && rolledBack,
    `batch=${JSON.stringify(g1.json)} guard_rows=${after.guard_abort_count} ` +
      `rows=${JSON.stringify(after.probe_rows)} ops=${JSON.stringify(after.probe_sync_ops)}`
  );
  void before;
}

// ---------- G2: UPDATE 1 行 → 守卫通过（0 行插入），批成功且守卫表空 ----------
{
  await reset();
  const g2 = await call('/g2');
  const after = (await call('/dump')).json;
  const passed =
    g2.json.ok === true &&
    after.guard_abort_count === 0 &&
    after.probe_sync_ops.some((o) => o.client_op_id === 'g2-op' && o.result_json !== null);
  record('G2', passed, `batch=${JSON.stringify(g2.json)} guard_rows=${after.guard_abort_count} ops=${JSON.stringify(after.probe_sync_ops)}`);
}

// ---------- G3a: 已有 session 重叠 → 重叠守卫中止 ----------
{
  await reset();
  const g3 = await call('/g3a');
  const after = (await call('/dump')).json;
  const batchFailed = g3.json.ok === false && isCheckError(g3.json.error);
  const rolledBack =
    after.guard_abort_count === 0 &&
    after.probe_sessions.length === 0 &&
    !after.probe_sync_ops.some((o) => o.client_op_id === 'g3a-op');
  record('G3a', batchFailed && rolledBack, `batch=${JSON.stringify(g3.json)} guard_rows=${after.guard_abort_count} sessions=${JSON.stringify(after.probe_sessions)} ops=${JSON.stringify(after.probe_sync_ops)}`);
}

// ---------- G3b: 同一 batch 内前序写入必须对守卫可见（读己方写）----------
{
  await reset();
  const g3b = await call('/g3b');
  const after = (await call('/dump')).json;
  const aborted = g3b.json.ok === false && isCheckError(g3b.json.error);
  const rolledBack =
    after.guard_abort_count === 0 && after.probe_sessions.length === 0;
  record('G3b', aborted && rolledBack, `batch=${JSON.stringify(g3b.json)} guard_rows=${after.guard_abort_count} sessions=${JSON.stringify(after.probe_sessions)}`);
}

// ---------- G4: 无重叠 → 成功且守卫表保持为空 ----------
{
  await reset();
  const g4 = await call('/g4');
  const after = (await call('/dump')).json;
  const passed =
    g4.json.ok === true &&
    after.guard_abort_count === 0 &&
    after.probe_sessions.some((s) => s.id === 'g4-base') &&
    after.probe_sessions.some((s) => s.id === 'g4-new') &&
    after.probe_sync_ops.some((o) => o.client_op_id === 'g4-op' && o.result_json !== null);
  record('G4', passed, `batch=${JSON.stringify(g4.json)} guard_rows=${after.guard_abort_count} sessions=${after.probe_sessions.map((s) => s.id)} ops=${JSON.stringify(after.probe_sync_ops)}`);
}

// ---------- G5: 两个并发补录（重叠区间）→ 恰好一个成功，失败方零残留 ----------
{
  await reset();
  const [a, b] = await Promise.all([
    call('/g5', 'POST', { op_id: 'g5-op-a', session_id: 'g5-session-a' }),
    call('/g5', 'POST', { op_id: 'g5-op-b', session_id: 'g5-session-b' }),
  ]);
  const after = (await call('/dump')).json;
  const successes = [a, b].filter((r) => r.json.ok === true).length;
  const failures = [a, b].filter((r) => r.json.ok === false);
  const sessionCount = after.probe_sessions.length;
  const committedOps = after.probe_sync_ops.filter((o) => o.result_json !== null).length;
  const placeholderLeftovers = after.probe_sync_ops.filter((o) => o.result_json === null).length;
  const passed =
    successes === 1 &&
    failures.length === 1 &&
    sessionCount === 1 &&
    committedOps === 1 &&
    placeholderLeftovers === 0 &&
    after.guard_abort_count === 0;
  record(
    'G5',
    passed,
    `successes=${successes} failures=${JSON.stringify(failures.map((f) => f.json.error))} ` +
      `sessions=${JSON.stringify(after.probe_sessions)} ops=${JSON.stringify(after.probe_sync_ops)} guard_rows=${after.guard_abort_count}`
  );
}

const failed = results.filter((r) => !r.pass);
console.log('\n===== GATE SUMMARY =====');
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.gate}`);
if (failed.length > 0) {
  console.log(`\n${failed.length} gate(s) FAILED → 停止业务实现，先报告问题。`);
  process.exit(1);
}
console.log('\nAll gates passed. 主方案（CHECK (1 = 0) 守卫）机制可用。');
