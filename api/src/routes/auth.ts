import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { setCookie, deleteCookie } from 'hono/cookie';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { SESSION_COOKIE_NAME, requireAuth } from '../middleware/auth.js';
import type { Env, User, Variables } from '../lib/types.js';

const auth = new Hono<{ Bindings: Env; Variables: Variables }>();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Register
auth.post('/register', zValidator('json', registerSchema), async (c) => {
  const { email, password } = c.req.valid('json');

  // Check if user exists
  const existingUser = await c.env.DB.prepare(
    'SELECT id FROM auth_users WHERE email = ?'
  )
    .bind(email.toLowerCase())
    .first();

  if (existingUser) {
    return c.json({ error: 'Email already registered' }, 400);
  }

  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  const now = Date.now();

  await c.env.DB.prepare(
    'INSERT INTO auth_users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)'
  )
    .bind(userId, email.toLowerCase(), passwordHash, now)
    .run();

  // Create session
  const sessionId = crypto.randomUUID();
  const expiresAt = now + SESSION_DURATION_MS;

  await c.env.DB.prepare(
    'INSERT INTO auth_sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
  )
    .bind(sessionId, userId, expiresAt, now)
    .run();

  setCookie(c, SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DURATION_MS / 1000,
  });

  // TODO: Send verification email via Resend

  return c.json({
    user: {
      id: userId,
      email: email.toLowerCase(),
      email_verified: 0,
    },
  });
});

// Login
auth.post('/login', zValidator('json', loginSchema), async (c) => {
  const { email, password } = c.req.valid('json');

  const user = await c.env.DB.prepare(
    'SELECT * FROM auth_users WHERE email = ?'
  )
    .bind(email.toLowerCase())
    .first<User & { password_hash: string }>();

  if (!user) {
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  // Create session
  const sessionId = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + SESSION_DURATION_MS;

  await c.env.DB.prepare(
    'INSERT INTO auth_sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
  )
    .bind(sessionId, user.id, expiresAt, now)
    .run();

  setCookie(c, SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DURATION_MS / 1000,
  });

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      email_verified: user.email_verified,
    },
  });
});

// Logout
auth.post('/logout', async (c) => {
  const session = c.get('session');

  if (session) {
    await c.env.DB.prepare('DELETE FROM auth_sessions WHERE id = ?')
      .bind(session.id)
      .run();
  }

  deleteCookie(c, SESSION_COOKIE_NAME, {
    path: '/',
  });

  return c.json({ success: true });
});

// APK token login (阶段 1): verify credentials with the same PBKDF2 logic and
// create a normal auth_sessions row, but return the session id as a Bearer
// token instead of setting a cookie. All subsequent requests validate the
// token through the shared authMiddleware session lookup.
auth.post('/token', zValidator('json', loginSchema), async (c) => {
  const { email, password } = c.req.valid('json');

  const user = await c.env.DB.prepare(
    'SELECT * FROM auth_users WHERE email = ?'
  )
    .bind(email.toLowerCase())
    .first<User & { password_hash: string }>();

  if (!user) {
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  const sessionId = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + SESSION_DURATION_MS;

  await c.env.DB.prepare(
    'INSERT INTO auth_sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
  )
    .bind(sessionId, user.id, expiresAt, now)
    .run();

  // No logging of token or password anywhere in this handler.
  return c.json({
    token: sessionId,
    token_type: 'Bearer',
    expires_at: new Date(expiresAt).toISOString(),
    user: {
      id: user.id,
      email: user.email,
      email_verified: user.email_verified,
    },
  });
});

// Revoke the caller's own server-side session (APK logout).
auth.delete('/token', requireAuth, async (c) => {
  const session = c.get('session');

  if (session) {
    await c.env.DB.prepare('DELETE FROM auth_sessions WHERE id = ?')
      .bind(session.id)
      .run();
  }

  return c.json({ success: true });
});

// Get current user
auth.get('/me', requireAuth, async (c) => {
  const user = c.get('user')!;

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      email_verified: user.email_verified,
    },
  });
});

// Request password reset
auth.post(
  '/forgot-password',
  zValidator('json', z.object({ email: z.string().email() })),
  async (c) => {
    const { email } = c.req.valid('json');

    const user = await c.env.DB.prepare(
      'SELECT id FROM auth_users WHERE email = ?'
    )
      .bind(email.toLowerCase())
      .first<{ id: string }>();

    // Always return success to prevent email enumeration
    if (!user) {
      return c.json({ success: true });
    }

    // Delete existing tokens
    await c.env.DB.prepare(
      "DELETE FROM auth_verification_tokens WHERE user_id = ? AND type = 'password_reset'"
    )
      .bind(user.id)
      .run();

    // Create reset token
    const tokenId = crypto.randomUUID();
    const token = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + 60 * 60 * 1000; // 1 hour

    await c.env.DB.prepare(
      'INSERT INTO auth_verification_tokens (id, user_id, token, type, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(tokenId, user.id, token, 'password_reset', expiresAt, now)
      .run();

    // TODO: Send password reset email via Resend

    return c.json({ success: true });
  }
);

// Reset password with token
auth.post(
  '/reset-password',
  zValidator(
    'json',
    z.object({
      token: z.string(),
      password: z.string().min(8),
    })
  ),
  async (c) => {
    const { token, password } = c.req.valid('json');

    const tokenRecord = await c.env.DB.prepare(
      "SELECT * FROM auth_verification_tokens WHERE token = ? AND type = 'password_reset' AND expires_at > ?"
    )
      .bind(token, Date.now())
      .first<{ id: string; user_id: string }>();

    if (!tokenRecord) {
      return c.json({ error: 'Invalid or expired token' }, 400);
    }

    const passwordHash = await hashPassword(password);
    const now = Date.now();

    // Update password
    await c.env.DB.prepare(
      'UPDATE auth_users SET password_hash = ?, updated_at = ? WHERE id = ?'
    )
      .bind(passwordHash, now, tokenRecord.user_id)
      .run();

    // Delete all sessions for this user
    await c.env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?')
      .bind(tokenRecord.user_id)
      .run();

    // Delete the token
    await c.env.DB.prepare('DELETE FROM auth_verification_tokens WHERE id = ?')
      .bind(tokenRecord.id)
      .run();

    return c.json({ success: true });
  }
);

export default auth;
