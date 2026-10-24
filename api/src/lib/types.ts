export interface Env {
  DB: D1Database;
  ENVIRONMENT: string;
  RESEND_API_KEY?: string;
  APP_URL?: string;
}

export interface User {
  id: string;
  email: string;
  email_verified: number;
  created_at: number;
  updated_at?: number;
}

export interface Session {
  id: string;
  user_id: string;
  expires_at: number;
  created_at: number;
}

export interface EventSchema {
  id: string;
  user_id: string;
  name: string;
  label: string;
  fields: string; // JSON string of FieldDefinition[]
  icon?: string;
  color?: string;
  default_tags?: string; // JSON array
  created_at: number;
}

export interface FieldDefinition {
  name: string;
  label: string;
  type: 'string' | 'number' | 'decimal' | 'boolean' | 'date' | 'datetime';
  required?: boolean;
  primary?: boolean;
  unit?: string;
}

export interface Event {
  id: string;
  user_id: string;
  timestamp: number;
  event_type: string;
  data?: string; // JSON object
  tags?: string; // JSON array
  source: string;
  created_at: number;
}

export interface VerificationToken {
  id: string;
  user_id: string;
  token: string;
  type: 'email_verification' | 'password_reset';
  expires_at: number;
  created_at: number;
}

// Extended Hono context with user
export type Variables = {
  user?: User;
  session?: Session;
};

// ---- Sleep tracking (阶段 1) ----
// All timestamps are normalized UTC ISO 8601: YYYY-MM-DDTHH:mm:ss.sssZ

export interface SleepEvent {
  id: string;
  user_id: string;
  client_event_id: string;
  event_type: 'sleep' | 'wake';
  occurred_at: string;
  session_id: string | null;
  created_at: string;
}

export interface SleepSession {
  id: string;
  user_id: string;
  sleep_event_id: string | null;
  wake_event_id: string | null;
  start_at: string;
  end_at: string;
  duration_minutes: number;
  quality: number | null;
  version: number;
  created_at: string;
  updated_at: string;
  last_op_id: string | null;
}

export interface SyncOp {
  user_id: string;
  client_op_id: string;
  op_type: string;
  result_json: string | null;
  created_at: string;
}
