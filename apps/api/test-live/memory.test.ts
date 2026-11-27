/**
 * REAL Phase 3 memory integration suite: real Prisma against the docker
 * pgvector Postgres, the real `createPostgresMemoryStore` (session advisory
 * locks via a dedicated pg.Client), the real BullMQ queue + worker over real
 * Redis, the real `MemoryService` — with a DETERMINISTIC keyword-mock 384-dim
 * embedder and a DETERMINISTIC delayed mock compactor. No Transformers, no
 * Ollama, no API key, no network beyond the local stack.
 *
 * Requirements (both already running per the repo conventions):
 * - Redis at REDIS_URL (default redis://127.0.0.1:6379)
 * - Postgres at DATABASE_URL (default postgresql://workforce:workforce@127.0.0.1:55432/workforce)
 *   with the memory migration applied (`npm run db:migrate`, wired into the
 *   root `pretest:integration` hook). URL values are never printed anywhere.
 * - Run: `npm run test:integration` (root). The offline `npm test` never
 *   touches Redis/Postgres — unchanged.
 *
 * Isolation contract:
 * - Unique per-run scope + queue name (`workforce-memory-test-<runId>`), so
 *   parallel/repeat runs never collide with each other or production queues.
 * - Cleanup deletes EXACTLY this run's DB rows (parameterized, by scope) and
 *   obliterates EXACTLY this run's test queue (never FLUSHDB, never other.
 *   queues, nothing outside the test scope).
 * - Bounded polling only (25ms ticks, hard timeouts) — no arbitrary sleeps that
 *   could hang; every close is best-effort and error-safe.
 * - ioredis connections use a fail-fast retry strategy: failures surface as
 *   test failures instead of endless reconnect loops.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import { PrismaClient } from '@workforce/core/generated/prisma';
import {
  MEMORY_EMBEDDING_MODEL,
  MemoryService,
  type EmbeddingProvider,
  type MemoryBlock,
  type MemoryCompactionRequest,
  type MemoryCompactor,
} from '@workforce/core/memory';
import { createPostgresMemoryStore } from '@workforce/core/memory/postgres';
import { DEFAULT_DATABASE_URL } from '../src/config.js';
import {
  BullMQMemoryJobQueue,
  memoryEmbedJobId,
  type BullMQMemoryJobQueueHandle,
} from '../src/memory/bullmq-queue.js';
import { createMemoryWorker, type MemoryWorkerHandle } from '../src/memory/worker.js';

// -- Environment (values never printed; all error text is fixed) --------------

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
const DATABASE_URL = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
const RUN_ID = `${process.pid.toString(36)}-${Date.now().toString(36)}`;
const TEST_QUEUE = `workforce-memory-test-${RUN_ID}`;
const RUN_SCOPE = `run-${RUN_ID}`;
/** Shared clock anchor: recency decay stays in a tiny window (deterministic scores). */
const FIXED_NOW = new Date('2026-01-15T12:00:00.000Z');
/**
 * Monotonic test clock: each `now()` call advances exactly 1ms past the last.
 * Keeps recency effectively frozen for score assertions while guaranteeing
 * STRICTLY INCREASING createdAt across writes — so compaction's "oldest 30"
 * is the first 30 writes and the threshold trigger (31st) is deterministically
 * excluded (equal-createdAt UUID tie-breaks would make that a coin flip).
 */
let nowCounter = 0;
const monotonicNow = (): Date => {
  nowCounter += 1;
  return new Date(FIXED_NOW.getTime() + nowCounter);
};
/** Short backoff for retry tests — a TEST factory option; production stays 1000. */
const TEST_BACKOFF_MS = 250;
const WAIT_TIMEOUT_MS = 30_000;
/** The mock compactor sleeps this long under the session lock on purpose. */
const COMPACTION_DELAY_MS = 700;

if (RUN_SCOPE.length > 64 || !/^[a-z0-9_-]+$/.test(RUN_SCOPE)) {
  throw new Error('test run scope failed its own schema sanity check');
}

// -- Bounded polling ----------------------------------------------------------

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

// -- Deterministic keyword embedder (content-keyed failure control) -----------

/** Token occurrences put mass at a fixed dim window; the tail is content-hash noise. */
const AXES: ReadonlyArray<{ token: string; base: number }> = [
  { token: 'atlas', base: 0 },
  { token: 'migration', base: 8 },
  { token: 'database', base: 16 },
  { token: 'postgres', base: 24 },
  { token: 'pgvector', base: 32 },
  { token: 'zebra', base: 40 },
  { token: 'jungle', base: 48 },
  { token: 'habitat', base: 56 },
  { token: 'queue', base: 64 },
  { token: 'worker', base: 72 },
  { token: 'summary', base: 80 },
  { token: 'error', base: 88 },
];

const embedderControl = {
  /** content → remaining controlled failures (retry semantics tests). */
  contentFailures: new Map<string, number>(),
  /** content → total embed calls (exactly-N assertions). */
  contentCalls: new Map<string, number>(),
};

const keywordEmbedder: EmbeddingProvider & { control: typeof embedderControl } = {
  dimensions: 384,
  model: MEMORY_EMBEDDING_MODEL,
  control: embedderControl,
  async embed(text: string): Promise<readonly number[]> {
    embedderControl.contentCalls.set(text, (embedderControl.contentCalls.get(text) ?? 0) + 1);
    const remaining = embedderControl.contentFailures.get(text) ?? 0;
    if (remaining > 0) {
      embedderControl.contentFailures.set(text, remaining - 1);
      throw new Error('controlled embedder failure');
    }
    const vector = new Array<number>(384).fill(0);
    const lowered = text.toLowerCase();
    for (const axis of AXES) {
      if (lowered.includes(axis.token)) {
        for (let j = 0; j < 8; j += 1) {
          const index: number = axis.base + j;
          vector[index] = (vector[index] ?? 0) + 1;
        }
      }
    }
    for (let i = 0; i < text.length; i += 1) {
      const index = 128 + ((text.charCodeAt(i) * 7 + i) % 128);
      vector[index] = (vector[index] ?? 0) + 0.05;
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    return vector.map((value) => value / norm);
  },
};

// -- Deterministic delayed compactor ------------------------------------------

const compactorRecord = {
  calls: [] as Array<{ scope: string; path: string; triggerBlockId: string; sourceCount: number }>,
};

const delayedMockCompactor: MemoryCompactor & { record: typeof compactorRecord } = {
  record: compactorRecord,
  async compact(request: MemoryCompactionRequest): Promise<string> {
    compactorRecord.calls.push({
      scope: request.scope,
      path: request.path,
      triggerBlockId: request.triggerBlockId,
      sourceCount: request.blocks.length,
    });
    await new Promise((resolve) => setTimeout(resolve, COMPACTION_DELAY_MS));
    return (
      `summary compaction ${request.scope} ${request.path} retained facts from ` +
      `${request.blocks.length} sources trigger ${request.triggerBlockId.slice(0, 8)}`
    );
  },
};

// -- Shared stack (built in before(), torn down in after()) -------------------

interface LiveMemoryStack {
  prisma: PrismaClient;
  service: MemoryService;
  store: ReturnType<typeof createPostgresMemoryStore>;
  queue: BullMQMemoryJobQueueHandle;
  worker: MemoryWorkerHandle;
  /** Fresh store+service over the SAME Prisma client (persistence proofs). */
  freshService(): MemoryService;
}

const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
const stack = {} as LiveMemoryStack;
/** Every test-owned ioredis client gets a hard disconnect fallback in after(). */
const ownedRedisClients: IORedis[] = [];

async function deleteRunRows(client: PrismaClient, scope: string): Promise<void> {
  await client.$executeRaw`
    DELETE FROM "MemoryRelation"
    WHERE "sourceId" IN (SELECT "id" FROM "MemoryBlock" WHERE "scope" = ${scope})
       OR "targetId" IN (SELECT "id" FROM "MemoryBlock" WHERE "scope" = ${scope})`;
  await client.$executeRaw`DELETE FROM "MemoryBlock" WHERE "scope" = ${scope}`;
}

before(async () => {
  const connectTimeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Postgres connect timeout')), 5_000);
  });
  await Promise.race([prisma.$connect(), connectTimeout]);

  // The memory schema must exist (fixed message; the URL is never printed).
  const table = await prisma.$queryRaw<Array<{ found: number }>>`
    SELECT COUNT(*)::int AS found FROM information_schema.tables
    WHERE table_name = 'MemoryBlock' AND table_schema = 'public'`;
  if (Number(table[0]?.found ?? 0) !== 1) {
    throw new Error('MemoryBlock table missing — apply the memory migration first (root: npm run db:migrate).');
  }

  const queue: BullMQMemoryJobQueueHandle = new BullMQMemoryJobQueue({
    redisUrl: REDIS_URL,
    queueName: TEST_QUEUE,
    logger: { warn: () => undefined, error: () => undefined },
    jobOptions: { backoffBaseMs: TEST_BACKOFF_MS },
    reconnectStrategy: () => null, // fail fast; never hang the suite
  });
  const store = createPostgresMemoryStore(prisma, { databaseUrl: DATABASE_URL });
  const buildService = (storeOverride?: typeof store): MemoryService =>
    new MemoryService({
      store: storeOverride ?? store,
      embeddingProvider: keywordEmbedder,
      queue,
      compactor: delayedMockCompactor,
      logger: { warn: () => undefined },
      now: monotonicNow,
    });
  const service = buildService();
  const worker = createMemoryWorker({
    service,
    redisUrl: REDIS_URL,
    queueName: TEST_QUEUE,
    logger: { warn: () => undefined, error: () => undefined },
    reconnectStrategy: () => null,
  });
  Object.assign(stack, {
    prisma,
    service,
    store,
    queue,
    worker,
    freshService: () => buildService(createPostgresMemoryStore(prisma, { databaseUrl: DATABASE_URL })),
  });

  // Defensive pre-clean (a run id can never repeat, so this is a no-op guard).
  await deleteRunRows(prisma, RUN_SCOPE);
});

/** Rejects when the wrapped cleanup step exceeds its bound — teardown never hangs. */
async function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${String(timeoutMs)}ms`)), timeoutMs);
  });
  try {
    await Promise.race([promise, timeout]);
  } catch (error) {
    void error; // cleanup failures must never hang; report via runner, best-effort
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

after(async () => {
  // 1. Close the worker FIRST: it stops fetching, lets any ACTIVE job settle.
  //    (The old order obliterated the queue under a live worker: the runner
  //    then hung with a pending post-test promise.)
  if (stack.worker !== undefined) {
    await bounded(stack.worker.close(), 10_000, 'memory worker close');
  }
  // 2. Obliterate ONLY this run's test queue (worker is stopped now; nothing
  //    else in the shared Redis DB is ever touched).
  try {
    const cleaner = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, retryStrategy: () => null });
    ownedRedisClients.push(cleaner);
    const testQueue = new Queue(TEST_QUEUE, { connection: cleaner });
    await bounded(testQueue.obliterate({ force: true }), 10_000, 'test queue obliterate');
    await bounded(testQueue.close(), 5_000, 'test queue close');
    await bounded(cleaner.quit(), 5_000, 'cleanup redis quit');
  } catch (error) {
    void error;
  }
  // 3. Close the queue handle (BullMQ-owned connection sockets).
  if (stack.queue !== undefined) {
    await bounded(stack.queue.close(), 15_000, 'memory queue close');
  }
  // 3b. Any test-owned ioredis clients that outlived their graceful quit get
  //     a hard disconnect so the event loop can drain (no hang, no leftovers).
  for (const client of ownedRedisClients) {
    // statusOf() as a function call keeps TS from narrowing ioredis' status
    // union across the `await` (the client can transition mid-cleanup).
    const statusOf = (): string => client.status;
    if (statusOf() !== 'close') {
      try {
        await bounded(client.quit(), 2_000, 'client quit');
      } catch {
        client.disconnect();
      }
      if (statusOf() !== 'close') {
        client.disconnect();
      }
    }
  }
  // 4. Exact-scope DB cleanup (parameterized; relations first, subquery-scoped).
  try {
    await bounded(deleteRunRows(prisma, RUN_SCOPE), 10_000, 'run-scope DB cleanup');
  } catch (error) {
    void error;
  }
  // 5. Prisma last.
  await bounded(prisma.$disconnect(), 10_000, 'prisma disconnect');
});

/** Seed one service write; the block is `pending` until the real worker runs. */
async function writeBlock(
  input: { path: string; kind?: MemoryBlock['kind']; content: string; scope?: string; supersedesId?: string },
): Promise<MemoryBlock> {
  return stack.service.writeBlock({
    // IMPORTANT: default to the run scope so every service write lands in the
    // same scope the tests assert against (defaulting to `default` leaked rows).
    scope: input.scope ?? RUN_SCOPE,
    ...(input.supersedesId !== undefined ? { supersedesId: input.supersedesId } : {}),
    path: input.path,
    kind: input.kind ?? 'learning',
    content: input.content,
  });
}

async function waitReady(ids: readonly string[], timeoutMs = WAIT_TIMEOUT_MS): Promise<void> {
  await waitFor(async () => {
    const rows = await stack.store.getBlocks(ids);
    return ids.every((id) => rows.get(id)?.embeddingStatus === 'ready');
  }, timeoutMs, 'blocks did not reach ready status');
}

// ---------------------------------------------------------------------------
// Tests (sequential by node:test default; later tests build on earlier state)
// ---------------------------------------------------------------------------

test('prerequisites: pgvector extension, HNSW cosine index, and tables exist', async () => {
  const extVersion = await prisma.$queryRawUnsafe<Array<{ extversion: string }>>(
    `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
  );
  const version = extVersion[0]?.extversion ?? '';
  assert.ok(version !== '', 'pgvector extension must be installed');
  // The store probes `iterative_scan` support at >= 0.8.0.
  assert.ok(version >= '0.8.0', 'pgvector >= 0.8.0 required for iterative-scan support');

  const hnsw = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
    `SELECT indexname FROM pg_indexes
     WHERE tablename = 'MemoryBlock' AND indexdef ILIKE '%hnsw%' AND indexdef ILIKE '%vector_cosine_ops%'`,
  );
  assert.ok(hnsw.length >= 1, 'HNSW cosine index must exist on MemoryBlock.embedding');

  const relations = await prisma.$queryRawUnsafe<Array<{ found: number }>>(
    `SELECT COUNT(*)::int AS found FROM information_schema.tables WHERE table_name = 'MemoryRelation'`,
  );
  assert.equal(Number(relations[0]?.found ?? 0), 1, 'MemoryRelation table must exist');
});

test('writes flow through the real queue+worker to ready across paths (corrections included)', async () => {
  const originalBlock = await writeBlock({ path: 'projects/atlas', content: 'atlas original pgvector stores memory atlas' });
  const correction = await writeBlock({
    path: 'projects/atlas',
    kind: 'correction',
    content: 'atlas correction postgres hnsw cosine index atlas v8',
    supersedesId: originalBlock.id,
  });

  const created: string[] = [originalBlock.id, correction.id];
  for (let i = 0; i < 5; i += 1) {
    created.push((await writeBlock({ path: 'projects/atlas', content: `atlas database migration worker queue fact ${i}` })).id);
  }
  created.push((await writeBlock({ path: 'projects/atlas/notes', content: 'atlas summary notes for the descendant path' })).id);
  const betaDecision = await writeBlock({ path: 'projects/beta', kind: 'decision', content: 'beta decision queue worker beta' });
  created.push(betaDecision.id);
  for (let i = 1; i < 4; i += 1) {
    created.push((await writeBlock({ path: 'projects/beta', content: `beta queue worker beta note ${i}` })).id);
  }
  created.push((await writeBlock({ path: 'projects/gamma', kind: 'changelog', content: 'gamma changelog error retry summary' })).id);
  created.push((await writeBlock({ path: 'projects/gamma', kind: 'observation', content: 'gamma observation zebra jungle habitat' })).id);
  created.push((await writeBlock({ path: 'projects/gamma', kind: 'preference', content: 'gamma preference summary pgvector' })).id);

  await waitReady(created); // everything processed by the REAL worker

  const superseded = await stack.store.getBlock(originalBlock.id);
  assert.equal(superseded?.supersededById, correction.id);
  assert.equal(superseded?.embeddingStatus, 'ready'); // superseded rows keep their embedding work

  // Exact-path active count: 5 facts + 1 correction = 6 (original is inactive).
  await waitFor(
    async () => (await stack.store.countActiveBlocksByPath(RUN_SCOPE, 'projects/atlas')) === 6,
    10_000,
    'atlas exact-path active count',
  );
  const atlasList = await stack.store.listActiveBlocksByPath(RUN_SCOPE, 'projects/atlas', { limit: 10, order: 'newest' });
  assert.equal(atlasList.length, 6);
});

test('queryBlocks honors path prefix, keyword, kind, limit and the superseded default', async () => {
  const prefix = await stack.service.queryBlocks({ scope: RUN_SCOPE, path: 'projects/atlas', limit: 100 });
  assert.ok(prefix.every((block) => block.path === 'projects/atlas' || block.path.startsWith('projects/atlas/')));
  assert.ok(prefix.some((block) => block.path === 'projects/atlas/notes'), 'descendant path included by prefix');
  assert.ok(prefix.every((block) => block.supersededById === null), 'superseded hidden by default');

  const withSuperseded = await stack.service.queryBlocks({ scope: RUN_SCOPE, path: 'projects/atlas', limit: 100, includeSuperseded: true });
  assert.ok(withSuperseded.some((block) => block.supersededById !== null), 'includeSuperseded reveals superseded rows');
  assert.equal(withSuperseded.length, prefix.length + 1);

  const keyword = await stack.service.queryBlocks({ scope: RUN_SCOPE, keyword: 'gamma changelog', limit: 100 });
  assert.equal(keyword.length, 1);
  assert.equal(keyword[0]?.kind, 'changelog');

  const byKind = await stack.service.queryBlocks({ scope: RUN_SCOPE, kind: 'preference', limit: 100 });
  assert.equal(byKind.length, 1);
  assert.equal(byKind[0]?.kind, 'preference');

  const limited = await stack.service.queryBlocks({ scope: RUN_SCOPE, limit: 2 });
  assert.equal(limited.length, 2);
  const differentScope = await stack.service.queryBlocks({ scope: 'no-such-scope-xyz', limit: 100 });
  assert.equal(differentScope.length, 0);
});

test('semanticSearch: relevance, exact 0.8/0.2 fields, no vectors, failed and pending excluded', async () => {
  const target = await writeBlock({ path: 'projects/atlas', content: 'atlas database migration pgvector atlas engine' });
  await waitReady([target.id]);

  // Deterministic exclusion guard: PAUSE the REAL worker BEFORE creating the
  // failed/pending blocks. Their embedding jobs may otherwise be picked up
  // in-flight and processEmbedding's markEmbeddingReady would land AFTER the
  // manual markEmbeddingFailed below, flipping the status back to ready
  // (correct BullMQ retry semantics — proven by the retry assertion at the
  // end) and racing this test. Paused => the jobs stay queued, so the
  // statuses below are stable for the whole search/assertion window.
  await stack.worker.worker.pause();
  let failed: MemoryBlock;
  let pending: MemoryBlock | null = null;
  try {
    failed = await writeBlock({ path: 'projects/gamma', content: 'failed zebra error atlas' });
    await stack.store.markEmbeddingFailed(failed.id, { model: MEMORY_EMBEDDING_MODEL });
    const failedStatusAtMark = (await stack.store.getBlock(failed.id))?.embeddingStatus;
    assert.equal(failedStatusAtMark, 'failed', 'the guard: failed status is stable while the worker is paused');

    const results = await stack.service.semanticSearch({ query: 'atlas database migration pgvector', scope: RUN_SCOPE, limit: 10 });
    assert.ok(results.length >= 1, 'search must return ready candidates');
    assert.equal(results[0]?.block.id, target.id, 'exact-keyword block must rank first');
    assert.ok(results.every((result) => result.block.embeddingStatus === 'ready'), 'only ready blocks returned');
    assert.ok(!results.some((result) => result.block.id === failed.id), 'failed block excluded');

    for (const result of results) {
      // Exact decomposition: score === 0.8*cosine + 0.2*recency (same float ops).
      assert.equal(result.score, 0.8 * result.cosineSimilarity + 0.2 * result.recencyScore);
      for (const key of Object.keys(result)) {
        assert.ok(['block', 'cosineSimilarity', 'recencyScore', 'score'].includes(key), key);
      }
      for (const key of Object.keys(result.block)) {
        assert.ok(!['embedding', 'vector', 'data', 'embeddingVector'].includes(key), key);
      }
    }

    // Pending exclusion (worker already paused): write, search.
    pending = await writeBlock({ path: 'projects/gamma', content: 'zebra jungle habitat pending probe' });
    const pendingNow = pending;
    const midResults = await stack.service.semanticSearch({ query: 'zebra jungle habitat pending', scope: RUN_SCOPE, limit: 10 });
    assert.ok(!midResults.some((result) => result.block.id === pendingNow.id), 'pending block excluded');
  } finally {
    await stack.worker.worker.resume().catch(() => undefined);
  }

  // Bounded state polling (no sleeps): the resumed worker settles the queued
  // embedding jobs — including the FAILED one, whose retry re-embeds and
  // flips it back to ready (the documented BullMQ retry semantics).
  if (pending !== null) {
    await waitReady([failed.id, pending.id]);
  } else {
    await waitReady([failed.id]);
  }
  const after = await stack.service.semanticSearch({ query: 'atlas database migration pgvector', scope: RUN_SCOPE, limit: 10 });
  assert.ok(after.some((result) => result.block.id === failed.id), 'failed block becomes searchable once its retry re-embeds (product retry semantics)');
  if (pending === null) {
    assert.fail('pending block was required by this fixture');
  }
  const pendingAfter = await stack.service.semanticSearch({ query: 'zebra jungle habitat pending', scope: RUN_SCOPE, limit: 10 });
  assert.ok(pendingAfter.some((result) => result.block.id === pending.id), 'pending block searchable once ready');
});

test('semanticSearch access accounting: accessCount increments, score unchanged', async () => {
  const search = { query: 'atlas database migration pgvector', scope: RUN_SCOPE, limit: 10 };
  const first = await stack.service.semanticSearch(search);
  const targetId = first[0]?.block.id as string;
  assert.ok(typeof targetId === 'string');
  const beforeBlock = await stack.store.getBlock(targetId);
  const firstScore = first[0]?.score as number;

  const second = await stack.service.semanticSearch(search);
  const afterBlock = await stack.store.getBlock(targetId);
  const secondTarget = second.find((result) => result.block.id === targetId);
  assert.ok(secondTarget !== undefined, 'same block still found');
  // The stats bump itself must not change scoring; the only movement is the
  // test clock advancing ~a few ms against a 30-day half-life (< 1e-9 score).
  assert.equal(secondTarget.score, 0.8 * secondTarget.cosineSimilarity + 0.2 * secondTarget.recencyScore);
  assert.ok(
    Math.abs(secondTarget.score - firstScore) < 1e-9,
    `access stats bump must not change the score (Δ=${String(Math.abs(secondTarget.score - firstScore))})`,
  );
  assert.equal(afterBlock?.accessCount, (beforeBlock?.accessCount ?? 0) + 1);
  assert.ok((afterBlock?.lastAccessedAt ?? null) !== null);
});

test('exploreRelated returns the correction graph with FULL neighbor blocks', async () => {
  // Independent pair on its own path — nothing else depends on it.
  const originalBlock = await writeBlock({ path: 'related/demo', content: 'related original atlas summary' });
  const correction = await writeBlock({
    path: 'related/demo',
    kind: 'correction',
    content: 'related correction queue worker atlas',
    supersedesId: originalBlock.id,
  });
  await waitReady([originalBlock.id, correction.id]);

  const onOriginal = await stack.service.exploreRelated(originalBlock.id);
  assert.equal(onOriginal.block.id, originalBlock.id);
  assert.ok(onOriginal.outgoing.length === 0, 'superseded block has no outgoing supersedes');
  const inEdge = onOriginal.incoming[0];
  assert.ok(inEdge !== undefined);
  assert.equal(inEdge.relation.type, 'supersedes');
  assert.equal(inEdge.relation.sourceId, correction.id);
  assert.equal(inEdge.block.id, correction.id);
  assert.ok(inEdge.block.content.includes('correction'), 'neighbor block is FULL (content present)');

  const onCorrection = await stack.service.exploreRelated(correction.id);
  const outEdge = onCorrection.outgoing[0];
  assert.ok(outEdge !== undefined);
  assert.equal(outEdge.relation.type, 'supersedes');
  assert.equal(outEdge.relation.targetId, originalBlock.id);
  assert.equal(outEdge.block.id, originalBlock.id, 'outgoing edge carries the FULL target block');
  assert.equal(onCorrection.incoming.length, 0);

  await assert.rejects(() => stack.service.exploreRelated(randomUUID()), (error: unknown) =>
    error instanceof Error && error.name === 'MemoryNotFoundError');
});

test('fresh service/store read proves real persistence', async () => {
  const fresh = stack.freshService();
  const blocks = await fresh.queryBlocks({ scope: RUN_SCOPE, path: 'projects/atlas', limit: 100 });
  assert.ok(blocks.length >= 1);
  const search = await fresh.semanticSearch({ query: 'atlas database migration pgvector', scope: RUN_SCOPE, limit: 10 });
  assert.ok(search.length >= 1);
  const correction = await fresh.queryBlocks({ scope: RUN_SCOPE, keyword: 'atlas correction', limit: 10 });
  assert.equal(correction[0]?.kind, 'correction');
});

test('queue retry: provider fails twice then succeeds third; exactly 3 processing calls', async () => {
  const content = `retry probe one retry ${RUN_ID}`;
  embedderControl.contentFailures.set(content, 2);
  const block = await writeBlock({ path: 'projects/retry', content });
  await waitReady([block.id], 20_000);
  assert.equal(embedderControl.contentCalls.get(content), 3, 'exactly 3 processing calls (2 failures + 1 success)');
  const final = await stack.store.getBlock(block.id);
  assert.equal(final?.embeddingStatus, 'ready');
});

test('exhausted job stays failed; explicit re-enqueue genuinely requeues and succeeds', async () => {
  const content = `retry probe exhaustion ${RUN_ID}`;
  embedderControl.contentFailures.set(content, 99);
  const block = await writeBlock({ path: 'projects/retry', content });
  // attempts=3 with test backoff (250/500ms) → exactly 3 runs, then failed.
  await waitFor(
    async () => (embedderControl.contentCalls.get(content) ?? 0) >= 3,
    20_000,
    'job exhausted its 3 attempts',
  );
  await new Promise((resolve) => setTimeout(resolve, 100)); // let the final mark land
  const failedBlock = await stack.store.getBlock(block.id);
  assert.equal(failedBlock?.embeddingStatus, 'failed', 'honest failed status after exhausted retries');

  // The deterministic job is genuinely FAILED in BullMQ (all 3 attempts used).
  const checkConnection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, retryStrategy: () => null });
  ownedRedisClients.push(checkConnection);
  const jobCheck = new Queue(TEST_QUEUE, { connection: checkConnection });
  try {
    await waitFor(async () => {
      const job = await jobCheck.getJob(memoryEmbedJobId(block.id));
      return job !== undefined && (await job.isFailed());
    }, 15_000, 'embed job reached failed state after 3 attempts');
    const job = await jobCheck.getJob(memoryEmbedJobId(block.id));
    assert.ok(job !== undefined, 'failed job is still tracked under its deterministic id');
    assert.equal(await job.isFailed(), true, 'job state is failed after 3 attempts');
  } finally {
    await bounded(jobCheck.close(), 5_000, 'job check close');
  }

  embedderControl.contentFailures.delete(content);
  // Explicit re-enqueue path (the call the retry route makes): the FAILED job
  // is removed and re-added under the SAME deterministic id.
  await stack.queue.enqueueEmbedding(block.id);
  await waitReady([block.id], 20_000);
  assert.equal(embedderControl.contentCalls.get(content), 4, '3 failed attempts + 1 successful requeue run');
});

test('compaction auto-triggers at 31 exact-path blocks: one summary, 30 superseded, active 2, summary ready', async () => {
  const path = 'compact/auto';
  const sourceIds: string[] = [];
  let triggerId = '';
  for (let i = 0; i < 31; i += 1) {
    const block = await writeBlock({ path, content: `auto compact block ${i} queue worker ${RUN_ID}` });
    sourceIds.push(block.id);
    if (i === 30) {
      triggerId = block.id; // the write that crossed the threshold
    }
  }
  await waitReady(sourceIds);
  await waitFor(
    async () => (await stack.store.countActiveBlocksByPath(RUN_SCOPE, path)) === 2,
    40_000,
    'compaction settled (summary + trigger remain active)',
  );

  const activeAll = await stack.store.listActiveBlocksByPath(RUN_SCOPE, path, { limit: 10, order: 'newest' });
  assert.equal(activeAll.length, 2, 'exactly the summary and the threshold-crossing trigger stay active');
  const summary = activeAll.find((block) => block.kind === 'learning' && block.metadata['triggerBlockId'] === triggerId);
  assert.ok(summary !== undefined, 'one summary references the real trigger id');

  const trigger = await stack.store.getBlock(triggerId);
  assert.equal(trigger?.supersededById ?? null, null, 'threshold trigger stays active');

  const metadataSources = summary?.metadata['compactedFromIds'] as string[];
  assert.ok(Array.isArray(metadataSources));
  assert.equal(metadataSources.length, 30);
  assert.ok(!metadataSources.includes(triggerId), 'summary does not claim the still-active trigger');
  for (const sourceId of metadataSources) {
    const source = await stack.store.getBlock(sourceId);
    assert.equal(source?.supersededById, summary?.id, 'each compacted source superseded by the summary');
    assert.equal(source?.embeddingStatus, 'ready', 'source rows retained, never deleted');
  }
  // Supersede relations point FROM the summary TO each source, full row retained.
  const summaryRelations = await stack.store.listRelationsBySource(summary.id);
  assert.equal(summaryRelations.filter((relation) => relation.type === 'supersedes').length, 30);
  const firstSource = metadataSources[0] as string;
  assert.ok(summaryRelations.some((relation) => relation.type === 'supersedes' && relation.targetId === firstSource));

  await waitReady([summary.id], 15_000);
  const readySummary = await stack.store.getBlock(summary.id);
  assert.equal(readySummary?.embeddingStatus, 'ready', 'summary embedding processed through the real queue');
  // Compactor contract: invoked exactly once for this path with 30 sources.
  const calls = compactorRecord.calls.filter((call) => call.path === path);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.sourceCount, 30);
  assert.equal(calls[0]?.scope, RUN_SCOPE);
});

test('concurrent duplicate-trigger compaction creates no duplicate; Prisma reads flow during the session lock', async () => {
  const { service, store } = stack;
  const path = 'compact/explicit';
  const sourceIds: string[] = [];
  let triggerId = '';
  for (let i = 0; i < 31; i += 1) {
    // Direct store writes (ready, no vectors): compaction does not need
    // embeddings. Strictly increasing createdAt makes the compactor's
    // "oldest 30" exactly the FIRST 30 writes; the threshold trigger (31st)
    // is deterministically excluded and stays active.
    const block = await store.insertSupersedingBlock(
      {
        scope: RUN_SCOPE,
        path,
        kind: 'learning',
        content: `explicit compact block ${i} summary atlas`,
        confidence: 0.5,
        embeddingStatus: 'ready',
        createdAt: new Date(FIXED_NOW.getTime() + i).toISOString(),
      },
      [],
    );
    sourceIds.push(block.id);
    if (i === 30) {
      triggerId = block.id;
    }
  }
  assert.equal(sourceIds.length, 31);

  let settled = false;
  const markDone = (): void => {
    settled = true;
  };
  const compactA = service.processCompaction(RUN_SCOPE, path, triggerId).then((outcome) => {
    markDone();
    return outcome;
  });
  const compactB = service.processCompaction(RUN_SCOPE, path, triggerId).then((outcome) => {
    markDone();
    return outcome;
  });

  // While BOTH calls hold/wait the session advisory lock, plain Prisma reads
  // keep flowing — proof the compaction is NOT wrapped in a 60s Prisma
  // transaction and the lock lives on a separate pg.Client session.
  const readStarted = Date.now();
  const read = await prisma.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count FROM "MemoryBlock" WHERE "scope" = ${RUN_SCOPE}`;
  const readMs = Date.now() - readStarted;
  assert.ok(readMs < 400, `independent Prisma read must not be blocked by the compaction lock (took ${String(readMs)}ms)`);
  assert.ok(Number(read[0]?.count ?? 0) >= 31);
  assert.equal(settled, false, 'a compaction is still in progress while unrelated reads succeed');

  const [outcomeA, outcomeB] = await Promise.all([compactA, compactB]);
  const createdCount = [outcomeA, outcomeB].filter((outcome) => outcome.status === 'created').length;
  assert.equal(createdCount, 1, 'exactly one created summary across duplicate triggers');
  const skipped = [outcomeA, outcomeB].find((outcome) => outcome.status === 'skipped');
  assert.ok(skipped !== undefined, 'the duplicate call skipped (already_compacted or below_threshold)');

  const activeAll = await store.listActiveBlocksByPath(RUN_SCOPE, path, { limit: 10, order: 'newest' });
  assert.equal(activeAll.length, 2, 'one summary + one still-active trigger block');
  const summaries = activeAll.filter((block) => block.kind === 'learning' && Array.isArray(block.metadata['compactedFromIds']));
  assert.equal(summaries.length, 1, 'no duplicate summaries');
  const summary = summaries[0] as MemoryBlock;
  assert.equal(summary.metadata['triggerBlockId'], triggerId);
  assert.equal((summary.metadata['compactedFromIds'] as string[]).length, 30);
  // Exactly one compactor invocation for this path across both calls.
  assert.equal(compactorRecord.calls.filter((call) => call.path === path).length, 1);

  // The summary's own embedding job (enqueued after commit) really runs.
  await waitFor(
    async () => (await store.getBlock(summary.id))?.embeddingStatus === 'ready',
    20_000,
    'explicit-compaction summary embeds through the real queue',
  );
});
