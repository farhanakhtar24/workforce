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
  APPEND_MESSAGE_WITH_INDEX_LUA,
  chatIndexKey,
  CLEAR_ACTIVE_STREAM_LUA,
  REDIS_KEY_PREFIX,
  createRedisChatStore,
  type RedisLike,
} from '../src/store/redis.js';
import { IDEMPOTENCY_KEY_TTL_SECONDS, type ChatRef } from '../src/store/types.js';

const CHAT = { ownerId: 'owner-a', slug: 'general', chatId: 'chat-1' };
const INDEX_KEY = chatIndexKey('owner-a');
/** Deterministic injected clock (epoch ms) for the activity-index scores. */
let NOW_MS = 1_000_000;
function tick(by = 1): number {
  NOW_MS += by;
  return NOW_MS;
}
function nowMs(): number {
  return NOW_MS;
}

/**
 * Minimal Redis with real SET(NX/EX)/GET/DEL/EVAL semantics for the compare-
 * and-delete script only. No network.
 */
class TinyRedis implements RedisLike {
  readonly hashes = new Map<string, Record<string, string>>();
  async hGetAll(key: string): Promise<Record<string, string> | unknown> {
    const value = this.hashes.get(key);
    return value === undefined ? {} : { ...value };
  }
  async hSet(key: string, value: Record<string, string>): Promise<number | unknown> {
    const existing = this.hashes.get(key) ?? {};
    this.hashes.set(key, { ...existing, ...value });
    return Object.keys(value).length;
  }
  readonly data = new Map<string, string>();
  readonly expiryAt = new Map<string, number>();
  readonly lastEvalScript: { script: string; keys: string[]; args: string[] } | null = null;
  /** Sorted sets: key → (member → score), emulating real ZSET semantics. */
  readonly zsets = new Map<string, Map<string, number>>();

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

  async lLen(key: string): Promise<number> {
    return this.listLength(key);
  }

  async zAdd(key: string, members: Array<{ value: string; score: number }>): Promise<number> {
    const zset = this.zsets.get(key) ?? new Map<string, number>();
    this.zsets.set(key, zset);
    let added = 0;
    for (const member of members) {
      if (!zset.has(member.value)) {
        added += 1;
      }
      zset.set(member.value, member.score);
    }
    return added;
  }

  async zRangeWithScores(
    key: string,
    min: number | string,
    max: number | string,
    options?: { BY?: 'SCORE' | 'LEX'; REV?: boolean; LIMIT?: { offset: number; count: number } },
  ): Promise<Array<{ value: string; score: number }>> {
    const zset = this.zsets.get(key);
    if (zset === undefined) {
      return [];
    }
    let entries = [...zset.entries()].map(([value, score]) => ({ value, score }));
    // Redis: equal scores are ordered member ASCENDING internally.
    entries.sort((a, b) => (a.score !== b.score ? a.score - b.score : a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
    if (options?.REV === true) {
      entries.reverse();
    }
    if (typeof min === 'number' && typeof max === 'number') {
      entries = entries.filter((entry) => entry.score >= min && (max === -1 || entry.score <= max));
    }
    if (options?.LIMIT !== undefined) {
      entries = entries.slice(options.LIMIT.offset, options.LIMIT.offset + options.LIMIT.count);
    }
    return entries;
  }

  async zRem(key: string, members: string[]): Promise<number> {
    const zset = this.zsets.get(key);
    if (zset === undefined) {
      return 0;
    }
    let removed = 0;
    for (const member of members) {
      if (zset.delete(member)) {
        removed += 1;
      }
    }
    return removed;
  }

  async zScore(key: string, member: string): Promise<number | null> {
    const zset = this.zsets.get(key);
    if (zset === undefined || !zset.has(member)) {
      return null;
    }
    return zset.get(member) ?? null;
  }

  async scan(
    cursor: number | string,
    options?: { MATCH?: string; COUNT?: number },
  ): Promise<{ cursor: string; keys: string[] }> {
    const everyKey = [...this.data.keys(), ...this.lists.keys(), ...this.zsets.keys()];
    const pattern = options?.MATCH ?? '*';
    const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replaceAll('*', '.*')}$`);
    const keys = everyKey.filter((key) => regex.test(key));
    // Full result in one page: cursor '0' terminates the loop deterministically.
    void cursor;
    return { cursor: '0', keys };
  }

  async eval(script: string, options?: { keys?: string[]; arguments?: string[] }): Promise<unknown> {
    // Emulates exactly the compare-and-delete script this store uses.
    if (script === CLEAR_ACTIVE_STREAM_LUA) {
      const key = options?.keys?.[0] ?? '';
      const expected = options?.arguments?.[0] ?? '';
      if (this.alive(key) === expected) {
        await this.del(key);
        return 1;
      }
      return 0;
    }
    // Emulates exactly the atomic append + activity-index script (TYPE check
    // → RPUSH → ZADD; missing index key is 'none', plain string refuses -1,
    // and NOTHING is touched when it refuses).
    if (script === APPEND_MESSAGE_WITH_INDEX_LUA) {
      const listKey = options?.keys?.[0] ?? '';
      const indexKey = options?.keys?.[1] ?? '';
      const [entry, score, member] = options?.arguments ?? [];
      if (this.data.has(indexKey)) {
        return -1; // wrongtype at the index key: nothing touched
      }
      await this.rPush(listKey, entry ?? '');
      await this.zAdd(indexKey, [{ value: member ?? '', score: Number(score ?? '0') }]);
      return 1;
    }
    throw new Error('unexpected script');
  }
}

class BrokenRedis implements RedisLike {
  async hGetAll(): Promise<Record<string, string> | unknown> {
    throw new Error('simulated database outage');
  }
  async hSet(): Promise<number | unknown> {
    throw new Error('simulated database outage');
  }
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
  async lLen(): Promise<never> {
    throw new Error('READONLY You cannot write against a read only replica');
  }
  async zAdd(): Promise<never> {
    throw new Error('READONLY You cannot write against a read only replica');
  }
  async zRangeWithScores(): Promise<never> {
    throw new Error('READONLY You cannot write against a read only replica');
  }
  async scan(): Promise<never> {
    throw new Error('READONLY You cannot write against a read only replica');
  }
  async zScore(): Promise<never> {
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
  assert.ok(redis.lists.has(`${REDIS_KEY_PREFIX}:chat:owner-a:general:chat-1:messages`));
  await store.setActiveStreamId(CHAT, 'strm-1');
  assert.equal(redis.data.get(`${REDIS_KEY_PREFIX}:chat:owner-a:general:chat-1:active-stream`), 'strm-1');
  await store.acquireIdempotencyKey(CHAT, 'chat-1:m1', IDEMPOTENCY_KEY_TTL_SECONDS);
  assert.equal(
    redis.data.get(`${REDIS_KEY_PREFIX}:idempotency:owner-a:general:chat-1:chat-1:m1`),
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
  const entries = redis.lists.get(`${REDIS_KEY_PREFIX}:chat:owner-a:general:chat-1:messages`) ?? [];
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
  const marker = recorded.find((entry) => entry.key === `${REDIS_KEY_PREFIX}:chat:owner-a:general:chat-1:active-stream`);
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
  const badKey = `${REDIS_KEY_PREFIX}:chat:owner-a:general:chat-1:messages`;
  // One corrupt entry among good ones: the whole read fails rather than
  // silently truncating the conversation.
  (redis as { lists: Map<string, string[]> }).lists.set(badKey, [
    JSON.stringify({ id: 'ok', role: 'user', parts: [] }),
    'not-json{',
  ]);
  const store = createRedisChatStore(redis);
  await assert.rejects(() => store.loadMessages(CHAT), StoreUnavailableError);
  const badObjectKey = `${REDIS_KEY_PREFIX}:chat:owner-a:other:chat-9:messages`;
  (redis as { lists: Map<string, string[]> }).lists.set(badObjectKey, ['null']);
  await assert.rejects(
    () => store.loadMessages({ ownerId: 'owner-a', slug: 'other', chatId: 'chat-9' }),
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
  await assert.rejects(() => store.listRecentChats(CHAT.ownerId, 20), StoreUnavailableError);
});

// ---------------------------------------------------------------------------
// Recent-chat activity index (Phase 6 UX): atomic RPUSH+ZADD, listing order,
// legacy discovery. Evaluated against the in-process Redis-semantics fake;
// real-Redis behavior of the Lua script itself is integration-tested live.
// ---------------------------------------------------------------------------

function chatRef(slug: string, chatId: string): ChatRef {
  return { ownerId: CHAT.ownerId, slug, chatId };
}

test('appendMessage atomically re-scores the activity index (RPUSH+ZADD in one script)', async () => {
  const redis = new TinyRedis();
  const store = createRedisChatStore(redis, { now: nowMs });
  const message = { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] };
  tick(1);
  await store.appendMessage(CHAT, message as never);
  assert.equal(redis.lists.get(`${REDIS_KEY_PREFIX}:chat:owner-a:general:chat-1:messages`)?.length, 1);
  assert.deepEqual(redis.zsets.get(INDEX_KEY)?.get('general:chat-1'), NOW_MS);
  // A second append re-scores the SAME member (newest activity wins).
  tick(50);
  await store.appendMessage(CHAT, { id: 'a1', role: 'assistant', parts: [] } as never);
  assert.deepEqual(redis.zsets.get(INDEX_KEY)?.get('general:chat-1'), NOW_MS);
  assert.equal(redis.lists.get(`${REDIS_KEY_PREFIX}:chat:owner-a:general:chat-1:messages`)?.length, 2);
});

test('appendMessage refuses without writing anything when the index key is corrupt', async () => {
  const redis = new TinyRedis();
  const store = createRedisChatStore(redis, { now: nowMs });
  // Plant a plain string at the index key: wrongtype must refuse the WHOLE
  // write (no list entry, no index change) via the script's -1 path.
  redis.data.set(INDEX_KEY, 'not-a-zset');
  await assert.rejects(() => store.appendMessage(CHAT, { id: 'm1', role: 'user', parts: [] } as never), StoreUnavailableError);
  assert.equal(redis.lists.has(`${REDIS_KEY_PREFIX}:chat:owner-a:general:chat-1:messages`), false);
});

test('listRecentChats: indexed chats newest-first, legacy deterministically after with null timestamp', async () => {
  const redis = new TinyRedis();
  const store = createRedisChatStore(redis, { now: nowMs });
  // LEGACY chat: messages written WITHOUT the store (pre-index history).
  await redis.rPush(
    `${REDIS_KEY_PREFIX}:chat:owner-a:general:legacy-chat:messages`,
    JSON.stringify({ id: 'lu1', role: 'user', parts: [{ type: 'text', text: 'legacy first message' }] }),
  );
  await redis.rPush(
    `${REDIS_KEY_PREFIX}:chat:owner-a:general:legacy-chat:messages`,
    JSON.stringify({ id: 'la1', role: 'assistant', parts: [{ type: 'text', text: 'legacy newest reply' }] }),
  );
  // Hand-planted garbage the parser must skip deterministically.
  await redis.rPush(`${REDIS_KEY_PREFIX}:chat:notaslug:bogus1:messages`, 'x');
  await redis.rPush(`${REDIS_KEY_PREFIX}:chat:owner-a:general:bad:id:messages`, 'x');
  await redis.rPush(`${REDIS_KEY_PREFIX}:chat:owner-a:general:garbage-chat:messages`, 'not-json{');
  await redis.rPush(
    `${REDIS_KEY_PREFIX}:chat:owner-a:general:garbage-chat:messages`,
    JSON.stringify({ id: 'gu1', role: 'user', parts: [{ type: 'text', text: 'survives' }] }),
  );

  // Indexed writes at distinct injected times (older first, so the SECOND
  // chat must list before the first).
  tick(10);
  await store.appendMessage(chatRef('general', 'chat-old'), { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'older chat opening text' }] } as never);
  tick(10);
  await store.appendMessage(chatRef('orchestrator', 'chat-new'), { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'newest chat opening text' }] } as never);

  const chats = await store.listRecentChats(CHAT.ownerId, 20);
  // Order: indexed newest → indexed older → legacy ascending by slug:chatId
  // ('general:garbage-chat' < 'general:legacy-chat').
  assert.deepEqual(
    chats.map((c) => `${c.agent}:${c.chatId}`),
    ['orchestrator:chat-new', 'general:chat-old', 'general:garbage-chat', 'general:legacy-chat'],
  );
  const newest = chats[0];
  assert.ok(newest !== undefined);
  assert.equal(newest.lastActivityAt, new Date(NOW_MS).toISOString());
  assert.equal(newest.title, 'newest chat opening text');
  const older = chats[1];
  assert.ok(older !== undefined);
  assert.equal(older.lastActivityAt, new Date(NOW_MS - 10).toISOString());
  // Legacy: timestamp NEVER fabricated, count + contents extracted leniently.
  const legacy = chats[3];
  assert.ok(legacy !== undefined);
  assert.equal(legacy.lastActivityAt, null);
  assert.equal(legacy.title, 'legacy first message');
  assert.equal(legacy.preview, 'legacy newest reply');
  assert.equal(legacy.messageCount, 2);
  // Garbage entry counted (raw LLEN parity = 2) but never leaked into text.
  const garbage = chats[2];
  assert.ok(garbage !== undefined);
  assert.equal(garbage.messageCount, 2);
  assert.equal(garbage.title, 'survives');
  assert.equal(garbage.preview, 'survives');
});

test('listRecentChats: window-overflow indexed chat keeps its real timestamp via zScore (never legacy-null)', async () => {
  const redis = new TinyRedis();
  const store = createRedisChatStore(redis, { now: nowMs });
  tick(10);
  await store.appendMessage(chatRef('general', 'window-fallen'), { id: 'u', role: 'user', parts: [{ type: 'text', text: 'survives window overflow' }] } as never);
  const realScore = NOW_MS;
  // Overfill the top read window with stale members (no message lists): with
  // limit 5 the read window is 5 + slack 16 = 21 < 26 members, so the real
  // chat falls OUTSIDE the window and would previously surface as legacy null.
  for (let index = 0; index < 25; index += 1) {
    await redis.zAdd(INDEX_KEY, [{ value: `general:stale-${String(index).padStart(2, '0')}`, score: realScore + 1 + index }]);
  }
  // A genuinely legacy chat (no index member ever) in the same listing.
  await redis.rPush(
    `${REDIS_KEY_PREFIX}:chat:owner-a:general:real-legacy:messages`,
    JSON.stringify({ id: 'lu', role: 'user', parts: [{ type: 'text', text: 'truly legacy' }] }),
  );
  const chats = await store.listRecentChats(CHAT.ownerId, 5);
  const recovered = chats.find((chat) => chat.chatId === 'window-fallen');
  assert.ok(recovered !== undefined, 'the window-fallen indexed chat is still listed');
  assert.equal(recovered.lastActivityAt, new Date(realScore).toISOString(), 'real index score survives the window overflow');
  assert.equal(recovered.title, 'survives window overflow');
  assert.equal(recovered.messageCount, 1);
  const legacy = chats.find((chat) => chat.chatId === 'real-legacy');
  assert.ok(legacy !== undefined, 'the truly legacy chat is listed in the same call');
  assert.equal(legacy.lastActivityAt, null, 'only truly unindexed chats carry null');
  // Legacy discovery stays deterministic (ascending slug:chatId) after the fix.
  assert.ok((chats.findIndex((c) => c.chatId === 'real-legacy')) < (chats.findIndex((c) => c.chatId === 'window-fallen')));
});

test('listRecentChats: index membership verify surfaces as StoreUnavailableError when zScore fails', async () => {
  const redis = new TinyRedis();
  const store = createRedisChatStore(redis, { now: nowMs });
  tick(10);
  await store.appendMessage(chatRef('general', 'window-fallen'), { id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] } as never);
  // Push the chat outside the read window (25 higher-scored stale members),
  // so discovery routes it through the membership-verify step.
  const realScore = NOW_MS;
  for (let index = 0; index < 25; index += 1) {
    await redis.zAdd(INDEX_KEY, [{ value: `general:stale-${String(index).padStart(2, '0')}`, score: realScore + 1 + index }]);
  }
  // Simulate the member's score lookup failing (network drop mid-listing).
  const original = redis.zScore.bind(redis);
  (redis as unknown as { zScore: RedisLike['zScore'] }).zScore = async () => {
    throw new Error('READONLY You cannot write against a read only replica');
  };
  void original;
  await assert.rejects(() => store.listRecentChats(CHAT.ownerId, 5), StoreUnavailableError);
});

test('listRecentChats: limit bounds are honored (store clamp), stale index members skipped', async () => {
  const redis = new TinyRedis();
  const store = createRedisChatStore(redis, { now: nowMs });
  tick(10);
  await store.appendMessage(chatRef('general', 'c1'), { id: 'u', role: 'user', parts: [{ type: 'text', text: 'one' }] } as never);
  tick(10);
  await store.appendMessage(chatRef('general', 'c2'), { id: 'u', role: 'user', parts: [{ type: 'text', text: 'two' }] } as never);
  // Stale index member whose messages list never existed (hand-planted).
  await redis.zAdd(INDEX_KEY, [{ value: 'general:ghost', score: NOW_MS + 100 }]);
  // A stale member pointing at a DELETED list: zAdd + list then delete the
  // list via del on the (fake) — simulate a chat whose messages vanished.
  tick(10);
  const staleKey = `${REDIS_KEY_PREFIX}:chat:owner-a:general:vanishing:messages`;
  await redis.rPush(staleKey, JSON.stringify({ id: 'u', role: 'user', parts: [] }));
  await redis.zAdd(INDEX_KEY, [{ value: 'general:vanishing', score: NOW_MS }]);
  redis.lists.delete(staleKey); // the Redis store never deletes; this models an outside deletion

  const chats = await store.listRecentChats(CHAT.ownerId, 50);
  assert.deepEqual(
    chats.map((c) => `${c.agent}:${c.chatId}`),
    ['general:c2', 'general:c1'],
    'ghost member and member with an empty list are skipped',
  );
  // Limit clamps to exactly the available chats, ordered newest-first.
  const limited = await store.listRecentChats(CHAT.ownerId, 1);
  assert.equal(limited.length, 1);
  assert.equal(limited[0]?.chatId, 'c2');
  // Defensive clamp: bogus limits behave like the default (never unbounded).
  const clamped = await store.listRecentChats(CHAT.ownerId, 50);
  assert.equal(clamped.length, 2);
});

test('listRecentChats: index failure surfaces as StoreUnavailableError (503 path)', async () => {
  const redis = new TinyRedis();
  const store = createRedisChatStore(redis);
  await store.appendMessage(CHAT, { id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] } as never);
  // Corrupt an index reply by making zRangeWithScores unreadable.
  const original = redis.zRangeWithScores.bind(redis);
  (redis as unknown as { zRangeWithScores: RedisLike['zRangeWithScores'] }).zRangeWithScores = async () => 'broken reply' as unknown as Array<{ value: string; score: number }>;
  void original;
  await assert.rejects(() => store.listRecentChats(CHAT.ownerId, 20), StoreUnavailableError);
});
