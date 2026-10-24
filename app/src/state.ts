/**
 * 应用状态（阶段 3：本地优先 + 最小自动同步）。
 *
 * 打卡/补录/编辑先写本地 SQLite（同一事务入队），UI 立即反馈；同步由
 * sync.ts 在启动、回到前台、网络恢复、手动点击时串行推送并增量拉取。
 * 失败绝不清空本地数据。
 */
import { useEffect, useState } from 'preact/compat';
import { api, ApiError, setAuthToken } from './api.js';
import {
  addBackfill,
  countPendingOps,
  editLocal,
  getMeta,
  getOpenSleep,
  initLocal,
  isPersistent,
  isReady,
  listSessions,
  recordSleep,
  recordWake,
  setMeta,
  storageErrorMessage,
  type LocalSession,
  type WriteFailure,
} from './local.js';
import { loadToken, storeToken } from './secure-token.js';
import { getSyncSnapshot, manualSync, onSyncChange, requestSync, setUnauthorizedHandler, type SyncSnapshot } from './sync.js';

export type PunchStatus =
  | { kind: 'signed_out' }
  | { kind: 'idle' }
  | { kind: 'open_sleep'; occurredAt: string }
  | { kind: 'busy' }
  | { kind: 'storage_error'; message: string };

type Store = {
  signedIn: boolean;
  status: PunchStatus;
  sessions: LocalSession[];
  lastResult: string | null;
  storageNote: string | null;
  sync: SyncSnapshot;
};

const store: Store = {
  signedIn: false,
  status: { kind: 'signed_out' },
  sessions: [],
  lastResult: null,
  storageNote: null,
  sync: getSyncSnapshot(),
};

const listeners = new Set<() => void>();

function set(patch: Partial<Store>): void {
  Object.assign(store, patch);
  for (const l of listeners) l();
}

export function useStore(): Store {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((n) => n + 1);
    listeners.add(listener);
    const unsubSync = onSyncChange((s) => {
      set({ sync: s });
      // 同步会改写本地行（临时配对 → 正式记录），结束后必须重新读库，
      // 否则历史页一直停留在同步前的快照。
      if (s.phase !== 'running') void reloadFromLocal();
    });
    return () => {
      listeners.delete(listener);
      unsubSync();
    };
  }, []);
  return store;
}

const FAILURE_TEXT: Record<WriteFailure, string> = {
  SLEEP_ALREADY_OPEN: '已有一条未配对的入睡记录，请先点「醒了」',
  NO_OPEN_SLEEP: '当前没有待配对的入睡记录，请先点「睡了」',
  INVALID_INTERVAL: '时间无效：结束时间必须晚于开始时间',
  SESSION_OVERLAP: '该时间段与已有记录重叠，未保存',
  INVALID_QUALITY: '质量只接受 1–5 的整数（留空表示清除）',
  NOT_FOUND: '记录不存在',
};

function localWriteError(f: WriteFailure): void {
  set({ lastResult: FAILURE_TEXT[f] });
}

/** 启动：初始化本地存储 → 恢复 token → 校验数据归属 → 触发同步。 */
export async function bootstrap(): Promise<void> {
  const err = await initLocal();
  set({ storageNote: err });
  const token = await loadToken();
  if (token !== null) {
    setAuthToken(token);
    set({ signedIn: true });
  }
  await reloadFromLocal();
  if (store.signedIn) void requestSync('启动');
}

async function reloadFromLocal(): Promise<void> {
  if (!isReady()) return;
  const [open, sessions] = await Promise.all([getOpenSleep(), listSessions()]);
  set({
    status: store.signedIn
      ? open !== null
        ? { kind: 'open_sleep', occurredAt: open.occurred_at }
        : { kind: 'idle' }
      : { kind: 'signed_out' },
    sessions,
  });
}

/** 同步完成后刷新展示。 */
async function afterSyncRefresh(): Promise<void> {
  await reloadFromLocal();
}

export async function login(email: string, password: string): Promise<string | null> {
  if (!isReady()) return storageErrorMessage() ?? '本地存储不可用';
  try {
    const res = await api.login(email, password);
    // 数据归属守卫：本地已有别的账号的数据时阻止串号。
    const owner = await getMeta('owner.user_id');
    if (owner !== null && owner !== res.user.id) {
      const pending = await countPendingOps();
      if (pending > 0) {
        return `本机还有 ${pending} 条属于原账号的待同步记录，请先同步或回到原账号`;
      }
      // 无待推送数据 → 提示后清空旧数据再接新账号（MVP：直接清）。
      const { clearLocalData } = await import('./local.js');
      await clearLocalData();
    }
    await setMeta('owner.user_id', res.user.id);
    await setMeta('owner.email', res.user.email);
    setAuthToken(res.token);
    await storeToken(res.token);
    set({ signedIn: true, lastResult: null });
    await reloadFromLocal();
    void requestSync('登录');
    return null;
  } catch (e) {
    if (e instanceof ApiError) return e.status === 401 ? '邮箱或密码不正确' : e.message;
    return '无法连接服务器，请检查网络后重试';
  }
}

export async function logout(): Promise<void> {
  try {
    await api.logout();
  } catch {
    /* 断网退出：token 本地清除即可，数据全部保留 */
  }
  setAuthToken(null);
  await storeToken(null);
  set({ signedIn: false, status: { kind: 'signed_out' }, sessions: [], lastResult: null });
}

export async function refreshStatus(): Promise<void> {
  await reloadFromLocal();
  if (store.signedIn) void requestSync('刷新');
}

export async function syncNow(): Promise<void> {
  await manualSync();
  await afterSyncRefresh();
}

function storageHint(): string {
  return isPersistent() ? '已保存到本地' : '已保存（浏览器内存，重启丢失）';
}

export async function punchSleep(): Promise<void> {
  if (!isReady()) {
    set({ status: { kind: 'storage_error', message: storageErrorMessage() ?? '本地存储不可用' } });
    return;
  }
  set({ status: { kind: 'busy' }, lastResult: null });
  try {
    const res = await recordSleep(new Date().toISOString());
    if (typeof res !== 'string') {
      set({ status: { kind: 'open_sleep', occurredAt: res.occurred_at }, lastResult: '已记录入睡（' + storageHint() + '）' });
      void requestSync('打卡');
    } else {
      localWriteError(res);
      await reloadFromLocal();
    }
  } catch (e) {
    set({ status: { kind: 'storage_error', message: e instanceof Error ? e.message : String(e) } });
    await reloadFromLocal();
  }
  set({ sessions: await (isReady() ? listSessions() : Promise.resolve([])) });
}

export async function punchWake(): Promise<void> {
  if (!isReady()) {
    set({ status: { kind: 'storage_error', message: storageErrorMessage() ?? '本地存储不可用' } });
    return;
  }
  set({ status: { kind: 'busy' }, lastResult: null });
  try {
    const res = await recordWake(new Date().toISOString());
    if (typeof res !== 'string') {
      set({
        status: { kind: 'idle' },
        lastResult: `配对成功：${res.session.duration_minutes} 分钟（${storageHint()}，待同步）`,
      });
      void requestSync('打卡');
    } else {
      localWriteError(res);
    }
  } catch (e) {
    set({ status: { kind: 'storage_error', message: e instanceof Error ? e.message : String(e) } });
  }
  await reloadFromLocal();
  set({ sessions: isReady() ? await listSessions() : store.sessions });
}

/** 补录：返回给页面的错误文本（成功 null）。 */
export async function backfill(
  startAt: string,
  endAt: string,
  quality: number | null,
): Promise<string | null> {
  if (!isReady()) return storageErrorMessage() ?? '本地存储不可用';
  try {
    const res = await addBackfill(startAt, endAt, quality);
    if (typeof res !== 'string') {
      set({ lastResult: `补录成功：${res.session.duration_minutes} 分钟（${storageHint()}，待同步）` });
      set({ sessions: await listSessions() });
      void requestSync('补录');
      return null;
    }
    return FAILURE_TEXT[res];
  } catch (e) {
    return e instanceof Error ? e.message : '保存失败';
  }
}

/** 编辑：返回给页面的错误文本（成功 null）。 */
export async function editSession(
  id: string,
  patch: { start_at?: string; end_at?: string; quality?: number | null },
): Promise<string | null> {
  if (!isReady()) return storageErrorMessage() ?? '本地存储不可用';
  try {
    const res = await editLocal(id, patch);
    if (typeof res !== 'string') {
      set({ lastResult: `编辑成功（${storageHint()}，待同步）` });
      set({ sessions: await listSessions() });
      void requestSync('编辑');
      return null;
    }
    return FAILURE_TEXT[res];
  } catch (e) {
    return e instanceof Error ? e.message : '保存失败';
  }
}

// ---------------------------------------------------------------------------
// 触发器：回到前台（原生 appResume 事件）/ 网络恢复 / visibilitychange
// ---------------------------------------------------------------------------
let triggersBound = false;

export function bindSyncTriggers(): void {
  if (triggersBound) return;
  triggersBound = true;
  setUnauthorizedHandler(() => {
    // 只退出登录态；本地记录与队列全部保留。
    set({ signedIn: false, status: { kind: 'signed_out' }, lastResult: null });
  });
  window.addEventListener('appResume', () => {
    if (store.signedIn) void requestSync('回到前台');
  });
  window.addEventListener('online', () => {
    if (store.signedIn) void requestSync('网络恢复');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && store.signedIn) void requestSync('回到前台');
  });
}
