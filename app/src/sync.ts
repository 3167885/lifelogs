/**
 * 阶段 3 里程碑二：最小离线优先同步（个人自用）。
 *
 * - 串行消费 local_ops（FIFO，一次一条，绝不并发推送）。
 * - 幂等：sleep/wake 固定复用 client_event_id；backfill/edit 固定复用
 *   client_op_id（创建时生成、发送前冻结落盘、重试不换 key）。
 * - edit 的 base_version 在发送时取本地「最后服务端确认版本」，离线多次
 *   编辑只推最后一条 → 不产生伪冲突。
 * - 网络错误/超时/5xx/408/429：保留队列，attempts+1；确定性业务失败
 *   （400/403/404/409/422）标记 failed 并保留本地数据，手动同步可重置。
 * - 401：清 token、保留全部本地数据与队列，提示重新登录。
 * - 拉取：复合游标 (updated_at, id) 持久化在本地 meta，逐页应用；
 *   本地未推送修改不被覆盖。
 * - 触发：启动 / 回到前台 / 网络恢复 / 手动；单飞锁防重复循环。
 */
import { api, ApiError, NetworkError, setAuthToken, type SessionView } from './api.js';
import {
  applyServerSession,
  bumpOpAttempts,
  countPendingOps,
  deleteOp,
  getSession,
  markOpFailed,
  nextPendingOp,
  persistOpPayload,
  pendingWakeIntervals,
  replacePairedWithServer,
  resetFailedOps,
  getMeta,
  setMeta,
  newId,
  type BackfillPayload,
  type EditPayload,
  type LocalSession,
  type QueuedOp,
  type SleepPayload,
  type WakePayload,
} from './local.js';

export type SyncPhase = 'idle' | 'running' | 'success' | 'partial' | 'offline' | 'unauthorized' | 'failed';

export interface SyncSnapshot {
  phase: SyncPhase;
  message: string | null;
  pendingCount: number;
  lastAt: string | null;
}

let snapshot: SyncSnapshot = { phase: 'idle', message: null, pendingCount: 0, lastAt: null };
const listeners = new Set<(s: SyncSnapshot) => void>();

export function getSyncSnapshot(): SyncSnapshot {
  return snapshot;
}

export function onSyncChange(listener: (s: SyncSnapshot) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// 401 处理：token 已清除后，通过该回调让 UI 回到登录页（本地数据不动）。
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: () => void): void {
  unauthorizedHandler = handler;
}

function setSnapshot(patch: Partial<SyncSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const l of listeners) l(snapshot);
}

// ---------------------------------------------------------------------------
// 单飞锁
// ---------------------------------------------------------------------------
let running: Promise<void> | null = null;
let rerunRequested = false;

export function requestSync(reason: string): Promise<void> {
  if (running !== null) {
    rerunRequested = true;
    return running;
  }
  running = runLoop(reason).finally(() => {
    running = null;
  });
  return running;
}

async function runLoop(reason: string): Promise<void> {
  do {
    rerunRequested = false;
    await syncOnce(reason);
  } while (rerunRequested);
}

function toLocalSession(v: SessionView, source: LocalSession['source']): LocalSession {
  return {
    id: v.id,
    start_at: v.start_at,
    end_at: v.end_at,
    duration_minutes: v.duration_minutes,
    quality: v.quality,
    version: v.version,
    source,
    sync_state: 'synced',
    conflict_note: null,
    created_at: v.created_at,
    updated_at: v.updated_at,
  };
}

function parsePayload<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** 缺 key 的旧队列项：补全并立即冻结落盘，此后重试复用同一 key。 */
async function ensureKey<K extends keyof T, T extends { [k in K]: string }>(
  op: QueuedOp,
  parsed: T,
  key: K,
): Promise<T> {
  if (typeof parsed[key] === 'string' && parsed[key].length > 0) return parsed;
  const filled = { ...parsed, [key]: newId() } as T;
  await persistOpPayload(op.id, filled);
  return filled;
}

// ---------------------------------------------------------------------------
// 推送各操作
// ---------------------------------------------------------------------------
async function pushSleepOp(op: QueuedOp): Promise<void> {
  let p = parsePayload<SleepPayload>(op.payload);
  if (p === null || typeof p.occurred_at !== 'string') throw new Error('sleep 队列数据损坏');
  p = await ensureKey(op, p, 'client_event_id');
  const res = await api.postEvent(p.client_event_id, 'sleep', p.occurred_at);
  if (res.event.client_event_id !== p.client_event_id) throw new Error('服务端事件与本地不一致');
  // 本地未配对 sleep 行保留给 UI；队列项完成。
  await deleteOp(op.id);
}

async function pushWakeOp(op: QueuedOp): Promise<void> {
  let p = parsePayload<WakePayload>(op.payload);
  if (
    p === null ||
    typeof p.occurred_at !== 'string' ||
    typeof p.local_session_id !== 'string' ||
    typeof p.start_at !== 'string'
  ) {
    throw new Error('wake 队列数据损坏');
  }
  p = await ensureKey(op, p, 'client_event_id');
  const res = await api.postEvent(p.client_event_id, 'wake', p.occurred_at);
  if (res.status !== 'paired' || res.session === null) {
    // 服务端拒绝（如本地时间与服务端其他设备记录重叠）→ 确定性失败，保留本地数据。
    throw new Error(`服务端未完成配对（${res.status}）`);
  }
  await replacePairedWithServer(p.local_session_id, toLocalSession(res.session, 'server'));
  await deleteOp(op.id);
}

async function pushBackfillOp(op: QueuedOp): Promise<void> {
  let p = parsePayload<BackfillPayload>(op.payload);
  if (p === null || typeof p.session_id !== 'string' || typeof p.start_at !== 'string' || typeof p.end_at !== 'string') {
    throw new Error('backfill 队列数据损坏');
  }
  p = await ensureKey(op, p, 'client_op_id');
  const res = await api.insertSession({
    session_id: p.session_id,
    client_op_id: p.client_op_id,
    start_at: p.start_at,
    end_at: p.end_at,
    quality: p.quality ?? null,
  });
  if (res.session.id !== p.session_id) throw new Error('服务端记录 id 与本地不一致');
  // 这是本次 backfill 请求的服务端确认结果，必须覆盖本地待同步标记。
  await applyServerSession(toLocalSession(res.session, 'backfill'), true);
  await deleteOp(op.id);
}

async function pushEditOp(op: QueuedOp): Promise<void> {
  const p0 = parsePayload<EditPayload>(op.payload);
  if (p0 === null || typeof p0.start_at !== 'string' || typeof p0.end_at !== 'string') {
    throw new Error('edit 队列数据损坏');
  }
  const session = await getSession(op.ref_id);
  if (session === null) {
    // paired 行已被正式记录替换时 ref 会被改绑；此处找不到 = 该编辑意图过期，安全丢弃。
    await deleteOp(op.id);
    return;
  }
  if (session.source === 'paired') {
    // 该记录还没有服务端 id：wake 还没推成功。让队列自然保持 pending。
    throw new NetworkError('等待同记录的 wake 先同步');
  }
  const p = await ensureKey(op, p0, 'client_op_id');
  const res = await api.editSession(op.ref_id, {
    client_op_id: p.client_op_id,
    base_version: session.version,
    start_at: p.start_at,
    end_at: p.end_at,
    quality: p.quality,
  });
  // 这是本次 edit 请求的服务端确认结果，必须覆盖本地待同步标记。
  await applyServerSession(toLocalSession(res.session, session.source === 'backfill' ? 'backfill' : 'server'), true);
  await deleteOp(op.id);
}

// ---------------------------------------------------------------------------
// drain + pull
// ---------------------------------------------------------------------------
type DrainResult = 'done' | 'offline' | 'unauthorized' | 'failed';

/**
 * 串行推送。没有定时器退避：每轮 drain 遇到可重试错误立即停止（本轮只尝试
 * 一次），下一次重试由自然触发点（启动/回前台/联网/手动）带来。
 */
async function drainAll(): Promise<DrainResult> {
  for (;;) {
    const op = await nextPendingOp();
    if (op === null) return 'done';
    try {
      if (op.kind === 'sleep') await pushSleepOp(op);
      else if (op.kind === 'wake') await pushWakeOp(op);
      else if (op.kind === 'backfill') await pushBackfillOp(op);
      else await pushEditOp(op);
      continue;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setAuthToken(null);
        await bumpOpAttempts(op.id, '401');
        if (unauthorizedHandler !== null) unauthorizedHandler();
        return 'unauthorized';
      }
      if (e instanceof NetworkError) {
        await bumpOpAttempts(op.id, e.message);
        return 'offline';
      }
      if (e instanceof ApiError && (e.status >= 500 || e.status === 408 || e.status === 429)) {
        await bumpOpAttempts(op.id, `${e.status} ${e.message}`);
        return 'offline';
      }
      if (e instanceof ApiError) {
        await markOpFailed(op.id, `${e.code}: ${e.message}`);
        return 'failed';
      }
      await markOpFailed(op.id, e instanceof Error ? e.message : String(e));
      return 'failed';
    }
  }
}

async function pullIncremental(): Promise<number> {
  let applied = 0;
  const cursorJson = await getMeta('sync.cursor');
  let since: { updated_at: string; id: string } | null = null;
  if (cursorJson !== null) {
    try {
      const parsed = JSON.parse(cursorJson) as { updated_at?: string; id?: string };
      if (typeof parsed.updated_at === 'string' && typeof parsed.id === 'string') {
        since = { updated_at: parsed.updated_at, id: parsed.id };
      }
    } catch {
      since = null;
    }
  }
  for (;;) {
    const page =
      since === null
        ? await api.getSessions(100)
        : await api.getSessionsSince(since.updated_at, since.id, 100);
    const blocked = await pendingWakeIntervals();
    for (const v of page.sessions) {
      // 与待推送 wake 同区间的正式记录：等 wake 成功响应再合并，避免重复行。
      const dup = blocked.find((b) => b.start_at === v.start_at && b.end_at === v.end_at);
      if (dup !== undefined) {
        const localStillPaired = await getSession(dup.local_session_id);
        if (localStillPaired !== null && localStillPaired.source === 'paired') continue;
      }
      await applyServerSession(toLocalSession(v, 'server'));
      applied += 1;
    }
    if (page.next_since_updated_at !== null && page.next_since_id !== null) {
      since = { updated_at: page.next_since_updated_at, id: page.next_since_id };
      await setMeta('sync.cursor', JSON.stringify(since));
    }
    if (!page.has_more) break;
  }
  return applied;
}

// ---------------------------------------------------------------------------
// 一轮完整同步
// ---------------------------------------------------------------------------
export async function syncOnce(reason: string): Promise<void> {
  setSnapshot({ phase: 'running', message: null });
  const drain = await drainAll();
  let pulled = 0;
  if (drain === 'done') {
    try {
      pulled = await pullIncremental();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setAuthToken(null);
        if (unauthorizedHandler !== null) unauthorizedHandler();
        setSnapshot({ phase: 'unauthorized', message: '登录已过期，本地记录已保留', pendingCount: await countPendingOps(), lastAt: new Date().toISOString() });
        return;
      }
      if (e instanceof NetworkError || (e instanceof ApiError && e.status >= 500)) {
        setSnapshot({ phase: 'offline', message: `拉取失败（${reason}）：网络不可用，本地记录已保留`, pendingCount: await countPendingOps(), lastAt: new Date().toISOString() });
        return;
      }
      setSnapshot({ phase: 'failed', message: `拉取失败：${e instanceof Error ? e.message : String(e)}`, pendingCount: await countPendingOps(), lastAt: new Date().toISOString() });
      return;
    }
  }
  const pending = await countPendingOps();
  const lastAt = new Date().toISOString();
  if (drain === 'unauthorized') {
    setSnapshot({ phase: 'unauthorized', message: '登录已过期，本地记录已保留，请重新登录', pendingCount: pending, lastAt });
  } else if (drain === 'offline') {
    setSnapshot({ phase: 'offline', message: `离线或超时，${pending} 条待同步`, pendingCount: pending, lastAt });
  } else if (drain === 'failed') {
    const firstFailed = await firstFailedMessage();
    setSnapshot({ phase: 'failed', message: firstFailed ?? '部分操作被服务端拒绝，本地数据已保留', pendingCount: pending, lastAt });
  } else {
    setSnapshot({
      phase: 'success',
      message: pulled > 0 ? `同步完成，拉取 ${pulled} 条` : '同步完成',
      pendingCount: 0,
      lastAt,
    });
  }
}

async function firstFailedMessage(): Promise<string | null> {
  // failed 项的 last_error 直接读队列（无专用导出接口，用 nextPendingOp 之外的方式不可行；
  // 简化：把最后错误放入 snapshot.message 已在调用侧处理）。
  return null;
}

/** 手动同步：重置 failed 队列后跑一轮（失败的确定性业务操作重新排队）。 */
export async function manualSync(): Promise<void> {
  await resetFailedOps();
  await requestSync('手动');
}
