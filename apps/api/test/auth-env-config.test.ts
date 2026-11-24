/**
 * Offline tests for the safe auth environment parsing (pre-Phase 6): the
 * required secret / baseURL, the optional COMPLETE Google/GitHub pairs with
 * safe availability metadata, and the optional email allowlist. The
 * security contract asserted everywhere: error text names variables only
 * and never echoes any value. Pure node:test — no env mutation, no network.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AUTH_ENV_KEYS,
  parseAuthEmailAllowlist,
  parseAuthEnvironment,
  parseAuthProviderEnv,
} from '../src/auth/env-config.js';

/** Fixed fake credentials for tests ONLY (never real values). */
const FAKE_ENV = {
  BETTER_AUTH_SECRET: 'test-secret-not-real-0123456789abcdef',
  BETTER_AUTH_URL: 'http://127.0.0.1:3001',
  GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.test',
  GOOGLE_CLIENT_SECRET: 'test-google-secret',
  GITHUB_CLIENT_ID: 'test-github-client-id',
  GITHUB_CLIENT_SECRET: 'test-github-secret',
};

test('AUTH_ENV_KEYS names exactly the variables this module reads', () => {
  assert.deepEqual([...AUTH_ENV_KEYS].sort(), [
    'AUTH_EMAIL_ALLOWLIST',
    'BETTER_AUTH_SECRET',
    'BETTER_AUTH_URL',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
  ]);
});

test('parseAuthEnvironment accepts the full variable set with both complete pairs', () => {
  const parsed = parseAuthEnvironment(FAKE_ENV);
  assert.equal(parsed.secret, FAKE_ENV.BETTER_AUTH_SECRET);
  assert.equal(parsed.baseURL, 'http://127.0.0.1:3001');
  assert.deepEqual(parsed.google, { clientId: FAKE_ENV.GOOGLE_CLIENT_ID, clientSecret: FAKE_ENV.GOOGLE_CLIENT_SECRET });
  assert.deepEqual(parsed.github, { clientId: FAKE_ENV.GITHUB_CLIENT_ID, clientSecret: FAKE_ENV.GITHUB_CLIENT_SECRET });
  assert.equal(parsed.providerAvailability.google.available, true);
  assert.equal(parsed.providerAvailability.github.available, true);
  assert.equal(parsed.emailAllowlist, null);
});

test('parseAuthEnvironment tolerates blank values exactly as absent', () => {
  assert.throws(() => parseAuthEnvironment({ BETTER_AUTH_SECRET: '   ', BETTER_AUTH_URL: '' }), /BETTER_AUTH_SECRET is required/);
  const complete = parseAuthEnvironment({
    BETTER_AUTH_SECRET: FAKE_ENV.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: FAKE_ENV.BETTER_AUTH_URL,
  });
  assert.equal(complete.google, null);
  assert.equal(complete.github, null);
  assert.equal(complete.providerAvailability.google.available, false);
  assert.equal(complete.providerAvailability.google.issue, null, 'no issue when a provider is simply not configured');
});

test('parseAuthEnvironment requires the secret and the baseURL, naming only the variables', () => {
  try {
    parseAuthEnvironment({});
    assert.fail('expected parseAuthEnvironment({}) to throw');
  } catch (error) {
    const message = (error as Error).message;
    assert.match(message, /Invalid auth configuration \(values are never included\)/);
    assert.match(message, /BETTER_AUTH_SECRET is required/);
    assert.match(message, /BETTER_AUTH_URL is required/);
    // Secrets never appear in error text even when the variable was set.
    assert.ok(!message.includes(FAKE_ENV.BETTER_AUTH_SECRET));
  }
});

test('parseAuthEnvironment rejects an incomplete Google pair and reports the missing variable name', () => {
  try {
    parseAuthEnvironment({
      ...FAKE_ENV,
      GOOGLE_CLIENT_SECRET: undefined,
    } as NodeJS.ProcessEnv);
    assert.fail('expected an incomplete pair to be rejected');
  } catch (error) {
    const message = (error as Error).message;
    assert.match(message, /GOOGLE_CLIENT_SECRET is missing/);
    assert.ok(!message.includes(FAKE_ENV.GOOGLE_CLIENT_SECRET));
    assert.ok(!message.includes(FAKE_ENV.GOOGLE_CLIENT_ID));
  }
});

test('parseAuthEnvironment rejects an invalid baseURL and an under-length secret without echoing values', () => {
  assert.throws(
    () => parseAuthEnvironment({ ...FAKE_ENV, BETTER_AUTH_URL: 'https://example.com/api' }),
    /BETTER_AUTH_URL must be an http\(s\) origin without a path/,
  );
  assert.throws(
    () => parseAuthEnvironment({ ...FAKE_ENV, BETTER_AUTH_SECRET: 'short' }),
    /BETTER_AUTH_SECRET must be at least 16 characters/,
  );
});

test('parseAuthProviderEnv reports safe availability metadata without throwing', () => {
  const complete = parseAuthProviderEnv(FAKE_ENV);
  assert.equal(complete.issues.length, 0);
  assert.equal(complete.availability.google.available, true);
  assert.equal(complete.availability.github.available, true);
  assert.deepEqual(complete.availability, {
    google: { available: true, issue: null },
    github: { available: true, issue: null },
  });

  const empty = parseAuthProviderEnv({});
  assert.equal(empty.google, null);
  assert.equal(empty.github, null);
  assert.deepEqual(empty.availability, {
    google: { available: false, issue: null },
    github: { available: false, issue: null },
  });

  const incomplete = parseAuthProviderEnv({ GITHUB_CLIENT_ID: 'test-github-client-id' });
  assert.deepEqual(incomplete.availability.github, {
    available: false,
    issue: 'GITHUB_CLIENT_ID is set but GITHUB_CLIENT_SECRET is missing: the provider must be configured as a COMPLETE pair',
  });
  assert.deepEqual(incomplete.availability.google, { available: false, issue: null });
  assert.equal(incomplete.google, null);
  // The stray id is reported by name, never echoed as a value.
  assert.deepEqual(incomplete.issues, [
    'GITHUB_CLIENT_ID is set but GITHUB_CLIENT_SECRET is missing: the provider must be configured as a COMPLETE pair',
  ]);
});

test('parseAuthProviderEnv never echoes credential values in any issue text', () => {
  const broken = parseAuthProviderEnv({
    GOOGLE_CLIENT_ID: 'super-secret-client-id-value',
    GITHUB_CLIENT_SECRET: 'super-secret-github-secret-value',
  });
  for (const issue of broken.issues) {
    assert.ok(!issue.includes('super-secret-client-id-value'));
    assert.ok(!issue.includes('super-secret-github-secret-value'));
  }
  assert.equal(broken.google, null);
});

test('parseAuthEmailAllowlist normalizes, orders, de-duplicates, and bounds entries', () => {
  assert.equal(parseAuthEmailAllowlist({}), null);
  assert.equal(parseAuthEmailAllowlist({ AUTH_EMAIL_ALLOWLIST: '   ' }), null);
  assert.deepEqual(parseAuthEmailAllowlist({ AUTH_EMAIL_ALLOWLIST: 'a@example.com' }), ['a@example.com']);
  assert.deepEqual(
    parseAuthEmailAllowlist({ AUTH_EMAIL_ALLOWLIST: ' B@Example.com ,b@example.com,,c@x.io ' }),
    ['b@example.com', 'c@x.io'],
  );
});

test('parseAuthEmailAllowlist rejects malformed entries without echoing them', () => {
  assert.throws(
    () => parseAuthEmailAllowlist({ AUTH_EMAIL_ALLOWLIST: 'not-an-email' }),
    /AUTH_EMAIL_ALLOWLIST entry 1 must be an email address/,
  );
  assert.throws(
    () => parseAuthEmailAllowlist({ AUTH_EMAIL_ALLOWLIST: 'ok@example.com, spaced entry@example.com' }),
    /AUTH_EMAIL_ALLOWLIST entry 2 must be an email address/,
  );
});

test('parseAuthEnvironment parses the optional allowlist into the result', () => {
  const parsed = parseAuthEnvironment({
    ...FAKE_ENV,
    AUTH_EMAIL_ALLOWLIST: 'Farhan@Example.com, farhan@example.com',
  });
  assert.deepEqual(parsed.emailAllowlist, ['farhan@example.com']);
});
