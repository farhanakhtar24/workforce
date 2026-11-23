import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryMemoryStore,
  MemoryConflictError,
  MemoryNotFoundError,
  MemoryQueueError,
  MemoryService,
  MemoryValidationError,
} from '../index.js';
import type {
  MemoryBlock,
  MemoryCompactionOutcome,
  MemoryCompactionRequest,
  MemoryEmbeddingOutcome,
  MemoryJobQueue,
  MemoryLogger,
} from '../index.js';

// ---------------------------------------------------------------------------
// Test doubles (mocks only — no network, no real models, no real queues)
// ---------------------------------------------------------------------------

class RecordingQueue implements MemoryJobQueue {
  readonly embeddingCalls: string[] = [];
  readonly compactionCalls: Array<{ scope: string; path: string; triggerBlockId: string }> = [];
  failEmbedding: Error | null = null;
  failCompaction: Error | null = null;

  async enqueueEmbedding(blockId: string): Promise<void> {
    if (this.failEmbedding) {
      throw this.failEmbedding;
    }
    this.embeddingCalls.push(blockId);
  }

  async enqueueCompaction(scope: string, path: string, triggerBlockId: string): Promise<void> {
    if (this.failCompaction) {
      throw this.failCompaction;
    }
    this.compactionCalls.push({ scope, path, triggerBlockId });
  }
}

class ScriptedCompactor {
  readonly calls: MemoryCompactionRequest[] = [];
  failWith: Error | null = null;
  summary: string | ((request: MemoryCompactionRequest) => string) = 'summary';

  async compact(request: MemoryCompactionRequest): Promise<string> {
    this.calls.push(request);
    if (this.failWith) {
      throw this.failWith;
    }
    return typeof this.summary === 'function' ? this.summary(request) : this.summary;
  }
}

class RecordingLogger implements MemoryLogger {
  readonly warnings: Array<{ message: string; error?: unknown }> = [];
  readonly debugs: string[] = [];

  debug(message: string): void {
    this.debugs.push(message);
  }

  warn(message: string, error?: unknown): void {
    this.warnings.push({ message, error });
  }
}

let clock = 0;

function nextDate(): Date {
  clock += 1;
  return new Date(1_700_000_000_000 + clock);
}

interface Harness {
  store: InMemoryMemoryStore;
  queue: RecordingQueue;
  compactor: ScriptedCompactor;
  logger: RecordingLogger;
  service: MemoryService;
}

function makeHarness(overrides?: { now?: () => Date }): Harness {
  clock = 0;
  const store = new InMemoryMemoryStore();
  const queue = new RecordingQueue();
  const compactor = new ScriptedCompactor();
  const logger = new RecordingLogger();
  const service = new MemoryService({
    store,
    queue,
    compactor,
    logger,
    embeddingProvider: {
      dimensions: 384,
      model: 'Xenova/all-MiniLM-L6-v2',
      async embed() {
        return new Array(384).fill(0.1);
      },
    },
    now: overrides?.now ?? nextDate,
  });
  return { store, queue, compactor, logger, service };
}

const UUID_A = '00000000-0000-4000-8000-00000000000a';
const UUID_B = '00000000-0000-4000-8000-00000000000b';

// ---------------------------------------------------------------------------
// writeBlock semantics
// ---------------------------------------------------------------------------

test('writeBlock inserts a pending block and enqueues its embedding job by id', async () => {
  const { service, store, queue } = makeHarness();
  const block = await service.writeBlock({
    path: 'projects/atlas',
    kind: 'learning',
    content: '  Atlas scales horizontally  ',
    metadata: { source: 'test' },
  });

  assert.strictEqual(block.embeddingStatus, 'pending');
  assert.strictEqual(block.embeddingModel, null);
  assert.strictEqual(block.scope, 'default');
  assert.strictEqual(block.path, 'projects/atlas');
  assert.strictEqual(block.content, 'Atlas scales horizontally');
  assert.strictEqual(block.confidence, 0.8);
  assert.strictEqual(block.supersededById, null);
  assert.strictEqual(block.accessCount, 0);
  assert.deepStrictEqual(block.metadata, { source: 'test' });
  assert.match(block.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

  assert.deepStrictEqual(queue.embeddingCalls, [block.id]);
  assert.strictEqual(queue.compactionCalls.length, 0);

  const stored = await store.getBlock(block.id);
  assert.ok(stored);
  assert.strictEqual(stored!.id, block.id);
});

test('writeBlock normalizes scope and path; siblings stay isolated (path prefix)', async () => {
  const { service, store } = makeHarness();
  const inTree = await service.writeBlock({ scope: 'Ops', path: 'A/B', kind: 'observation', content: 'one' });
  const otherBranch = await service.writeBlock({ scope: 'Ops', path: 'A/C', kind: 'observation', content: 'two' });
  const lookalike = await service.writeBlock({ scope: 'Ops', path: 'AB', kind: 'observation', content: 'lookalike' });

  assert.strictEqual(inTree.path, 'a/b');
  assert.strictEqual(lookalike.path, 'ab');

  await store.queryBlocks({ scope: 'ops', pathPrefix: 'a', limit: 100 }).then((blocks) => {
    assert.strictEqual(blocks.length, 2);
    const paths = blocks.map((block) => block.path).sort();
    assert.deepStrictEqual(paths, ['a/b', 'a/c']);
  });

  const exactBranch = await service.queryBlocks({ scope: 'ops', path: 'a/c', limit: 10 });
  assert.deepStrictEqual(exactBranch.map((block) => block.id), [otherBranch.id]);
});

test('queryBlocks filters by keyword (case-insensitive) and kind, hides superseded by default', async () => {
  const { service } = makeHarness();
  const alpha = await service.writeBlock({ path: 'a', kind: 'learning', content: 'Atlas deployed to prod' });
  const beta = await service.writeBlock({ path: 'a', kind: 'decision', content: 'ATLAS ROLLED BACK' });
  const gamma = await service.writeBlock({ path: 'a', kind: 'observation', content: 'unrelated note' });

  const byKeyword = await service.queryBlocks({ keyword: 'AtLaS', limit: 10 });
  assert.deepStrictEqual(
    byKeyword.map((block) => block.id).sort(),
    [alpha.id, beta.id].sort(),
  );

  const byKind = await service.queryBlocks({ kind: 'decision', limit: 10 });
  assert.deepStrictEqual(byKind.map((block) => block.id), [beta.id]);

  const byKeywordAndKind = await service.queryBlocks({ keyword: 'atlas', kind: 'observation', limit: 10 });
  assert.deepStrictEqual(byKeywordAndKind, []);

  assert.deepStrictEqual((await service.queryBlocks({ limit: 10 })).map((block) => block.id).sort(), [alpha.id, beta.id, gamma.id].sort());
});

test('queryBlocks orders newest first with deterministic id tie-break and honors limit', async () => {
  // Same timestamp for every write -> createdAt ties are guaranteed.
  const { service } = makeHarness({ now: () => new Date(1_700_000_000_000) });
  for (let i = 0; i < 25; i += 1) {
    await service.writeBlock({ path: 'bulk', kind: 'changelog', content: `entry ${i}` });
  }
  const top20 = await service.queryBlocks({ path: 'bulk', limit: 20 });
  assert.strictEqual(top20.length, 20);
  // All createdAt tie -> ids are sorted ascending.
  const ids = top20.map((block) => block.id);
  assert.deepStrictEqual([...ids].sort(), ids);

  const all = await service.queryBlocks({ path: 'bulk', limit: 100 });
  assert.strictEqual(all.length, 25);
});

test('correction write: atomic supersedes relation + target marking, typed errors', async () => {
  const { service, store } = makeHarness();
  const target = await service.writeBlock({ path: 'facts', kind: 'learning', content: 'old fact' });
  const correction = await service.writeBlock({
    path: 'facts',
    kind: 'correction',
    content: 'new fact',
    supersedesId: target.id,
  });

  const freshTarget = await store.getBlock(target.id);
  assert.ok(freshTarget);
  assert.strictEqual(freshTarget!.supersededById, correction.id);
  assert.strictEqual(correction.supersededById, null);

  const related = await service.exploreRelated(correction.id);
  assert.strictEqual(related.block.id, correction.id);
  assert.strictEqual(related.outgoing.length, 1);
  assert.strictEqual(related.outgoing[0]!.relation.type, 'supersedes');
  assert.strictEqual(related.outgoing[0]!.block.id, target.id);
  assert.strictEqual(related.incoming.length, 0);

  const fromTarget = await service.exploreRelated(target.id);
  assert.strictEqual(fromTarget.incoming.length, 1);
  assert.strictEqual(fromTarget.incoming[0]!.block.id, correction.id);

  // Superseded target hidden by default, visible with includeSuperseded.
  const active = await service.queryBlocks({ path: 'facts', limit: 10 });
  assert.deepStrictEqual(active.map((block) => block.id), [correction.id]);
  const withSuperseded = await service.queryBlocks({ path: 'facts', includeSuperseded: true, limit: 10 });
  assert.strictEqual(withSuperseded.length, 2);
});

test('correction write validates target: not found / cross-scope / double supersede', async () => {
  const { service } = makeHarness();
  const target = await service.writeBlock({ path: 'facts', kind: 'learning', content: 'old fact' });

  await assert.rejects(
    () =>
      service.writeBlock({
        path: 'facts',
        kind: 'correction',
        content: 'x',
        supersedesId: UUID_A,
      }),
    (error: unknown) => error instanceof MemoryNotFoundError && error.code === 'memory_not_found',
  );

  await assert.rejects(
    () =>
      service.writeBlock({
        path: 'facts',
        kind: 'correction',
        content: 'x',
        scope: 'other',
        supersedesId: target.id,
      }),
    (error: unknown) => error instanceof MemoryConflictError && error.code === 'memory_conflict',
  );

  await service.writeBlock({ path: 'facts', kind: 'correction', content: 'double', supersedesId: target.id });
  await assert.rejects(
    () => service.writeBlock({ path: 'facts', kind: 'correction', content: 'again', supersedesId: target.id }),
    MemoryConflictError,
  );
});

test('store rejects a block superseding itself', async () => {
  const { store } = makeHarness();
  const target = await store.insertSupersedingBlock(
    { id: UUID_A, scope: 'test', path: 'a', kind: 'learning', content: 'original', confidence: 1, metadata: {} },
    [],
  );
  assert.strictEqual(target.id, UUID_A);

  // A write that reuses the target id as its own id cannot supersede itself.
  await assert.rejects(
    () =>
      store.insertSupersedingBlock(
        {
          id: UUID_A,
          scope: 'test',
          path: 'a',
          kind: 'correction',
          content: 'same id',
          confidence: 1,
          metadata: {},
        },
        [UUID_A],
      ),
    MemoryValidationError,
  );

  // A fixed new id superseding the target is fine.
  const correction = await store.insertSupersedingBlock(
    { id: UUID_B, scope: 'test', path: 'a', kind: 'correction', content: 'fixed id', confidence: 1, metadata: {} },
    [UUID_A],
  );
  assert.strictEqual(correction.id, UUID_B);
  assert.strictEqual((await store.getBlock(UUID_A))?.supersededById, UUID_B);
});

test('schema-invalid writes throw typed validation errors', async () => {
  const { service } = makeHarness();
  await assert.rejects(
    () => service.writeBlock({ path: 'BAD PATH', kind: 'learning', content: 'x' }),
    MemoryValidationError,
  );
  await assert.rejects(
    () => service.writeBlock({ path: 'a', kind: 'learning', content: '' }),
    MemoryValidationError,
  );
});

// ---------------------------------------------------------------------------
// Async-contract failure semantics
// ---------------------------------------------------------------------------

test('embedding enqueue failure marks the block failed and throws MemoryQueueError', async () => {
  const { service, store, queue } = makeHarness();
  queue.failEmbedding = new Error('bullmq down');

  await assert.rejects(
    () => service.writeBlock({ path: 'a', kind: 'learning', content: 'never scheduled' }),
    (error: unknown) => {
      assert.ok(error instanceof MemoryQueueError);
      assert.strictEqual(error.code, 'memory_queue_error');
      assert.match(error.message, /failed to enqueue embedding job/);
      return true;
    },
  );

  const blocks = await service.queryBlocks({ path: 'a', includeSuperseded: true, limit: 10 });
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0]!.embeddingStatus, 'failed');
  assert.ok(await store.getBlock(blocks[0]!.id));
  // Compaction was never considered because the write threw first.
  assert.strictEqual(queue.compactionCalls.length, 0);
});

test('compaction enqueue failure is logged and does not undo the write', async () => {
  const { service, queue, logger } = makeHarness();
  for (let i = 0; i < 31; i += 1) {
    if (i === 30) {
      queue.failCompaction = new Error('redis unavailable');
    }
    await service.writeBlock({ path: 'hot', kind: 'observation', content: `n${i}` });
  }
  // The 31st write attempted a compaction enqueue and failed -> warn, not throw.
  assert.ok(logger.warnings.some((entry) => entry.message.includes('compaction enqueue failed')));
  const active = await service.queryBlocks({ path: 'hot', limit: 100 });
  assert.strictEqual(active.length, 31);
});

test('service rejects malformed scope/path for job inputs', async () => {
  const { service } = makeHarness();
  await assert.rejects(() => service.processCompaction('BAD SCOPE', 'a', UUID_A), MemoryValidationError);
  await assert.rejects(() => service.processCompaction('ops', 'not//valid', UUID_A), MemoryValidationError);
});

test('exploreRelated throws typed not-found for missing blocks', async () => {
  const { service } = makeHarness();
  await assert.rejects(
    () => service.exploreRelated(UUID_A),
    (error: unknown) => error instanceof MemoryNotFoundError && error.code === 'memory_not_found',
  );
});

test('exploreRelated includes superseded relations in both directions deterministically', async () => {
  const { service } = makeHarness({ now: () => new Date(1_700_000_000_000) });
  const first = await service.writeBlock({ path: 'r', kind: 'learning', content: 'v1' });
  const second = await service.writeBlock({ path: 'r', kind: 'correction', content: 'v2', supersedesId: first.id });
  const third = await service.writeBlock({ path: 'r', kind: 'correction', content: 'v3', supersedesId: second.id });

  const view = await service.exploreRelated(second.id);
  assert.strictEqual(view.block.id, second.id);
  // supersedesId points at the OLDER block, so `second -> first` is outgoing.
  assert.strictEqual(view.outgoing.length, 1);
  assert.strictEqual(view.outgoing[0]!.relation.type, 'supersedes');
  assert.strictEqual(view.outgoing[0]!.block.id, first.id);
  assert.strictEqual(view.incoming.length, 1);
  assert.strictEqual(view.incoming[0]!.block.id, third.id);

  // Symmetric views from the neighbors.
  const fromFirst = await service.exploreRelated(first.id);
  assert.strictEqual(fromFirst.incoming[0]!.block.id, second.id);
  assert.strictEqual(fromFirst.outgoing.length, 0);

  // Order deterministic: run again, identical view.
  const again = await service.exploreRelated(second.id);
  assert.deepStrictEqual(again, view);
});

// ---------------------------------------------------------------------------
// >50 entries behavior
// ---------------------------------------------------------------------------

test('a path with 60 entries pages correctly and triggers compaction enqueues', async () => {
  const { service, queue } = makeHarness();
  let last: MemoryBlock | null = null;
  for (let i = 0; i < 60; i += 1) {
    last = await service.writeBlock({ path: 'big/path', kind: 'observation', content: `entry-${i}` });
  }
  assert.ok(last);

  // Compaction enqueued from the 31st write onward.
  assert.strictEqual(queue.compactionCalls.length, 30);
  assert.strictEqual(queue.compactionCalls[0]!.triggerBlockId, queue.embeddingCalls[30]);

  const page1 = await service.queryBlocks({ path: 'big/path', limit: 20 });
  assert.strictEqual(page1.length, 20);
  const all = await service.queryBlocks({ path: 'big/path', limit: 100 });
  assert.strictEqual(all.length, 60);

  // Limit above 100 is rejected by the schema.
  await assert.rejects(() => service.queryBlocks({ limit: 101 }), MemoryValidationError);
});

test('compaction outcome type is exported and distinguishable (routes surface)', async () => {
  // Type-level smoke: compile-time shapes exist and are narrowable.
  const outcome: MemoryCompactionOutcome = { status: 'skipped', reason: 'below_threshold', summaryId: null };
  const embedding: MemoryEmbeddingOutcome = {
    blockId: UUID_A,
    model: 'Xenova/all-MiniLM-L6-v2',
    status: 'already_ready',
    embeddedAt: null,
  };
  assert.strictEqual(outcome.status, 'skipped');
  assert.strictEqual(embedding.status, 'already_ready');
});
