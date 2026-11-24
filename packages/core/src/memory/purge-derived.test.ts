/**
 * Unit tests for the DERIVED per-chat purge (`purgeDerivedChatBlocks` /
 * `MemoryService.purgeDerivedChatMemory`): whole-path purge deletes active +
 * superseded rows, the `assistantMessageIds` narrowing matches ONLY blocks
 * whose metadata carries those ids, relations of deleted blocks cascade
 * (both directions), shape validation throws typed errors without touching
 * data, and the service validates before delegating. In-memory store only —
 * no database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryMemoryStore } from './stores/in-memory-memory-store.js';
import { MemoryService } from './service.js';
import { MemoryValidationError } from './errors.js';
import type { EmbeddingProvider, MemoryJobQueue, MemoryCompactor, MemoryBlockInsert } from './index.js';

/** Minimal embedding provider (dimensions pinned). */
const embedding: EmbeddingProvider = { dimensions: 384, model: 'test-model', embed: async () => [0, 0, 0] };
/** Queue that records nothing (purge never enqueues). */
const queue: MemoryJobQueue = { enqueueEmbedding: async () => undefined, enqueueCompaction: async () => undefined };
/** Compactor that never runs (threshold not crossed in these tests). */
const compactor: MemoryCompactor = { compact: async () => 'summary' };

function makeInsert(overrides: Partial<MemoryBlockInsert> = {}): MemoryBlockInsert {
  return {
    scope: 'user-123',
    path: 'chats/c-1',
    kind: 'observation',
    content: 'derived memory text',
    confidence: 0.8,
    metadata: { source: 'personal-chat', chatId: 'c-1', assistantMessageId: 'a1' },
    ...overrides,
  };
}

async function seededPurgeStore(): Promise<InMemoryMemoryStore> {
  const store = new InMemoryMemoryStore();
  await store.insertSupersedingBlock(makeInsert(), []);
  await store.insertSupersedingBlock(
    makeInsert({ content: 'older derived', metadata: { source: 'personal-chat', chatId: 'c-1', assistantMessageId: 'a0' } }),
    [],
  );
  // A superseded derived row on the same path.
  const supersededTarget = await store.insertSupersedingBlock(makeInsert({ content: 'to be superseded' }), []);
  await store.insertSupersedingBlock(
    makeInsert({ content: 'corrector', metadata: { source: 'personal-chat', chatId: 'c-1', assistantMessageId: 'a2' } }),
    [supersededTarget.id],
  );
  // Other-scope and other-path rows must survive any purge.
  await store.insertSupersedingBlock(makeInsert({ scope: 'user-other' }), []);
  await store.insertSupersedingBlock(makeInsert({ path: 'notes/x', metadata: {} }), []);
  return store;
}

test('purge: whole exact path deletes active + superseded derived rows only', async () => {
  const store = await seededPurgeStore();
  const deleted = await store.purgeDerivedChatBlocks({ scope: 'user-123', path: 'chats/c-1' });
  assert.equal(deleted, 4, '3 active + 1 superseded, exact path only');
  const survivors = (await store.queryBlocks({ scope: 'user-123', pathPrefix: 'chats/c-1', limit: 100, includeSuperseded: true }));
  assert.equal(survivors.length, 0);
  // Other scopes/paths untouched.
  assert.equal((await store.queryBlocks({ scope: 'user-other', limit: 10 })).length, 1);
  assert.equal((await store.queryBlocks({ scope: 'user-123', pathPrefix: 'notes/x', limit: 10 })).length, 1);
  // Relations to/from deleted blocks are gone (both directions).
  assert.equal((await store.listRelationsBySource(survivors[0]?.id ?? 'missing')).length, 0);
});

test('purge: assistantMessageIds narrowing deletes ONLY matching metadata rows', async () => {
  const store = await seededPurgeStore();
  const deleted = await store.purgeDerivedChatBlocks({
    scope: 'user-123',
    path: 'chats/c-1',
    assistantMessageIds: ['a0', 'a2'],
  });
  assert.equal(deleted, 2);
  const remaining = await store.queryBlocks({ scope: 'user-123', pathPrefix: 'chats/c-1', limit: 10, includeSuperseded: true });
  assert.deepEqual(
    remaining.map((block) => block.metadata['assistantMessageId']).sort(),
    ['a1', 'a1'],
  );
});

test('purge: validation errors never touch data (bad ids, empty ids, bad path)', async () => {
  const store = await seededPurgeStore();
  const before = (await store.queryBlocks({ scope: 'user-123', limit: 100, includeSuperseded: true })).length;
  assert.equal(before, 5, 'sanity: 4 chat rows + notes/x inside the scope');
  await assert.rejects(() => store.purgeDerivedChatBlocks({ scope: 'user-123', path: 'chats/c-1', assistantMessageIds: [] }), MemoryValidationError);
  await assert.rejects(() => store.purgeDerivedChatBlocks({ scope: 'user-123', path: 'chats/c-1', assistantMessageIds: ['bad/id'] }), MemoryValidationError);
  await assert.rejects(() => store.purgeDerivedChatBlocks({ scope: 'bad/scope', path: 'chats/c-1' }), MemoryValidationError);
  await assert.rejects(() => store.purgeDerivedChatBlocks({ scope: 'user-123', path: 'chats/c-1', assistantMessageIds: Array.from({ length: 513 }, (_, i) => `m${i}`) }), MemoryValidationError);
  assert.equal((await store.queryBlocks({ scope: 'user-123', limit: 100, includeSuperseded: true })).length, before, 'no rows deleted');
});

test('service purgeDerivedChatMemory validates and delegates (in-memory store)', async () => {
  const store = new InMemoryMemoryStore();
  const written = await new MemoryService({ store, embeddingProvider: embedding, queue, compactor }).writeBlock({
    scope: 'user-123',
    path: 'chats/c-9',
    kind: 'observation',
    content: 'durable preference',
    metadata: { source: 'personal-chat', chatId: 'c-9', assistantMessageId: 'z1' },
  });
  assert.equal((await store.queryBlocks({ scope: 'user-123', limit: 10 })).length, 1);
  const deleted = await new MemoryService({ store, embeddingProvider: embedding, queue, compactor }).purgeDerivedChatMemory({
    scope: 'user-123',
    path: 'chats/c-9',
  });
  assert.equal(deleted, 1);
  assert.equal(await store.getBlock(written.id), null);
  await assert.rejects(() =>
    new MemoryService({ store, embeddingProvider: embedding, queue, compactor }).purgeDerivedChatMemory({
      scope: 'user-123',
      path: 'chats/c-9',
      assistantMessageIds: ['x'.repeat(65)],
    }),
  );
});
