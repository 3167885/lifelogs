import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveApiBase } from './api-environment.mjs';

test('development defaults to the local Worker', () => {
  assert.equal(
    resolveApiBase({ mode: 'development', configured: undefined }),
    'http://localhost:8787',
  );
});

test('android development defaults to the emulator host loopback', () => {
  assert.equal(
    resolveApiBase({ mode: 'android-dev', configured: undefined }),
    'http://10.0.2.2:8787',
  );
});

test('development accepts an explicit HTTPS URL', () => {
  assert.equal(
    resolveApiBase({ mode: 'development', configured: 'https://dev.example.test/' }),
    'https://dev.example.test',
  );
});

test('production accepts HTTPS and normalizes a trailing slash', () => {
  assert.equal(
    resolveApiBase({ mode: 'production', configured: 'https://api.example.test/' }),
    'https://api.example.test',
  );
});

test('production preserves a non-root path prefix', () => {
  assert.equal(
    resolveApiBase({ mode: 'production', configured: 'https://example.test/sleep/' }),
    'https://example.test/sleep',
  );
});

test('production requires an explicit URL', () => {
  assert.throws(
    () => resolveApiBase({ mode: 'production', configured: '' }),
    /VITE_API_BASE_URL is required/,
  );
});

test('production rejects the template placeholder', () => {
  assert.throws(
    () => resolveApiBase({
      mode: 'production',
      configured: 'https://api.example.invalid',
    }),
    /placeholder/,
  );
});

test('production rejects HTTP even for loopback hosts', () => {
  for (const url of ['http://localhost:8787', 'http://10.0.2.2:8787']) {
    assert.throws(
      () => resolveApiBase({ mode: 'production', configured: url }),
      /must use HTTPS/,
    );
  }
});

test('credentials, queries, and fragments are rejected', () => {
  for (const url of [
    'https://user:secret@example.test',
    'https://example.test/?token=secret',
    'https://example.test/#fragment',
  ]) {
    assert.throws(() => resolveApiBase({ mode: 'production', configured: url }));
  }
});
