/**
 * RedisChatStore semantics against an in-process Redis-semantics fake: key
 * namespacing, SET NX with EX, the compare-and-delete Lua script, JSON
 * serialization, and failure wrapping. Real-Redis behavior of the Lua script
 * itself is not covered offline (no live Redis in CI) — noted honestly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StoreUnavailableError } from '../src/errors.js';
import {
  CLEAR_ACTIVE_STREAM_LUA,
  REDIS_KEY_PREFIX,
  createRedisChatStore,
  type RedisLike,
} from '../src/store/redis.js';
import { IDEMPOTENCY_KEY_TTL_SECONDS } from '../src/store/types.js';

const CHAT = { slug: 'general', chatId: 'chat-1' };

/**
 * Minimal Redis with real SET(NX/EX)/GET/DEL/EVAL semantics for the compare-
 * and-delete script only. No network.
 */
class TinyRedis implements RedisLike {
  readonly data = new Map<string, string>();
  readonly expiryAt = new Map<string, number>();
  readonly lastEvalScript: { script: string; keys: string[]; args: string[] } | null = null;

  private alive(key: string): string | null {
    const raw = this.data.get(key);
    if (raw === undefined) {
      return null;
    }
    const until = this.expiryAt.get(key);
    if (until !== undefined && until <= Date.now()) {
      this.data.delete(key);
      return null;
    }
    return raw;
  }

  async get(key: string): Promise<string | null> {
    return this.alive(key);
  }

  async set(key: string, value: string, options?: { EX?: number; NX?: boolean }): Promise<unknown> {
    if (options?.NX === true && this.alive(key) !== null) {
      return null;
    }
    this.data.set(key, value);
    if (options?.EX !== undefined) {
      this.expiryAt.set(key, Date.now() + options.EX * 1000);
    }
    return 'OK';
  }

  async del(key: string): Promise<number> {
    const existed = this.data.delete(key);
    this.expiryAt.delete(key);
    return existed ? 1 : 0;
  }

  readonly lists = new Map<string, string[]>();

  async rPush(key: string, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.push(value);
    this.lists.set(key, list);
    return list.length;
  }

  async lRange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    // Redis bounds are inclusive; -1 means through the tail.
    const end = stop === -1 ? list.length : stop + 1;
    return list.slice(start, end);
  }

  async listLength(key: string): Promise<number> {
    return (this.lists.get(key) ?? []).length;
  }

  async eval(script: string, options?: { keys?: string[]; arguments?: string[] }): Promise<unknown> {
    // Emulates exactly the compare-and-delete script this store uses.
    assert.equal(script, CLEAR_ACTIVE_STREAM_LUA);
    const key = options?.keys?.[0] ?? '';
    const expected = options?.arguments?.[0] ?? '';
    if (this.alive(key) === expected) {
      await this.del(key);
      return 1;
    }
    return 0;
  }
}

class BrokenRedis implements RedisLike {
  async get(): Promise<never> {
    throw new Error('READONLY You cannot write against a read only replica');
  }
  async set(): Promise<never> {
    throw new Error('READONLY You cannot write against a read only replica');
  }
  async del(): Promise<never> {
    throw new Error('READONLY You cannot write against a read only replica');
  }
  async rPush(): Promise<never> {
    throw new Error('READONLY You cannot write against a read only replica');
  }
  async lRange(): Promise<never> {
    throw new Error('READONLY You cannot write against a read only replica');
  }
  async eval(): Promise<never> {
    throw new Error('READONLY You cannot write against a read only replica');
  }
}

test('keys are namespaced under workforce:phase2*', async () => {
  const redis = new TinyRedis();
  const store = createRedisChatStore(redis);
  const message = { id: 'm0', role: 'user', parts: [{ type: 'text', text: 'hi' }] };
  await store.appendMessage(CHAT, message as never);
  assert.ok(redis.lists.has(`${REDIS_KEY_PREFIX}:chat:general:chat-1:messages`));
  await store.setActiveStreamId(CHAT, 'strm-1');
  assert.equal(redis.data.get(`${REDIS_KEY_PREFIX}:chat:general:chat-1:active-stream`), 'strm-1');
  await store.acquireIdempotencyKey(CHAT, 'chat-1:m1', IDEMPOTENCY_KEY_TTL_SECONDS);
  assert.equal(
    redis.data.get(`${REDIS_KEY_PREFIX}:idempotency:general:chat-1:chat-1:m1`),
    '1',
    'idempotency key is scoped to the chat in the Redis key',
  );
  assert.equal(REDIS_KEY_PREFIX.startsWith('workforce:phase2'), true);
});

test('messages append as one LIST entry each, load oldest-first, empty chat is []', async () => {
  const redis = new TinyRedis();
  const store = createRedisChatStore(redis);
  assert.deepEqual(await store.loadMessages(CHAT), []);
  const first = { id: 'msg-a', role: 'user', parts: [{ type: 'text', text: 'hi' }] };
  const second = { id: 'msg-b', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] };
  await store.appendMessage(CHAT, first as never);
  await store.appendMessage(CHAT, second as never);
  // One JSON UIMessage per list entry (RPUSH/LRANGE), not one JSON array.
  const entries = redis.lists.get(`${REDIS_KEY_PREFIX}:chat:general:chat-1:messages`) ?? [];
  assert.equal(entries.length, 2);
  assert.deepEqual(JSON.parse(entries[0] as string), first);
  assert.deepEqual(JSON.parse(entries[1] as string), second);
  assert.deepEqual(await store.loadMessages(CHAT), [first, second]);
});

test('active stream marker is written with EX 86400 (24h sentinel alignment)', async () => {
  const redis = new TinyRedis();
  const store = createRedisChatStore(redis);
  const recorded: Array<{ key: string; options?: { EX?: number; NX?: boolean } }> = [];
  const originalSet = redis.set.bind(redis);
  (redis as { set: RedisLike['set'] }).set = async (key, value, options) => {
    recorded.push({ key, options });
    return await originalSet(key, value, options);
  };
  await store.setActiveStreamId(CHAT, 'strm-ttl');
  const marker = recorded.find((entry) => entry.key === `${REDIS_KEY_PREFIX}:chat:general:chat-1:active-stream`);
  assert.ok(marker !== undefined);
  assert.equal(marker?.options?.EX, 86_400);
});

test('idempotency: SET NX EX with exactly 900s; duplicate returns false', async () => {
  const redis = new TinyRedis();
  const store = createRedisChatStore(redis);
  const recorded: Array<{ key: string; value: string; options?: { EX?: number; NX?: boolean } }> = [];
  const originalSet = redis.set.bind(redis);
  (redis as { set: RedisLike['set'] }).set = async (key, value, options) => {
    recorded.push({ key, value, options });
    return await originalSet(key, value, options);
  };

  assert.equal(await store.acquireIdempotencyKey(CHAT, 'k1', IDEMPOTENCY_KEY_TTL_SECONDS), true);
  assert.equal(await store.acquireIdempotencyKey(CHAT, 'k1', IDEMPOTENCY_KEY_TTL_SECONDS), false);
  assert.equal(recorded[0]?.options?.EX, 900);
  assert.equal(recorded[0]?.options?.NX, true);

  await store.releaseIdempotencyKey(CHAT, 'k1');
  assert.equal(await store.acquireIdempotencyKey(CHAT, 'k1', IDEMPOTENCY_KEY_TTL_SECONDS), true);
});

test('clearActiveStreamId compare-and-deletes only on exact match', async () => {
  const redis = new TinyRedis();
  const store = createRedisChatStore(redis);
  await store.setActiveStreamId(CHAT, 'strm-a');
  assert.equal(await store.clearActiveStreamId(CHAT, 'strm-b'), false);
  assert.equal(await store.getActiveStreamId(CHAT), 'strm-a');
  assert.equal(await store.clearActiveStreamId(CHAT, 'strm-a'), true);
  assert.equal(await store.getActiveStreamId(CHAT), null);
});

test('corrupt stored messages surface as StoreUnavailableError, not JSON errors', async () => {
  const redis = new TinyRedis();
  const badKey = `${REDIS_KEY_PREFIX}:chat:general:chat-1:messages`;
  // One corrupt entry among good ones: the whole read fails rather than
  // silently truncating the conversation.
  (redis as { lists: Map<string, string[]> }).lists.set(badKey, [
    JSON.stringify({ id: 'ok', role: 'user', parts: [] }),
    'not-json{',
  ]);
  const store = createRedisChatStore(redis);
  await assert.rejects(() => store.loadMessages(CHAT), StoreUnavailableError);
  const badObjectKey = `${REDIS_KEY_PREFIX}:chat:other:chat-9:messages`;
  (redis as { lists: Map<string, string[]> }).lists.set(badObjectKey, ['null']);
  await assert.rejects(
    () => store.loadMessages({ slug: 'other', chatId: 'chat-9' }),
    StoreUnavailableError,
  );
});

test('redis failures map to StoreUnavailableError everywhere', async () => {
  const store = createRedisChatStore(new BrokenRedis());
  await assert.rejects(() => store.loadMessages(CHAT), StoreUnavailableError);
  await assert.rejects(
    () => store.appendMessage(CHAT, { id: 'm', role: 'user', parts: [] } as never),
    StoreUnavailableError,
  );
  await assert.rejects(() => store.getActiveStreamId(CHAT), StoreUnavailableError);
  await assert.rejects(() => store.setActiveStreamId(CHAT, 's'), StoreUnavailableError);
  await assert.rejects(() => store.clearActiveStreamId(CHAT, 's'), StoreUnavailableError);
  await assert.rejects(
    () => store.acquireIdempotencyKey(CHAT, 'k', IDEMPOTENCY_KEY_TTL_SECONDS),
    StoreUnavailableError,
  );
  await assert.rejects(() => store.releaseIdempotencyKey(CHAT, 'k'), StoreUnavailableError);
});
