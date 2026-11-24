/**
 * Package-local Redis/BullMQ connection plumbing.
 *
 * This is the OWNED variant of the connection-options semantics used by the
 * API-layer BullMQ queues (memory, delegation): the queue package never
 * imports app code, so the rules are repeated here on purpose.
 *
 * - `maxRetriesPerRequest: null` is REQUIRED by BullMQ (blocking commands).
 * - BullMQ OWNS every socket when created from a config OBJECT: it creates,
 *   duplicates (for blocking operations) and closes every socket on close().
 *   Never pass a live client instance to BullMQ.
 * - All Redis details (host, port, username/password, TLS, db) come from the
 *   URL; the URL VALUE itself is never logged and never included in any
 *   thrown message (fixed configuration errors only).
 */

import type { RedisOptions } from 'ioredis';

/**
 * ioredis reconnect strategy override (tests fail fast so hangs cannot hide).
 * ioredis names it `retryStrategy` at runtime; `false` disables reconnection.
 */
export type RedisReconnectStrategy = (retries: number) => number | void | null;

/**
 * Builds plain ioredis/BullMQ connection options from a URL:
 *
 * - `maxRetriesPerRequest: null` (required by BullMQ's blocking operations).
 * - `rediss://` gets `tls: {}` (node-ioredis TLS contract); `redis://` none.
 * - A numeric database path (`redis://host/2`) becomes `db: 2`; an empty or
 *   `/` path leaves the default database (0).
 * - Invalid non-integer database paths (negative, decimal, extra slashes,
 *   junk) and non-`redis:`/`rediss:` protocols throw a FIXED configuration
 *   error that never echoes the URL or its credentials.
 * - username/password/host/port are preserved from the URL parse; IPv6 hosts
 *   are unbracketed (ioredis wants the bare address).
 */
export function redisConnectionOptions(
  redisUrl: string,
  reconnectStrategy?: RedisReconnectStrategy,
): RedisOptions {
  const parsed = new URL(redisUrl);
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(
      'REDIS_URL must be a redis:// or rediss:// URL (fixed configuration error; the URL value is never echoed)',
    );
  }
  const isTls = parsed.protocol === 'rediss:';
  // pathname is '/' or empty for a default-URL parse; '/2' selects database 2.
  const dbSegment = parsed.pathname.replace(/^\//, '');
  let db: number | undefined;
  if (dbSegment !== '') {
    if (!/^\d+$/.test(dbSegment)) {
      throw new Error(
        'REDIS_URL database path must be an integer like /2 (fixed configuration error; the URL value is never echoed)',
      );
    }
    db = Number(dbSegment);
  }
  // URL keeps IPv6 hosts bracketed; ioredis wants the bare address.
  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
  const defaults: RedisOptions = {
    host,
    port: parsed.port === '' ? 6379 : Number(parsed.port),
    maxRetriesPerRequest: null,
    ...(parsed.username !== '' && parsed.username !== 'default'
      ? { username: parsed.username }
      : {}),
    ...(parsed.password !== '' ? { password: parsed.password } : {}),
    ...(isTls ? { tls: {} } : {}),
    ...(db !== undefined ? { db } : {}),
    ...(reconnectStrategy !== undefined ? { retryStrategy: reconnectStrategy } : {}),
  } as RedisOptions;
  return defaults;
}

/** PINGs a minimal ioredis surface with a hard timeout; fails calls honestly. */
export function connectWithTimeout(
  ping: (client: { ping(): Promise<unknown> }) => Promise<unknown>,
  client: { ping(): Promise<unknown> },
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Redis queue PING timeout after ${String(timeoutMs)}ms`));
    }, timeoutMs);
    ping(client).then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('Redis queue PING failed'));
      },
    );
  });
}
