/**
 * Real-stack integration suite: exercises the PRODUCTION Redis chat store and
 * the PRODUCTION resumable-stream adapter over three real node-redis
 * connections (base + publisher + subscriber), through the real Express app
 * with a deterministic mock model. No Ollama, no network beyond local Redis,
 * no API key, no secrets; message bodies are fixed test strings.
 *
 * Requirements:
 * - Redis reachable at REDIS_URL (default redis://127.0.0.1:6379). Start the
 *   stack from the repo root: `docker compose up -d redis`.
 * - Run only this suite: `npm run test:integration --workspace @workforce/api`
 *   (normal `npm test` stays offline and never touches Redis).
 *
 * Determinism: the resumable-stream keyPrefix and every chat ID are unique per
 * run (pid + timestamp) and cleanup deletes exactly the keys this run created —
 * no SCAN, no FLUSH of the shared database.
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
  ACTIVE_STREAM_TTL_SECONDS,
  createRedisChatStore,
  REDIS_KEY_PREFIX,
  type RedisLike,
} from '../src/store/redis.js';
import { createResumableStreamAdapter } from '../src/stream-context/resumable.js';
import { drainTextStream } from '../src/stream-context/memory.js';
import type { ChatStore } from '../src/store/types.js';
import { createMockModel, mockUsage, TEST_ORIGINAL_ORIGIN } from '../test/helpers.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
/** Unique per run so parallel/repeat runs never collide in the shared Redis. */
const RUN_ID = `${process.pid}-${Date.now().toString(36)}`;
const STREAM_KEY_PREFIX = `workforce:phase2:stream-live-test:${RUN_ID}`;
const SLUG = 'general';
const CHAT_ID = `live-chat-${RUN_ID}`;
const USER_MESSAGE_ID = 'm-live-1';
const IDEMPOTENCY_KEY = `${CHAT_ID}:${USER_MESSAGE_ID}`;
const EXPECTED_TEXT = 'Hello live ';
const REDIS_TIMEOUT_MS = 2_500;

interface LiveStack {
  base: RedisClientType;
  publisher: RedisClientType;
  subscriber: RedisClientType;
  store: ChatStore;
  streamContext: ReturnType<typeof createResumableStreamAdapter>;
  server: Server;
  port: number;
  background: BackgroundTaskTracker;
  chatRef: { slug: string; chatId: string };
  /** Registers one more exact Redis key to delete on close (never a SCAN). */
  ownKey(key: string): string;
  /** Closes the server, drains background work, deletes owned keys, quits clients. */
  close(): Promise<void>;
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

function messagesKey(chatId: string): string {
  return `${REDIS_KEY_PREFIX}:chat:${SLUG}:${chatId}:messages`;
}
function activeStreamKey(chatId: string): string {
  return `${REDIS_KEY_PREFIX}:chat:${SLUG}:${chatId}:active-stream`;
}
function idempotencyKey(chatId: string, key: string): string {
  return `${REDIS_KEY_PREFIX}:idempotency:${SLUG}:${chatId}:${key}`;
}

/**
 * Connects with a short bounded timeout and fails with the exact instruction
 * an offline environment needs — the suite must never guess-run.
 */
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

/** Test clients never auto-reconnect: failures fail the test instead of hanging it. */
function liveClient(): RedisClientType {
  return createClient({
    url: REDIS_URL,
    socket: { reconnectStrategy: false, connectTimeout: REDIS_TIMEOUT_MS },
  });
}

/**
 * Builds the real stack: three node-redis connections, the real Redis chat
 * store, the real resumable-stream adapter (unique key prefix), the tracked
 * background pump, and the real Express app with an injected mock model.
 */
async function createLiveStack(model: LanguageModel): Promise<LiveStack> {
  const base = liveClient();
  const publisher = liveClient();
  const subscriber = liveClient();
  for (const client of [base, publisher, subscriber]) {
    client.on('error', () => undefined); // emitted 'error' must never kill the process
  }
  await connectOrDie(base);
  await connectOrDie(publisher);
  await connectOrDie(subscriber);

  const background = createBackgroundTracker({ onError: () => undefined });
  const store = createRedisChatStore(base as unknown as RedisLike);
  const streamContext = createResumableStreamAdapter({
    waitUntil: background.track,
    publisher,
    subscriber,
    keyPrefix: STREAM_KEY_PREFIX,
  });
  const config = loadApiConfig({ OLLAMA_API_KEY: 'test-only-not-a-real-key', PORT: '3001', REDIS_URL });
  const app = buildApp({ config, store, streamContext, model, background });
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', 'ephemeral test port');

  // Only exact, run-scoped keys are ever deleted.
  const ownedKeys = new Set<string>();
  const ownKey = (key: string): string => {
    ownedKeys.add(key);
    return key;
  };
  ownKey(messagesKey(CHAT_ID));
  ownKey(activeStreamKey(CHAT_ID));
  ownKey(idempotencyKey(CHAT_ID, IDEMPOTENCY_KEY));
  // resumable-stream 2.2.13 nests a literal `rs:` segment inside its keys:
  // `${keyPrefix}:rs:sentinel:{streamId}` — cleanup must match that layout.
  ownKey(`${STREAM_KEY_PREFIX}:rs:sentinel:${RUN_ID}-direct`);

  return {
    base,
    publisher,
    subscriber,
    store,
    streamContext,
    server,
    port: address.port,
    background,
    chatRef: { slug: SLUG, chatId: CHAT_ID },
    ownKey,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      server.closeIdleConnections();
      await background.waitForAll(3_000);
      await Promise.allSettled([...ownedKeys].map((key) => base.del(key)));
      await Promise.allSettled([base.quit(), publisher.quit(), subscriber.quit()]);
    },
  };
}

/** Slow deterministic single-step text: ~1.2s of streaming, still mock-only. */
function slowLiveStep(): LanguageModelV3StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'Hello ' },
    { type: 'text-delta', id: 't1', delta: 'live ' },
    { type: 'text-end', id: 't1' },
    {
      type: 'finish',
      usage: mockUsage(),
      finishReason: { unified: 'stop', raw: undefined },
    },
  ];
}

interface LiveSseReader {
  nextFrame(timeoutMs?: number): Promise<string>;
  abort(): void;
}

/** Reads the SSE body frame-by-frame with bounded waits. */
function sseReader(response: Response, controller: AbortController): LiveSseReader {
  assert.ok(response.body !== null, 'SSE response must have a body');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  return {
    async nextFrame(timeoutMs = 4_000): Promise<string> {
      let done = false;
      for (;;) {
        const separator = buffer.indexOf('\n\n');
        if (separator !== -1) {
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          return frame;
        }
        if (done) {
          throw new Error('SSE stream ended before a complete frame');
        }
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('SSE frame timeout')), timeoutMs);
        });
        try {
          const chunk = await Promise.race([reader.read(), timeout]);
          done = chunk.done;
          buffer += chunk.value ?? '';
        } finally {
          clearTimeout(timer);
        }
      }
    },
    abort: () => controller.abort(),
  };
}

test('live: chat lifecycle over real Redis — SSE, disconnect, duplicate 409, resume replay, hydration', { timeout: 20_000 }, async () => {
  const model = createMockModel({ steps: [slowLiveStep()], chunkDelayMs: 200 });
  const stack = await createLiveStack(model as unknown as LanguageModel);
  try {
    // ---- 1. POST begins SSE; the active marker exists in real Redis.
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${stack.port}/api/agents/${SLUG}/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': IDEMPOTENCY_KEY,
        Origin: TEST_ORIGINAL_ORIGIN,
      },
      body: JSON.stringify({
        id: CHAT_ID,
        message: { id: USER_MESSAGE_ID, role: 'user', parts: [{ type: 'text', text: 'hello live' }] },
      }),
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.ok((response.headers.get('content-type') ?? '').startsWith('text/event-stream'));
    assert.equal(response.headers.get('access-control-allow-origin'), TEST_ORIGINAL_ORIGIN);

    await waitFor(
      async () => (await stack.store.getActiveStreamId(stack.chatRef)) !== null,
      3_000,
      'active stream marker never appeared in real Redis',
    );
    const streamId = await stack.store.getActiveStreamId(stack.chatRef);
    assert.ok(streamId !== null);
    stack.ownKey(`${STREAM_KEY_PREFIX}:rs:sentinel:${streamId}`);
    const markerTtl = await stack.base.ttl(activeStreamKey(CHAT_ID));
    assert.ok(
      markerTtl > ACTIVE_STREAM_TTL_SECONDS - 100 && markerTtl <= ACTIVE_STREAM_TTL_SECONDS,
      `live marker TTL must be ~86400s, got ${markerTtl}s`,
    );

    // ---- 2. Cancel the HTTP response mid-stream (client disconnect), NOT the model.
    const reader = sseReader(response, controller);
    const firstFrame = await reader.nextFrame();
    assert.ok(firstFrame.includes('data: '), 'SSE must begin streaming before the disconnect');
    reader.abort();

    // ---- 3. Duplicate same POST + key → 409, zero additional model calls.
    const duplicate = await fetch(`http://127.0.0.1:${stack.port}/api/agents/${SLUG}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': IDEMPOTENCY_KEY },
      body: JSON.stringify({
        id: CHAT_ID,
        message: { id: USER_MESSAGE_ID, role: 'user', parts: [{ type: 'text', text: 'hello live' }] },
      }),
    });
    assert.equal(duplicate.status, 409);
    assert.equal(model.doStreamCalls.length, 1, 'disconnect + duplicate must not re-invoke the model');
    const abortSignal = (model.doStreamCalls[0] as { abortSignal?: AbortSignal | null }).abortSignal;
    assert.ok(abortSignal === undefined || abortSignal === null, 'disconnect must not abort the model');

    // ---- 4. Resume through REAL resumable-stream (Redis pub/sub), full replay.
    const resume = await fetch(`http://127.0.0.1:${stack.port}/api/agents/${SLUG}/chat/${CHAT_ID}/stream`);
    assert.equal(resume.status, 200);
    assert.ok((resume.headers.get('content-type') ?? '').startsWith('text/event-stream'));
    assert.equal(resume.headers.get('x-vercel-ai-ui-message-stream'), 'v1');

    const resumeText = await resume.text();
    const resumeFrames = resumeText
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: ') && !frame.includes('[DONE]'));
    const chunks = resumeFrames.map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>);
    const startChunk = chunks.find((chunk) => chunk['type'] === 'start');
    assert.ok(startChunk !== undefined, 'full replay includes the start chunk');
    const deltas = chunks
      .filter((chunk) => chunk['type'] === 'text-delta')
      .map((chunk) => chunk['delta'] as string);
    assert.deepEqual(deltas, ['Hello ', 'live '], 'full replay from the start, no duplicated text chunks');
    assert.equal(
      resumeText.split('Hello ').length - 1,
      1,
      'content the earlier connection already saw is redelivered exactly once (full replay, no doubling)',
    );

    // ---- 5. Completion: one user + one assistant, stable server id, active=false.
    await waitFor(
      async () => (await stack.store.getActiveStreamId(stack.chatRef)) === null,
      8_000,
      'completion never cleared the active marker',
    );
    const hydration = await fetch(`http://127.0.0.1:${stack.port}/api/agents/${SLUG}/chat/${CHAT_ID}`);
    assert.equal(hydration.status, 200);
    const body = (await hydration.json()) as { messages: UIMessage[]; hasActiveStream: boolean };
    assert.equal(body.hasActiveStream, false);
    assert.equal(body.messages.length, 2);
    const [user, assistant] = body.messages;
    assert.equal(user?.id, USER_MESSAGE_ID);
    assert.equal(user?.role, 'user');
    assert.ok(assistant !== undefined);
    assert.match(assistant.id, /^msg-/);
    assert.equal(assistant.id, startChunk['messageId'], 'replayed start id equals the persisted server id');
    assert.equal(
      assistant.parts.map((part) => (part.type === 'text' ? part.text : '')).join(''),
      EXPECTED_TEXT,
    );
    assert.equal(model.doStreamCalls.length, 1);

    const resumeAfterCompletion = await fetch(
      `http://127.0.0.1:${stack.port}/api/agents/${SLUG}/chat/${CHAT_ID}/stream`,
    );
    assert.equal(resumeAfterCompletion.status, 204);

    // ---- 6. The real Redis LIST holds the messages; real SET NX duplicate fails.
    const rawEntries = await stack.base.lRange(messagesKey(CHAT_ID), 0, -1);
    assert.equal(rawEntries.length, 2);
    assert.equal(JSON.parse(rawEntries[0] as string).id, USER_MESSAGE_ID);
    assert.equal(JSON.parse(rawEntries[1] as string).id, assistant.id);
    assert.equal(
      await stack.store.acquireIdempotencyKey(stack.chatRef, IDEMPOTENCY_KEY, 900),
      false,
      'real SET NX must reject the already-used idempotency key',
    );
    // The route stores `idempotencyKey(chat, headerKey)` and the header value
    // itself is `${chatId}:${messageId}` — the chat id appears twice by design.
    const idemTtl = await stack.base.ttl(idempotencyKey(CHAT_ID, IDEMPOTENCY_KEY));
    assert.ok(idemTtl > 800 && idemTtl <= 900, `idempotency TTL should be ~900s, got ${idemTtl}s`);
  } finally {
    await stack.close();
  }
});

test('live: direct resumable-stream replay through the real adapter and Redis pub/sub', { timeout: 10_000 }, async () => {
  const stack = await createLiveStack(null as unknown as LanguageModel);
  try {
    const streamId = `${RUN_ID}-direct`;
    const chunks = ['a\n\n', 'b\n\n', 'c\n\n'];
    const source = new ReadableStream<string>({
      async start(controller) {
        for (const chunk of chunks) {
          await new Promise((resolve) => setTimeout(resolve, 60));
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    // Registration resolves only after the sentinel is set in real Redis:
    // waiting for it removes the race where a resume call before registration
    // sees "no stream" (undefined) and would wrongly end the poll loop early.
    await stack.streamContext
      .createNewResumableStream(streamId, () => source)
      .catch(() => undefined);

    // Every mid-flight resume replays from the very first byte (never deltas).
    let longestReplay = '';
    for (;;) {
      const replay = await stack.streamContext.resumeExistingStream(streamId);
      if (replay === null || replay === undefined) {
        break; // sentinel reached DONE — real finished-stream semantics
      }
      const text = await drainTextStream(replay);
      if (text.length > longestReplay.length) {
        longestReplay = text;
      }
      assert.ok(
        chunks.join('').startsWith(text),
        `mid-flight replay must be a full prefix, got ${JSON.stringify(text)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (longestReplay === chunks.join('')) {
        break;
      }
    }
    assert.ok(longestReplay.startsWith('a\n\n'), 'replay begins at the first recorded chunk');
  } finally {
    await stack.close();
  }
});

test('live: real Redis store primitives — idempotency, marker TTL, compare-and-delete', { timeout: 10_000 }, async () => {
  const stack = await createLiveStack(null as unknown as LanguageModel);
  try {
    const chat = { slug: SLUG, chatId: `${CHAT_ID}-prims` };
    stack.ownKey(messagesKey(chat.chatId));
    stack.ownKey(activeStreamKey(chat.chatId));
    stack.ownKey(idempotencyKey(chat.chatId, 'k'));
    const message = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] };
    await stack.store.appendMessage(chat, message as unknown as UIMessage);

    // Idempotency: SET NX + EX 900; duplicate loses; release works.
    assert.equal(await stack.store.acquireIdempotencyKey(chat, 'k', 900), true);
    assert.equal(await stack.store.acquireIdempotencyKey(chat, 'k', 900), false);
    const ttl = await stack.base.ttl(idempotencyKey(chat.chatId, 'k'));
    assert.ok(ttl > 850 && ttl <= 900, `TTL must be ~900s, got ${ttl}s`);
    await stack.store.releaseIdempotencyKey(chat, 'k');
    assert.equal(await stack.store.acquireIdempotencyKey(chat, 'k', 900), true);

    // Active marker: 24h TTL and exact-match delete only.
    await stack.store.setActiveStreamId(chat, 'strm-a');
    const markerTtl = await stack.base.ttl(activeStreamKey(chat.chatId));
    assert.ok(
      markerTtl > ACTIVE_STREAM_TTL_SECONDS - 100 && markerTtl <= ACTIVE_STREAM_TTL_SECONDS,
      `marker TTL must be ~86400s, got ${markerTtl}s`,
    );
    assert.equal(await stack.store.clearActiveStreamId(chat, 'strm-b'), false);
    assert.equal(await stack.store.getActiveStreamId(chat), 'strm-a');
    assert.equal(await stack.store.clearActiveStreamId(chat, 'strm-a'), true);
    assert.equal(await stack.store.getActiveStreamId(chat), null);

    // The LIST really holds one JSON UIMessage per entry (RPUSH/LRANGE).
    await stack.store.appendMessage(chat, { id: 'a1', role: 'assistant', parts: [] } as unknown as UIMessage);
    const entries = await stack.base.lRange(messagesKey(chat.chatId), 0, -1);
    assert.equal(entries.length, 2);
    assert.equal(JSON.parse(entries[0] as string).id, 'u1');
    assert.equal(JSON.parse(entries[1] as string).id, 'a1');
  } finally {
    await stack.close();
  }
});
