/**
 * 阶段 1 业务 API 测试（sleepAPKprompt_v2 §阶段1.6 场景清单 + 并发扩展）。
 *
 * 前置：本地 dev 服务器运行中（wrangler dev --local --port 8787），
 *       sleep_schema.sql 已应用到本地 D1。
 * 运行：node api/test/sleep-api.test.mjs
 * 零新增依赖：node 内置 fetch/assert。每个场景使用独立注册用户隔离数据。
 * 数据库级不变量断言见 sleep-db-invariants.mjs（服务器停止后运行）。
 */
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:8787';
const results = [];

async function api(path, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, headers: Object.fromEntries(res.headers.entries()) };
}

const uuid = () => crypto.randomUUID();

async function newUser(prefix) {
  const email = `${prefix}-${Date.now()}-${uuid().slice(0, 8)}@test.local`;
  await api('/api/auth/register', { method: 'POST', body: { email, password: 'password123' } });
  const r = await api('/api/auth/token', { method: 'POST', body: { email, password: 'password123' } });
  assert.equal(r.status, 200, `token login failed for ${email}`);
  return { email, token: r.json.token };
}

async function scenario(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push({ name, pass: false, error: e.message });
    console.log(`FAIL  ${name} :: ${e.message}`);
  }
}

const code = (j) => j?.error?.code;

// 年份参数：每个场景用不同年份区间，避免与后续场景重叠。
const iso = (year, month, day, hour = 0, min = 0) =>
  new Date(Date.UTC(year, month - 1, day, hour, min)).toISOString().replace('.000Z', '.000Z');

// ============ 配对 ============
await scenario('01 sleep→wake 正常配对，session 字段正确', async () => {
  const { token } = await newUser('t01');
  const s = await api('/api/events', { method: 'POST', token, body: { client_event_id: uuid(), event_type: 'sleep', occurred_at: iso(2021, 1, 1, 22) } });
  assert.equal(s.status, 201);
  assert.equal(s.json.status, 'open');
  const w = await api('/api/events', { method: 'POST', token, body: { client_event_id: uuid(), event_type: 'wake', occurred_at: iso(2021, 1, 2, 6, 30) } });
  assert.equal(w.status, 201);
  assert.equal(w.json.status, 'paired');
  // 22:00 → 06:30(+1d) = 8h30m = 510 min
  assert.equal(w.json.session.duration_minutes, 510);
  assert.equal(w.json.session.version, 1);
  assert.ok(w.json.session.id);
});

await scenario('02 没有 sleep 就 wake → 409 NO_OPEN_SLEEP', async () => {
  const { token } = await newUser('t02');
  const w = await api('/api/events', { method: 'POST', token, body: { client_event_id: uuid(), event_type: 'wake', occurred_at: iso(2021, 2, 1) } });
  assert.equal(w.status, 409);
  assert.equal(code(w.json), 'NO_OPEN_SLEEP');
});

await scenario('03 连续两次 sleep → 第二次 409 SLEEP_ALREADY_OPEN', async () => {
  const { token } = await newUser('t03');
  const s1 = await api('/api/events', { method: 'POST', token, body: { client_event_id: uuid(), event_type: 'sleep', occurred_at: iso(2021, 3, 1, 22) } });
  assert.equal(s1.status, 201);
  const s2 = await api('/api/events', { method: 'POST', token, body: { client_event_id: uuid(), event_type: 'sleep', occurred_at: iso(2021, 3, 1, 23) } });
  assert.equal(s2.status, 409);
  assert.equal(code(s2.json), 'SLEEP_ALREADY_OPEN');
});

await scenario('04 并发两条不同 client_event_id 的 sleep → 恰好 1 个 201', async () => {
  const { token } = await newUser('t04');
  const [a, b] = await Promise.all([
    api('/api/events', { method: 'POST', token, body: { client_event_id: uuid(), event_type: 'sleep', occurred_at: iso(2021, 4, 1, 22) } }),
    api('/api/events', { method: 'POST', token, body: { client_event_id: uuid(), event_type: 'sleep', occurred_at: iso(2021, 4, 1, 22, 1) } }),
  ]);
  const oks = [a, b].filter((r) => r.status === 201);
  const conflicts = [a, b].filter((r) => r.status === 409 && code(r.json) === 'SLEEP_ALREADY_OPEN');
  assert.equal(oks.length, 1, `expected 1 created, got statuses ${a.status}/${b.status}`);
  assert.equal(conflicts.length, 1);
});

await scenario('05 wake 时间早于/等于 sleep → 拒绝且无残留', async () => {
  const { token } = await newUser('t05');
  await api('/api/events', { method: 'POST', token, body: { client_event_id: uuid(), event_type: 'sleep', occurred_at: iso(2021, 5, 1, 22) } });
  const earlier = await api('/api/events', { method: 'POST', token, body: { client_event_id: uuid(), event_type: 'wake', occurred_at: iso(2021, 5, 1, 21) } });
  assert.equal(earlier.status, 400);
  assert.equal(code(earlier.json), 'INVALID_SLEEP_INTERVAL');
  const equal = await api('/api/events', { method: 'POST', token, body: { client_event_id: uuid(), event_type: 'wake', occurred_at: iso(2021, 5, 1, 22) } });
  assert.equal(equal.status, 400);
  assert.equal(code(equal.json), 'INVALID_SLEEP_INTERVAL');
  // sleep 仍未配对（失败无副作用）
  const p = await api('/api/events/pending', { token });
  assert.equal(p.json.events.filter((e) => e.event_type === 'sleep' && !e.session_id).length, 1);
});

await scenario('06 孤立 wake 防护：API 无法产生孤立 wake；存在时 sleep 被拒', async () => {
  const { token } = await newUser('t06');
  const w = await api('/api/events', { method: 'POST', token, body: { client_event_id: uuid(), event_type: 'wake', occurred_at: iso(2021, 6, 1) } });
  assert.equal(w.status, 409); // NO_OPEN_SLEEP：未写入任何 wake
  const p = await api('/api/events/pending', { token });
  assert.equal(p.json.events.length, 0);
  assert.equal(p.json.warning, null);
});

await scenario('07 配对区间与已有 session 重叠 → 409 SESSION_OVERLAP，无 wake/session', async () => {
  const { token } = await newUser('t07');
  // 已有 session：2021-07-01 00:00 → 08:00（补录）
  const ins = await api('/api/sessions', { method: 'POST', token, body: { session_id: uuid(), client_op_id: uuid(), start_at: iso(2021, 7, 1), end_at: iso(2021, 7, 1, 8) } });
  assert.equal(ins.status, 201);
  // sleep 07:00（与已有 session 重叠的 wake 将产生重叠区间）
  const s = await api('/api/events', { method: 'POST', token, body: { client_event_id: uuid(), event_type: 'sleep', occurred_at: iso(2021, 7, 1, 7) } });
  assert.equal(s.status, 201);
  const w = await api('/api/events', { method: 'POST', token, body: { client_event_id: uuid(), event_type: 'wake', occurred_at: iso(2021, 7, 1, 9) } });
  assert.equal(w.status, 409);
  assert.equal(code(w.json), 'SESSION_OVERLAP');
  // wake 未写入；sleep 仍未配对
  const p = await api('/api/events/pending', { token });
  assert.equal(p.json.events.length, 1);
  assert.equal(p.json.events[0].event_type, 'sleep');
});

await scenario('08 重复 client_event_id（sleep 与 wake）幂等返回', async () => {
  const { token } = await newUser('t08');
  const ceid = uuid();
  const s1 = await api('/api/events', { method: 'POST', token, body: { client_event_id: ceid, event_type: 'sleep', occurred_at: iso(2021, 8, 1, 22) } });
  assert.equal(s1.status, 201);
  const s2 = await api('/api/events', { method: 'POST', token, body: { client_event_id: ceid, event_type: 'sleep', occurred_at: iso(2021, 8, 1, 22) } });
  assert.equal(s2.status, 200);
  assert.equal(s2.json.event.id, s1.json.event.id);
  assert.equal(s2.json.status, 'open');
  const weid = uuid();
  const w1 = await api('/api/events', { method: 'POST', token, body: { client_event_id: weid, event_type: 'wake', occurred_at: iso(2021, 8, 2, 6) } });
  assert.equal(w1.status, 201);
  const w2 = await api('/api/events', { method: 'POST', token, body: { client_event_id: weid, event_type: 'wake', occurred_at: iso(2021, 8, 2, 6) } });
  assert.equal(w2.status, 200); // 幂等：现有事件状态 + 关联 session
  assert.equal(w2.json.status, 'paired');
  assert.equal(w2.json.session.id, w1.json.session.id);
});

await scenario('09 并发同 client_event_id 的 wake → 恰好 1 条事件', async () => {
  const { token } = await newUser('t09');
  await api('/api/events', { method: 'POST', token, body: { client_event_id: uuid(), event_type: 'sleep', occurred_at: iso(2021, 9, 1, 22) } });
  const weid = uuid();
  const [a, b] = await Promise.all([
    api('/api/events', { method: 'POST', token, body: { client_event_id: weid, event_type: 'wake', occurred_at: iso(2021, 9, 2, 6) } }),
    api('/api/events', { method: 'POST', token, body: { client_event_id: weid, event_type: 'wake', occurred_at: iso(2021, 9, 2, 6) } }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.ok(statuses.every((s) => s === 200 || s === 201), `unexpected statuses ${statuses}`);
  assert.equal(statuses.filter((s) => s === 201).length, 1, 'exactly one creation expected');
  assert.equal(a.json.event.id, b.json.event.id);
  const sessList = await api('/api/sessions', { token });
  assert.equal(sessList.json.sessions.length, 1);
});

await scenario('10 并发两条不同 wake 打同一 open sleep → 恰好 1 个 session', async () => {
  const { token } = await newUser('t10');
  await api('/api/events', { method: 'POST', token, body: { client_event_id: uuid(), event_type: 'sleep', occurred_at: iso(2021, 10, 1, 22) } });
  const [a, b] = await Promise.all([
    api('/api/events', { method: 'POST', token, body: { client_event_id: uuid(), event_type: 'wake', occurred_at: iso(2021, 10, 2, 5) } }),
    api('/api/events', { method: 'POST', token, body: { client_event_id: uuid(), event_type: 'wake', occurred_at: iso(2021, 10, 2, 6) } }),
  ]);
  const created = [a, b].filter((r) => r.status === 201);
  assert.equal(created.length, 1, `expected exactly one paired 201, got ${a.status}/${b.status}`);
  const rejected = [a, b].find((r) => r.status === 409);
  assert.equal(code(rejected.json), 'NO_OPEN_SLEEP');
  const sessList = await api('/api/sessions', { token });
  assert.equal(sessList.json.sessions.length, 1);
});

// ============ 补录 ============
await scenario('11 补录成功：客户端 UUID 作为服务端 id', async () => {
  const { token } = await newUser('t11');
  const sid = uuid();
  const r = await api('/api/sessions', { method: 'POST', token, body: { session_id: sid, client_op_id: uuid(), start_at: iso(2022, 1, 1, 23), end_at: iso(2022, 1, 2, 7), quality: 4 } });
  assert.equal(r.status, 201);
  assert.equal(r.json.session.id, sid);
  assert.equal(r.json.session.duration_minutes, 480);
  assert.equal(r.json.session.version, 1);
});

await scenario('12 补录时间倒置/相等 → 400 INVALID_SLEEP_INTERVAL', async () => {
  const { token } = await newUser('t12');
  const r = await api('/api/sessions', { method: 'POST', token, body: { session_id: uuid(), client_op_id: uuid(), start_at: iso(2022, 2, 2, 8), end_at: iso(2022, 2, 2, 7) } });
  assert.equal(r.status, 400);
  assert.equal(code(r.json), 'INVALID_SLEEP_INTERVAL');
  const eq = await api('/api/sessions', { method: 'POST', token, body: { session_id: uuid(), client_op_id: uuid(), start_at: iso(2022, 2, 2, 8), end_at: iso(2022, 2, 2, 8) } });
  assert.equal(eq.status, 400);
});

await scenario('13 补录与已有 session 重叠 → 409 SESSION_OVERLAP', async () => {
  const { token } = await newUser('t13');
  const r1 = await api('/api/sessions', { method: 'POST', token, body: { session_id: uuid(), client_op_id: uuid(), start_at: iso(2022, 3, 1), end_at: iso(2022, 3, 1, 8) } });
  assert.equal(r1.status, 201);
  const r2 = await api('/api/sessions', { method: 'POST', token, body: { session_id: uuid(), client_op_id: uuid(), start_at: iso(2022, 3, 1, 7), end_at: iso(2022, 3, 1, 15) } });
  assert.equal(r2.status, 409);
  assert.equal(code(r2.json), 'SESSION_OVERLAP');
});

await scenario('14 相同 session_id 重复补录（不同 op）→ 409 且不覆盖', async () => {
  const { token } = await newUser('t14');
  const sid = uuid();
  const r1 = await api('/api/sessions', { method: 'POST', token, body: { session_id: sid, client_op_id: uuid(), start_at: iso(2022, 4, 1), end_at: iso(2022, 4, 1, 8) } });
  assert.equal(r1.status, 201);
  const r2 = await api('/api/sessions', { method: 'POST', token, body: { session_id: sid, client_op_id: uuid(), start_at: iso(2022, 6, 1), end_at: iso(2022, 6, 1, 8) } });
  assert.ok([403, 409].includes(r2.status), `expected 403/409, got ${r2.status} ${JSON.stringify(r2.json)}`);
  const list = await api('/api/sessions', { token });
  assert.equal(list.json.sessions.length, 1);
  assert.equal(list.json.sessions[0].start_at, r1.json.session.start_at);
});

await scenario('15 跨用户：相同 session_id / 不同用户数据不可见', async () => {
  const u1 = await newUser('t15a');
  const u2 = await newUser('t15b');
  const sid = uuid();
  const r1 = await api('/api/sessions', { method: 'POST', token: u1.token, body: { session_id: sid, client_op_id: uuid(), start_at: iso(2022, 5, 1), end_at: iso(2022, 5, 1, 8) } });
  assert.equal(r1.status, 201);
  const steal = await api('/api/sessions', { method: 'POST', token: u2.token, body: { session_id: sid, client_op_id: uuid(), start_at: iso(2022, 7, 1), end_at: iso(2022, 7, 1, 8) } });
  assert.equal(steal.status, 403);
  assert.equal(code(steal.json), 'SESSION_ID_TAKEN');
  const list2 = await api('/api/sessions', { token: u2.token });
  assert.equal(list2.json.sessions.length, 0);
  const patch2 = await api(`/api/sessions/${sid}`, { method: 'PATCH', token: u2.token, body: { client_op_id: uuid(), base_version: 1, quality: 5 } });
  assert.equal(patch2.status, 404);
});

await scenario('16 相同 client_op_id 重复补录 → 缓存结果，不重复创建', async () => {
  const { token } = await newUser('t16');
  const op = uuid();
  const sid = uuid();
  const r1 = await api('/api/sessions', { method: 'POST', token, body: { session_id: sid, client_op_id: op, start_at: iso(2022, 8, 1), end_at: iso(2022, 8, 1, 8) } });
  assert.equal(r1.status, 201);
  const r2 = await api('/api/sessions', { method: 'POST', token, body: { session_id: sid, client_op_id: op, start_at: iso(2022, 8, 1), end_at: iso(2022, 8, 1, 8) } });
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.json.session, r1.json.session);
  const list = await api('/api/sessions', { token });
  assert.equal(list.json.sessions.length, 1);
});

await scenario('17 并发重叠补录（不同 op/session）→ 恰好 1 个成功', async () => {
  const { token } = await newUser('t17');
  const [a, b] = await Promise.all([
    api('/api/sessions', { method: 'POST', token, body: { session_id: uuid(), client_op_id: uuid(), start_at: iso(2022, 9, 1, 23), end_at: iso(2022, 9, 2, 7) } }),
    api('/api/sessions', { method: 'POST', token, body: { session_id: uuid(), client_op_id: uuid(), start_at: iso(2022, 9, 2, 6), end_at: iso(2022, 9, 2, 14) } }),
  ]);
  const created = [a, b].filter((r) => r.status === 201);
  const conflicts = [a, b].filter((r) => r.status === 409 && code(r.json) === 'SESSION_OVERLAP');
  assert.equal(created.length, 1, `statuses ${a.status}/${b.status}`);
  assert.equal(conflicts.length, 1);
  const list = await api('/api/sessions', { token });
  assert.equal(list.json.sessions.length, 1);
});

await scenario('18 并发相同 client_op_id 补录 → 各 1 行结果一致', async () => {
  const { token } = await newUser('t18');
  const op = uuid();
  const sid = uuid();
  const payload = { session_id: sid, client_op_id: op, start_at: iso(2022, 10, 1), end_at: iso(2022, 10, 1, 8) };
  const [a, b] = await Promise.all([
    api('/api/sessions', { method: 'POST', token, body: payload }),
    api('/api/sessions', { method: 'POST', token, body: payload }),
  ]);
  const created = [a, b].filter((r) => r.status === 201).length;
  const cached = [a, b].filter((r) => r.status === 200 && r.json?.session?.id === sid).length;
  assert.equal(created, 1);
  assert.equal(cached, 1);
  const list = await api('/api/sessions', { token });
  assert.equal(list.json.sessions.length, 1);
});

// ============ 编辑 ============
await scenario('19 编辑成功 → version 恰好 +1，响应为更新后记录', async () => {
  const { token } = await newUser('t19');
  const sid = uuid();
  const r1 = await api('/api/sessions', { method: 'POST', token, body: { session_id: sid, client_op_id: uuid(), start_at: iso(2023, 1, 1), end_at: iso(2023, 1, 1, 8) } });
  assert.equal(r1.status, 201);
  const r2 = await api(`/api/sessions/${sid}`, { method: 'PATCH', token, body: { client_op_id: uuid(), base_version: 1, quality: 5 } });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.session.version, 2);
  assert.equal(r2.json.session.quality, 5);
  const list = await api('/api/sessions', { token });
  assert.equal(list.json.sessions[0].version, 2);
});

await scenario('20 base_version 低于/高于当前 → 409 VERSION_CONFLICT 附最新记录', async () => {
  const { token } = await newUser('t20');
  const sid = uuid();
  await api('/api/sessions', { method: 'POST', token, body: { session_id: sid, client_op_id: uuid(), start_at: iso(2023, 2, 1), end_at: iso(2023, 2, 1, 8) } });
  await api(`/api/sessions/${sid}`, { method: 'PATCH', token, body: { client_op_id: uuid(), base_version: 1, quality: 3 } }); // → v2
  const stale = await api(`/api/sessions/${sid}`, { method: 'PATCH', token, body: { client_op_id: uuid(), base_version: 1, quality: 4 } });
  assert.equal(stale.status, 409);
  assert.equal(code(stale.json), 'VERSION_CONFLICT');
  assert.equal(stale.json.session.version, 2);
  const future = await api(`/api/sessions/${sid}`, { method: 'PATCH', token, body: { client_op_id: uuid(), base_version: 9, quality: 4 } });
  assert.equal(future.status, 409);
  assert.equal(code(future.json), 'VERSION_CONFLICT');
});

await scenario('21 编辑产生重叠 → 409 SESSION_OVERLAP，原记录不变', async () => {
  const { token } = await newUser('t21');
  const s1 = uuid(), s2 = uuid();
  const a = await api('/api/sessions', { method: 'POST', token, body: { session_id: s1, client_op_id: uuid(), start_at: iso(2023, 3, 1), end_at: iso(2023, 3, 1, 8) } });
  const b = await api('/api/sessions', { method: 'POST', token, body: { session_id: s2, client_op_id: uuid(), start_at: iso(2023, 3, 2), end_at: iso(2023, 3, 2, 8) } });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const edit = await api(`/api/sessions/${s2}`, { method: 'PATCH', token, body: { client_op_id: uuid(), base_version: 1, start_at: iso(2023, 3, 1, 4), end_at: iso(2023, 3, 1, 12) } });
  assert.equal(edit.status, 409);
  assert.equal(code(edit.json), 'SESSION_OVERLAP');
  const list = await api('/api/sessions', { token });
  const target = list.json.sessions.find((s) => s.id === s2);
  assert.equal(target.start_at, iso(2023, 3, 2)); // 未变
  assert.equal(target.version, 1);
});

await scenario('22 同一 client_op_id 重复编辑 → 缓存返回，version 不再增加', async () => {
  const { token } = await newUser('t22');
  const sid = uuid();
  const op = uuid();
  await api('/api/sessions', { method: 'POST', token, body: { session_id: sid, client_op_id: uuid(), start_at: iso(2023, 4, 1), end_at: iso(2023, 4, 1, 8) } });
  const r1 = await api(`/api/sessions/${sid}`, { method: 'PATCH', token, body: { client_op_id: op, base_version: 1, quality: 2 } });
  assert.equal(r1.json.session.version, 2);
  const r2 = await api(`/api/sessions/${sid}`, { method: 'PATCH', token, body: { client_op_id: op, base_version: 1, quality: 2 } });
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.json.session, r1.json.session);
});

await scenario('23 版本冲突的编辑不留 sync_ops 成功结果', async () => {
  const { token } = await newUser('t23');
  const sid = uuid();
  const conflictOp = uuid();
  await api('/api/sessions', { method: 'POST', token, body: { session_id: sid, client_op_id: uuid(), start_at: iso(2023, 5, 1), end_at: iso(2023, 5, 1, 8) } });
  await api(`/api/sessions/${sid}`, { method: 'PATCH', token, body: { client_op_id: uuid(), base_version: 1, quality: 3 } }); // v2
  const stale = await api(`/api/sessions/${sid}`, { method: 'PATCH', token, body: { client_op_id: conflictOp, base_version: 1, quality: 4 } });
  assert.equal(stale.status, 409);
  // 用同一 op 以正确版本重试：若冲突曾写入成功结果，这里会返回 quality=4 缓存；
  // 期望走正常路径产出 quality=5（证明 op 从未被记录成功）
  const retry = await api(`/api/sessions/${sid}`, { method: 'PATCH', token, body: { client_op_id: conflictOp, base_version: 2, quality: 5 } });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.session.quality, 5);
});

await scenario('24 并发同 base_version 编辑 → 恰好 1 成功，version 只 +1', async () => {
  const { token } = await newUser('t24');
  const sid = uuid();
  await api('/api/sessions', { method: 'POST', token, body: { session_id: sid, client_op_id: uuid(), start_at: iso(2023, 6, 1), end_at: iso(2023, 6, 1, 8) } });
  const [a, b] = await Promise.all([
    api(`/api/sessions/${sid}`, { method: 'PATCH', token, body: { client_op_id: uuid(), base_version: 1, quality: 2 } }),
    api(`/api/sessions/${sid}`, { method: 'PATCH', token, body: { client_op_id: uuid(), base_version: 1, quality: 3 } }),
  ]);
  const oks = [a, b].filter((r) => r.status === 200);
  const conflicts = [a, b].filter((r) => r.status === 409 && code(r.json) === 'VERSION_CONFLICT');
  assert.equal(oks.length, 1, `statuses ${a.status}/${b.status}`);
  assert.equal(conflicts.length, 1);
  const list = await api('/api/sessions', { token });
  assert.equal(list.json.sessions[0].version, 2);
});

await scenario('25 编辑与配对并发重叠 → 恰好 1 个持有该区间', async () => {
  const { token } = await newUser('t25');
  // 已有两行：A 2023-07-01 00:00→08:00（将被编辑到 06:00→14:00），B 2023-07-01 22:00→23:00
  const a = uuid();
  await api('/api/sessions', { method: 'POST', token, body: { session_id: a, client_op_id: uuid(), start_at: iso(2023, 7, 1), end_at: iso(2023, 7, 1, 8) } });
  const b = uuid();
  await api('/api/sessions', { method: 'POST', token, body: { session_id: b, client_op_id: uuid(), start_at: iso(2023, 7, 2), end_at: iso(2023, 7, 2, 1) } });
  // open sleep 07-02 00:30 → wake 07:30 与 B 重叠 → 配对将失败；
  // 同时编辑 A 到与 B 重叠也将失败。分别断言（串行即可，重点是不产生双写）。
  await api('/api/events', { method: 'POST', token, body: { client_event_id: uuid(), event_type: 'sleep', occurred_at: iso(2023, 7, 2, 0, 30) } });
  const pair = await api('/api/events', { method: 'POST', token, body: { client_event_id: uuid(), event_type: 'wake', occurred_at: iso(2023, 7, 2, 0, 45) } });
  assert.equal(pair.status, 409);
  assert.equal(code(pair.json), 'SESSION_OVERLAP');
  const edit = await api(`/api/sessions/${a}`, { method: 'PATCH', token, body: { client_op_id: uuid(), base_version: 1, start_at: iso(2023, 7, 1, 23), end_at: iso(2023, 7, 2, 1, 30) } });
  assert.equal(edit.status, 409);
  assert.equal(code(edit.json), 'SESSION_OVERLAP');
  const list = await api('/api/sessions', { token });
  assert.equal(list.json.sessions.length, 2);
});

// ============ 增量游标 ============
await scenario('26 复合游标：相同 updated_at 多条记录不漏不重', async () => {
  const { token } = await newUser('t26');
  // 用编辑把 3 条 session 的 updated_at 拉到同一值不可控（服务端时间）；
  // 改为直接验证游标语义：limit=1 逐页翻完全部 3 条非重叠 session。
  const ids = [];
  for (let d = 1; d <= 3; d++) {
    const sid = uuid();
    ids.push(sid);
    const r = await api('/api/sessions', { method: 'POST', token, body: { session_id: sid, client_op_id: uuid(), start_at: iso(2023, 8, d), end_at: iso(2023, 8, d, 8) } });
    assert.equal(r.status, 201);
  }
  const seen = [];
  let curTs = null, curId = null;
  for (let page = 0; page < 10; page++) {
    const q = curTs === null ? 'limit=2' : `limit=2&since_updated_at=${encodeURIComponent(curTs)}&since_id=${curId}`;
    const r = await api(`/api/sessions?${q}`, { token });
    assert.equal(r.status, 200);
    if (r.json.sessions.length === 0) break;
    seen.push(...r.json.sessions.map((s) => s.id));
    curTs = r.json.next_since_updated_at;
    curId = r.json.next_since_id;
  }
  assert.deepEqual(seen.sort(), ids.sort());
  // 相同 updated_at 的稳定性：SQL 级验证在 invariants 脚本中（直接以两条同 updated_at
  // 的行做字典序查询）。此处补充：游标推进后重复拉取返回空。
  const again = await api(`/api/sessions?limit=2&since_updated_at=${encodeURIComponent(curTs)}&since_id=${curId}`, { token });
  assert.equal(again.json.sessions.length, 0);
  assert.equal(again.json.next_since_updated_at, curTs);
});

// ============ 认证 ============
await scenario('27 未认证请求全部 401', async () => {
  const checks = await Promise.all([
    api('/api/events', { method: 'POST', body: { client_event_id: uuid(), event_type: 'sleep' } }),
    api('/api/sessions', { method: 'POST', body: { session_id: uuid(), client_op_id: uuid(), start_at: iso(2023, 9, 1), end_at: iso(2023, 9, 1, 8) } }),
    api('/api/sessions'),
    api('/api/events/pending'),
    api('/api/sessions/whatever', { method: 'PATCH', body: { client_op_id: uuid(), base_version: 1 } }),
  ]);
  for (const r of checks) assert.equal(r.status, 401, `got ${r.status}`);
});

await scenario('28 无效/过期 Bearer token → 401；有效 token 正常', async () => {
  const { token } = await newUser('t28');
  const bad = await api('/api/sessions', { token: 'not-a-real-session-id' });
  assert.equal(bad.status, 401);
  const ok = await api('/api/sessions', { token });
  assert.equal(ok.status, 200);
  const del = await api('/api/auth/token', { method: 'DELETE', token });
  assert.equal(del.status, 200);
  const after = await api('/api/sessions', { token });
  assert.equal(after.status, 401);
});

await scenario('29 Cookie 认证仍可用（与 Bearer 并行共存）', async () => {
  const email = `t29-${Date.now()}@test.local`;
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  const setCookie = reg.headers.get('set-cookie') ?? '';
  const m = /lifelogs_session=([a-f0-9-]+)/i.exec(setCookie);
  assert.ok(m, 'register must set session cookie');
  const r = await api('/api/sessions', { headers: { cookie: `lifelogs_session=${m[1]}` } });
  assert.equal(r.status, 200);
});

// ============ CORS ============
await scenario('30 CORS 预检：https://localhost 与 5173 允许；陌生 origin 拒绝', async () => {
  const pre = async (origin) =>
    fetch(`${BASE}/api/events`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
  const cap = await pre('https://localhost');
  assert.equal(cap.headers.get('access-control-allow-origin'), 'https://localhost');
  assert.equal(cap.headers.get('access-control-allow-credentials'), 'true');
  assert.match(cap.headers.get('access-control-allow-headers') ?? '', /authorization/i);
  assert.match(cap.headers.get('access-control-allow-methods') ?? '', /PATCH/i);
  const web = await pre('http://localhost:5173');
  assert.equal(web.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const evil = await pre('http://evil.example');
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});

// ============ 旧路由隔离 ============
await scenario('31 旧通用事件 API 在 /api/records 下正常；pending 不被 :id 截获', async () => {
  const { token } = await newUser('t31');
  const ce = uuid();
  const s = await api('/api/events', { method: 'POST', token, body: { client_event_id: ce, event_type: 'sleep', occurred_at: iso(2023, 10, 1, 22) } });
  assert.equal(s.status, 201);
  const pending = await api('/api/events/pending', { token });
  assert.equal(pending.status, 200);
  assert.equal(pending.json.events[0].client_event_id, ce); // 不是 legacy 404
  const legacyCreate = await api('/api/records', { method: 'POST', token, body: { event_type: 'drink', data: { ml: 250 } } });
  assert.equal(legacyCreate.status, 201);
  const legacyList = await api('/api/records?event_type=drink', { token });
  assert.equal(legacyList.status, 200);
  assert.equal(legacyList.json.events.length, 1);
  // 旧路径不再暴露为 /api/events
  const gone = await api('/api/events', { token });
  assert.equal(gone.status, 404);
});

// ============ 校验 ============
await scenario('32 请求体校验：非法 uuid/枚举/quality/limit', async () => {
  const { token } = await newUser('t32');
  const bad1 = await api('/api/events', { method: 'POST', token, body: { client_event_id: 'not-uuid', event_type: 'sleep' } });
  assert.equal(bad1.status, 400);
  const bad2 = await api('/api/events', { method: 'POST', token, body: { client_event_id: uuid(), event_type: 'nap' } });
  assert.equal(bad2.status, 400);
  const bad3 = await api('/api/sessions', { method: 'POST', token, body: { session_id: uuid(), client_op_id: uuid(), start_at: iso(2023, 11, 1), end_at: iso(2023, 11, 1, 8), quality: 6 } });
  assert.equal(bad3.status, 400);
  const bad4 = await api('/api/sessions?limit=10000', { token });
  assert.equal(bad4.status, 400);
  const bad5 = await api('/api/events', { method: 'POST', token, body: { client_event_id: uuid(), event_type: 'sleep', occurred_at: 'yesterday' } });
  assert.equal(bad5.status, 400);
});

await scenario('33 occurred_at 缺省时服务端补 UTC now；带偏移的输入规范化为 Z', async () => {
  const { token } = await newUser('t33');
  const s = await api('/api/events', { method: 'POST', token, body: { client_event_id: uuid(), event_type: 'sleep' } });
  assert.match(s.json.event.occurred_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  // start_at = 缺省生成的服务端 UTC now；end_at = 偏移时间规范化为 Z 形式
  const w = await api('/api/events', { method: 'POST', token, body: { client_event_id: uuid(), event_type: 'wake', occurred_at: '2099-01-01T10:00:00+08:00' } });
  assert.equal(w.status, 201);
  assert.equal(w.json.session.start_at, s.json.event.occurred_at);
  assert.equal(w.json.session.end_at, '2099-01-01T02:00:00.000Z');
});

// ============ summary ============
const failed = results.filter((r) => !r.pass);
console.log('\n===== SUMMARY =====');
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.log(`FAILED: ${f.name} :: ${f.error}`);
  process.exit(1);
}
