/**
 * Typed client for the 阶段 1 backend contract. ALL network calls go through
 * this module; pages never hardcode URLs or paths.
 *
 * The base URL is injected by Vite from VITE_API_BASE_URL. Development falls
 * back to the local Worker; production builds fail closed unless an HTTPS URL
 * is explicitly configured.
 */
declare const __API_BASE_URL__: string;

const API_BASE: string = __API_BASE_URL__;

export interface SessionView {
  id: string;
  start_at: string;
  end_at: string;
  duration_minutes: number;
  quality: number | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface EventView {
  id: string;
  client_event_id: string;
  event_type: 'sleep' | 'wake';
  occurred_at: string;
  session_id: string | null;
}

export interface EventResponse {
  event: EventView;
  status: 'open' | 'paired';
  session: SessionView | null;
}

export interface TokenResponse {
  token: string;
  token_type: string;
  expires_at: string;
  user: { id: string; email: string; email_verified: number };
}

export interface PendingResponse {
  events: EventView[];
  warning: string | null;
}

export interface SessionsPage {
  sessions: SessionView[];
  next_since_updated_at: string | null;
  next_since_id: string | null;
  has_more: boolean;
}

export interface InsertSessionBody {
  session_id: string;
  client_op_id: string;
  start_at: string;
  end_at: string;
  quality?: number | null;
}

export interface EditSessionBody {
  client_op_id: string;
  base_version: number;
  start_at?: string;
  end_at?: string;
  quality?: number | null;
}

/** API error carrying HTTP status plus the stable machine code from {error:{code,message}}. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Present on VERSION_CONFLICT: the authoritative latest server record. */
  readonly serverSession: SessionView | null;

  constructor(status: number, code: string, message: string, serverSession: SessionView | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.serverSession = serverSession;
  }
}

// Bearer token lives in module memory ONLY (阶段 2). It is not written to
// localStorage or any business table; safe storage arrives in 阶段 3.
let authToken: string | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

export function getAuthToken(): string | null {
  return authToken;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const REQUEST_TIMEOUT_MS = 15_000;

async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken !== null) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
  } catch (e) {
    // 断网/超时统一成可重试的 NetworkError，不误判为业务失败。
    const msg = e instanceof Error && e.name === 'AbortError' ? '请求超时' : '网络不可用';
    throw new NetworkError(msg);
  } finally {
    clearTimeout(timer);
  }

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }

  if (!res.ok) {
    let code = `HTTP_${res.status}`;
    let message = res.statusText;
    let serverSession: SessionView | null = null;
    if (isRecord(data) && isRecord(data.error)) {
      if (typeof data.error.code === 'string') code = data.error.code;
      if (typeof data.error.message === 'string') message = data.error.message;
    }
    // VERSION_CONFLICT 的权威记录在顶层 session 字段（阶段 1 契约）。
    if (isRecord(data) && isRecord(data.session) && isRecordSessionView(data.session)) {
      serverSession = data.session as unknown as SessionView;
    }
    throw new ApiError(res.status, code, message, serverSession);
  }

  return data as T;
}

/** 网络层错误（断网/超时）：结果未知，同步侧必须复用幂等键重试。 */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

function isRecordSessionView(v: Record<string, unknown>): boolean {
  return (
    typeof v.id === 'string' &&
    typeof v.start_at === 'string' &&
    typeof v.end_at === 'string' &&
    typeof v.duration_minutes === 'number' &&
    typeof v.version === 'number' &&
    typeof v.updated_at === 'string' &&
    typeof v.created_at === 'string'
  );
}

export const api = {
  login(email: string, password: string): Promise<TokenResponse> {
    return request<TokenResponse>('/api/auth/token', {
      method: 'POST',
      body: { email, password },
    });
  },
  logout(): Promise<{ success: boolean }> {
    return request<{ success: boolean }>('/api/auth/token', { method: 'DELETE' });
  },
  postEvent(
    clientEventId: string,
    eventType: 'sleep' | 'wake',
    occurredAt: string
  ): Promise<EventResponse> {
    return request<EventResponse>('/api/events', {
      method: 'POST',
      body: {
        client_event_id: clientEventId,
        event_type: eventType,
        occurred_at: occurredAt,
      },
    });
  },
  getPending(): Promise<PendingResponse> {
    return request<PendingResponse>('/api/events/pending');
  },
  getSessions(limit = 100): Promise<SessionsPage> {
    return request<SessionsPage>(`/api/sessions?limit=${limit}`);
  },
  getSessionsSince(sinceUpdatedAt: string, sinceId: string, limit = 100): Promise<SessionsPage> {
    const p = new URLSearchParams({ since_updated_at: sinceUpdatedAt, since_id: sinceId, limit: String(limit) });
    return request<SessionsPage>(`/api/sessions?${p.toString()}`);
  },
  insertSession(body: InsertSessionBody): Promise<{ session: SessionView }> {
    return request<{ session: SessionView }>('/api/sessions', { method: 'POST', body });
  },
  editSession(id: string, body: EditSessionBody): Promise<{ session: SessionView }> {
    return request<{ session: SessionView }>(`/api/sessions/${id}`, { method: 'PATCH', body });
  },
};

export { API_BASE };
