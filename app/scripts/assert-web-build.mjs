import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveApiBase } from '../config/api-environment.mjs';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const assetsDir = join(appRoot, 'dist', 'assets');
const localOrigins = ['http://10.0.2.2:', 'http://localhost:', 'http://127.0.0.1:'];
const expectedApiBase = resolveApiBase({
  mode: 'production',
  configured: process.env.VITE_API_BASE_URL,
});

async function scan(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await scan(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

let files;
try {
  files = await scan(assetsDir);
} catch {
  throw new Error('[release-check] dist/assets is missing; run the production Vite build first');
}

const findings = [];
let apiBaseFound = false;
for (const file of files) {
  const text = await readFile(file, 'utf8');
  if (text.includes(expectedApiBase)) apiBaseFound = true;
  for (const origin of localOrigins) {
    if (text.includes(origin)) findings.push(`${relative(appRoot, file)} contains ${origin}`);
  }
}

if (findings.length > 0) {
  throw new Error(`[release-check] local API origins found in production bundle:\n${findings.join('\n')}`);
}
if (!apiBaseFound) {
  throw new Error(`[release-check] configured API base was not found in the production bundle: ${expectedApiBase}`);
}
process.stdout.write('[release-check] production bundle has no local API origins\n');
