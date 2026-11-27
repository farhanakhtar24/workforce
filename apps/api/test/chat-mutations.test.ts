/**
 * Route-level unit tests for the authenticated chat MUTATION surfaces
 * (pre-Phase 6: delete / branch / destructive rewind). They run against the
 * REAL Express app (startTestApp) with the real in-memory ChatStore/Stream
 * Context and the app-wide owner gate, and against a script-faithful Redis
 * fake for the Lua mutation paths.
 * No network, no Redis, no provider.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { UIMessage } from 'ai';

import {
  TEST_OWNER,
  TEST_OWNER_B,
  createMockModel,
  textStep,
  startTestApp,
  seedMessages,
  userMessage,
  getJson,
} from './helpers.js';
import { createInMemoryChatStore } from '../src/store/memory.js';
import { IDEMPOTENCY_KEY_TTL_SECONDS, type ChatRef, type ChatStore } from '../src/store/types.js';
import type { RedisLike } from '../src/store/redis.js';
import {
  APPEND_MESSAGE_WITH_INDEX_LUA,
  ANSWER_PENDING_ASK_USER_LUA,
  BRANCH_CHAT_LUA,
  CLEAR_ACTIVE_STREAM_LUA,
  DELETE_CHAT_LUA,
  REWIND_CHAT_LUA,
  CHAT_MODEL_GET_LUA,
  REDIS_KEY_PREFIX,
  createRedisChatStore,
  chatIndexKey,
} from '../src/store/redis.js';

/** Fake Redis with exact script emulation for the mutation contracts. */
class MutationTinyRedis implements RedisLike {
  readonly lists = new Map<string, string[]>();
  readonly data = new Map<string, string>();
  readonly expiryAt = new Map<string, number>();
  readonly zsets = new Map<string, Map<string, number>>();
  /** Per-chat sidebar metadata hashes (HASH type; separate namespace). */
  readonly metadata = new Map<string, Record<string, string>>();
  readonly evals: Array<{ script: string; keys: string[]; args: string[] }> = [];
  metaTypeOf(key: string): 'hash' | 'none' {
    return this.metadata.has(key) ? 'hash' : 'none';
  }
  async hGetAll(key: string): Promise<Record<string, string> | unknown> {
    if (this.lists.has(key) || this.zsets.has(key) || this.data.has(key)) {
      throw new Error('WRONGTYPE Operation not allowed');
    }
    const value = this.metadata.get(key);
    return value === undefined ? {} : { ...value };
  }
  async hSet(key: string, value: Record<string, string>): Promise<number | unknown> {
    // Single-type semantics: HSET replaces any other key type.
    this.lists.delete(key);
    this.zsets.delete(key);
    this.data.delete(key);
    const existing = this.metadata.get(key) ?? {};
    const merged = { ...existing, ...value };
    this.metadata.set(key, merged);
    return Object.keys(value).length;
  }
  /**
   * When set, a concurrent RPUSH is injected into KEYS[1] BEFORE EVERY
   * script evaluation (persistent — that is how the CAS-conflict test keeps
   * losing retries, exactly like a live interleaved append).
   */
  conflictInjection: ((keys: string[]) => Promise<void>) | null = null;

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
    // Single-Redis-type semantics: SET replaces any other key type.
    this.lists.delete(key);
    this.zsets.delete(key);
    this.data.set(key, value);
    if (options?.EX !== undefined) {
      this.expiryAt.set(key, Date.now() + options.EX * 1000);
    }
    return 'OK';
  }

  async del(key: string): Promise<number> {
    const v = this.data.delete(key) ? 1 : 0;
    this.expiryAt.delete(key);
    const l = this.lists.delete(key) ? 1 : 0;
    return v || l;
  }

  /** Actual Redis TYPE of a key (list/string/zset/none). */
  typeOf(key: string): 'list' | 'string' | 'zset' | 'none' {
    if (this.lists.has(key)) return 'list';
    if (this.data.has(key)) return 'string';
    if (this.zsets.has(key)) return 'zset';
    return 'none';
  }

  async rPush(key: string, value: string): Promise<number> {
    // Single-Redis-type semantics: RPUSH replaces any other key type.
    this.data.delete(key);
    this.zsets.delete(key);
    const list = this.lists.get(key) ?? [];
    list.push(value);
    this.lists.set(key, list);
    return list.length;
  }

  async lRange(key: string, start: number, stop: number): Promise<string[]> {
    // Real Redis LRANGE on a string/other wrongtype key ERRORS — the store
    // maps that to StoreUnavailableError (503), never silent-empty.
    if (this.data.has(key)) {
      throw new Error('WRONGTYPE Operation not allowed');
    }
    const list = this.lists.get(key) ?? [];
    const end = stop === -1 ? list.length : stop + 1;
    return list.slice(start, end);
  }

  async lLen(key: string): Promise<number> {
    if (this.data.has(key)) {
      throw new Error('WRONGTYPE Operation not allowed');
    }
    return (this.lists.get(key) ?? []).length;
  }

  async zScore(key: string, member: string): Promise<number | null> {
    return this.zsets.get(key)?.get(member) ?? null;
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

  async zRangeWithScores(key: string, _min: number | string, _max: number | string, options?: { BY?: 'SCORE' | 'LEX'; REV?: boolean; LIMIT?: { offset: number; count: number } }): Promise<Array<{ value: string; score: number }>> {
    const zset = this.zsets.get(key);
    if (zset === undefined) {
      return [];
    }
    const entries = [...zset.entries()].map(([value, score]) => ({ value, score }));
    entries.sort((a, b) => (a.score !== b.score ? a.score - b.score : a.value < b.value ? 1 : -1));
    const ordered = options?.REV === true ? entries.reverse() : entries;
    return options?.LIMIT !== undefined ? ordered.slice(options.LIMIT.offset, options.LIMIT.offset + options.LIMIT.count) : ordered;
  }

  async scan(cursor: number | string, options?: { MATCH?: string; COUNT?: number }): Promise<{ cursor: string; keys: string[] }> {
    // Redis glob → regex (this store only ever uses literal + `*` patterns).
    const pattern = options?.MATCH ?? '*';
    const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    const keys = [...this.lists.keys(), ...this.data.keys(), ...this.zsets.keys()].filter((key) => regex.test(key));
    return { cursor: '0', keys };
  }

  /** Exact per-script emulation, matching the store's Lua contracts. */
  async eval(script: string, options?: { keys?: string[]; arguments?: string[] }): Promise<unknown> {
    const keys = (options?.keys ?? []) as string[];
    const args = (options?.arguments ?? []) as string[];
    this.evals.push({ script, keys, args });
    if (this.conflictInjection !== null) {
      await this.conflictInjection(keys);
    }
    if (script === APPEND_MESSAGE_WITH_INDEX_LUA) {
      const [listKey, indexKey] = keys as [string, string];
      const [entry, score, member] = args;
      const type = this.data.has(indexKey) ? 'string' : this.zsets.has(indexKey) ? 'zset' : 'none';
      if (type !== 'none' && type !== 'zset') return -1;
      await this.rPush(listKey, entry ?? '');
      await this.zAdd(indexKey, [{ value: member ?? '', score: Number(score ?? '0') }]);
      return 1;
    }
    if (script === CLEAR_ACTIVE_STREAM_LUA) {
      const [key] = keys as [string];
      if (this.alive(key) === args[0]) {
        await this.del(key);
        return 1;
      }
      return 0;
    }
    if (script === ANSWER_PENDING_ASK_USER_LUA) {
      const list = this.lists.get(keys[0] ?? '') ?? [];
      const idx = Number(args[0] ?? '-1');
      if (list[idx] === args[1]) {
        list[idx] = args[2] ?? '';
        return 1;
      }
      return 0;
    }
    if (script === CHAT_MODEL_GET_LUA) {
      const [modelKey] = keys as [string];
      const modelType = this.typeOf(modelKey);
      if (modelType !== 'none' && modelType !== 'string') return -3;
      const value = this.data.get(modelKey);
      return value === undefined ? '' : value;
    }
    if (script === DELETE_CHAT_LUA) {
      const [listKey, markerKey, indexKey, modelKey, metadataKey] = keys as [string, string, string, string, string];
      const [member] = args;
      const listType = this.typeOf(listKey);
      const markerType = this.typeOf(markerKey);
      const indexType = this.typeOf(indexKey);
      const modelType = this.typeOf(modelKey);
      const metadataType = this.metaTypeOf(metadataKey);
      if ((listType !== 'none' && listType !== 'list') || (markerType !== 'none' && markerType !== 'string') || (indexType !== 'none' && indexType !== 'zset') || (modelType !== 'none' && modelType !== 'string') || (metadataType !== 'none' && metadataType !== 'hash')) {
        return -3;
      }
      if (this.data.has(markerKey)) return -1;
      if (!this.lists.has(listKey)) return 0;
      this.lists.delete(listKey);
      this.data.delete(markerKey);
      this.data.delete(modelKey);
      this.metadata.delete(metadataKey);
      this.zsets.get(indexKey)?.delete(member ?? '');
      return 1;
    }
    if (script === BRANCH_CHAT_LUA) {
      const [listKey, indexKey, markerKey, srcModelKey, destModelKey] = keys as [string, string, string, string, string];
      const [member, score, ...entries] = args;
      const listType = this.typeOf(listKey);
      const markerType = this.typeOf(markerKey);
      const indexType = this.typeOf(indexKey);
      const srcModelType = this.typeOf(srcModelKey);
      const destModelType = this.typeOf(destModelKey);
      if ((listType !== 'none' && listType !== 'list') || (markerType !== 'none' && markerType !== 'string') || (indexType !== 'none' && indexType !== 'zset') || (srcModelType !== 'none' && srcModelType !== 'string') || (destModelType !== 'none' && destModelType !== 'string')) {
        return -3;
      }
      if ((this.lists.get(listKey) ?? []).length > 0) return -1;
      if (this.data.has(markerKey)) return -2;
      for (const entry of entries) {
        await this.rPush(listKey, entry);
      }
      await this.zAdd(indexKey, [{ value: member ?? '', score: Number(score ?? '0') }]);
      // Model copy: same-script GET src → SET dest.
      const srcModel = this.data.get(srcModelKey);
      if (srcModel !== undefined) {
        this.data.delete(destModelKey);
        this.lists.delete(destModelKey);
        this.data.set(destModelKey, srcModel);
      }
      return entries.length;
    }
    if (script === REWIND_CHAT_LUA) {
      const [listKey, indexKey] = keys as [string, string];
      const [expectedTail, expectedLen, expectedFirstRemoved, keepLastRaw, score, member] = args;
      const listType = this.typeOf(listKey);
      const indexType = this.typeOf(indexKey);
      if ((listType !== 'none' && listType !== 'list') || (indexType !== 'none' && indexType !== 'zset')) {
        return -3;
      }
      const list = this.lists.get(listKey) ?? [];
      if (list.length !== Number(expectedLen)) return -2;
      if (list.length > 0 && list[list.length - 1] !== expectedTail) return -2;
      const firstRemoved = Number(keepLastRaw) + 1;
      if (firstRemoved <= list.length - 1 && list[firstRemoved] !== expectedFirstRemoved) return -2;
      const removed = list.length - Number(keepLastRaw) - 1;
      this.lists.set(listKey, list.slice(0, Number(keepLastRaw) + 1));
      await this.zAdd(indexKey, [{ value: member ?? '', score: Number(score ?? '0') }]);
      return removed;
    }
    throw new Error(`unexpected script in MutationTinyRedis`);
  }
}

const RAW_HUGE = `{"id":"a1","role":"assistant","parts":[{"type":"text","text":"big"},{"type":"tool-ask_user","toolCallId":"tc","state":"output-available","output":{"answer":"a"},"input":{"q":"q","options":[],"meta":{"big":12345678901234567890,"tiny":1.5}}}]}`;
const RAW_USER_1 = JSON.stringify({ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'first message payload' }] });
const RAW_USER_2 = JSON.stringify({ id: 'u2', role: 'user', parts: [{ type: 'text', text: 'second message payload' }] });

/** Types a snapshot entry for assertions on the RAW round-trip. */
function parsedId(entry: unknown): string {
  return (entry as { id?: unknown }).id as string;
}

// ---------------------------------------------------------------------------
// Store-level (Redis scripts, MutationTinyRedis)
// ---------------------------------------------------------------------------

test('chat-mutations store: delete removes messages/marker/index + this chat idempotency keys only', async () => {
  const redis = new MutationTinyRedis();
  const store = createRedisChatStore(redis, { now: () => 5_000 });
  const chat: ChatRef = { ownerId: 'owner-a', slug: 'general', chatId: 'c-del' };
  await store.appendMessage(chat, { id: 'u1', role: 'user', parts: [] } as never);
  await store.appendMessage(chat, { id: 'a1', role: 'assistant', parts: [] } as never);
  await store.acquireIdempotencyKey(chat, 'c-del:u1', IDEMPOTENCY_KEY_TTL_SECONDS);
  await store.setActiveStreamId(chat, 'strm-1');

  // Busy refusal while the generation runs.
  assert.deepEqual(await store.deleteChat(chat), { status: 'busy', removedIdempotencyKeys: 0 });
  assert.ok((await store.loadMessages(chat)).length > 0, 'busy delete touches nothing');

  // Marker cleared exactly → delete succeeds and cleans every surface.
  assert.equal(await store.clearActiveStreamId(chat, 'strm-1'), true);
  const result = await store.deleteChat(chat);
  assert.equal(result.status, 'deleted');
  assert.ok(result.removedIdempotencyKeys >= 1, 'the chat-scoped idempotency key was removed');

  // Everything of this chat is gone.
  assert.deepEqual(await store.loadMessages(chat), [], 'messages list deleted');
  assert.equal(await store.getActiveStreamId(chat), null);
  assert.equal(await store.acquireIdempotencyKey(chat, 'c-del:u1', 900), true, 'stale key gone: prompt regenerable');
  // Index member (per owner) removed: listing is empty afterwards.
  const indexKey = chatIndexKey(chat.ownerId);
  assert.equal((redis.zsets.get(indexKey)?.get('general:c-del') ?? null), null, `${indexKey} holds no member`);

  // Idempotent second delete: not-found.
  assert.deepEqual(await store.deleteChat(chat), { status: 'not-found', removedIdempotencyKeys: 0 });
  // And a foreign chat's keys/data stay untouched.
  const other: ChatRef = { ownerId: 'owner-b', slug: 'general', chatId: 'c-del' };
  await store.appendMessage(other, { id: 'u-b', role: 'user', parts: [] } as never);
  await store.acquireIdempotencyKey(other, 'c-del:u-b', IDEMPOTENCY_KEY_TTL_SECONDS);
  assert.deepEqual(await store.deleteChat(chat), { status: 'not-found', removedIdempotencyKeys: 0 });
  assert.equal((await store.loadMessages(other)).length, 1, 'other owner chat untouched');
  await store.deleteChat(other);
  assert.ok(!redis.data.has(`${REDIS_KEY_PREFIX}:idempotency:owner-b:general:c-del:c-del:u-b`), 'foreign chat cleanup is its own owner scope');
});

test('chat-mutations store: branch copies exact raw bytes through the message into an empty destination', async () => {
  const redis = new MutationTinyRedis();
  const store = createRedisChatStore(redis, { now: () => 5_000 });
  const chat: ChatRef = { ownerId: 'owner-a', slug: 'general', chatId: 'c-src' };
  await redis.rPush(`${REDIS_KEY_PREFIX}:chat:owner-a:general:c-src:messages`, RAW_USER_1);
  await redis.rPush(`${REDIS_KEY_PREFIX}:chat:owner-a:general:c-src:messages`, RAW_HUGE);
  await redis.rPush(`${REDIS_KEY_PREFIX}:chat:owner-a:general:c-src:messages`, RAW_USER_2);
  await redis.zAdd(chatIndexKey('owner-a'), [{ value: 'general:c-src', score: 1_000 }]);
  await store.setActiveStreamId(chat, 'strm-src');

  const result = await store.branchChat(chat, { messageId: 'a1', newChatId: 'c-clone' });
  assert.deepEqual(result, { status: 'branched', copiedMessages: 2 }, 'copies THROUGH the selected message inclusive');

  const destination = { ...chat, chatId: 'c-clone' } as ChatRef;
  const copied = await store.loadMessages(destination);
  assert.deepEqual(copied.map(parsedId), ['u1', 'a1'], 'the selected point is the LAST message');
  // EXACT raw bytes: RAW storage entries are byte-identical (huge literals/
  // options arrays survive untouched — loadMessages PARSES, so re-stringify
  // must never be used for byte assertions).
  assert.deepEqual(
    await redis.lRange(`${REDIS_KEY_PREFIX}:chat:owner-a:general:c-clone:messages`, 0, -1),
    [RAW_USER_1, RAW_HUGE],
    'byte-exact raw copy',
  );
  const parsedHuge = (copied[1] as { parts: Array<{ input?: { meta?: { big?: number; tiny?: number } } }> }).parts;
  assert.equal((parsedHuge[1]?.input?.meta?.big ?? 0) === 12345678901234567890, true, 'huge integer survives JSON.parse as a double');
  assert.equal((parsedHuge[1]?.input?.meta?.tiny ?? 0) === 1.5, true);

  // Source NEVER changes (messages + active marker + order).
  assert.deepEqual((await store.loadMessages(chat)).map(parsedId), ['u1', 'a1', 'u2']);
  assert.equal(await store.getActiveStreamId(chat), 'strm-src');
  // Destination: no marker, indexed for the sidebar.
  assert.equal(await store.getActiveStreamId(destination), null);
  assert.ok((await redis.zRangeWithScores(chatIndexKey('owner-a'), '+inf', '-inf')).some((entry) => entry.value === 'general:c-clone'), 'destination index member written');

  // Conflicts + lookups.
  assert.deepEqual(await store.branchChat(chat, { messageId: 'a1', newChatId: 'c-clone' }), { status: 'destination-conflict', copiedMessages: 0 }, 'nonempty destination refuses');
  assert.deepEqual(await store.branchChat(chat, { messageId: 'a1', newChatId: 'c-src' }), { status: 'destination-conflict', copiedMessages: 0 }, 'branching into itself refuses');
  assert.deepEqual(await store.branchChat(chat, { messageId: 'nope', newChatId: 'c-empty2' }), { status: 'message-not-found', copiedMessages: 0 });
  assert.deepEqual(await store.branchChat({ ...chat, chatId: 'ghost' }, { messageId: 'u1', newChatId: 'c-x' }), { status: 'chat-not-found', copiedMessages: 0 });
  // The rejected attempts did not create anything.
  assert.equal((redis.lists.get(`${REDIS_KEY_PREFIX}:chat:owner-a:general:c-empty2:messages`) ?? []).length, 0);
  assert.equal((redis.lists.get(`${REDIS_KEY_PREFIX}:chat:owner-a:general:c-x:messages`) ?? []).length, 0);
});

test('chat-mutations store: rewind removes only the tail with byte-exact CAS; removed user keys released', async () => {
  const redis = new MutationTinyRedis();
  const store = createRedisChatStore(redis, { now: () => 6_000 });
  const chat: ChatRef = { ownerId: 'owner-a', slug: 'general', chatId: 'c-rw' };
  await redis.rPush(`${REDIS_KEY_PREFIX}:chat:owner-a:general:c-rw:messages`, RAW_USER_1);
  await redis.rPush(`${REDIS_KEY_PREFIX}:chat:owner-a:general:c-rw:messages`, RAW_HUGE);
  await redis.rPush(`${REDIS_KEY_PREFIX}:chat:owner-a:general:c-rw:messages`, RAW_USER_2);
  // Seed idempotency keys for both user turns (as the chat POST would).
  await store.acquireIdempotencyKey(chat, 'c-rw:u1', IDEMPOTENCY_KEY_TTL_SECONDS);
  await store.acquireIdempotencyKey(chat, 'c-rw:u2', IDEMPOTENCY_KEY_TTL_SECONDS);

  const result = await store.rewindChat(chat, 'a1');
  assert.deepEqual(result, { status: 'applied', kept: 2, removed: 1 });
  const kept = await store.loadMessages(chat);
  assert.deepEqual(kept.map(parsedId), ['u1', 'a1'], 'tail removed THROUGH the selected message inclusive');
  // Raw bytes of KEPT entries untouched (LTRIM, never cjson re-serialization).
  assert.deepEqual(
    await redis.lRange(`${REDIS_KEY_PREFIX}:chat:owner-a:general:c-rw:messages`, 0, -1),
    [RAW_USER_1, RAW_HUGE],
    'kept raw entries are byte-identical',
  );

  // Removed user turn's key is GONE; the KEPT turn's key survives.
  assert.equal(await store.acquireIdempotencyKey(chat, 'c-rw:u2', 900), true, 'removed prompt regenerable');
  await store.releaseIdempotencyKey(chat, 'c-rw:u2');
  assert.equal(await store.acquireIdempotencyKey(chat, 'c-rw:u1', 900), false, 'kept turn key untouched');

  // Unknown message / unknown chat.
  assert.deepEqual(await store.rewindChat(chat, 'nope'), { status: 'message-not-found', kept: 0, removed: 0 });
  assert.deepEqual(await store.rewindChat({ ...chat, chatId: 'ghost' }, 'u1'), { status: 'chat-not-found', kept: 0, removed: 0 });
});

test('chat-mutations store: rewind CAS loses to a concurrent append and reports stale', async () => {
  const redis = new MutationTinyRedis();
  const store = createRedisChatStore(redis, { now: () => 6_000 });
  const chat: ChatRef = { ownerId: 'owner-a', slug: 'general', chatId: 'c-race' };
  await redis.rPush(`${REDIS_KEY_PREFIX}:chat:owner-a:general:c-race:messages`, RAW_USER_1);
  await redis.rPush(`${REDIS_KEY_PREFIX}:chat:owner-a:general:c-race:messages`, RAW_USER_2);
  // Inject a concurrent append BEFORE EVERY script evaluation (persistent):
  // the CAS can never match, so all retries lose — the exact 'stale' path.
  redis.conflictInjection = async (keys) => {
    await redis.rPush(keys[0] ?? '', JSON.stringify({ id: 'u-x', role: 'user', parts: [] }));
  };
  const result = await store.rewindChat(chat, 'u1');
  assert.deepEqual(result, { status: 'stale', kept: 0, removed: 0 }, 'bounded CAS retries exhausted');
  assert.ok((await store.loadMessages(chat)).length > 2, 'nothing was trimmed');
});

test('chat-mutations store: wrongtype surfaces as StoreUnavailableError with no partial writes', async () => {
  const redis = new MutationTinyRedis();
  const store = createRedisChatStore(redis, { now: () => 6_000 });
  const chat: ChatRef = { ownerId: 'owner-a', slug: 'general', chatId: 'c-wrong' };
  await redis.rPush(`${REDIS_KEY_PREFIX}:chat:owner-a:general:c-wrong:messages`, RAW_USER_1);
  // Corrupt the destination INDEX key (a string where a zset belongs).
  await redis.set(chatIndexKey('owner-a') === 'x' ? 'x' : `${REDIS_KEY_PREFIX}:chat-index:owner-a`, 'not-a-zset');
  await assert.rejects(
    () => store.branchChat(chat, { messageId: 'u1', newChatId: 'c-clone-wrong' }),
    (error: { name: string }) => error.name === 'StoreUnavailableError',
  );
  assert.equal((redis.lists.get(`${REDIS_KEY_PREFIX}:chat:owner-a:general:c-clone-wrong:messages`) ?? []).length, 0, 'no partial copy');
  // Corrupt the SOURCE list (string where a list belongs) → branch + rewind refuse loudly.
  await redis.del(`${REDIS_KEY_PREFIX}:chat-index:owner-a`);
  await redis.set(`${REDIS_KEY_PREFIX}:chat:owner-a:general:c-wrong:messages`, 'not-a-list');
  await assert.rejects(
    () => store.branchChat(chat, { messageId: 'u1', newChatId: 'c-clone-wrong' }),
    (error: { name: string }) => error.name === 'StoreUnavailableError',
  );
  await assert.rejects(
    () => store.rewindChat(chat, 'u1'),
    (error: { name: string }) => error.name === 'StoreUnavailableError',
  );
  await assert.rejects(
    () => store.deleteChat(chat),
    (error: { name: string }) => error.name === 'StoreUnavailableError',
  );
});

// ---------------------------------------------------------------------------
// In-memory parity
// ---------------------------------------------------------------------------

test('chat-mutations memory store: exact contract parity with the Redis store', async () => {
  const store = createInMemoryChatStore({ now: () => 5_000 });
  const chat: ChatRef = { ownerId: 'owner-a', slug: 'general', chatId: 'c-par' };
  const u1 = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'one' }] } as unknown as UIMessage;
  const a1 = { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: `{"big":12345678901234567890}` }] } as unknown as UIMessage;
  const u2 = { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'two' }] } as unknown as UIMessage;
  await store.appendMessage(chat, u1);
  await store.appendMessage(chat, a1);
  await store.appendMessage(chat, u2);
  await store.acquireIdempotencyKey(chat, 'c-par:u1', IDEMPOTENCY_KEY_TTL_SECONDS);
  await store.acquireIdempotencyKey(chat, 'c-par:u2', IDEMPOTENCY_KEY_TTL_SECONDS);
  await store.setActiveStreamId(chat, 'strm-p');

  // delete + branch + rewind all refuse while active.
  assert.deepEqual(await store.deleteChat(chat), { status: 'busy', removedIdempotencyKeys: 0 });
  await store.snapshot(chat); // sanity no-throw
  const branchResult = await store.branchChat(chat, { messageId: 'a1', newChatId: 'c-par-clone' });
  assert.deepEqual(branchResult, { status: 'branched', copiedMessages: 2 }, 'branch allowed mid-generation (source untouched)');
  const clone = { ...chat, chatId: 'c-par-clone' } as ChatRef;
  assert.deepEqual((await store.snapshot(clone)).messages.map(parsedId), ['u1', 'a1']);
  assert.equal(JSON.stringify((await store.loadMessages(clone))[1]).includes('12345678901234567890'), true, 'in-memory raw bytes preserved identical');

  await store.clearActiveStreamId(chat, 'strm-p');
  const rewind = await store.rewindChat(chat, 'a1');
  assert.deepEqual(rewind, { status: 'applied', kept: 2, removed: 1 });
  assert.equal(await store.acquireIdempotencyKey(chat, 'c-par:u2', 900), true, 'removed key released');
  await store.releaseIdempotencyKey(chat, 'c-par:u2');
  assert.equal(await store.acquireIdempotencyKey(chat, 'c-par:u1', 900), false, 'kept key untouched');

  const delResult = await store.deleteChat(chat);
  assert.equal(delResult.status, 'deleted');
  assert.ok(delResult.removedIdempotencyKeys >= 1);
  assert.deepEqual(await store.loadMessages(chat), []);
  assert.deepEqual(await store.deleteChat(chat), { status: 'not-found', removedIdempotencyKeys: 0 });
});

test('chat-mutations store: model setting branches, survives rewind, dies with delete', async () => {
  const redis = new MutationTinyRedis();
  const store = createRedisChatStore(redis, { now: () => 5_000 });
  const chat: ChatRef = { ownerId: 'owner-a', slug: 'general', chatId: 'c-mod' };
  await store.appendMessage(chat, { id: 'u1', role: 'user', parts: [] } as never);
  await store.appendMessage(chat, { id: 'a1', role: 'assistant', parts: [] } as never);

  // None → null; set → round-trip; unset → null.
  assert.equal(await store.getChatModel(chat), null);
  await store.setChatModel(chat, 'glm-5.3-flash');
  assert.equal(await store.getChatModel(chat), 'glm-5.3-flash');
  await store.setChatModel(chat, 'gpt-oss:20b');
  assert.equal(await store.getChatModel(chat), 'gpt-oss:20b');
  await store.setChatModel(chat, null);
  assert.equal(await store.getChatModel(chat), null);
  await store.setChatModel(chat, 'glm-5.3-flash');

  // REWIND preserves the setting (it rewinds messages only).
  const rewind = await store.rewindChat(chat, 'a1');
  assert.deepEqual(rewind, { status: 'applied', kept: 2, removed: 0 });
  assert.equal(await store.getChatModel(chat), 'glm-5.3-flash');

  // BRANCH copies the model atomically into the destination (and a second
  // branch from an UNSET source leaves the dest unset).
  await store.branchChat(chat, { messageId: 'a1', newChatId: 'c-mod-clone' });
  assert.equal(await store.getChatModel({ ...chat, chatId: 'c-mod-clone' }), 'glm-5.3-flash');
  await store.setChatModel(chat, null);
  await store.branchChat(chat, { messageId: 'a1', newChatId: 'c-mod-clone2' });
  assert.equal(await store.getChatModel({ ...chat, chatId: 'c-mod-clone2' }), null);

  // DELETE removes the setting together with everything else of the chat.
  await store.setChatModel(chat, 'glm-5.3-flash');
  const del = await store.deleteChat(chat);
  assert.equal(del.status, 'deleted');
  assert.equal(await store.getChatModel(chat), null);
  // The copied clone's model survives the source's deletion.
  assert.equal(await store.getChatModel({ ...chat, chatId: 'c-mod-clone' }), 'glm-5.3-flash');
});

test('chat-mutations memory store: model get/set parity (unset/round-trip/delete)', async () => {
  const store = createInMemoryChatStore({ now: () => 5_000 });
  const chat: ChatRef = { ownerId: 'owner-a', slug: 'general', chatId: 'c-mem-mod' };
  assert.equal(await store.getChatModel(chat), null);
  await store.setChatModel(chat, 'gpt-oss:20b');
  assert.equal(await store.getChatModel(chat), 'gpt-oss:20b');
  await store.branchChat(chat, { messageId: 'x', newChatId: 'c-mem-mod-c' }).catch(() => undefined);
  await store.setChatModel(chat, null);
  assert.equal(await store.getChatModel(chat), null);
});

// ---------------------------------------------------------------------------
// Route-level (real Express app + auth/owner gate)
// ---------------------------------------------------------------------------

interface MutationApp {
  app: Awaited<ReturnType<typeof startTestApp>>;
  store: ChatStore;
}

async function mutationApp(): Promise<MutationApp> {
  const store = createInMemoryChatStore({ now: () => 5_000 });
  const app = await startTestApp({ store, model: createMockModel({ steps: [textStep()] }) });
  return { app, store };
}

test('chat-mutations route: DELETE is owner-scoped, fixed404 for unknown/foreign, fixed409 while active', async () => {
  const { app, store } = await mutationApp();
  try {
    await seedMessages(store, { ownerId: TEST_OWNER.userId, slug: 'general', chatId: 'rm-a' }, [userMessage('mine', 'u1')]);
    await seedMessages(store, { ownerId: TEST_OWNER_B.userId, slug: 'general', chatId: 'rm-a' }, [userMessage('theirs', 'u1')]);
    await store.setActiveStreamId({ ownerId: TEST_OWNER.userId, slug: 'general', chatId: 'rm-b' }, 'strm-live');
    await seedMessages(store, { ownerId: TEST_OWNER.userId, slug: 'general', chatId: 'rm-b' }, [userMessage('busy', 'u1')]);

    // Unknown chat (same owner): fixed 404.
    const missing = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/never-existed`, { method: 'DELETE' });
    assert.equal(missing.status, 404);
    assert.deepEqual((await missing.json()) as unknown, { error: 'Chat not found.' });

    // Active stream: fixed 409, chat intact.
    const busy = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/rm-b`, { method: 'DELETE' });
    assert.equal(busy.status, 409);
    assert.deepEqual((await busy.json()) as unknown, { error: 'Chat has an active generation. Resume or wait.' });
    assert.equal((await store.loadMessages({ ownerId: TEST_OWNER.userId, slug: 'general', chatId: 'rm-b' })).length, 1);

    // Cross-owner SAME chat id: deleting as TEST_OWNER never touches B's data.
    const deleted = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/rm-a`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    const deletedBody = (await deleted.json()) as { deleted: boolean; purgedPersonalMemoryBlocks?: number };
    assert.equal(deletedBody.deleted, true);
    assert.deepEqual(await store.loadMessages({ ownerId: TEST_OWNER.userId, slug: 'general', chatId: 'rm-a' }), []);
    assert.equal((await store.loadMessages({ ownerId: TEST_OWNER_B.userId, slug: 'general', chatId: 'rm-a' })).length, 1, "owner B's same-id chat untouched");
    const foreignList = (await getJson({ port: app.port, path: '/api/chats' })).body as { chats: Array<{ chatId: string }> };
    assert.equal(foreignList.chats.some((chat) => chat.chatId === 'rm-a'), false, "owner B's chat stays in owner B's index");
  } finally {
    await app.close();
  }
});

test('chat-mutations route: DELETE invalid chat id is a fixed 400', async () => {
  const { app } = await mutationApp();
  try {
    const unsafe = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/bad%2Fid`, { method: 'DELETE' });
    assert.equal(unsafe.status, 400);
    assert.deepEqual((await unsafe.json()) as unknown, { error: 'clientChatId must be 1-64 characters of A-Z a-z 0-9 _ -' });
  } finally {
    await app.close();
  }
});

test('chat-mutations route: branch is owner-scoped with fixed body/id/message/destination errors', async () => {
  const { app, store } = await mutationApp();
  try {
    await store.appendMessage({ ownerId: TEST_OWNER.userId, slug: 'general', chatId: 'br-a' }, userMessage('first payload', 'u1'));
    await store.appendMessage({ ownerId: TEST_OWNER.userId, slug: 'general', chatId: 'br-a' }, { id: 'a1', role: 'assistant', parts: [], metadata: {} } as never);
    await store.appendMessage({ ownerId: TEST_OWNER.userId, slug: 'general', chatId: 'br-a' }, userMessage('second payload', 'u2'));

    const branchUrl = `http://127.0.0.1:${app.port}/api/agents/general/chat/br-a/branch`;
    // Invalid ids → fixed 400.
    const unsafeNew = await fetch(branchUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'u2', newChatId: 'bad/id' }),
    });
    assert.equal(unsafeNew.status, 400);
    // Malformed body → fixed 400.
    const junk = await fetch(branchUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'u2' }),
    });
    assert.equal(junk.status, 400);
    // Unknown message → fixed 404.
    const unknownMessage = await fetch(branchUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'nope', newChatId: 'br-clone' }),
    });
    assert.equal(unknownMessage.status, 404);
    assert.deepEqual((await unknownMessage.json()) as unknown, { error: 'Message not found.' });
    // Unknown SOURCE chat → fixed 404.
    const unknownSource = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/ghost/branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'u1', newChatId: 'br-clone' }),
    });
    assert.equal(unknownSource.status, 404);
    assert.deepEqual((await unknownSource.json()) as unknown, { error: 'Chat not found.' });

    // Success: 201, copies through the selected message into the NEW chat.
    const branched = await fetch(branchUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'a1', newChatId: 'br-clone' }),
    });
    assert.equal(branched.status, 201);
    assert.deepEqual((await branched.json()) as unknown, { branched: true, destinationChatId: 'br-clone', copiedMessages: 2 });

    // Destination content + source untouched (+ still active during branch).
    const destination = await getJson({ port: app.port, path: '/api/agents/general/chat/br-clone' });
    assert.deepEqual(
      ((destination.body as { messages: Array<{ id: string }> }).messages).map((m) => m.id),
      ['u1', 'a1'],
    );
    const source = await getJson({ port: app.port, path: '/api/agents/general/chat/br-a' });
    assert.deepEqual(
      ((source.body as { messages: Array<{ id: string }> }).messages).map((m) => m.id),
      ['u1', 'a1', 'u2'],
    );
    // Second branch attempt on the now-NONEMPTY destination → fixed 409.
    const conflict = await fetch(branchUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'u1', newChatId: 'br-clone' }),
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual((await conflict.json()) as unknown, { error: 'Destination chat already exists.' });

    // Cross-owner SAME chat id: owner B cannot see/branch owner A's source.
    const foreignBranch = await startTestApp({ store, model: createMockModel({ steps: [textStep()] }), auth: { staticOwner: TEST_OWNER_B } });
    try {
      const foreign = await fetch(`http://127.0.0.1:${foreignBranch.port}/api/agents/general/chat/br-a/branch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: 'u1', newChatId: 'br-clone' }),
      });
      assert.equal(foreign.status, 404, 'a foreign owner cannot even read the source');
      assert.deepEqual((await foreign.json()) as unknown, { error: 'Chat not found.' });
    } finally {
      await foreignBranch.close();
    }
  } finally {
    await app.close();
  }
});

test('chat-mutations route: rewind keeps raw bytes, releases removed-user keys only, refuses while active', async () => {
  const { app, store } = await mutationApp();
  try {
    const owner = { ownerId: TEST_OWNER.userId, slug: 'general', chatId: 'rw-a' } as ChatRef;
    // Order: [u1, a1, u2, a2] — rewinding through a1 (the assistant message)
    // removes the LATER user turn u2 + assistant a2: only u2's key releases.
    await seedMessages(store, owner, [userMessage('first question text', 'u1')]);
    await store.appendMessage(owner, { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'first answer' }] } as never);
    await store.appendMessage(owner, userMessage('second question text', 'u2'));
    await store.appendMessage(owner, { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'tail answer' }] } as never);
    await store.acquireIdempotencyKey(owner, 'rw-a:u1', IDEMPOTENCY_KEY_TTL_SECONDS);
    await store.acquireIdempotencyKey(owner, 'rw-a:u2', IDEMPOTENCY_KEY_TTL_SECONDS);
    await store.setActiveStreamId(owner, 'strm-rw');

    const rewindUrl = `http://127.0.0.1:${app.port}/api/agents/general/chat/rw-a/rewind`;
    // Active stream: fixed 409, nothing trimmed.
    const busy = await fetch(rewindUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'u1' }),
    });
    assert.equal(busy.status, 409);
    assert.deepEqual((await busy.json()) as unknown, { error: 'Chat has an active generation. Resume or wait.' });
    assert.equal((await store.loadMessages(owner)).length, 4);

    await store.clearActiveStreamId(owner, 'strm-rw');
    // Unknown message → 404; malformed body → 400.
    const unknownMessage = await fetch(rewindUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'ghost' }),
    });
    assert.equal(unknownMessage.status, 404);
    assert.deepEqual((await unknownMessage.json()) as unknown, { error: 'Message not found.' });
    const junk = await fetch(rewindUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nope: 1 }),
    });
    assert.equal(junk.status, 400);
    // Unknown chat → 404.
    const missing = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/ghost/rewind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'u1' }),
    });
    assert.equal(missing.status, 404);

    // Rewind through a1: removes u2 + a2 → kept [u1, a1].
    const rewound = await fetch(rewindUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'a1' }),
    });
    assert.equal(rewound.status, 200);
    const rewoundBody = (await rewound.json()) as { rewound: boolean; kept: number; removed: number; hasActiveStream: boolean };
    assert.deepEqual({ ...rewoundBody, purgedPersonalMemoryBlocks: undefined }, { rewound: true, kept: 2, removed: 2, hasActiveStream: false, purgedPersonalMemoryBlocks: undefined });

    const kept = await store.loadMessages(owner);
    assert.deepEqual(kept.map(parsedId), ['u1', 'a1'], 'tail u2+a2 removed; kept raw entries untouched');
    // Removed user turn u2's key released; KEPT u1 key survives.
    assert.equal(await store.acquireIdempotencyKey(owner, 'rw-a:u2', 900), true, 'removed prompt regenerable');
    await store.releaseIdempotencyKey(owner, 'rw-a:u2');
    assert.equal(await store.acquireIdempotencyKey(owner, 'rw-a:u1', 900), false);

    // Hydration state: no active stream.
    const hydration = await getJson({ port: app.port, path: '/api/agents/general/chat/rw-a' });
    assert.equal((hydration.body as { hasActiveStream: boolean }).hasActiveStream, false);
  } finally {
    await app.close();
  }
});

test('chat-mutations route: rewind+regenerate round-trip with a mock model keeps raw bytes', async () => {
  const store = createInMemoryChatStore({ now: () => 5_000 });
  const app = await startTestApp({ store, model: createMockModel({ steps: [textStep()] }) });
  try {
    const owner = { ownerId: TEST_OWNER.userId, slug: 'general', chatId: 'rr-1' } as ChatRef;
    const body = { id: 'rr-1', message: userMessage('the same prompt', 'u1') };
    const idem = { 'Idempotency-Key': 'rr-1:u1' };

    // Round 1: generate (user+assistant stored).
    const first = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...idem },
      body: JSON.stringify(body),
    });
    assert.equal(first.status, 200);
    await first.text();

    // Round 2 with the SAME key → 409 (exactly-once per message).
    const duplicate = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...idem },
      body: JSON.stringify(body),
    });
    assert.equal(duplicate.status, 409);

    // Rewind to the assistant message → the tail survives, nothing removed.
    const rewound = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/rr-1/rewind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'u1' }),
    });
    assert.equal(rewound.status, 200);
    const rewindBody = (await rewound.json()) as { kept: number; removed: number };
    assert.equal(rewindBody.removed, 1, 'the assistant reply was removed; u1 kept');

    // The removed turn's key belonged to the ASSISTANT-only tail; the KEPT
    // user key survives → the SAME prompt still 409s (regeneration requires a
    // NEW message id, exactly the chat contract).
    const regenerateId = 'u1-regen';
    const regenerate = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': `rr-1:${regenerateId}` },
      body: JSON.stringify({ id: 'rr-1', message: userMessage('the same prompt', regenerateId) }),
    });
    assert.equal(regenerate.status, 200, 'a new message id CAN regenerate after rewind');
    await regenerate.text();
    const hydrated = await getJson({ port: app.port, path: '/api/agents/general/chat/rr-1' });
    assert.deepEqual(
      ((hydrated.body as { messages: Array<{ id: string }> }).messages).map((m) => m.id),
      ['u1', regenerateId],
    );
    // The kept entries' bytes never changed (append-only preserved).
    const before = store.snapshot(owner).messages.map((entry) => (entry as { id: string }).id);
    assert.deepEqual(before, ['u1', regenerateId]);
  } finally {
    await app.close();
  }
});
