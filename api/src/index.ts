import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { authMiddleware } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import eventsRoutes from './routes/events.js';
import sleepEventsRoutes from './routes/sleep-events.js';
import sleepSessionsRoutes from './routes/sleep-sessions.js';
import schemasRoutes from './routes/schemas.js';
import importRoutes from './routes/import.js';
import type { Env, Variables } from './lib/types.js';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Global middleware
app.use('*', logger());
app.use('*', async (c, next) => {
  // Explicit origin allowlist (no "*"): legacy SvelteKit dev/preview origins
  // keep Cookie CORS working; https://localhost is the default Capacitor
  // Android WebView origin. APP_URL covers the deployed web frontend.
  const origins = ['http://localhost:5173', 'http://localhost:4173', 'https://localhost'];
  if (c.env.APP_URL) {
    origins.push(c.env.APP_URL);
  }
  return cors({
    origin: origins,
    credentials: true,
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  })(c, next);
});
app.use('*', authMiddleware);

// Health check
app.get('/health', (c) => c.json({ status: 'ok' }));

// Routes
app.route('/api/auth', authRoutes);
// Sleep API occupies the literal contract paths (阶段 1). It must be mounted
// before the legacy generic events router: Hono matches in registration
// order, and legacy GET /api/events/:id would otherwise capture
// GET /api/events/pending.
app.route('/api/events', sleepEventsRoutes);
app.route('/api/sessions', sleepSessionsRoutes);
// Legacy generic event API is preserved under /api/records (same handlers,
// unchanged file). No current client depends on the old /api/events path.
app.route('/api/records', eventsRoutes);
app.route('/api/schemas', schemasRoutes);
app.route('/api/import', importRoutes);

// 404 handler
app.notFound((c) => c.json({ error: 'Not found' }, 404));

// Error handler
app.onError((err, c) => {
  console.error('Error:', err);
  return c.json(
    { error: err.message || 'Internal server error' },
    500
  );
});

export default app;
