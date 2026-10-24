# Lifelogs

Personal event tracking app with arbitrary key-value logging.

## Tech Stack

- **API**: Cloudflare Workers + Hono + D1 (SQLite)
- **Web**: SvelteKit (static adapter)
- **Charts**: Chart.js

## Project Structure

```
lifelogs/
├── api/                 # Cloudflare Worker API
│   ├── src/
│   │   ├── index.ts     # Hono app entry
│   │   ├── routes/      # API routes (auth, events, import)
│   │   ├── lib/         # Utilities (password hashing, types)
│   │   ├── middleware/  # Auth middleware
│   │   └── db/          # D1 schema
│   └── wrangler.toml    # Cloudflare config
│
├── web/                 # SvelteKit frontend
│   ├── src/
│   │   ├── routes/      # Pages (dashboard, log, charts, import)
│   │   └── lib/         # API client, auth store, chart utils
│   └── static/          # PWA manifest, service worker
│
└── package.json         # Monorepo root
```

## Development

```bash
# Install dependencies
cd api && npm install
cd ../web && npm install

# Run database migrations (local)
cd api && npm run db:migrate

# Start API (runs on :8787)
cd api && npm run dev

# Start web (runs on :5173, proxies /api to :8787)
cd web && npm run dev
```

## Deployment

```bash
# Create D1 database (first time only; already created for sleep.extra.us.ci)
cd api && wrangler d1 create lifelogs-sleep-db

# Update wrangler.toml with the database_id from above

# Run production migrations
cd api && npm run db:migrate:prod

# Deploy API
cd api && npm run deploy

# Build web for static hosting
cd web && npm run build
# Deploy build/ directory to Cloudflare Pages or other static host
```

## Environment Variables

API uses Cloudflare Workers environment bindings:
- `DB`: D1 database binding
- `APP_URL`: Production frontend URL (for CORS)

## Key Features

- Arbitrary event logging with string key-value pairs
- Quick-fill from recent event types
- Charts with auto-detected numeric fields
- CSV/JSON import
- PWA support
