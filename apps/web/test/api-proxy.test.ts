import test from 'node:test';
import assert from 'node:assert/strict';
import {
  API_INTERNAL_URL_DEFAULT,
  API_PROXY_CONFIG_ERROR,
  API_PROXY_SOURCE,
  apiProxyRewrites,
  isBoundedHttpOrigin,
  resolveApiInternalOrigin,
} from '../src/lib/api-proxy.js';

/**
 * Pure contract tests for the Phase 6 single-origin API proxy (ADR-009):
 * the SERVER-ONLY `/api/:path*` rewrite target (`API_INTERNAL_URL`). No
 * next.config import (the config itself performs no side effects beyond this
 * resolution, but these tests pin the pure helper the config delegates to).
 */

test('default: absent/blank API_INTERNAL_URL falls back to the local dev API origin', () => {
  assert.equal(resolveApiInternalOrigin(undefined), 'http://localhost:3001');
  assert.equal(resolveApiInternalOrigin(''), API_INTERNAL_URL_DEFAULT);
  assert.equal(resolveApiInternalOrigin('   '), API_INTERNAL_URL_DEFAULT);
  assert.equal(API_INTERNAL_URL_DEFAULT, 'http://localhost:3001');
});

test('default is itself a bounded http(s) origin (never triggers the config error)', () => {
  assert.equal(isBoundedHttpOrigin(API_INTERNAL_URL_DEFAULT), true);
  assert.equal(resolveApiInternalOrigin(API_INTERNAL_URL_DEFAULT), API_INTERNAL_URL_DEFAULT);
});

test('valid set value: Railway-style private origin passes through, trailing slash stripped', () => {
  assert.equal(
    resolveApiInternalOrigin('http://api.railway.internal:3001'),
    'http://api.railway.internal:3001',
  );
  // A single trailing slash is the URL root — normalized away, never kept.
  assert.equal(resolveApiInternalOrigin('http://api.railway.internal:3001/'), 'http://api.railway.internal:3001');
  assert.equal(resolveApiInternalOrigin('https://api.example.com/'), 'https://api.example.com');
  // Surrounding whitespace is tolerated (trimmed before validation).
  assert.equal(
    resolveApiInternalOrigin('  https://api.example.com:8443  '),
    'https://api.example.com:8443',
  );
  // No-port http(s) origins are allowed (scheme defaults apply).
  assert.equal(isBoundedHttpOrigin('http://api.internal'), true);
  assert.equal(isBoundedHttpOrigin('https://api.internal'), true);
  // IPv6 literals keep their bracketed origin shape.
  assert.equal(resolveApiInternalOrigin('http://[::1]:3001'), 'http://[::1]:3001');
});

test('invalid set value: every non-bound-origin shape throws the FIXED safe error', () => {
  const invalid = [
    'http://api.internal/api', // real path
    'http://api.internal:3001/api/', // path under a trailing slash
    'https://api.internal/api?x=1',
    'http://api.internal/api#frag',
    'http://api.internal?x=1', // query on the origin
    'http://api.internal#frag', // hash on the origin
    'http://user:pass@api.internal', // userinfo
    'https://user@api.internal',
    'ftp://api.internal', // wrong scheme
    'file:///etc/passwd',
    'not-a-url', // garbage
    '//api.internal', // scheme-relative
    'https://', // empty host
    'https://api.internal:99999', // port out of range
    'https://api.internal/foo/', // path beyond the root (only the root '/' itself is allowed)
    'http://api.internal:3001//', // double slash = path beyond the root
    'http://api.internal:3001/anything',
  ];
  for (const candidate of invalid) {
    assert.throws(
      () => resolveApiInternalOrigin(candidate),
      (error: unknown) => error instanceof Error && error.message === API_PROXY_CONFIG_ERROR,
      `expected fixed config error for: ${candidate}`,
    );
  }
});

test('config error never echoes the invalid value (safe for build/Railway logs)', () => {
  const secrets = ['http://api.internal:3001?token=hunter2', 'http://u:p@api.internal', 'garbage-value'];
  for (const candidate of secrets) {
    try {
      resolveApiInternalOrigin(candidate);
      assert.fail(`expected throw for: ${candidate}`);
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.equal(error.message, API_PROXY_CONFIG_ERROR);
      assert.equal(error.message.includes(candidate), false);
    }
  }
});

test('apiProxyRewrites: source is exactly /api/:path* and the destination preserves it server-side', () => {
  const rewrites = apiProxyRewrites('http://api.railway.internal:3001/');
  assert.deepEqual(rewrites, [
    { source: '/api/:path*', destination: 'http://api.railway.internal:3001/api/:path*' },
  ]);
  assert.equal(API_PROXY_SOURCE, '/api/:path*');
  // Default env builds the same shape against the local fallback.
  assert.deepEqual(apiProxyRewrites(undefined), [
    { source: '/api/:path*', destination: 'http://localhost:3001/api/:path*' },
  ]);
  // Invalid env propagates the fixed error.
  assert.throws(
    () => apiProxyRewrites('http://api.internal/api'),
    /Invalid API_INTERNAL_URL: it must be an http\(s\) origin only/,
  );
});

test('proxy surface: destination keeps the API mount paths (auth + SSE) so Better Auth stays same-origin', () => {
  // The browser only ever talks to the web origin; /api/auth/* and the SSE
  // resume route pass through the SAME single rewrite source.
  const rewrites = apiProxyRewrites('https://api.railway.internal:3001');
  assert.equal(rewrites[0].destination.startsWith('https://api.railway.internal:3001/api/'), true);
  for (const mount of [
    '/api/auth/callback/google',
    '/api/auth/callback/github',
    '/api/auth/providers',
    '/api/agents/general/chat/chat-1/stream',
  ]) {
    // ':path*' must cover each production mount verbatim under /api/.
    const resolved = '/api/:path*'.replace(':path*', mount.slice('/api/'.length));
    assert.equal(resolved, mount, `rewrite source must cover ${mount}`);
  }
});
