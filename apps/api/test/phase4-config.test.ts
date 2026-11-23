/**
 * Phase 4 configuration tests: new env keys, defaults, bounds, and the
 * "safe errors only" rule (no values echoed in failures).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApiConfig } from '../src/config.js';

const BASE_ENV = {
  OLLAMA_API_KEY: 'test-key-not-real',
  OLLAMA_BASE_URL: 'https://ollama.invalid/v1',
  OLLAMA_MODEL: 'glm-5.3-flash',
  REDIS_URL: 'redis://127.0.0.1:6379',
  PORT: '3001',
  WEB_ORIGIN: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://workforce:workforce@127.0.0.1:55432/workforce',
} as NodeJS.ProcessEnv;

test('phase 4 defaults: loopback base from PORT, 120000ms delegation budget, 2000ms/200 query guards', () => {
  const config = loadApiConfig(BASE_ENV);
  assert.equal(config.internalApiBaseUrl, 'http://127.0.0.1:3001');
  assert.equal(config.delegationTimeoutMs, 120_000);
  assert.equal(config.queryStatementTimeoutMs, 2_000);
  assert.equal(config.queryRowCap, 200);
  assert.equal(config.delegationContextSecret, null);
});

test('PORT change re-bases the default internal API URL', () => {
  const config = loadApiConfig({ ...BASE_ENV, PORT: '4567' });
  assert.equal(config.internalApiBaseUrl, 'http://127.0.0.1:4567');
});

test('INTERNAL_API_BASE_URL override wins; malformed origins (paths/slashes) rejected', () => {
  const config = loadApiConfig({ ...BASE_ENV, INTERNAL_API_BASE_URL: 'http://api.internal:9999' });
  assert.equal(config.internalApiBaseUrl, 'http://api.internal:9999');
  assert.throws(() => loadApiConfig({ ...BASE_ENV, INTERNAL_API_BASE_URL: 'http://api.internal:9999/' }), /INTERNAL_API_BASE_URL/);
});

test('DELEGATION_CONTEXT_SECRET accepted at >= 16 chars; shorter rejected without echoing values', () => {
  const withSecret = loadApiConfig({ ...BASE_ENV, DELEGATION_CONTEXT_SECRET: 'x'.repeat(24) });
  assert.equal(withSecret.delegationContextSecret === null, false);

  const short = (() => {
    try {
      loadApiConfig({ ...BASE_ENV, DELEGATION_CONTEXT_SECRET: 'short' });
      return null;
    } catch (error) {
      return error as Error;
    }
  })();
  assert.ok(short !== null);
  assert.ok(!short.message.includes('short'), 'rejected values are never echoed');
  assert.ok(short.message.startsWith('Invalid API configuration'), 'safe failure prefix');
});

test('DELEGATION_TIMEOUT_MS bounds: 1000..600000 with 120000 default; noninteger rejected', () => {
  assert.equal(loadApiConfig({ ...BASE_ENV, DELEGATION_TIMEOUT_MS: '5432' }).delegationTimeoutMs, 5432);
  for (const bad of ['999', '600001', '12.5', 'nope']) {
    assert.throws(() => loadApiConfig({ ...BASE_ENV, DELEGATION_TIMEOUT_MS: bad }), /DELEGATION_TIMEOUT_MS/);
  }
});

test('QUERY_STATEMENT_TIMEOUT_MS and QUERY_ROW_CAP bounds with defaults', () => {
  assert.equal(loadApiConfig({ ...BASE_ENV, QUERY_STATEMENT_TIMEOUT_MS: '250' }).queryStatementTimeoutMs, 250);
  assert.equal(loadApiConfig({ ...BASE_ENV, QUERY_ROW_CAP: '42' }).queryRowCap, 42);
  for (const bad of ['99', '300001', '7.0']) {
    assert.throws(() => loadApiConfig({ ...BASE_ENV, QUERY_STATEMENT_TIMEOUT_MS: bad }), /QUERY_STATEMENT_TIMEOUT_MS/);
  }
  for (const bad of ['0', '10001', 'x']) {
    assert.throws(() => loadApiConfig({ ...BASE_ENV, QUERY_ROW_CAP: bad }), /QUERY_ROW_CAP/);
  }
});

test('blank Phase 4 env values fall back to defaults (blank-as-absent)', () => {
  const config = loadApiConfig({
    ...BASE_ENV,
    INTERNAL_API_BASE_URL: '   ',
    DELEGATION_CONTEXT_SECRET: '',
    DELEGATION_TIMEOUT_MS: '',
    QUERY_STATEMENT_TIMEOUT_MS: '',
    QUERY_ROW_CAP: '',
  });
  assert.equal(config.internalApiBaseUrl, 'http://127.0.0.1:3001');
  assert.equal(config.delegationContextSecret, null);
  assert.equal(config.delegationTimeoutMs, 120_000);
  assert.equal(config.queryStatementTimeoutMs, 2_000);
  assert.equal(config.queryRowCap, 200);
});

test('config object stays frozen (immutability) with the new fields', () => {
  const config = loadApiConfig(BASE_ENV);
  assert.throws(() => {
    (config as unknown as { internalApiBaseUrl: string }).internalApiBaseUrl = 'http://elsewhere';
  });
});
