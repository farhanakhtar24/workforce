import test from 'node:test';
import assert from 'node:assert/strict';
import {
  API_FETCH_CREDENTIALS,
  AUTH_DENIED_ERROR,
  AUTH_PROVIDERS_ERROR,
  SESSION_EXPIRED_ERROR,
  absoluteWebCallback,
  authErrorForStatus,
  authProvidersEndpoint,
  mapAuthProviders,
  requestAuthError,
  safeLocalCallback,
} from '../src/lib/api.js';

test('safeLocalCallback: keeps same-origin local routes only', () => {
  assert.equal(safeLocalCallback(undefined), '/');
  assert.equal(safeLocalCallback(null), '/');
  assert.equal(safeLocalCallback(''), '/');
  assert.equal(safeLocalCallback('   '), '/');
  assert.equal(safeLocalCallback('memory'), '/');
  assert.equal(safeLocalCallback('http://evil.example/cb'), '/');
  assert.equal(safeLocalCallback('https://workforce.local/x'), '/');
  // Scheme-relative + backslash tricks are refused.
  assert.equal(safeLocalCallback('//evil.example/x'), '/');
  assert.equal(safeLocalCallback('/\\evil.example/x'), '/');
  // Local routes pass through (query strings included; no encoding here —
  // encoding happens when placed into `?next=`).
  assert.equal(safeLocalCallback('/agents/orchestrator/chat/abc'), '/agents/orchestrator/chat/abc');
  assert.equal(safeLocalCallback('/work?chatId=abc&agent=x'), '/work?chatId=abc&agent=x');
  assert.equal(safeLocalCallback(' /custom-return '), '/custom-return');
  assert.equal(safeLocalCallback('anything', '/memory'), '/memory');
});

test('authErrorForStatus: 401 → session-expired copy, 403 → denied copy, others null', () => {
  // Browser context: 401 must call the redirect helper (jsdom-free guard
  // makes window a no-op here — the mapping itself is what we assert).
  const expired = authErrorForStatus(401, '/memory');
  assert.equal(expired, SESSION_EXPIRED_ERROR);
  const denied = authErrorForStatus(403, '/');
  assert.equal(denied, AUTH_DENIED_ERROR);
  assert.equal(authErrorForStatus(400, '/'), null);
  assert.equal(authErrorForStatus(404, '/'), null);
  assert.equal(authErrorForStatus(500, '/'), null);
  assert.equal(authErrorForStatus(503, '/'), null);
});

test('the two fixed errors differ and never leak internals', () => {
  assert.notEqual(SESSION_EXPIRED_ERROR, AUTH_DENIED_ERROR);
  assert.ok(SESSION_EXPIRED_ERROR.length > 0);
  assert.ok(AUTH_DENIED_ERROR.length > 0);
  assert.ok(!/cookie|header|stack|user id|session id/i.test(SESSION_EXPIRED_ERROR));
  assert.ok(!/cookie|header|stack|user id|session id/i.test(AUTH_DENIED_ERROR));
});

test('requestAuthError (non-browser) maps 401/403 without throwing', () => {
  assert.equal(requestAuthError(401), SESSION_EXPIRED_ERROR);
  assert.equal(requestAuthError(403), AUTH_DENIED_ERROR);
  assert.equal(requestAuthError(429), null);
});

test('authProvidersEndpoint points at the public auth mount regardless of trailing slash', () => {
  assert.equal(authProvidersEndpoint('http://localhost:3001'), 'http://localhost:3001/api/auth/providers');
  assert.equal(authProvidersEndpoint('http://localhost:3001/'), 'http://localhost:3001/api/auth/providers');
});

test('mapAuthProviders: strict booleans; malformed shapes map to the fixed error', () => {
  assert.deepEqual(mapAuthProviders({ google: true, github: false }), {
    ok: true,
    google: true,
    github: false,
  });
  assert.deepEqual(mapAuthProviders({ google: false, github: true }), {
    ok: true,
    google: false,
    github: true,
  });
  for (const payload of [
    null,
    'x',
    7,
    {},
    { google: 'yes', github: true },
    { google: true, github: 1 },
  ]) {
    const result = mapAuthProviders(payload);
    assert.deepEqual(result, { ok: false, error: AUTH_PROVIDERS_ERROR }, JSON.stringify(payload));
  }
  // Extra unknown fields with the two required booleans stay acceptable —
  // server shape evolution must not break the mapping.
  assert.deepEqual(mapAuthProviders({ google: true, github: false, extra: 'x' }), {
    ok: true,
    google: true,
    github: false,
  });
});

test('the credentials contract is explicit and literal', () => {
  assert.equal(API_FETCH_CREDENTIALS, 'include');
});

test('absoluteWebCallback: local next becomes absolute at the supplied web origin', () => {
  assert.equal(
    absoluteWebCallback('http://localhost:3000', '/agents/general/chat/abc'),
    'http://localhost:3000/agents/general/chat/abc',
  );
  // Query preserved, origin + port (3000) preserved.
  assert.equal(
    absoluteWebCallback('http://localhost:3000', '/agents/general/chat/abc?mode=plan'),
    'http://localhost:3000/agents/general/chat/abc?mode=plan',
  );
  assert.equal(absoluteWebCallback('http://localhost:3000/', '/a/b'), 'http://localhost:3000/a/b');
});

test('absoluteWebCallback: empty/relative next falls back to the web-origin root', () => {
  assert.equal(absoluteWebCallback('http://localhost:3000', ''), 'http://localhost:3000/');
  assert.equal(absoluteWebCallback('http://localhost:3000', undefined), 'http://localhost:3000/');
  assert.equal(absoluteWebCallback('http://localhost:3000', 'memory'), 'http://localhost:3000/');
});

test('absoluteWebCallback: hostile next values never target API3001 or an evil origin', () => {
  // Absolute hostile next collapses to the safe web-origin root.
  assert.equal(absoluteWebCallback('http://localhost:3000', 'http://localhost:3001/hijack'), 'http://localhost:3000/');
  assert.equal(absoluteWebCallback('http://localhost:3000', 'https://evil.example/x'), 'http://localhost:3000/');
  // Scheme-relative + backslash tricks never change the origin.
  assert.equal(absoluteWebCallback('http://localhost:3000', '//evil.example/x'), 'http://localhost:3000/');
  assert.equal(absoluteWebCallback('http://localhost:3000', '/\\evil.example/x'), 'http://localhost:3000/');
  // With evil ORIGIN supplied, output origin equals the supplied origin (callers
  // pass the real window origin); the route still can never smuggle a host in.
  const evilOrigin = absoluteWebCallback('https://evil.example', '/path');
  assert.equal(evilOrigin, 'https://evil.example/path');
});

test('absoluteWebCallback: non-http(s)/malformed origins degrade to the relative route', () => {
  assert.equal(absoluteWebCallback(undefined, '/x'), '/x');
  assert.equal(absoluteWebCallback(null, '/x'), '/x');
  assert.equal(absoluteWebCallback('not a url', '/x'), '/x');
  assert.equal(absoluteWebCallback('ftp://host', '/x'), '/x');
  // Missing route + unusable origin: still a safe relative root.
  assert.equal(absoluteWebCallback(undefined, undefined), '/');
});

test('absoluteWebCallback: output can never carry a second origin in the route', () => {
  const out = absoluteWebCallback('http://localhost:3000', '/next?to=https://evil.example');
  assert.ok(out.startsWith('http://localhost:3000'));
  assert.ok(!out.startsWith('http://localhost:3001'));
  assert.ok(!out.includes('https://evil.example?'));
});
