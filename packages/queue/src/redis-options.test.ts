/**
 * Unit tests for the package-owned Redis option plumbing: URL → ioredis
 * options (TLS, numeric db path, credentials), fixed secret-safe errors, and
 * the bounded PING helper.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { connectWithTimeout, redisConnectionOptions, type RedisReconnectStrategy } from './redis-options.js';

test('plain redis:// URL keeps host/port and forces maxRetriesPerRequest null', () => {
  const options = redisConnectionOptions('redis://localhost:6380');
  assert.deepEqual(options, {
    host: 'localhost',
    port: 6380,
    maxRetriesPerRequest: null,
  });
});

test('default port is 6379 when the URL omits it', () => {
  const options = redisConnectionOptions('redis://redis.internal');
  assert.equal(options.port, 6379);
});

test('rediss:// URL enables the ioredis TLS contract (tls: {})', () => {
  const options = redisConnectionOptions('rediss://cache.internal:6380');
  assert.equal(options.tls !== undefined, true);
  assert.deepEqual(options.tls, {});
  assert.equal(options.host, 'cache.internal');
  assert.equal(options.port, 6380);
});

test('numeric database path maps to db (redis://host/2 and /0)', () => {
  assert.equal(redisConnectionOptions('redis://h/2').db, 2);
  assert.equal(redisConnectionOptions('redis://rediss-host.invalid/0').db, 0);
});

test('username/password are preserved; the default username is dropped', () => {
  const named = redisConnectionOptions('redis://me:pw@h.internal:6379/1');
  assert.equal(named.username, 'me');
  assert.equal(named.password, 'pw');
  assert.equal(named.db, 1);
  const anonymous = redisConnectionOptions('redis://:pw@h.internal');
  assert.equal(anonymous.username, undefined);
  assert.equal(anonymous.password, 'pw');
});

test('reconnect strategy override is passed through as retryStrategy', () => {
  const strategy: RedisReconnectStrategy = (retries) => (retries > 2 ? null : 10);
  const options = redisConnectionOptions('redis://h', strategy);
  assert.equal(options.retryStrategy, strategy);
});

test('invalid database paths throw a FIXED error that never echoes the URL', () => {
  const secretUrl = 'redis://scheduler:supersecret@redis.internal/nonsense';
  assert.throws(
    () => redisConnectionOptions(secretUrl),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return (
        message.includes('database path must be an integer like /2') &&
        !message.includes('supersecret') &&
        !message.includes('redis://')
      );
    },
  );
});

test('non-redis protocols throw a FIXED error', () => {
  assert.throws(
    () => redisConnectionOptions('postgresql://localhost/workforce'),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes('must be a redis:// or rediss:// URL') && !message.includes('postgresql');
    },
  );
});

test('connectWithTimeout resolves on a fast PING', async () => {
  await connectWithTimeout((client) => client.ping(), { ping: async () => 'PONG' }, 100);
});

test('connectWithTimeout rejects with the ping error untouched', async () => {
  await assert.rejects(
    connectWithTimeout(
      (client) => client.ping(),
      { ping: () => Promise.reject(new Error('boom')) },
      100,
    ),
    (error: unknown) => `${(error as Error).message}` === 'boom',
  );
});

test('connectWithTimeout rejects on the bounded timeout', async () => {
  await assert.rejects(
    connectWithTimeout(
      (_client) => new Promise(() => undefined),
      { ping: () => new Promise(() => undefined) },
      25,
    ),
    (error: unknown) => `${(error as Error).message}`.includes('PING timeout after 25ms'),
  );
});
