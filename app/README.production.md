# Sleep APK production configuration

## API URL

`VITE_API_BASE_URL` is the single API origin compiled into the APK. It must
match the Worker's CORS origin exactly.

```bash
cd app
cp .env.production.example .env.production
# Replace the placeholder with the deployed HTTPS URL.
npm run cap:sync:production
npm run apk:release
```

Production builds fail when the URL is missing, uses HTTP, contains a
query/fragment/credentials, or still equals the example placeholder. Local
browser development defaults to `http://localhost:8787`; Android emulator
development uses `http://10.0.2.2:8787`.

## Local Android development

The HTTP bridge and mixed-content override are opt-in:

```bash
cd app
CAPACITOR_DEV_HTTP=1 npm run cap:sync:dev
CAPACITOR_DEV_HTTP=1 npm run apk:debug
```

Release builds reject `CAPACITOR_DEV_HTTP=1`, and their synced Capacitor
config must have `cleartext` and `allowMixedContent` disabled.

## Release signing

Create `android/keystore.properties` from `android/keystore.properties.example`
and keep the keystore outside the repository. `assembleRelease` fails before
R8 starts when this file is absent; it never falls back to the debug key.

## Local data

The SQLite file is the source of truth for records and the outbox. Android
automatic backup and device transfer are disabled so a reinstall or restore
cannot revive stale sync state. Logout retains local data and the pending
outbox; switching to another account requires the pending queue to be empty.

## Verification

```bash
cd app
npm run typecheck
npm run test:api-config
VITE_API_BASE_URL=https://api.example.test npm run build:production
```

The production bundle check rejects local API origins and requires the
configured HTTPS URL to be present. A real release still requires the actual
cloud URL and signing key. Real-device login, CORS, offline sync, and token
log inspection remain pending until the cloud deployment is available.
