import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApiConfig } from '../src/config.js';

const BASE_ENV = {
  OLLAMA_API_KEY: 'test-key-not-real',
  OLLAMA_BASE_URL: 'https://ollama.example/v1',
  OLLAMA_MODEL: 'glm-5.3-flash',
  REDIS_URL: 'redis://127.0.0.1:6379',
  PORT: '3001',
  WEB_ORIGIN: 'http://localhost:3000',
};

test('loadApiConfig applies documented defaults', () => {
  const config = loadApiConfig({ REDIS_URL: 'redis://127.0.0.1:6379' });
  assert.equal(config.apiKey, null);
  assert.equal(config.baseUrl, 'https://ollama.com/v1');
  assert.equal(config.model, 'glm-5.3-flash');
  assert.equal(config.redisUrl, 'redis://127.0.0.1:6379');
  assert.equal(config.port, 3001);
  assert.equal(config.webOrigin, 'http://localhost:3000');
  assert.equal(config.databaseUrl, 'postgresql://workforce:workforce@127.0.0.1:55432/workforce');
});

test('loadApiConfig strips trailing slashes from OLLAMA_BASE_URL (no /v1 duplication)', () => {
  const config = loadApiConfig({ ...BASE_ENV, OLLAMA_BASE_URL: 'https://ollama.example/v1/' });
  assert.equal(config.baseUrl, 'https://ollama.example/v1');
});

test('loadApiConfig accepts empty OLLAMA_API_KEY absence but not blank value', () => {
  const ok = loadApiConfig({});
  assert.equal(ok.apiKey, null);
  assert.throws(() => loadApiConfig({ ...BASE_ENV, OLLAMA_API_KEY: '   ' }), /OLLAMA_API_KEY/);
});

test('loadApiConfig parses and bounds PORT', () => {
  assert.equal(loadApiConfig({ ...BASE_ENV, PORT: '4321' }).port, 4321);
  assert.equal(loadApiConfig({ ...BASE_ENV, PORT: '1' }).port, 1);
  assert.throws(() => loadApiConfig({ ...BASE_ENV, PORT: '0' }), /PORT/);
  assert.throws(() => loadApiConfig({ ...BASE_ENV, PORT: '65536' }), /PORT/);
  assert.throws(() => loadApiConfig({ ...BASE_ENV, PORT: 'not-a-number' }), /PORT/);
});

test('loadApiConfig accepts plain redis:// localhost and rediss:// variants', () => {
  assert.equal(loadApiConfig({ ...BASE_ENV, REDIS_URL: 'redis://127.0.0.1:6379' }).redisUrl, 'redis://127.0.0.1:6379');
  assert.equal(loadApiConfig({ ...BASE_ENV, REDIS_URL: 'rediss://redis.example:6380' }).redisUrl, 'rediss://redis.example:6380');
  assert.throws(() => loadApiConfig({ ...BASE_ENV, REDIS_URL: 'postgres://x' }), /REDIS_URL/);
});

test('loadApiConfig rejects WEB_ORIGIN with a path (origin only)', () => {
  assert.throws(() => loadApiConfig({ ...BASE_ENV, WEB_ORIGIN: 'http://localhost:3000/app' }), /WEB_ORIGIN/);
  assert.doesNotThrow(() => loadApiConfig({ ...BASE_ENV, WEB_ORIGIN: 'https://chat.example.com:8443' }));
});

test('loadApiConfig error messages never contain secret values', () => {
  const secret = 'super-secret-value-do-not-log';
  try {
    loadApiConfig({ ...BASE_ENV, OLLAMA_API_KEY: secret, PORT: 'nope' });
    assert.fail('expected throw');
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes(secret), false);
  }
});

test('loadApiConfig validates base URL shape without echoing values', () => {
  assert.throws(() => loadApiConfig({ ...BASE_ENV, OLLAMA_BASE_URL: 'not-http' }), /OLLAMA_BASE_URL/);
});

test('loadApiConfig defaults DATABASE_URL to the local dev stack; env overrides it', () => {
  assert.equal(
    loadApiConfig({}).databaseUrl,
    'postgresql://workforce:workforce@127.0.0.1:55432/workforce',
  );
  assert.equal(
    loadApiConfig(BASE_ENV).databaseUrl,
    'postgresql://workforce:workforce@127.0.0.1:55432/workforce',
  );
  assert.equal(
    loadApiConfig({ ...BASE_ENV, DATABASE_URL: 'postgresql://mem.example:5432/prod' }).databaseUrl,
    'postgresql://mem.example:5432/prod',
  );
});

test('loadApiConfig accepts postgres:// and postgresql:// DATABASE_URL', () => {
  assert.equal(
    loadApiConfig({ ...BASE_ENV, DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/workforce' }).databaseUrl,
    'postgres://user:pass@127.0.0.1:5432/workforce',
  );
  assert.equal(
    loadApiConfig({ ...BASE_ENV, DATABASE_URL: 'postgresql://127.0.0.1:5432/workforce' }).databaseUrl,
    'postgresql://127.0.0.1:5432/workforce',
  );
  assert.throws(() => loadApiConfig({ ...BASE_ENV, DATABASE_URL: 'mysql://x/y' }), /DATABASE_URL/);
  assert.throws(() => loadApiConfig({ ...BASE_ENV, DATABASE_URL: 'not-a-url' }), /DATABASE_URL/);
});

test('loadApiConfig never echoes a bad DATABASE_URL value (may contain a password)', () => {
  const secret = 'super-secret-db-password';
  try {
    loadApiConfig({ ...BASE_ENV, DATABASE_URL: `mysql://user:${secret}@host/db` });
    assert.fail('expected throw');
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes(secret), false);
  }
});

test('loadApiConfig resolves EMBEDDING_CACHE_DIR to an absolute repo-local path', () => {
  const defaultConfig = loadApiConfig(BASE_ENV);
  assert.match(defaultConfig.embeddingCacheDir, /\.cache\/workforce-models$/);
  assert.equal(defaultConfig.embeddingCacheDir.startsWith('/'), true);

  const relative = loadApiConfig({ ...BASE_ENV, EMBEDDING_CACHE_DIR: 'models' });
  assert.equal(relative.embeddingCacheDir.startsWith('/'), true);
  assert.match(relative.embeddingCacheDir, /\/models$/);

  const absolute = loadApiConfig({ ...BASE_ENV, EMBEDDING_CACHE_DIR: '/var/cache/workforce-models' });
  assert.equal(absolute.embeddingCacheDir, '/var/cache/workforce-models');
});
