import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.CAPACITOR_DEV_HTTP === '1') {
  throw new Error('[release-check] CAPACITOR_DEV_HTTP=1 is development-only and cannot be used for a release');
}

if (process.argv.includes('--before-sync')) {
  process.stdout.write('[release-check] development HTTP bridge is disabled\n');
  process.exit(0);
}

const androidRoot = fileURLToPath(new URL('../android', import.meta.url));
const configPath = join(androidRoot, 'app', 'src', 'main', 'assets', 'capacitor.config.json');
if (!existsSync(configPath)) {
  throw new Error('[release-check] missing Android capacitor config; run `npx cap sync android` first');
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const server = config.server ?? {};
const android = config.android ?? {};
if (config.loggingBehavior !== 'none') {
  throw new Error('[release-check] Capacitor logging must be disabled');
}
if (server.cleartext === true || android.allowMixedContent === true) {
  throw new Error('[release-check] release Android config permits cleartext or mixed content');
}
process.stdout.write('[release-check] Android release config blocks cleartext and mixed content\n');
