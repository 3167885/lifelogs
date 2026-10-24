const PRODUCTION_PLACEHOLDER = 'https://api.example.invalid';

function fail(message) {
  throw new Error(`[api-config] ${message}`);
}

/**
 * Only an origin (plus optional non-root path prefix) is accepted. Rejecting
 * credentials, query strings, fragments, and trailing slashes prevents secrets
 * or accidental environment text from being embedded in the APK.
 */
function validateApiBase(raw, label, { allowLocalHttp }) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`${label} must be an absolute URL`);
  }

  const localHosts = new Set(['localhost', '127.0.0.1', '10.0.2.2', '[::1]']);
  const isLocalHttp = parsed.protocol === 'http:' && localHosts.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(allowLocalHttp && isLocalHttp)) {
    fail(`${label} must use HTTPS${allowLocalHttp ? ' (HTTP is allowed only for local development)' : ''}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    fail(`${label} must not contain credentials`);
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    fail(`${label} must not contain a query string or fragment`);
  }

  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${path === '/' ? '' : path}`;
}

export function resolveApiBase({ mode, configured }) {
  const isProduction = mode === 'production';
  const label = 'VITE_API_BASE_URL';
  const value = configured?.trim() ?? '';

  if (isProduction) {
    if (value === '') fail(`${label} is required for production builds`);
    if (value === PRODUCTION_PLACEHOLDER) fail(`${label} still contains the placeholder URL`);
    return validateApiBase(value, label, { allowLocalHttp: false });
  }

  const localDefault = mode === 'android-dev' ? 'http://10.0.2.2:8787' : 'http://localhost:8787';
  return validateApiBase(value === '' ? localDefault : value, label, { allowLocalHttp: true });
}
