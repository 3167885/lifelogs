/**
 * In-memory app state (阶段 2 baseline).
 *
 * IMPORTANT — temporary-data boundary:
 * Nothing here is persisted. No SQLite, no localStorage, no outbox, no sync
 * engine (those are 阶段 3). Every mutation below calls the real backend
 * synchronously; if the network call fails, the state is not changed and the
 * error is surfaced. Reopening the app always requires login again.
 */
import { useEffect, useState } from 'preact/compat';
import { api, ApiError, getAuthToken, setAuthToken, type SessionView } from './api.js';

export type PunchStatus =
  | { kind: 'signed_out' }
  | { kind: 'idle' } // no open sleep event
  | { kind: 'open_sleep'; occurredAt: string } // 已点击睡了，等待醒了
  | { kind: 'syncing' } // 正在调用后端
  | { kind: 'error'; message: string; code: string };

export type ConflictState = {
  sessionId: string;
  message: string;
  serverSession: SessionView | null;
  retry: () => Promise<void>;
} | null;

type Store = {
  signedIn: boolean;
  status: PunchStatus;
  sessions: SessionView[];
  pendingWarning: string | null;
  conflict: ConflictState;
  lastResult: string | null;
};

let store: Store = {
  signedIn: getAuthToken() !== null,
  status: getAuthToken() !== null ? { kind: 'idle' } : { kind: 'signed_out' },
  sessions: [],
  pendingWarning: null,
  conflict: null,
  lastResult: null,
};

const listeners = new Set<() => void>();

function set(patch: Partial<Store>): void {
  store = { ...store, ...patch };
  for (const l of listeners) l();
}

export function useStore(): Store {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return store;
}

const uuid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : // 运行时环境若无 randomUUID（非安全上下文），回退手动拼装 v4。
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
        const r = (Math.random() * 16) | 0;
        const v = ch === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });

export async function login(email: string, password: string): Promise<string | null> {
  try {
    const res = await api.login(email, password);
    setAuthToken(res.token);
    set({ signedIn: true, status: { kind: 'idle' } });
    await Promise.all([refreshSessions(), refreshPending()]);
    return null;
  } catch (e) {
    return e instanceof ApiError ? e.message : 'Network error';
  }
}

export async function logout(): Promise<void> {
  try {
    await api.logout(); // revokes the server-side session (阶段 1 contract)
  } catch {
    /* even if the call fails, drop the in-memory token */
  }
  setAuthToken(null);
  set({
    signedIn: false,
    status: { kind: 'signed_out' },
    sessions: [],
    pendingWarning: null,
    conflict: null,
    lastResult: null,
  });
}

export async function refreshPending(): Promise<void> {
  if (!store.signedIn) return;
  try {
    const res = await api.getPending();
    const open = res.events.find((e) => e.event_type === 'sleep' && e.session_id === null);
    set({
      pendingWarning: res.warning,
      status: open
        ? { kind: 'open_sleep', occurredAt: open.occurred_at }
        : store.status.kind === 'open_sleep'
          ? { kind: 'idle' }
          : store.status,
    });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      set({ signedIn: false, status: { kind: 'signed_out' } });
    }
  }
}

export async function refreshSessions(): Promise<void> {
  if (!store.signedIn) return;
  try {
    const res = await api.getSessions();
    set({ sessions: res.sessions.slice().sort((a, b) => (a.start_at < b.start_at ? 1 : -1)) });
  } catch {
    /* keep previous list; error surfaces via punch flows */
  }
}

export async function punchSleep(): Promise<void> {
  set({ status: { kind: 'syncing' }, lastResult: null });
  try {
    const res = await api.postEvent(uuid(), 'sleep', new Date().toISOString());
    set({
      status:
        res.status === 'open'
          ? { kind: 'open_sleep', occurredAt: res.event.occurred_at }
          : { kind: 'idle' },
      lastResult: `已记录入睡：${res.event.occurred_at}（服务端已确认）`,
    });
    await refreshPending();
  } catch (e) {
    handlePunchError(e);
  }
}

export async function punchWake(): Promise<void> {
  set({ status: { kind: 'syncing' }, lastResult: null });
  try {
    const res = await api.postEvent(uuid(), 'wake', new Date().toISOString());
    set({
      status: { kind: 'idle' },
      lastResult:
        res.session !== null
          ? `配对成功：${res.session.duration_minutes} 分钟（服务端 session ${res.session.id.slice(0, 8)}…）`
          : '已记录醒来',
    });
    await Promise.all([refreshSessions(), refreshPending()]);
  } catch (e) {
    handlePunchError(e);
  }
}

function handlePunchError(e: unknown): void {
  if (e instanceof ApiError) {
    set({ status: { kind: 'error', message: e.message, code: e.code } });
  } else {
    set({ status: { kind: 'error', message: 'Network error', code: 'NETWORK' } });
  }
}

export async function backfill(
  startAt: string,
  endAt: string,
  quality: number | null
): Promise<string | null> {
  try {
    const res = await api.insertSession({
      session_id: uuid(),
      client_op_id: uuid(),
      start_at: startAt,
      end_at: endAt,
      quality,
    });
    await refreshSessions();
    set({ lastResult: `补录成功：${res.session.duration_minutes} 分钟` });
    return null;
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.code === 'SESSION_OVERLAP') {
        set({
          conflict: {
            sessionId: 'backfill',
            message: '补录区间与已有记录重叠',
            serverSession: null,
            retry: async () => undefined,
          },
        });
      }
      return `${e.code}: ${e.message}`;
    }
    return 'Network error';
  }
}

export async function editSession(
  id: string,
  baseVersion: number,
  patch: { start_at?: string; end_at?: string; quality?: number | null }
): Promise<string | null> {
  const body = { client_op_id: uuid(), base_version: baseVersion, ...patch };
  const retry = async () => {
    await editSessionDirect(id, { ...body });
  };
  try {
    const res = await editSessionDirect(id, body);
    await refreshSessions();
    set({ lastResult: `编辑成功：version ${res.session.version}` });
    return null;
  } catch (e) {
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
      set({
        conflict: {
          sessionId: id,
          message: '服务器版本已变化（VERSION_CONFLICT）',
          serverSession: e.serverSession,
          retry,
        },
      });
      return '版本冲突，请在冲突提示中选择处理方式';
    }
    if (e instanceof ApiError && e.code === 'SESSION_OVERLAP') {
      return '编辑后的区间与已有记录重叠，未保存';
    }
    return e instanceof ApiError ? `${e.code}: ${e.message}` : 'Network error';
  }
}

async function editSessionDirect(
  id: string,
  body: { client_op_id: string; base_version: number; start_at?: string; end_at?: string; quality?: number | null }
) {
  return api.editSession(id, body);
}

/** 冲突处理：采用服务器版本 → 丢弃本地修改意图，仅刷新列表。 */
export async function resolveConflictAdoptServer(): Promise<void> {
  set({ conflict: null });
  await refreshSessions();
}

/** 冲突处理：保留本地修改并重新提交 → 以最新服务端版本为 base_version 重试一次。 */
export async function resolveConflictKeepLocal(): Promise<void> {
  const c = store.conflict;
  if (c === null) return;
  set({ conflict: null });
  try {
    await c.retry();
    set({ lastResult: '已基于最新版本重新提交' });
  } catch {
    set({ lastResult: '重新提交失败，请重试或采用服务器版本' });
  }
  await refreshSessions();
}
