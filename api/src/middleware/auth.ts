import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env, User, Session, Variables } from '../lib/types.js';

const SESSION_COOKIE_NAME = 'lifelogs_session';

/**
 * Extract the bearer token from the Authorization header, if present.
 * Used by the APK (阶段 1): the token is an existing auth_sessions row id
 * created via POST /api/auth/token. Sessions are validated with exactly the
 * same query as cookie sessions; nothing bypasses the session check.
 */
function extractBearer(header: string | null | undefined): string | null {
  if (!header) {
    return null;
  }
  const match = /^Bearer (.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

export async function authMiddleware(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  next: Next
) {
  const sessionId =
    getCookie(c, SESSION_COOKIE_NAME) ??
    extractBearer(c.req.header('authorization'));

  if (sessionId) {
    const session = await c.env.DB.prepare(
      'SELECT * FROM auth_sessions WHERE id = ? AND expires_at > ?'
    )
      .bind(sessionId, Date.now())
      .first<Session>();

    if (session) {
      const user = await c.env.DB.prepare(
        'SELECT id, email, email_verified, created_at, updated_at FROM auth_users WHERE id = ?'
      )
      .bind(session.user_id)
        .first<User>();

      if (user) {
        c.set('user', user);
        c.set('session', session);
      }
    }
  }

  await next();
}

export async function requireAuth(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  next: Next
) {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
}

export { SESSION_COOKIE_NAME, extractBearer };
