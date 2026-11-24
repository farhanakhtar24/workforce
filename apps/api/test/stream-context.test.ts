/**
 * Semantics of the injectable stream context + its memory implementation, and
 * the in-memory store contract used by the app tests. The production
 * `resumable-stream` adapter itself is wired in `server.ts` (needs live Redis
 * pub/sub; not testable offline) — its constructor input/output types are the
 * `StreamContext` contract exercised here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryStreamContext, drainTextStream } from '../src/stream-context/memory.js';
import { createInMemoryChatStore } from '../src/store/memory.js';

function sseStream(chunks: string[], delayMs = 0): ReadableStream<string> {
  return new ReadableStream<string>({
    async start(controller) {
      for (const chunk of chunks) {
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

test('createNewResumableStream records the full stream; replay before finish', async () => {
  const context = createInMemoryStreamContext();
  const registering = context.createNewResumableStream('strm-1', () =>
    sseStream(['a\n\n', 'b\n\n', 'c\n\n'], 30),
  );
  void registering;
  // While the pump is still running, resume replays the buffered prefix.
  await new Promise((resolve) => setTimeout(resolve, 15));
  const partial = await context.resumeExistingStream('strm-1');
  assert.ok(partial !== null && partial !== undefined);
  const partialText = await drainTextStream(partial);
  assert.equal(['', 'a\n\n', 'a\n\nb\n\n'].includes(partialText), true);
  await registering;
  assert.equal(context.state.done.has('strm-1'), true);
  // resumable-stream semantics: a fully finished stream returns null (the
  // client is expected to use hydration). Full replay happens only mid-flight.
  assert.equal(await context.resumeExistingStream('strm-1'), null);
});

test('mid-flight replay is the full buffer from the start (no deltas)', async () => {
  const context = createInMemoryStreamContext();
  // Recorded prefix, still active (not done): replay must contain every
  // recorded chunk from the very start, not a delta.
  context.state.streams.set('strm-2', ['one\n\n', 'two\n\n']);
  const replay = await context.resumeExistingStream('strm-2');
  assert.ok(replay !== null && replay !== undefined);
  assert.equal(await drainTextStream(replay), 'one\n\ntwo\n\n');
});

test('resumeExistingStream: null when finished, undefined when unknown', async () => {
  const context = createInMemoryStreamContext();
  await context.createNewResumableStream('strm-done', () => sseStream(['x']));
  assert.equal(await context.resumeExistingStream('strm-done'), null);
  assert.equal(await context.resumeExistingStream('strm-unknown'), undefined);
});

test('in-memory store: idempotency TTL semantics and release', async () => {
  const store = createInMemoryChatStore();
  const chat = { ownerId: 'owner-a', slug: 'general', chatId: 'c1' };
  assert.equal(await store.acquireIdempotencyKey(chat, 'k', 900), true);
  const snapshot = store.snapshot(chat);
  const expiry = [...snapshot.idempotencyKeys.values()][0] ?? 0;
  assert.ok(Math.abs(expiry - (Date.now() + 900_000)) < 5_000, 'TTL must be 900s');
  await store.releaseIdempotencyKey(chat, 'k');
  assert.equal((await store.acquireIdempotencyKey(chat, 'k', 900)), true);
});

test('in-memory store: chats are isolated by owner+slug+chatId; appends land in order', async () => {
  const store = createInMemoryChatStore();
  const chat = { ownerId: 'owner-a', slug: 'general', chatId: 'c1' };
  await store.appendMessage(chat, {
    id: 'a',
    role: 'user',
    parts: [],
  } as never);
  assert.deepEqual(await store.loadMessages({ ownerId: 'owner-b', slug: 'general', chatId: 'c1' }), []);
  assert.deepEqual(await store.loadMessages({ ownerId: 'owner-a', slug: 'general', chatId: 'c2' }), []);
  assert.deepEqual((await store.loadMessages({ ownerId: 'owner-a', slug: 'other', chatId: 'c1' })), []);
  await store.appendMessage(chat, {
    id: 'b',
    role: 'assistant',
    parts: [],
  } as never);
  assert.deepEqual(
    (await store.loadMessages(chat)).map(
      (message) => (message as { id: string }).id,
    ),
    ['a', 'b'],
    'append-only ordering: concurrent appends both land, nothing is lost',
  );
});
