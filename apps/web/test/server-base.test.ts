import test from 'node:test';
import assert from 'node:assert/strict';
import {
  API_PROXY_CONFIG_ERROR,
  resolveServerApiBaseUrl,
} from '../src/lib/api-proxy.js';

const WEB_ORIGIN = 'http://localhost:3200';

test('server base resolution: runtime internal origin wins and normalizes', () => {
  assert.equal(
    resolveServerApiBaseUrl({
      runtimeInternalUrl: 'http://api:3001',
      publicApiUrl: 'http://localhost:3001',
      isServer: true,
    }),
    'http://api:3001',
  );
  // Trailing slash never survives (URL.origin normalization).
  assert.equal(
    resolveServerApiBaseUrl({
      runtimeInternalUrl: 'http://api:3001/',
      publicApiUrl: WEB_ORIGIN,
      isServer: true,
    }),
    'http://api:3001',
  );
  // A custom internal host/port is honored verbatim.
  assert.equal(
    resolveServerApiBaseUrl({
      runtimeInternalUrl: 'https://api.internal.example:8443',
      publicApiUrl: WEB_ORIGIN,
      isServer: true,
    }),
    'https://api.internal.example:8443',
  );
});

test('server base resolution: absent/blank falls back to the public base', () => {
  assert.equal(
    resolveServerApiBaseUrl({ runtimeInternalUrl: undefined, publicApiUrl: 'http://localhost:3001', isServer: true }),
    'http://localhost:3001',
  );
  assert.equal(
    resolveServerApiBaseUrl({ runtimeInternalUrl: '   ', publicApiUrl: 'http://localhost:3001', isServer: true }),
    'http://localhost:3001',
  );
  // No env at all → dev default.
  assert.equal(
    resolveServerApiBaseUrl({
      runtimeInternalUrl: undefined,
      publicApiUrl: undefined,
      isServer: true,
    }),
    'http://localhost:3001',
  );
});

test('server base resolution: custom PUBLIC fallback is preserved, never localhost3001', () => {
  assert.equal(
    resolveServerApiBaseUrl({
      runtimeInternalUrl: undefined,
      publicApiUrl: 'https://api.example.com',
      isServer: true,
    }),
    'https://api.example.com',
  );
  // The public WEB origin (3200 in the Compose gate) is used as-is for the
  // public base; it is never rewritten to localhost3001.
  assert.equal(
    resolveServerApiBaseUrl({
      runtimeInternalUrl: undefined,
      publicApiUrl: WEB_ORIGIN,
      isServer: true,
    }),
    WEB_ORIGIN,
  );
});

test('server base resolution: invalid internal origin fails with the fixed safe error', () => {
  // The invalid VALUE is never echoed in the thrown error.
  for (const bad of [
    'not-a-url',
    'ftp://api:3001',
    'http://api:3001/with/path',
    'http://api:3001?q=1',
    'http://user:pass@api:3001',
    'http://localhost:3001/#secret',
  ]) {
    assert.throws(
      () =>
        resolveServerApiBaseUrl({
          runtimeInternalUrl: bad,
          publicApiUrl: 'http://localhost:3001',
          isServer: true,
        }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : '';
        return message === API_PROXY_CONFIG_ERROR && !message.includes(bad);
      },
      bad,
    );
  }
});

test('server base resolution: browser context is a hard guard', () => {
  assert.throws(
    () =>
      resolveServerApiBaseUrl({
        runtimeInternalUrl: 'http://api:3001',
        publicApiUrl: 'http://localhost:3001',
        isServer: false,
      }),
  );
});
