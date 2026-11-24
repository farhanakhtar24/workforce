/**
 * Real-stack integration suite for the recent-chat history API
 * (`GET /api/chats`, Phase 6 UX): the PRODUCTION `createRedisChatStore`
 * (atomic RPUSH+ZADD Lua activity index) over real node-redis connections,
 * through the real Express app with a deterministic mock model — plus RAW
 * Redis writes that model pre-index ("legacy") chats exactly how they exist
 * on an upgraded install.
 *
 * Proven here (only a real Redis can):
 * - legacy SCAN discovery: message lists written OUTSIDE the store are found
 *   by the bounded read-only SCAN; corrupt entries and roster-foreign keys
 *   are skipped safely, and legacy summaries carry `lastActivityAt: null`
 *   (never fabricated);
 * - indexed write order: a POST through the real app lists newest-activity
 *   FIRST with an ISO timestamp, legacy chats deterministically after it;
 * - append/index atomicity: the store's own Lua script lands the LIST entry
 *   and the index member together on real Redis, and refuses BOTH (the real
 *   `-1` wrongtype path) without ever touching the shared index key.
 *
 * Requirements:
 * - Redis reachable at REDIS_URL (default redis://127.0.0.1:6379). Start the
 *   stack from the repo root: `docker compose up -d redis`.
 * - Run only this suite: `npm run test:integration --workspace @workforce/api`
 *   (normal `npm test` stays offline and never touches Redis).
 *
 * Determinism and hygiene: every chat id / key this suite creates is unique
 * per run (pid + timestamp) and cleanup deletes EXACTLY those keys plus the
 * suite's own index members (ZREM) — no FLUSH, no KEYS, no DELETE of anything
 * shared; the wrongtype probe uses its own unique string key, never the
 * shared index. On a dev Redis already holding many legacy chats, bounded
 * discovery may not surface every chat of the run; assertions therefore
 * filter to THIS RUN's chats (unique RUN_ID prefix).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, type RedisClientType } from 'redis';
import type { LanguageModel, UIMessage } from 'ai';
import type { Server } from 'node:http';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { createBackgroundTracker, type BackgroundTaskTracker } from '../src/background.js';
import { loadApiConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import {
  APPEND_MESSAGE_WITH_INDEX_LUA,
  chatIndexKey,
  createRedisChatStore,
  REDIS_KEY_PREFIX,
  type RedisLike,
} from '../src/store/redis.js';
import { createResumableStreamAdapter } from '../src/stream-context/resumable.js';
import { StoreUnavailableError } from '../src/errors.js';
import { createMockModel, TEST_ORIGINAL_ORIGIN } from '../test/helpers.js';
import type { ChatSummary } from '../src/store/types.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
/** Unique per run so parallel/repeat runs never collide in the shared Redis. */
const RUN_ID = `hist-${process.pid.toString(36)}-${Date.now().toString(36)}`;
const STREAM_KEY_PREFIX = `workforce:phase2:stream-live-test:${RUN_ID}`;
const SLUG = 'general';
/** The live tests exercise ONE owner: key shapes are owner-scoped (pre-Phase 6). */
const OWNER_ID = `owner-${RUN_ID}`;
const indexKey = (): string => `${REDIS_KEY_PREFIX}:chat-index:${OWNER_ID}`;
const INDEXED_CHAT_ID = `${RUN_ID}-live-post`;
const LEGACY_A_ID = `${RUN_ID}-legacy-a`;
const LEGACY_B_ID = `${RUN_ID}-legacy-b`;
const FOREIGN_ID = `${RUN_ID}-foreign`;
const WRONGTYPE_KEY = `${REDIS_KEY_PREFIX}:chat-index-wrongtype-probe:${RUN_ID}`;
const GHOST_MEMBER = `${SLUG}:${RUN_ID}-ghost-refused`;
const USER_MESSAGE_ID = 'm-live-hist';
const IDEMPOTENCY_KEY = `${INDEXED_CHAT_ID}:${USER_MESSAGE_ID}`;
const REDIS_TIMEOUT_MS = 2_500;

interface LiveStack {
  base: RedisClientType;
  port: number;
  /** Registers one more exact Redis key to delete on close (never a SCAN). */
  ownKey(key: string): string;
  /** Registers one more index member to ZREM on close. */
  ownIndexMember(member: string): string;
  close(): Promise<void>;
}

function messagesKey(chatId: string, slug = SLUG): string {
  return `${REDIS_KEY_PREFIX}:chat:${OWNER_ID}:${slug}:${chatId}:messages`;
}
function activeStreamKey(chatId: string): string {
  return `${REDIS_KEY_PREFIX}:chat:${OWNER_ID}:${SLUG}:${chatId}:active-stream`;
}
function idempotencyKey(chatId: string, key: string): string {
  return `${REDIS_KEY_PREFIX}:idempotency:${OWNER_ID}:${SLUG}:${chatId}:${key}`;
}

/** Bounded wait around an explicit condition — never an arbitrary sleep. */
async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`${message} (waited ${Date.now() - started}ms)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Test clients never auto-reconnect: failures fail the test instead of hanging it. */
function liveClient(): RedisClientType {
  return createClient({
    url: REDIS_URL,
    socket: { reconnectStrategy: false, connectTimeout: REDIS_TIMEOUT_MS },
  });
}

/** Connects with a short bounded timeout; an offline environment must fail loudly. */
async function connectOrDie(client: RedisClientType): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('probe timeout')), REDIS_TIMEOUT_MS);
  });
  try {
    await Promise.race([client.connect(), timeout]);
  } catch {
    assert.fail(
      'Redis is not reachable for the configured REDIS_URL (default redis://127.0.0.1:6379). ' +
        'Start it from the repo root with `docker compose up -d redis`, then re-run: ' +
        '`npm run test:integration --workspace @workforce/api`. ' +
        'The normal offline suite (`npm test`) does not need Redis.',
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Single-step deterministic text model, mock only. */
function oneTextStep(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    {
      type: 'finish',
      usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
      finishReason: { unified: 'stop', raw: undefined },
    },
  ];
}

function isRunChat(chat: ChatSummary): boolean {
  return chat.chatId.includes(RUN_ID);
}

/**
 * Connects three node-redis connections (base + publisher + subscriber),
 * builds the real store + real resumable-stream adapter + real app with an
 * injected mock model, and owns exactly the run-scoped keys for cleanup.
 */
async function createLiveStack(model: LanguageModel | null): Promise<LiveStack & { background: BackgroundTaskTracker }> {
  const base = liveClient();
  const publisher = liveClient();
  const subscriber = liveClient();
  for (const client of [base, publisher, subscriber]) {
    client.on('error', () => undefined);
  }
  await connectOrDie(base);
  await connectOrDie(publisher);
  await connectOrDie(subscriber);

  const background = createBackgroundTracker({ onError: () => undefined });
  const ownedKeys = new Set<string>();
  const ownedMembers = new Set<string>();
  const ownKey = (key: string): string => {
    ownedKeys.add(key);
    return key;
  };
  const ownIndexMember = (member: string): string => {
    ownedMembers.add(member);
    return member;
  };

  const store = createRedisChatStore(base as unknown as RedisLike);
  const streamContext = createResumableStreamAdapter({
    waitUntil: background.track,
    publisher,
    subscriber,
    keyPrefix: STREAM_KEY_PREFIX,
  });
  const config = loadApiConfig({ OLLAMA_API_KEY: 'test-only-not-a-real-key', PORT: '3001', REDIS_URL });
  // Test-only owner injection (never a production bypass): the whole suite
  // acts as the SAME per-run owner the Redis key/scan shapes use.
  const app = buildApp({
    config,
    store,
    streamContext,
    model: (model ?? 'unused') as LanguageModel,
    background,
    auth: { staticOwner: { userId: OWNER_ID, email: 'live-chat-history@example.com', emailVerified: true } },
  });
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', 'ephemeral test port');

  ownKey(idempotencyKey(INDEXED_CHAT_ID, IDEMPOTENCY_KEY));
  ownIndexMember(`${SLUG}:${INDEXED_CHAT_ID}`);

  return {
    base,
    port: address.port,
    background,
    ownKey,
    ownIndexMember,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      server.closeIdleConnections();
      await background.waitForAll(3_000);
      await Promise.allSettled([...ownedKeys].map((key) => base.del(key)));
      await Promise.allSettled([...ownedMembers].map((member) => base.zRem(indexKey(), member)));
      await Promise.allSettled([base.quit(), publisher.quit(), subscriber.quit()]);
    },
  };
}

async function getChats(port: number, query: string): Promise<ChatSummary[]> {
  const response = await fetch(`http://127.0.0.1:${port}/api/chats${query}`, {
    headers: { Origin: TEST_ORIGINAL_ORIGIN },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), TEST_ORIGINAL_ORIGIN);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = (await response.json()) as { chats: ChatSummary[] };
  return body.chats;
}

test('live: legacy discovery + indexed write order over real Redis', { timeout: 30_000 }, async () => {
  const stack = await createLiveStack(createMockModel({ steps: [oneTextStep('Hello sidebar!')] }));
  const base = stack.base;
  try {
    // ---- 1. LEGACY chats: written RAW, exactly like pre-index history —
    // the POST route never touches these chats in this test.
    const legacyA = messagesKey(LEGACY_A_ID);
    const legacyB = messagesKey(LEGACY_B_ID);
    const foreign = messagesKey(FOREIGN_ID, 'notaslug');
    stack.ownKey(legacyA);
    stack.ownKey(legacyB);
    stack.ownKey(foreign);
    await base.rPush(legacyA, JSON.stringify({ id: 'lu1', role: 'user', parts: [{ type: 'text', text: 'legacy alpha opening text' }] }));
    await base.rPush(legacyA, JSON.stringify({ id: 'la1', role: 'assistant', parts: [{ type: 'text', text: 'legacy alpha reply' }] }));
    await base.rPush(legacyB, JSON.stringify({ id: 'lu2', role: 'user', parts: [{ type: 'text', text: 'legacy beta opening text' }] }));
    // A corrupt entry inside a real legacy chat: skipped leniently, never a 503.
    await base.rPush(legacyB, 'not-json{');
    // A legacy-shaped key whose slug is NOT on the roster: deterministically
    // ignored by discovery (never parsed loosely).
    await base.rPush(foreign, JSON.stringify({ id: 'fx', role: 'user', parts: [{ type: 'text', text: 'foreign' }] }));
    // A hand-planted INDEX member whose message list does not exist: stale.
    stack.ownIndexMember(GHOST_MEMBER);
    await base.zAdd(indexKey(), [{ value: GHOST_MEMBER, score: Date.now() }]);

    // ---- 2. A REAL POST through the real app: the atomic Lua write lands
    // the message list entry AND the index member together.
    const response = await fetch(`http://127.0.0.1:${stack.port}/api/agents/${SLUG}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': IDEMPOTENCY_KEY },
      body: JSON.stringify({
        id: INDEXED_CHAT_ID,
        message: { id: USER_MESSAGE_ID, role: 'user', parts: [{ type: 'text', text: 'brand new live chat' }] },
      }),
    });
    assert.equal(response.status, 200);
    await response.text();
    const store = createRedisChatStore(base as unknown as RedisLike);
    await waitFor(
      async () => (await store.getActiveStreamId({ ownerId: OWNER_ID, slug: SLUG, chatId: INDEXED_CHAT_ID })) === null,
      10_000,
      'completion never cleared the active marker',
    );
    stack.ownKey(messagesKey(INDEXED_CHAT_ID));
    stack.ownKey(activeStreamKey(INDEXED_CHAT_ID));

    // Both effects of ONE append are present: the index member got re-scored
    // and the real ZRANGE REV read back newest-score-first.
    const indexWindow = await base.zRangeWithScores(indexKey(), '+inf', '-inf', {
      BY: 'SCORE',
      REV: true,
      LIMIT: { offset: 0, count: 25 },
    });
    assert.ok(Array.isArray(indexWindow) && indexWindow.length > 0, 'activity index is readable (real ZRANGE WITHSCORES)');
    for (let index = 1; index < indexWindow.length; index += 1) {
      assert.ok(
        Number(indexWindow[index - 1]?.score) >= Number(indexWindow[index]?.score),
        'real ZRANGE REV returns entries newest-score first',
      );
    }
    const mine = indexWindow.find((entry) => entry.value === `${SLUG}:${INDEXED_CHAT_ID}`);
    assert.ok(mine !== undefined, 'the POST append re-scored the chat activity index member');

    // ---- 3. The route: indexed first (ISO), legacy after (null), bounded.
    const chats = await getChats(stack.port, '?limit=50');
    const runIds = chats.filter(isRunChat).map((chat) => chat.chatId);
    assert.ok(runIds.includes(INDEXED_CHAT_ID), 'indexed POST chat is listed');
    assert.ok(runIds.includes(LEGACY_A_ID), 'legacy chat A discovered by bounded SCAN');
    assert.ok(runIds.includes(LEGACY_B_ID), 'legacy chat B discovered by bounded SCAN');
    assert.equal(runIds.includes(FOREIGN_ID), false, 'roster parse skips foreign legacy-shaped keys');
    assert.equal(runIds.includes(`${RUN_ID}-ghost-refused`), false, 'stale index member with no messages is skipped');

    // Indexed before every legacy of this run in the REAL response order.
    const indexedPosition = chats.findIndex((chat) => chat.chatId === INDEXED_CHAT_ID);
    assert.ok(indexedPosition !== -1);
    const legacyPositions = [LEGACY_A_ID, LEGACY_B_ID].map((id) => chats.findIndex((chat) => chat.chatId === id));
    for (const position of legacyPositions) {
      assert.ok(position > indexedPosition, 'legacy chats sort deterministically AFTER indexed ones (real SCAN discovery)');
    }
    assert.ok(
      (legacyPositions[0] ?? 0) < (legacyPositions[1] ?? 0),
      'legacy order is deterministic (ascending slug:chatId)',
    );

    // Summary facts, exact.
    const indexedSummary = chats[indexedPosition];
    assert.ok(indexedSummary !== undefined);
    assert.equal(indexedSummary.agent, SLUG);
    assert.equal(indexedSummary.title, 'brand new live chat');
    assert.equal(indexedSummary.preview, 'Hello sidebar!');
    assert.equal(indexedSummary.messageCount, 2);
    assert.ok(indexedSummary.lastActivityAt !== null, 'indexed chat carries an ISO timestamp');
    assert.ok(!Number.isNaN(new Date(indexedSummary.lastActivityAt ?? '').getTime()));

    const legacySummaryA = chats.find((chat) => chat.chatId === LEGACY_A_ID);
    assert.ok(legacySummaryA !== undefined);
    assert.equal(legacySummaryA.lastActivityAt, null, 'legacy timestamps are NEVER fabricated');
    assert.equal(legacySummaryA.title, 'legacy alpha opening text');
    assert.equal(legacySummaryA.preview, 'legacy alpha reply');
    assert.equal(legacySummaryA.messageCount, 2);

    const legacySummaryB = chats.find((chat) => chat.chatId === LEGACY_B_ID);
    assert.ok(legacySummaryB !== undefined);
    assert.equal(legacySummaryB.lastActivityAt, null);
    assert.equal(legacySummaryB.messageCount, 2, 'corrupt entry still counts toward the raw LLEN (1 valid + 1 corrupt)');
    assert.equal(legacySummaryB.preview, 'legacy beta opening text');
  } finally {
    await stack.close();
  }
});

test('live: real-Lua atomic append + index (both land together; wrongtype refuses both)', { timeout: 15_000 }, async () => {
  const stack = await createLiveStack(null);
  const base = stack.base;
  try {
    const chatId = `${RUN_ID}-atomic`;
    const listKey = messagesKey(chatId);
    stack.ownKey(listKey);
    stack.ownIndexMember(`${SLUG}:${chatId}`);
    const entry = JSON.stringify({ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'atomic write' }] });
    const score = String(Date.now());

    // The store's own script through REAL Redis: RPUSH + ZADD land together.
    const ok = await base.eval(APPEND_MESSAGE_WITH_INDEX_LUA, {
      keys: [listKey, indexKey()],
      arguments: [entry, score, `${SLUG}:${chatId}`],
    });
    assert.equal(ok, 1, 'real Redis executes the atomic append+index script');
    assert.deepEqual(await base.lRange(listKey, 0, -1), [entry], 'the LIST entry landed');
    const window = await base.zRangeWithScores(indexKey(), '+inf', '-inf', { BY: 'SCORE', REV: true });
    const scored = window.find((candidate) => candidate.value === `${SLUG}:${chatId}`);
    assert.ok(scored !== undefined, 'the SAME script re-scored the index member');
    assert.equal(Number(scored.score), Number(score));

    // Wrongtype probe on a UNIQUE key (never the shared index): the script
    // refuses BOTH effects atomically — the real `-1` path. An index
    // failure can never split a write.
    await base.set(WRONGTYPE_KEY, 'plain-string-not-a-zset');
    stack.ownKey(WRONGTYPE_KEY);
    const refused = await base.eval(APPEND_MESSAGE_WITH_INDEX_LUA, {
      keys: [listKey, WRONGTYPE_KEY],
      arguments: [entry, score, `${SLUG}:${chatId}-refused`],
    });
    assert.equal(refused, -1, 'real Redis refuses the whole write on a wrongtype index key');
    assert.equal(await base.lLen(listKey), 1, 'no second entry landed');
    // The ZADD must not have landed either: reading the wrongtype key as a
    // zset is impossible (WRONGTYPE error) — the refusal already proves both
    // effects were skipped (the script aborted before RPUSH).
    await assert.rejects(() => base.zRangeWithScores(WRONGTYPE_KEY, '+inf', '-inf', { BY: 'SCORE' }), /WRONGTYPE/);
  } finally {
    await stack.close();
  }
});

test('live: indexed chat outside the read window keeps its real timestamp (zScore recovery)', { timeout: 15_000 }, async () => {
  const stack = await createLiveStack(null);
  const base = stack.base;
  const chatId = `00${RUN_ID}-recovered`;
  try {
    const store = createRedisChatStore(base as unknown as RedisLike);
    stack.ownKey(messagesKey(chatId));
    stack.ownIndexMember(`${SLUG}:${chatId}`);
    await store.appendMessage({ ownerId: OWNER_ID, slug: SLUG, chatId }, { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'recovered from window overflow' }] } as unknown as UIMessage);
    // Overfill the top read window with stale members (no message lists):
    // with limit 5 the window is 5 + 16 = 21 entries < 76 members, so this
    // chat's member falls outside the ZRANGE window and is rediscovered by
    // bounded SCAN — where the ZSCORE membership verification must return
    // its REAL timestamp instead of a fabricated legacy null. The chat id
    // sorts FIRST among legacy candidates (digit prefix), so the fixed
    // behavior is observable deterministically on a shared dev Redis.
    const member = `${SLUG}:${chatId}`;
    const window = await base.zRangeWithScores(indexKey(), '+inf', '-inf', { BY: 'SCORE', REV: true });
    const scored = window.find((entry) => entry.value === member);
    assert.ok(scored !== undefined, 'the chat is indexed in real Redis');
    const realScore = Number(scored.score);
    for (let index = 0; index < 70; index += 1) {
      const staleMember = `${SLUG}:${RUN_ID}-stale-${String(index).padStart(2, '0')}`;
      await stack.ownIndexMember(staleMember);
      await base.zAdd(indexKey(), [{ value: staleMember, score: realScore + 1 + index }]);
    }
    const chats = await store.listRecentChats(OWNER_ID, 5);
    const recovered = chats.find((chat) => chat.chatId === chatId);
    assert.ok(recovered !== undefined, 'the window-fallen indexed chat is still listed on real Redis');
    assert.equal(recovered.lastActivityAt, new Date(realScore).toISOString(), 'real ZSCORE keeps the true timestamp');
    assert.equal(recovered.title, 'recovered from window overflow');
    assert.equal(recovered.messageCount, 1);
  } finally {
    await stack.close();
  }
});

test('live: store-level listRecentChats over real Redis — clamps, timestamp, safe failure', { timeout: 15_000 }, async () => {
  const stack = await createLiveStack(null);
  const base = stack.base;
  try {
    const store = createRedisChatStore(base as unknown as RedisLike);
    const chatId = `${RUN_ID}-store-api`;
    const listKey = messagesKey(chatId);
    stack.ownKey(listKey);
    stack.ownIndexMember(`${SLUG}:${chatId}`);
    await store.appendMessage({ ownerId: OWNER_ID, slug: SLUG, chatId }, { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'store api text' }] } as unknown as UIMessage);
    const chats = await store.listRecentChats(OWNER_ID, 50);
    const summary = chats.filter(isRunChat).find((chat) => chat.chatId === chatId);
    assert.ok(summary !== undefined, 'store.listRecentChats surfaces the indexed chat');
    assert.equal(summary.title, 'store api text');
    assert.equal(summary.messageCount, 1);
    assert.ok(summary.lastActivityAt !== null);
    // Defensive clamps: huge/NaN limits stay bounded reads (never throw).
    const clamped = await store.listRecentChats(OWNER_ID, 100_000);
    assert.ok(Array.isArray(clamped));
    assert.ok(Array.isArray(await store.listRecentChats(OWNER_ID, Number.NaN)));

    // A full Redis-like failure maps to the typed 503-safe error.
    const boom = (): Promise<never> => Promise.reject(new Error('ECONNREFUSED test-only'));
    const broken = createRedisChatStore({
      get: boom,
      set: boom,
      del: boom,
      rPush: boom,
      lRange: boom,
      lLen: boom,
      zAdd: boom,
      zRangeWithScores: boom,
      zScore: boom,
      scan: boom,
      eval: boom,
    });
    await assert.rejects(() => broken.listRecentChats(OWNER_ID, 20), StoreUnavailableError);
  } finally {
    await stack.close();
  }
});
