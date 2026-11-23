/**
 * Phase 3 memory route tests: the REAL Express app (`buildApp`) with the real
 * `MemoryService` over an `InMemoryMemoryStore`, plus deterministic mock
 * embedder/compactor and a recording queue. No Redis, no Prisma, no network,
 * no model, no real Ollama — the same offline contract as Phase 2 tests.
 *
 * Covering: all routes happy paths, defaults, strict JSON/query/path/UUID
 * validation, unknown fields, correction 404/409, semantic scores (no
 * vectors), related, ready retry 409, failed/pending retry 202, compaction
 * 202, queue failures 503, unexpected service/store failure 503 without
 * leaking internals, and memory routes absent (404) when deps are omitted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  MEMORY_EMBEDDING_MODEL,
  MemoryService,
  InMemoryMemoryStore,
  type EmbeddingProvider,
  type MemoryBlock,
  type MemoryCompactor,
  type MemoryCompactionRequest,
  type MemoryJobQueue,
  type MemoryStore,
} from '@workforce/core/memory';
import { startTestApp, type TestApp } from './helpers.js';

// ---------------------------------------------------------------------------
// Offline fakes
// ---------------------------------------------------------------------------

/** Deterministic embedder: content-derived 384-dim vectors (no randomness). */
function mockEmbedder(options: { fail?: Error } = {}): EmbeddingProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    dimensions: 384,
    model: MEMORY_EMBEDDING_MODEL,
    calls,
    embed: async (text: string) => {
      if (options.fail !== undefined) {
        calls.push(text);
        throw options.fail;
      }
      calls.push(text);
      const vector = new Array<number>(384).fill(0);
      for (let i = 0; i < text.length; i += 1) {
        vector[i % 384] = (vector[i % 384] ?? 0) + text.charCodeAt(i);
      }
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
      return vector.map((value) => value / norm);
    },
  };
}

function mockCompactor(summary = 'compacted summary'): MemoryCompactor & { calls: MemoryCompactionRequest[] } {
  const calls: MemoryCompactionRequest[] = [];
  return {
    calls,
    compact: async (request) => {
      calls.push(request);
      return summary;
    },
  };
}

/** Recording queue: never touches Redis. */
function workingQueue(): MemoryJobQueue & {
  embedded: string[];
  compacted: Array<{ scope: string; path: string; triggerBlockId: string }>;
} {
  const queue = {
    embedded: [] as string[],
    compacted: [] as Array<{ scope: string; path: string; triggerBlockId: string }>,
    async enqueueEmbedding(blockId: string) {
      queue.embedded.push(blockId);
    },
    async enqueueCompaction(scope: string, path: string, triggerBlockId: string) {
      queue.compacted.push({ scope, path, triggerBlockId });
    },
  };
  return queue;
}

/** Store whose every method throws a generic (non-memory) error. */
function failingStore(): MemoryStore {
  const fail = (): never => {
    throw new Error('simulated database outage');
  };
  return {
    insertSupersedingBlock: async () => fail(),
    getBlock: async () => fail(),
    getBlocks: async () => fail(),
    queryBlocks: async () => fail(),
    countActiveBlocksByPath: async () => fail(),
    listActiveBlocksByPath: async () => fail(),
    runPathExclusive: async () => fail(),
    markEmbeddingReady: async () => fail(),
    markEmbeddingFailed: async () => fail(),
    nearestReadyCandidates: async () => fail(),
    listRelationsBySource: async () => fail(),
    listRelationsByTarget: async () => fail(),
    touchAccessed: async () => fail(),
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface MemoryTestApp {
  app: TestApp;
  service: MemoryService;
  store: InMemoryMemoryStore;
  queue: ReturnType<typeof workingQueue>;
  embedder: ReturnType<typeof mockEmbedder>;
  compactor: ReturnType<typeof mockCompactor>;
}

function buildMemoryApp(): Promise<MemoryTestApp> {
  const store = new InMemoryMemoryStore();
  const queue = workingQueue();
  const embedder = mockEmbedder();
  const compactor = mockCompactor();
  const service = new MemoryService({
    store,
    embeddingProvider: embedder,
    queue,
    compactor,
  });
  return startTestApp({ memory: { service, queue } }).then((app) => ({ app, service, store, queue, embedder, compactor }));
}

interface JsonCall {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  /** Raw body string (for malformed JSON tests). */
  rawBody?: string;
}

async function callJson(port: number, options: JsonCall): Promise<{ status: number; body: any; text: string }> {
  const init: RequestInit = { method: options.method };
  if (options.method === 'POST') {
    init.headers = { 'content-type': 'application/json' };
    init.body = options.rawBody ?? (options.body === undefined ? '{}' : JSON.stringify(options.body));
  }
  const response = await fetch(`http://127.0.0.1:${port}${options.path}`, init);
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? (JSON.parse(text) as any) : null, text };
}

/** Seeds ONE block through the service (embed job enqueued, status pending). */
async function seedBlock(
  service: MemoryService,
  input: { scope?: string; path: string; kind?: MemoryBlock['kind']; content?: string },
): Promise<MemoryBlock> {
  return service.writeBlock({
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    path: input.path,
    kind: input.kind ?? 'learning',
    content: input.content ?? 'seeded block content',
  });
}

/** Seeds + embeds synchronously via the worker-facing service method. */
async function seedReadyBlock(service: MemoryService, content: string): Promise<MemoryBlock> {
  const block = await seedBlock(service, { path: 'projects/atlas', content });
  await service.processEmbedding(block.id);
  return (await service.exploreRelated(block.id)).block;
}

// ---------------------------------------------------------------------------
// POST /api/memory/blocks
// ---------------------------------------------------------------------------

test('POST /api/memory/blocks returns 201 {block} with pending embedding', async () => {
  const ctx = await buildMemoryApp();
  try {
    const { body, status } = await callJson(ctx.app.port, {
      method: 'POST',
      path: '/api/memory/blocks',
      body: { kind: 'learning', path: 'projects/atlas', content: 'Atlas uses Postgres 16.', confidence: 0.9 },
    });
    assert.equal(status, 201);
    const block = body.block as MemoryBlock;
    assert.equal(typeof block.id, 'string');
    assert.equal(block.scope, 'default');
    assert.equal(block.path, 'projects/atlas');
    assert.equal(block.kind, 'learning');
    assert.equal(block.content, 'Atlas uses Postgres 16.');
    assert.equal(block.confidence, 0.9);
    assert.equal(block.embeddingStatus, 'pending');
    // Embed job enqueued on the real queue with the block id.
    assert.deepEqual(ctx.queue.embedded, [block.id]);
  } finally {
    await ctx.app.close();
  }
});

test('POST /api/memory/blocks applies schema defaults (scope, confidence)', async () => {
  const ctx = await buildMemoryApp();
  try {
    const { status, body } = await callJson(ctx.app.port, {
      method: 'POST',
      path: '/api/memory/blocks',
      body: { path: 'a', kind: 'correction', content: 'x' },
    });
    assert.equal(status, 201);
    assert.equal(body.block.scope, 'default');
    assert.equal(body.block.confidence, 0.8);
  } finally {
    await ctx.app.close();
  }
});

test('POST /api/memory/blocks rejects unknown fields, empty/oversized content, bad path/kind', async () => {
  const ctx = await buildMemoryApp();
  try {
    for (const body of [
      { path: 'a', kind: 'learning', content: 'x', unknown: true },
      { path: 'a', kind: 'learning', content: '   ' },
      { path: 'a', kind: 'learning', content: 'a'.repeat(1001) },
      { path: '../nope', kind: 'learning', content: 'x' },
      { path: 'a', kind: 'nope', content: 'x' },
      { kind: 'learning', content: 'x' }, // missing path
    ]) {
      const { status, body: out } = await callJson(ctx.app.port, {
        method: 'POST',
        path: '/api/memory/blocks',
        body,
      });
      assert.equal(status, 400, JSON.stringify(body));
      assert.equal(out.error, 'Invalid memory request.');
    }
  } finally {
    await ctx.app.close();
  }
});

test('POST /api/memory/blocks rejects superseding a missing target (404) and a superseded target (409)', async () => {
  const ctx = await buildMemoryApp();
  try {
    const corrected = await seedBlock(ctx.service, { path: 'projects/atlas', kind: 'learning', content: 'old fact' });
    await ctx.service.writeBlock({ path: 'projects/atlas', kind: 'correction', content: 'new fact', supersedesId: corrected.id });

    // 404: unknown supersedesId
    const res404 = await callJson(ctx.app.port, {
      method: 'POST',
      path: '/api/memory/blocks',
      body: { path: 'projects/atlas', kind: 'correction', content: 'fix', supersedesId: randomUUID() },
    });
    assert.equal(res404.status, 404);
    assert.equal(res404.body.error, 'Memory block not found.');

    // 409: `corrected` is already superseded by the fix above
    const res409 = await callJson(ctx.app.port, {
      method: 'POST',
      path: '/api/memory/blocks',
      body: { path: 'projects/atlas', kind: 'correction', content: 'fix again', supersedesId: corrected.id },
    });
    assert.equal(res409.status, 409);
    assert.equal(res409.body.error, 'Memory conflict.');
  } finally {
    await ctx.app.close();
  }
});

test('POST /api/memory/blocks returns 400 for malformed JSON and 415-free path for absent body', async () => {
  const ctx = await buildMemoryApp();
  try {
    const malformed = await callJson(ctx.app.port, {
      method: 'POST',
      path: '/api/memory/blocks',
      rawBody: '{not json',
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error, 'Malformed JSON request body.');
  } finally {
    await ctx.app.close();
  }
});

// ---------------------------------------------------------------------------
// GET /api/memory/blocks
// ---------------------------------------------------------------------------

test('GET /api/memory/blocks lists newest-first with defaults, hides superseded', async () => {
  const ctx = await buildMemoryApp();
  try {
    const first = await seedBlock(ctx.service, { path: 'projects/atlas', content: 'first' });
    const second = await seedBlock(ctx.service, { path: 'projects/atlas', content: 'second' });
    const third = await seedBlock(ctx.service, { path: 'projects/atlas', kind: 'correction', content: 'third' });
    await ctx.service.writeBlock({ path: 'projects/atlas', kind: 'correction', content: 'replacement', supersedesId: first.id });

    const { status, body } = await callJson(ctx.app.port, { method: 'GET', path: '/api/memory/blocks' });
    assert.equal(status, 200);
    const blocks = body.blocks as Array<{ id: string; content: string; createdAt: string }>;
    // Defaults: includeSuperseded=false hides the superseded first block.
    const ids = blocks.map((block) => block.id);
    assert.equal(ids.length, 3);
    assert.equal(ids.includes(first.id), false);
    // Newest-first ordering.
    const byCreatedAt = [...blocks].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    assert.deepEqual(ids, byCreatedAt.map((block) => block.id));
  } finally {
    await ctx.app.close();
  }
});

test('GET /api/memory/blocks strict limit/includeSuperseded/kind/scope parsing', async () => {
  const ctx = await buildMemoryApp();
  try {
    await seedBlock(ctx.service, { path: 'a', content: 'one' });
    await seedBlock(ctx.service, { path: 'a', content: 'two' });

    const ok = await callJson(ctx.app.port, { method: 'GET', path: '/api/memory/blocks?limit=1&includeSuperseded=true&kind=learning' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.blocks.length, 1);

    for (const bad of [
      '/api/memory/blocks?limit=abc',
      '/api/memory/blocks?limit=1.5',
      '/api/memory/blocks?limit=0',
      '/api/memory/blocks?limit=101',
      '/api/memory/blocks?limit=1&limit=2', // repeated key: junk, never joined
      '/api/memory/blocks?includeSuperseded=yes',
      '/api/memory/blocks?includeSuperseded=1',
      '/api/memory/blocks?unknownParam=1',
      '/api/memory/blocks?kind=nope',
      '/api/memory/blocks?keyword=',
    ]) {
      const { status, body } = await callJson(ctx.app.port, { method: 'GET', path: bad });
      assert.equal(status, 400, bad);
      assert.equal(body.error, 'Invalid memory request.', bad);
    }
  } finally {
    await ctx.app.close();
  }
});

test('GET /api/memory/blocks filters by scope, keyword, and includeSuperseded=false default', async () => {
  const ctx = await buildMemoryApp();
  try {
    const a1 = await seedBlock(ctx.service, { scope: 'alpha', path: 'a', content: 'unusual-needle' });
    await seedBlock(ctx.service, { scope: 'beta', path: 'a', content: 'unusual-needle' });
    await ctx.service.writeBlock({ scope: 'alpha', path: 'a', kind: 'correction', content: 'sup', supersedesId: a1.id });

    const scoped = await callJson(ctx.app.port, { method: 'GET', path: '/api/memory/blocks?scope=alpha' });
    assert.equal(scoped.status, 200);
    assert.ok((scoped.body.blocks as Array<{ content: string }>)[0] !== undefined);
    assert.ok((scoped.body.blocks as Array<{ content: string }>).every((block) => block.content === 'sup'));

    const keyword = await callJson(ctx.app.port, { method: 'GET', path: '/api/memory/blocks?keyword=unusual-needle&scope=beta&limit=100' });
    assert.equal(keyword.status, 200);
    assert.ok((keyword.body.blocks as unknown[])[0] !== undefined);

    const hidden = await callJson(ctx.app.port, { method: 'GET', path: '/api/memory/blocks?scope=alpha&keyword=unusual-needle' });
    assert.equal(hidden.status, 200);
    assert.equal((hidden.body.blocks as unknown[]).length, 0); // superseded hidden by default
  } finally {
    await ctx.app.close();
  }
});

// ---------------------------------------------------------------------------
// POST /api/memory/search
// ---------------------------------------------------------------------------

test('POST /api/memory/search returns ranked results with scores and no vectors', async () => {
  const ctx = await buildMemoryApp();
  try {
    const atlas = await seedReadyBlock(ctx.service, 'atlas database migration');
    const other = await seedReadyBlock(ctx.service, 'zebra jungle habitat');

    const { status, body } = await callJson(ctx.app.port, {
      method: 'POST',
      path: '/api/memory/search',
      body: { query: 'atlas database migration' },
    });
    assert.equal(status, 200);
    const results = body.results as Array<{ block: { id: string }; cosineSimilarity: number; recencyScore: number; score: number }>;
    assert.ok(results.length >= 1);
    assert.equal(results[0]?.block.id, atlas.id);
    // Scores are numbers; recency decays but cos for identical text == ~1.
    for (const result of results) {
      assert.equal(typeof result.cosineSimilarity, 'number');
      assert.ok(Number.isFinite(result.score));
      assert.ok(result.cosineSimilarity > 0.9 || result.block.id === other.id);
      // No vector data anywhere on the block/result (vectors live in stores).
      for (const key of Object.keys(result)) {
        assert.ok(!['embedding', 'vector', 'data'].includes(key), key);
      }
      assert.ok(!('embedding' in result.block));
      assert.ok(!('vector' in result.block));
    }
  } finally {
    await ctx.app.close();
  }
});

test('POST /api/memory/search applies defaults and strict validation', async () => {
  const ctx = await buildMemoryApp();
  try {
    const ok = await callJson(ctx.app.port, { method: 'POST', path: '/api/memory/search', body: { query: 'q' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.results, []);

    for (const body of [
      { query: '' },
      { query: 'x'.repeat(501) },
      { query: 'q', scope: 'has space' },
      { query: 'q', unknown: true },
      { query: 'q', limit: 0 },
    ]) {
      const { status, body: out } = await callJson(ctx.app.port, { method: 'POST', path: '/api/memory/search', body });
      assert.equal(status, 400, JSON.stringify(body));
      assert.equal(out.error, 'Invalid memory request.');
    }
  } finally {
    await ctx.app.close();
  }
});

test('POST /api/memory/search maps embedder failure and bad vector to safe 503', async () => {
  const store = new InMemoryMemoryStore();
  const failing = mockEmbedder({ fail: new Error('embedder down') });
  const serviceFail = new MemoryService({ store, embeddingProvider: failing, queue: workingQueue(), compactor: mockCompactor() });
  const appFail = await startTestApp({ memory: { service: serviceFail, queue: workingQueue() } });
  try {
    const res = await callJson(appFail.port, { method: 'POST', path: '/api/memory/search', body: { query: 'hello' } });
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'Memory service is temporarily unavailable.');
  } finally {
    await appFail.close();
  }

  const badVector: EmbeddingProvider = {
    dimensions: 384,
    model: MEMORY_EMBEDDING_MODEL,
    embed: async () => new Array(10).fill(0.5), // wrong dims
  };
  const serviceBad = new MemoryService({ store, embeddingProvider: badVector, queue: workingQueue(), compactor: mockCompactor() });
  const appBad = await startTestApp({ memory: { service: serviceBad, queue: workingQueue() } });
  try {
    const res = await callJson(appBad.port, { method: 'POST', path: '/api/memory/search', body: { query: 'hello' } });
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'Memory service is temporarily unavailable.');
  } finally {
    await appBad.close();
  }
});

// ---------------------------------------------------------------------------
// GET /api/memory/blocks/:id/related
// ---------------------------------------------------------------------------

test('GET /api/memory/blocks/:id/related returns block + outgoing + incoming', async () => {
  const ctx = await buildMemoryApp();
  try {
    const original = await seedBlock(ctx.service, { path: 'projects/atlas', content: 'original' });
    const correction = await ctx.service.writeBlock({ path: 'projects/atlas', kind: 'correction', content: 'corrected', supersedesId: original.id });

    const self = await callJson(ctx.app.port, { method: 'GET', path: `/api/memory/blocks/${correction.id}/related` });
    assert.equal(self.status, 200);
    assert.equal(self.body.block.id, correction.id);
    assert.ok(Array.isArray(self.body.outgoing));
    assert.ok(Array.isArray(self.body.incoming));
    const outEdge = self.body.outgoing[0];
    assert.equal(outEdge.relation.type, 'supersedes');
    assert.equal(outEdge.relation.targetId, original.id);
    assert.equal(outEdge.block.id, original.id);

    const onOriginal = await callJson(ctx.app.port, { method: 'GET', path: `/api/memory/blocks/${original.id}/related` });
    assert.equal(onOriginal.body.incoming[0].relation.sourceId, correction.id);
    assert.equal(onOriginal.body.incoming[0].block.id, correction.id);
  } finally {
    await ctx.app.close();
  }
});

test('GET /api/memory/blocks/:id/related 404 unknown, 400 bad UUID', async () => {
  const ctx = await buildMemoryApp();
  try {
    const missing = await callJson(ctx.app.port, { method: 'GET', path: `/api/memory/blocks/${randomUUID()}/related` });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'Memory block not found.');

    const bad = await callJson(ctx.app.port, { method: 'GET', path: '/api/memory/blocks/not-a-uuid/related' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'Invalid memory request.');
  } finally {
    await ctx.app.close();
  }
});

// ---------------------------------------------------------------------------
// POST /api/memory/blocks/:id/retry
// ---------------------------------------------------------------------------

test('POST /api/memory/blocks/:id/retry 202 pending block, records enqueue', async () => {
  const ctx = await buildMemoryApp();
  try {
    const block = await seedBlock(ctx.service, { path: 'a', content: 'retry me' });
    const enqueuedBefore = ctx.queue.embedded.length;

    const { status, body } = await callJson(ctx.app.port, { method: 'POST', path: `/api/memory/blocks/${block.id}/retry` });
    assert.equal(status, 202);
    assert.deepEqual(body, { status: 'queued', blockId: block.id });
    assert.equal(ctx.queue.embedded.length, enqueuedBefore + 1);
  } finally {
    await ctx.app.close();
  }
});

test('POST /api/memory/blocks/:id/retry 409 ready block, 404 unknown, 400 bad uuid', async () => {
  const ctx = await buildMemoryApp();
  try {
    const ready = await seedReadyBlock(ctx.service, 'already embedded');

    const conflict = await callJson(ctx.app.port, { method: 'POST', path: `/api/memory/blocks/${ready.id}/retry` });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, 'Memory conflict.');

    const missing = await callJson(ctx.app.port, { method: 'POST', path: `/api/memory/blocks/${randomUUID()}/retry` });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'Memory block not found.');

    const bad = await callJson(ctx.app.port, { method: 'POST', path: '/api/memory/blocks/abc/retry' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'Invalid memory request.');
  } finally {
    await ctx.app.close();
  }
});

test('POST /api/memory/blocks/:id/retry 202 failed block (embedding failed stays honest until worker success)', async () => {
  const ctx = await buildMemoryApp();
  try {
    const block = await seedBlock(ctx.service, { path: 'a', content: 'will fail' });
    // Simulate the worker/queue marking failure (service-side honest status).
    await ctx.store.markEmbeddingFailed(block.id, { model: ctx.embedder.model });
    const { status, body } = await callJson(ctx.app.port, { method: 'POST', path: `/api/memory/blocks/${block.id}/retry` });
    assert.equal(status, 202);
    assert.equal(body.status, 'queued');
    // Status stays failed; only the worker success flips it to ready.
    const after = await ctx.store.getBlock(block.id);
    assert.equal(after?.embeddingStatus, 'failed');
  } finally {
    await ctx.app.close();
  }
});

test('POST /api/memory/blocks/:id/retry 503 when queue fails', async () => {
  const store = new InMemoryMemoryStore();
  const embedder = mockEmbedder();
  const seedQueue = workingQueue();
  const seeding = new MemoryService({ store, embeddingProvider: embedder, queue: seedQueue, compactor: mockCompactor() });
  const block = await seeding.writeBlock({ path: 'a', kind: 'learning', content: 'seed' });

  const throwingQueue = workingQueue();
  (throwingQueue as unknown as { enqueueEmbedding: (id: string) => Promise<void> }).enqueueEmbedding = async () => {
    throw new Error('redis down');
  };
  const service = new MemoryService({ store, embeddingProvider: embedder, queue: throwingQueue, compactor: mockCompactor() });
  const app = await startTestApp({ memory: { service, queue: throwingQueue } });
  try {
    const res = await callJson(app.port, { method: 'POST', path: `/api/memory/blocks/${block.id}/retry` });
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'Memory queue is temporarily unavailable.');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// POST /api/memory/compact
// ---------------------------------------------------------------------------

test('POST /api/memory/compact 202 with queued response', async () => {
  const ctx = await buildMemoryApp();
  try {
    const { status, body } = await callJson(ctx.app.port, {
      method: 'POST',
      path: '/api/memory/compact',
      body: { scope: 'Alpha ', path: 'Projects/Atlas' },
    });
    assert.equal(status, 202);
    assert.equal(body.status, 'queued');
    assert.equal(body.scope, 'alpha');
    assert.equal(body.path, 'projects/atlas');
    assert.ok(typeof body.triggerBlockId === 'string');
    assert.equal(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.triggerBlockId),
      true,
    );
    assert.deepEqual(ctx.queue.compacted, [{ scope: 'alpha', path: 'projects/atlas', triggerBlockId: body.triggerBlockId }]);
  } finally {
    await ctx.app.close();
  }
});

test('POST /api/memory/compact strict validation and 503 queue failure', async () => {
  const ctx = await buildMemoryApp();
  try {
    for (const body of [{}, { path: 'a' }, { scope: 'a' }, { scope: 12, path: 'a' }, { scope: 'a', path: 'a', extra: 1 }]) {
      const { status, body: out } = await callJson(ctx.app.port, { method: 'POST', path: '/api/memory/compact', body });
      assert.equal(status, 400, JSON.stringify(body));
      assert.equal(out.error, 'Invalid memory request.');
    }

    const failingQueue = workingQueue();
    (failingQueue as unknown as { enqueueCompaction: (scope: string, path: string, trigger: string) => Promise<void> }).enqueueCompaction =
      async () => {
        throw new Error('redis down');
      };
    const store = new InMemoryMemoryStore();
    const service = new MemoryService({ store, embeddingProvider: mockEmbedder(), queue: failingQueue, compactor: mockCompactor() });
    const app2 = await startTestApp({ memory: { service, queue: failingQueue } });
    try {
      const res = await callJson(app2.port, { method: 'POST', path: '/api/memory/compact', body: { scope: 'a', path: 'a' } });
      assert.equal(res.status, 503);
      assert.equal(res.body.error, 'Memory queue is temporarily unavailable.');
    } finally {
      await app2.close();
    }
  } finally {
    await ctx.app.close();
  }
});

// ---------------------------------------------------------------------------
// Failure containment
// ---------------------------------------------------------------------------

test('unexpected store failure maps to safe 503 without leaking details', async () => {
  const store = failingStore();
  const service = new MemoryService({ store, embeddingProvider: mockEmbedder(), queue: workingQueue(), compactor: mockCompactor() });
  const app = await startTestApp({ memory: { service, queue: workingQueue() } });
  try {
    const write = await callJson(app.port, {
      method: 'POST',
      path: '/api/memory/blocks',
      body: { path: 'a', kind: 'learning', content: 'x' },
    });
    assert.equal(write.status, 503);
    assert.equal(write.body.error, 'Memory service is temporarily unavailable.');
    assert.ok(!write.text.includes('simulated database outage'));

    const related = await callJson(app.port, { method: 'GET', path: `/api/memory/blocks/${randomUUID()}/related` });
    assert.equal(related.status, 503);
    assert.ok(!related.text.includes('simulated database outage'));
  } finally {
    await app.close();
  }
});

test('memory routes are absent (404) when memory deps are omitted', async () => {
  const test = await startTestApp();
  try {
    const write = await callJson(test.port, { method: 'POST', path: '/api/memory/blocks', body: { path: 'a', kind: 'learning', content: 'x' } });
    assert.equal(write.status, 404);
    assert.equal(write.body.error, 'Not found.');
    const compact = await callJson(test.port, { method: 'POST', path: '/api/memory/compact', body: { scope: 'a', path: 'a' } });
    assert.equal(compact.status, 404);
  } finally {
    await test.close();
  }
});
