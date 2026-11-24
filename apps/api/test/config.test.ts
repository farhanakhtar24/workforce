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

test('loadApiConfig treats blank OLLAMA_API_KEY exactly as absent', () => {
  const ok = loadApiConfig({});
  assert.equal(ok.apiKey, null);
  const blank = loadApiConfig({ ...BASE_ENV, OLLAMA_API_KEY: '   ' });
  assert.equal(blank.apiKey, null);
  // The other blank-driven defaults coexist with present values in BASE_ENV.
  assert.equal(blank.baseUrl, 'https://ollama.example/v1');
  assert.equal(blank.model, 'glm-5.3-flash');
});

test('loadApiConfig treats empty/whitespace values for every variable as defaults', () => {
  const config = loadApiConfig({
    OLLAMA_API_KEY: '',
    OLLAMA_BASE_URL: '   ',
    OLLAMA_MODEL: '\t\n  ',
    REDIS_URL: ' ',
    PORT: '  ',
    WEB_ORIGIN: '\t',
    DATABASE_URL: '\n',
    EMBEDDING_CACHE_DIR: '\t ',
  });
  assert.equal(config.apiKey, null);
  assert.equal(config.baseUrl, 'https://ollama.com/v1');
  assert.equal(config.model, 'glm-5.3-flash');
  assert.equal(config.redisUrl, 'redis://127.0.0.1:6379');
  assert.equal(config.port, 3001);
  assert.equal(config.webOrigin, 'http://localhost:3000');
  assert.equal(config.databaseUrl, 'postgresql://workforce:workforce@127.0.0.1:55432/workforce');
  assert.equal(config.embeddingCacheDir.startsWith('/'), true);
  assert.match(config.embeddingCacheDir, /\.cache\/workforce-models$/);
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
  // Only WHOLLY blank values become absent; a nonempty value with surrounding
  // whitespace is still validated (and still rejected) untouched.
  assert.throws(
    () => loadApiConfig({ ...BASE_ENV, OLLAMA_BASE_URL: '  https://ollama.example/v1  ' }),
    /OLLAMA_BASE_URL/,
  );
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

// ---------------------------------------------------------------------------
// Pre-Phase 6: model policy + honest usage pricing
// ---------------------------------------------------------------------------

test('loadApiConfig defaults blocked prefixes to kimi and parses the CSV', () => {
  const defaults = loadApiConfig(BASE_ENV);
  assert.deepEqual(defaults.blockedModelPrefixes, ['kimi']);
  // Case-insensitive, deduplicated, sorted; blank segments dropped.
  assert.deepEqual(loadApiConfig({ ...BASE_ENV, WORKFORCE_BLOCKED_MODEL_PREFIXES: 'Kimi, gpt-oss , KIMI,' }).blockedModelPrefixes, ['gpt-oss', 'kimi']);
});

test('loadApiConfig bounds the blocked-prefix CSV and never echoes values', () => {
  assert.throws(() => loadApiConfig({ ...BASE_ENV, WORKFORCE_BLOCKED_MODEL_PREFIXES: 'bad/slash' }), /WORKFORCE_BLOCKED_MODEL_PREFIXES/);
  assert.throws(() => loadApiConfig({ ...BASE_ENV, WORKFORCE_BLOCKED_MODEL_PREFIXES: `${'x'.repeat(65)}` }), /WORKFORCE_BLOCKED_MODEL_PREFIXES/);
  assert.throws(() => loadApiConfig({ ...BASE_ENV, WORKFORCE_BLOCKED_MODEL_PREFIXES: Array.from({ length: 17 }, (_, i) => `p${i}`).join(',') }), /at most 16/);
});

test('loadApiConfig treats blank/absent OLLAMA_MODEL_PRICING_JSON as null pricing', () => {
  assert.equal(loadApiConfig(BASE_ENV).modelPricing, null);
  assert.equal(loadApiConfig({ ...BASE_ENV, OLLAMA_MODEL_PRICING_JSON: '  ' }).modelPricing, null);
});

test('loadApiConfig parses bounded pricing JSON with the safe error contract', () => {
  const pricing = loadApiConfig({ ...BASE_ENV, OLLAMA_MODEL_PRICING_JSON: JSON.stringify({ 'glm-5.3-flash': { input: 1, output: 2 } }) }).modelPricing;
  assert.ok(pricing !== null);
  assert.deepEqual(pricing['glm-5.3-flash'], { input: 1, output: 2 });

  for (const bad of ['[]', '"x"', '{bad', '{"m":1}', '{"m":{"input":1}}', '{"m":{"input":1,"output":-2}}', '{"m":{"input":1,"output":true}}', `{"${'x'.repeat(81)}":{"input":1,"output":2}}`]) {
    try {
      loadApiConfig({ ...BASE_ENV, OLLAMA_MODEL_PRICING_JSON: bad });
      assert.fail(`expected throw for ${bad}`);
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.match(error.message, /OLLAMA_MODEL_PRICING_JSON/);
      assert.match(error.message, /values are never included/);
    }
  }
  const oversized = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`m-${i}`, { input: 1, output: 1 }]));
  assert.throws(() => loadApiConfig({ ...BASE_ENV, OLLAMA_MODEL_PRICING_JSON: JSON.stringify(oversized) }), /at most 200/);
});
