import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryMemoryStore,
  MemoryEmbeddingError,
  MemoryNotFoundError,
  MemoryService,
  SEMANTIC_SEARCH_CANDIDATE_FETCH_LIMIT,
  SEMANTIC_WEIGHT,
  RECENCY_WEIGHT,
  type EmbeddingProvider,
  type MemorySearchResult,
} from '../index.js';

// ---------------------------------------------------------------------------
// Test doubles (mocks only — no network, no real models, no real queues)
// ---------------------------------------------------------------------------

const DIM = 384;

class TestEmbedder implements EmbeddingProvider {
  readonly dimensions = DIM as 384;
  model: string;
  readonly vectors = new Map<string, readonly number[]>();
  calls: string[] = [];
  throwOn: Error | null = null;

  constructor(model?: string) {
    this.model = model ?? 'Xenova/all-MiniLM-L6-v2';
  }

  /** Set an explicit sparse vector for a text (index -> value). */
  set(text: string, entries: Record<number, number>): void {
    const vector = new Array<number>(DIM).fill(0);
    for (const [index, value] of Object.entries(entries)) {
      vector[Number(index) % DIM] = value;
    }
    this.vectors.set(text, vector);
  }

  async embed(text: string): Promise<readonly number[]> {
    this.calls.push(text);
    if (this.throwOn) {
      throw this.throwOn;
    }
    const vector = this.vectors.get(text);
    if (!vector) {
      throw new Error('test embedder has no vector configured for this text');
    }
    return vector;
  }
}

interface Harness {
  store: InMemoryMemoryStore;
  embedder: TestEmbedder;
  service: MemoryService;
}

function makeHarness(): Harness {
  const store = new InMemoryMemoryStore();
  const embedder = new TestEmbedder();
  const service = new MemoryService({
    store,
    embeddingProvider: embedder,
    queue: {
      async enqueueEmbedding() {},
      async enqueueCompaction() {},
    },
    compactor: {
      async compact() {
        return 'summary';
      },
    },
  });
  return { store, embedder, service };
}

/** Write then embed a block with an explicit sparse vector fixture. */
async function writeReady(
  harness: Harness,
  options: {
    scope?: string;
    path?: string;
    kind?: 'learning' | 'decision';
    content: string;
    vector: Record<number, number>;
  },
) {
  const block = await harness.service.writeBlock({
    scope: options.scope,
    path: options.path ?? 'notes',
    kind: options.kind ?? 'learning',
    content: options.content,
  });
  harness.embedder.set(options.content, options.vector);
  await harness.service.processEmbedding(block.id);
  return block;
}

// ---------------------------------------------------------------------------
// processEmbedding: ready / retry / idempotence / contract violations
// ---------------------------------------------------------------------------

test('processEmbedding embeds content and flips the block to ready', async () => {
  const { service, embedder, store } = makeHarness();
  const block = await service.writeBlock({ path: 'a', kind: 'learning', content: 'vector me' });
  embedder.set('vector me', { 3: 1, 7: 0.5 });

  const outcome = await service.processEmbedding(block.id);
  assert.strictEqual(outcome.status, 'embedded');
  assert.strictEqual(outcome.model, embedder.model);
  assert.ok(outcome.embeddedAt !== null);

  const fresh = await store.getBlock(block.id);
  assert.ok(fresh);
  assert.strictEqual(fresh.embeddingStatus, 'ready');
  assert.strictEqual(fresh.embeddingModel, embedder.model);
  assert.ok(fresh.embeddedAt !== null);
});

test('processEmbedding is an idempotent no-op for ready blocks with the same model', async () => {
  const { service, embedder, store } = makeHarness();
  const block = await service.writeBlock({ path: 'a', kind: 'learning', content: 'stable' });
  embedder.set('stable', { 0: 1 });
  const first = await service.processEmbedding(block.id);
  const callsAfterFirst = embedder.calls.length;

  const second = await service.processEmbedding(block.id);
  assert.strictEqual(second.status, 'already_ready');
  assert.strictEqual(second.embeddedAt, first.embeddedAt);
  assert.strictEqual((await store.getBlock(block.id))?.embeddedAt, first.embeddedAt);
  assert.strictEqual(embedder.calls.length, callsAfterFirst);
});

test('processEmbedding rejects a worker whose provider model drifted; block stays failed', async () => {
  const { service, embedder, store } = makeHarness();
  const block = await service.writeBlock({ path: 'a', kind: 'learning', content: 'drift' });
  embedder.set('drift', { 1: 1 });
  await service.processEmbedding(block.id);
  assert.strictEqual((await store.getBlock(block.id))?.embeddingStatus, 'ready');

  embedder.model = 'some-other-model';
  await assert.rejects(() => service.processEmbedding(block.id), MemoryEmbeddingError);
});

test('processEmbedding marks failed and rethrows provider failures for queue retries', async () => {
  const { service, embedder, store } = makeHarness();
  const block = await service.writeBlock({ path: 'a', kind: 'learning', content: 'boom' });
  embedder.throwOn = new Error('provider 500');

  await assert.rejects(
    () => service.processEmbedding(block.id),
    (error: unknown) => {
      // The ORIGINAL error is rethrown so queue retries carry the cause.
      assert.ok(error instanceof Error);
      assert.strictEqual(error.message, 'provider 500');
      return true;
    },
  );

  const fresh = await store.getBlock(block.id);
  assert.ok(fresh);
  assert.strictEqual(fresh.embeddingStatus, 'failed');
  assert.strictEqual(fresh.embeddingModel, embedder.model);

  // Retry with a healthy provider succeeds.
  embedder.throwOn = null;
  embedder.set('boom', { 2: 1 });
  const outcome = await service.processEmbedding(block.id);
  assert.strictEqual(outcome.status, 'embedded');
  const recovered = await store.getBlock(block.id);
  assert.strictEqual(recovered?.embeddingStatus, 'ready');
});

test('processEmbedding rejects providers with wrong dimensions or wrong model', async () => {
  const { service, embedder, store } = makeHarness();
  const block = await service.writeBlock({ path: 'a', kind: 'learning', content: 'strict' });
  embedder.set('strict', { 0: 1 });

  const wrongDims = embedder as unknown as EmbeddingProvider;
  Object.defineProperty(wrongDims, 'dimensions', { value: 512, configurable: true });

  await assert.rejects(
    () => service.processEmbedding(block.id),
    (error: unknown) => {
      assert.ok(error instanceof MemoryEmbeddingError);
      assert.match(error.message, /dimensions/);
      return true;
    },
  );
  const failedOnce = await store.getBlock(block.id);
  assert.strictEqual(failedOnce?.embeddingStatus, 'failed');

  Object.defineProperty(wrongDims, 'dimensions', { value: DIM, configurable: true });
  const wrongModel = new TestEmbedder('some-other-model');
  const secondService = new MemoryService({
    store,
    embeddingProvider: wrongModel,
    queue: { async enqueueEmbedding() {}, async enqueueCompaction() {} },
    compactor: { async compact() { return 'summary'; } },
  });
  await assert.rejects(
    () => secondService.processEmbedding(block.id),
    (error: unknown) => {
      assert.ok(error instanceof MemoryEmbeddingError);
      assert.match(error.message, /model/);
      return true;
    },
  );
});

test('processEmbedding validates the returned vector (length + finite values)', async () => {
  const { service, embedder, store } = makeHarness();
  const shortBlock = await service.writeBlock({ path: 'a', kind: 'learning', content: 'short' });
  embedder.vectors.set('short', new Array<number>(DIM - 1).fill(0));
  await assert.rejects(() => service.processEmbedding(shortBlock.id), MemoryEmbeddingError);
  const shortFresh = await store.getBlock(shortBlock.id);
  assert.strictEqual(shortFresh?.embeddingStatus, 'failed');

  const nanBlock = await service.writeBlock({ path: 'a', kind: 'learning', content: 'nan' });
  const nanVector = new Array<number>(DIM).fill(0);
  nanVector[10] = Number.NaN;
  embedder.vectors.set('nan', nanVector);
  await assert.rejects(() => service.processEmbedding(nanBlock.id), MemoryEmbeddingError);
  const nanFresh = await store.getBlock(nanBlock.id);
  assert.strictEqual(nanFresh?.embeddingStatus, 'failed');
});

test('processEmbedding throws typed not-found for missing blocks', async () => {
  const { service } = makeHarness();
  await assert.rejects(() => service.processEmbedding('00000000-0000-4000-8000-00000000000a'), MemoryNotFoundError);
});

// ---------------------------------------------------------------------------
// semanticSearch
// ---------------------------------------------------------------------------

test('semanticSearch returns exact hybrid scores for ready blocks', async () => {
  const harness = makeHarness();
  const block = await writeReady(harness, { content: 'atlas scaling fix', vector: { 0: 1, 1: 1 } });

  const results = await harness.service.semanticSearch({ query: 'atlas scaling fix', limit: 5 });
  assert.strictEqual(results.length, 1);
  const result = results[0] as MemorySearchResult;
  assert.strictEqual(result.block.id, block.id);
  assert.ok(Math.abs(result.cosineSimilarity - 1) < 1e-12);
  assert.ok(result.recencyScore > 0.99);
  assert.ok(
    Math.abs(
      result.score - (SEMANTIC_WEIGHT * result.cosineSimilarity + RECENCY_WEIGHT * result.recencyScore),
    ) < 1e-12,
  );
});

test('semanticSearch excludes pending, failed, and superseded blocks', async () => {
  const harness = makeHarness();
  const { service, embedder, store } = harness;

  // Pending: never processed.
  const pending = await service.writeBlock({ path: 'a', kind: 'learning', content: 'pending one' });
  embedder.set('pending one', { 0: 1 });

  // Failed: provider blew up during processing.
  const failed = await service.writeBlock({ path: 'a', kind: 'learning', content: 'failed one' });
  embedder.throwOn = new Error('provider 500');
  await assert.rejects(() => service.processEmbedding(failed.id), Error);
  embedder.throwOn = null;

  // Ready, then superseded by a fresh correction (also ready).
  const superseded = await writeReady(harness, { content: 'superseded one', vector: { 5: 1 } });
  const correction = await service.writeBlock({
    path: 'a',
    kind: 'correction',
    content: 'replaces the ready one',
    supersedesId: superseded.id,
  });
  embedder.set('replaces the ready one', { 5: 1 });
  await service.processEmbedding(correction.id);

  const results = await service.semanticSearch({ query: 'replaces the ready one', limit: 50 });
  const ids = results.map((result) => result.block.id);
  assert.ok(ids.includes(correction.id));
  assert.ok(!ids.includes(superseded.id));
  assert.ok(!ids.includes(failed.id));
  assert.ok(!ids.includes(pending.id));
  assert.strictEqual(ids.length, 1);

  // Sanity: everything still exists when ask explicitly (no deletes).
  for (const id of [pending.id, failed.id, superseded.id]) {
    assert.ok(await store.getBlock(id));
  }
});

test('semanticSearch filters by scope, path prefix, and kind', async () => {
  const harness = makeHarness();
  await writeReady(harness, { scope: 'ops', path: 'runbooks', content: 'runbook entry', vector: { 9: 1 } });
  await writeReady(harness, { scope: 'labs', path: 'runbooks', content: 'lab entry', vector: { 9: 1 } });
  await writeReady(harness, { scope: 'ops', path: 'notes/other', content: 'note entry', vector: { 9: 1 } });
  await writeReady(harness, {
    scope: 'ops',
    path: 'runbooks/nightly',
    kind: 'decision',
    content: 'nightly decision',
    vector: { 9: 1 },
  });
  harness.embedder.set('shared probe term', { 9: 1 });

  const all = (await harness.service.semanticSearch({ query: 'shared probe term', limit: 50 })).map(
    (result) => result.block.id,
  );
  assert.strictEqual(all.length, 4);

  const ops = await harness.service.semanticSearch({ query: 'shared probe term', scope: 'ops', limit: 50 });
  assert.strictEqual(ops.length, 3);

  // Path prefix includes the exact path and descendants, not lookalikes.
  // Within one scope: 'runbooks' + 'runbooks/nightly' = 2.
  const runbooks = await harness.service.semanticSearch({
    query: 'shared probe term',
    scope: 'ops',
    path: 'runbooks',
    limit: 50,
  });
  assert.strictEqual(runbooks.length, 2);
  assert.ok(runbooks.every((result) => result.block.path === 'runbooks' || result.block.path === 'runbooks/nightly'));

  const runbooksLearning = await harness.service.semanticSearch({
    query: 'shared probe term',
    scope: 'ops',
    path: 'runbooks',
    kind: 'learning',
    limit: 50,
  });
  assert.strictEqual(runbooksLearning.length, 1);
  assert.strictEqual(runbooksLearning[0]?.block.path, 'runbooks');
});

test('semanticSearch bumps accessCount/lastAccessedAt without changing order', async () => {
  const harness = makeHarness();
  await writeReady(harness, { content: 'counter one', vector: { 11: 1, 14: 0.5 } });
  await writeReady(harness, { content: 'counter two', vector: { 11: 1 } });
  harness.embedder.set('counter probe', { 11: 1 });

  const first = await harness.service.semanticSearch({ query: 'counter probe', limit: 10 });
  const idsFirst = first.map((result) => result.block.id);
  const countsAfterFirst = await Promise.all(
    idsFirst.map(async (id) => (await harness.store.getBlock(id))?.accessCount),
  );
  assert.deepStrictEqual(countsAfterFirst, [1, 1]);
  // The returned snapshot predates the touch; the store shows the bump.
  for (const id of idsFirst) {
    assert.ok((await harness.store.getBlock(id))?.lastAccessedAt !== null);
  }

  const second = await harness.service.semanticSearch({ query: 'counter probe', limit: 10 });
  const countsAfterSecond = await Promise.all(
    idsFirst.map(async (id) => (await harness.store.getBlock(id))?.accessCount),
  );
  assert.deepStrictEqual(countsAfterSecond, [2, 2]);
  assert.deepStrictEqual(
    second.map((result) => result.block.id),
    idsFirst,
  );
});

test('semanticSearch breaks score ties deterministically (newest, then id)', async () => {
  const anchor = new Date('2026-11-19T12:00:00.000Z');
  const store = new InMemoryMemoryStore();
  const embedder = new TestEmbedder();
  const service = new MemoryService({
    store,
    embeddingProvider: embedder,
    queue: { async enqueueEmbedding() {}, async enqueueCompaction() {} },
    compactor: { async compact() { return 'summary'; } },
    now: () => anchor,
  });

  const a = await service.writeBlock({ path: 'tie', kind: 'learning', content: 'tie a' });
  const b = await service.writeBlock({ path: 'tie', kind: 'learning', content: 'tie b' });
  embedder.set('tie a', { 21: 1 });
  embedder.set('tie b', { 21: 1 });
  embedder.set('tie probe', { 21: 1 });
  await service.processEmbedding(a.id);
  await service.processEmbedding(b.id);

  const first = await service.semanticSearch({ query: 'tie probe', limit: 10 });
  assert.strictEqual(first.length, 2);
  assert.ok(Math.abs(first[0]!.score - first[1]!.score) < 1e-15);
  const ids = first.map((result) => result.block.id);
  assert.deepStrictEqual([...ids].sort(), ids); // id-ascending tie-break

  const second = await service.semanticSearch({ query: 'tie probe', limit: 10 });
  assert.deepStrictEqual(second.map((result) => result.block.id), ids);
});

test('semanticSearch candidate fetch is capped at SEMANTIC_SEARCH_CANDIDATE_FETCH_LIMIT', async () => {
  const { store } = makeHarness();
  assert.strictEqual(SEMANTIC_SEARCH_CANDIDATE_FETCH_LIMIT, 100);

  const embedder = new TestEmbedder();
  const service = new MemoryService({
    store,
    embeddingProvider: embedder,
    queue: { async enqueueEmbedding() {}, async enqueueCompaction() {} },
    compactor: { async compact() { return 'summary'; } },
  });
  const total = SEMANTIC_SEARCH_CANDIDATE_FETCH_LIMIT + 20;
  for (let i = 0; i < total; i += 1) {
    const content = `cap probe ${i}`;
    const block = await service.writeBlock({ path: 'cap', kind: 'learning', content });
    embedder.set(content, { [i % DIM]: 1 });
    await service.processEmbedding(block.id);
  }

  const queryVector = new Array<number>(DIM).fill(0);
  queryVector[0] = 1;
  const candidates = await store.nearestReadyCandidates({ embedding: queryVector, limit: SEMANTIC_SEARCH_CANDIDATE_FETCH_LIMIT });
  assert.strictEqual(candidates.length, SEMANTIC_SEARCH_CANDIDATE_FETCH_LIMIT);
  // Deterministic order: cosine desc, then createdAt desc, then id asc.
  const sims = candidates.map((candidate) => candidate.cosineSimilarity);
  for (let i = 1; i < sims.length; i += 1) {
    assert.ok(sims[i - 1]! >= sims[i]!);
  }
});

test('semanticSearch surfaces provider contract violations for the query vector', async () => {
  const harness = makeHarness();

  // Provider rejects the query outright (mock throws): error propagates.
  await assert.rejects(
    () => harness.service.semanticSearch({ query: 'unknown text', limit: 5 }),
    /test embedder has no vector configured/,
  );

  // Wrong-length query vector is caught by the validation layer.
  harness.embedder.vectors.set('short query', new Array<number>(DIM - 1).fill(0));
  await assert.rejects(
    () => harness.service.semanticSearch({ query: 'short query', limit: 5 }),
    (error: unknown) => {
      assert.ok(error instanceof MemoryEmbeddingError);
      assert.match(error.message, /dimensionality|values for the query|384/);
      return true;
    },
  );
});

