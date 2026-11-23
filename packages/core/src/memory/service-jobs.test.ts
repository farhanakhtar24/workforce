import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPACTION_THRESHOLD,
  InMemoryMemoryStore,
  MemoryCompactionError,
  MemoryConflictError,
  MemoryNotFoundError,
  MemoryQueueError,
  MemoryService,
  type EmbeddingProvider,
  type MemoryBlock,
  type MemoryCompactionRequest,
  type MemoryJobQueue,
  type MemoryLogger,
} from '../index.js';
import { classifyProviderCause } from './service.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class TestEmbedder implements EmbeddingProvider {
  readonly dimensions = 384 as 384;
  readonly model = 'Xenova/all-MiniLM-L6-v2';
  async embed(): Promise<readonly number[]> {
    return new Array<number>(384).fill(0);
  }
}

interface QueueCalls {
  embedding: string[];
  compaction: Array<{ scope: string; path: string; triggerBlockId: string }>;
}

class RecordingQueue implements MemoryJobQueue {
  readonly calls: QueueCalls = { embedding: [], compaction: [] };
  failEmbedding = false;

  async enqueueEmbedding(blockId: string): Promise<void> {
    if (this.failEmbedding) {
      throw new Error('queue down');
    }
    this.calls.embedding.push(blockId);
  }

  async enqueueCompaction(scope: string, path: string, triggerBlockId: string): Promise<void> {
    this.calls.compaction.push({ scope, path, triggerBlockId });
  }
}

class ScriptedCompactor {
  readonly calls: Array<readonly MemoryBlock[]> = [];
  respond: (request: MemoryCompactionRequest) => string = () => 'compacted summary';
  failWith: Error | null = null;

  async compact(request: MemoryCompactionRequest): Promise<string> {
    this.calls.push(request.blocks);
    if (this.failWith) {
      throw this.failWith;
    }
    return this.respond(request);
  }
}

class RecordingLogger implements MemoryLogger {
  readonly warnings: Array<{ message: string; error?: unknown }> = [];
  warn(message: string, error?: unknown): void {
    this.warnings.push({ message, error });
  }
}

interface Harness {
  store: InMemoryMemoryStore;
  queue: RecordingQueue;
  compactor: ScriptedCompactor;
  logger: RecordingLogger;
  service: MemoryService;
}

function makeHarness(options?: { now?: () => Date }): Harness {
  const store = new InMemoryMemoryStore();
  const queue = new RecordingQueue();
  const compactor = new ScriptedCompactor();
  const logger = new RecordingLogger();
  const service = new MemoryService({
    store,
    embeddingProvider: new TestEmbedder(),
    queue,
    compactor,
    logger,
    ...(options?.now ? { now: options.now } : {}),
  });
  return { store, queue, compactor, logger, service };
}

/** Increasing timestamps so "oldest" ordering is fully determined. */
function makeClock(): () => Date {
  let tick = 0;
  return () => new Date(1_700_000_000_000 + tick++ * 1_000);
}

async function writeN(service: MemoryService, count: number, kind: 'observation' | 'learning' = 'observation'): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const block = await service.writeBlock({ path: 'hot/path', kind, content: `entry ${i}` });
    ids.push(block.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Compaction trigger
// ---------------------------------------------------------------------------

test('compaction enqueues at the 31st active block, not the 30th', async () => {
  const { service, queue } = makeHarness();
  const ids = await writeN(service, 31);
  assert.strictEqual(queue.calls.compaction.length, 1);
  assert.strictEqual(queue.calls.compaction[0]?.triggerBlockId, ids[COMPACTION_THRESHOLD]);
  assert.strictEqual(queue.calls.compaction[0]?.scope, 'default');
  assert.strictEqual(queue.calls.compaction[0]?.path, 'hot/path');
});

test('processCompaction at exactly COMPACTION_THRESHOLD blocks is skipped', async () => {
  const { service, compactor } = makeHarness();
  await writeN(service, COMPACTION_THRESHOLD);
  const outcome = await service.processCompaction('default', 'hot/path', '00000000-0000-4000-8000-00000000000a');
  assert.deepStrictEqual(outcome, { status: 'skipped', reason: 'below_threshold', summaryId: null });
  assert.strictEqual(compactor.calls.length, 0);
});

// ---------------------------------------------------------------------------
// processCompaction: creation semantics
// ---------------------------------------------------------------------------

test('compaction creates one pending learning summary, supersedes exactly 30 oldest sources', async () => {
  const clock = makeClock();
  const { service, store, compactor, queue } = makeHarness({ now: clock });
  const ids = await writeN(service, 31);

  compactor.respond = ({ blocks }) => `summary of ${blocks.length}: ${blocks[0]?.id ?? ''}`;

  const trigger = ids[30] as string;
  const outcome = await service.processCompaction('default', 'hot/path', trigger);

  assert.strictEqual(outcome.status, 'created');
  if (outcome.status !== 'created') return;
  const { summary } = outcome;

  assert.strictEqual(summary.kind, 'learning');
  assert.strictEqual(summary.scope, 'default');
  assert.strictEqual(summary.path, 'hot/path');
  assert.strictEqual(summary.embeddingStatus, 'pending');
  assert.strictEqual(summary.content, 'summary of 30: ' + ids[0]);
  assert.deepStrictEqual(outcome.compactedFromIds, ids.slice(0, 30));
  assert.strictEqual(outcome.compactedCount, 30);
  assert.deepStrictEqual(summary.metadata, { compactedFromIds: ids.slice(0, 30), triggerBlockId: trigger });

  // The compactor received the OLDEST 30 active blocks in ascending order.
  const received = compactor.calls[0];
  assert.strictEqual(received?.length, 30);
  assert.deepStrictEqual(received?.map((block) => block.id), ids.slice(0, 30));
  assert.deepStrictEqual(
    received?.map((block) => block.createdAt),
    [...(received ?? [])].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).map((block) => block.createdAt),
  );

  // Sources superseded by the summary but retained.
  for (const sourceId of ids.slice(0, 30)) {
    const source = await store.getBlock(sourceId);
    assert.ok(source);
    assert.strictEqual(source?.supersededById, summary.id);
  }
  const triggerBlock = await store.getBlock(trigger);
  assert.strictEqual(triggerBlock?.supersededById, null); // newest stays active

  // Supersede relations exist from the summary to every source.
  const related = await service.exploreRelated(summary.id);
  assert.strictEqual(related.outgoing.length, 30);
  assert.ok(related.outgoing.every((edge) => edge.relation.type === 'supersedes'));
  assert.deepStrictEqual(
    related.outgoing.map((edge) => edge.block.id).sort(),
    ids.slice(0, 30).sort(),
  );

  // Active count: 31 - 30 + 1 summary = 2.
  assert.strictEqual(await store.countActiveBlocksByPath('default', 'hot/path'), 2);

  // Summary embedding enqueued exactly once, after commit.
  assert.strictEqual(queue.calls.embedding.filter((id) => id === summary.id).length, 1);
});

test('summary confidence is the conservative minimum of source confidences', async () => {
  const clock = makeClock();
  const { service, store } = makeHarness({ now: clock });
  for (let i = 0; i < COMPACTION_THRESHOLD; i += 1) {
    await service.writeBlock({ path: 'conf/path', kind: 'learning', content: `c${i}`, confidence: i === 5 ? 0.3 : 0.9 });
  }
  const oneMore = await service.writeBlock({ path: 'conf/path', kind: 'learning', content: 'trigger' , confidence: 1 });

  const outcome = await service.processCompaction('default', 'conf/path', oneMore.id);
  assert.strictEqual(outcome.status, 'created');
  if (outcome.status !== 'created') return;
  const summary = await store.getBlock(outcome.summary.id);
  assert.strictEqual(summary?.confidence, 0.3);
});

test('compaction enforces the summary contract: trim, 1..1000 chars, plain string', async () => {
  const { service, compactor, store, queue } = makeHarness({ now: makeClock() });
  const ids = await writeN(service, 31);

  // Empty after trim -> rejected, nothing written.
  compactor.respond = () => '   ';
  await assert.rejects(
    () => service.processCompaction('default', 'hot/path', ids[30] as string),
    (error: unknown) => {
      assert.ok(error instanceof MemoryCompactionError);
      assert.match(error.message, /1..1000 characters/);
      return true;
    },
  );
  assert.strictEqual(await store.countActiveBlocksByPath('default', 'hot/path'), 31);
  assert.strictEqual(queue.calls.embedding.length, 31); // only write enqueues

  // 1001 chars -> rejected; 1000 chars -> accepted.
  compactor.respond = () => 'x'.repeat(1001);
  await assert.rejects(() => service.processCompaction('default', 'hot/path', ids[30] as string), MemoryCompactionError);

  compactor.respond = () => `  ${'y'.repeat(999)}  `; // trims to 999, fine
  const outcome = await service.processCompaction('default', 'hot/path', ids[30] as string);
  assert.strictEqual(outcome.status, 'created');
});

test('compactor failures leave sources untouched and throw typed errors', async () => {
  const { service, compactor, store } = makeHarness({ now: makeClock() });
  const ids = await writeN(service, 31);
  compactor.failWith = new Error('LLM timeout');

  await assert.rejects(
    () => service.processCompaction('default', 'hot/path', ids[30] as string),
    (error: unknown) => {
      assert.ok(error instanceof MemoryCompactionError);
      assert.match(error.message, /compactor failed/);
      return true;
    },
  );
  assert.strictEqual(await store.countActiveBlocksByPath('default', 'hot/path'), 31);
  for (const id of ids) {
    assert.strictEqual((await store.getBlock(id))?.supersededById, null);
  }
});

// ---------------------------------------------------------------------------
// Safe provider-cause classification (BullMQ failedReason diagnostics)
// ---------------------------------------------------------------------------

const DUMMY_SECRET = 'sk-test-dummy-DO-NOT-LEAK';

/** Provider error packed with secrets across message/url/body/headers/stack to prove none leak. */
class SneakyProviderError extends Error {
  readonly statusCode?: number;
  readonly code?: string;
  readonly url = `https://provider.example/v1/chat?key=${DUMMY_SECRET}`;
  readonly body = { error: `invalid key ${DUMMY_SECRET}` };
  readonly headers = { 'x-api-key': DUMMY_SECRET };

  constructor(message: string, options?: { statusCode?: number; code?: string; name?: string }) {
    super(`${message} secret=${DUMMY_SECRET}`);
    this.name = options?.name ?? 'ProviderError';
    if (options?.statusCode !== undefined) {
      this.statusCode = options.statusCode;
    }
    if (options?.code !== undefined) {
      this.code = options.code;
    }
    this.stack = `Error: ${DUMMY_SECRET}\n    at provider`;
  }
}

async function expectCompactionFailure(
  service: MemoryService,
  scope: string,
  path: string,
  triggerBlockId: string,
  match: RegExp,
  verify: (message: string) => void,
): Promise<void> {
  await assert.rejects(
    () => service.processCompaction(scope, path, triggerBlockId),
    (error: unknown) => {
      assert.ok(error instanceof MemoryCompactionError);
      assert.ok(error.cause !== undefined); // raw cause stays attached internally
      verify(error.message);
      assert.match(error.message, match);
      return true;
    },
  );
}

test('compactor failure classification: provider HTTP 401 with secrets stays out of the public message', async () => {
  const { service, compactor } = makeHarness({ now: makeClock() });
  const ids = await writeN(service, 31);
  compactor.failWith = new SneakyProviderError('unauthorized', { statusCode: 401 });

  await expectCompactionFailure(
    service,
    'default',
    'hot/path',
    ids[30] as string,
    /^memory compactor failed for default:hot\/path \(provider HTTP 401\)$/,
    (message) => {
      assert.ok(!message.includes(DUMMY_SECRET));
      assert.ok(!message.includes('unauthorized'));
      assert.ok(!message.includes('https://'));
      assert.ok(!message.includes('body'));
    },
  );
});

test('compactor failure classification: AbortError -> provider timeout', async () => {
  const { service, compactor } = makeHarness({ now: makeClock() });
  const ids = await writeN(service, 31);
  const abort = new SneakyProviderError('request was aborted', { name: 'AbortError' });
  compactor.failWith = abort;

  await expectCompactionFailure(
    service,
    'default',
    'hot/path',
    ids[30] as string,
    /\(provider timeout\)$/,
    (message) => {
      assert.ok(!message.includes(DUMMY_SECRET));
      // Priority: timeout wins even though the sneaky error also has fields.
      assert.ok(!message.includes('HTTP'));
    },
  );
});

test('compactor failure classification: ECONNREFUSED code -> provider ECONNREFUSED', async () => {
  const { service, compactor } = makeHarness({ now: makeClock() });
  const ids = await writeN(service, 31);
  compactor.failWith = new SneakyProviderError('connect ECONNREFUSED', { code: 'ECONNREFUSED' });

  await expectCompactionFailure(
    service,
    'default',
    'hot/path',
    ids[30] as string,
    /\(provider ECONNREFUSED\)$/,
    (message) => {
      assert.ok(!message.includes(DUMMY_SECRET));
      assert.ok(!message.includes('connect ECONNREFUSED'));
    },
  );
});

test('compactor failure classification: provider SDK error name (AI_NoOutputGeneratedError)', async () => {
  const { service, compactor } = makeHarness({ now: makeClock() });
  const ids = await writeN(service, 31);
  compactor.failWith = new SneakyProviderError('no output text generated', {
    name: 'AI_NoOutputGeneratedError',
  });

  await expectCompactionFailure(
    service,
    'default',
    'hot/path',
    ids[30] as string,
    /\(provider AI_NoOutputGeneratedError\)$/,
    (message) => {
      assert.ok(!message.includes(DUMMY_SECRET));
      assert.ok(!message.includes('no output text generated'));
    },
  );
});

test('compactor failure classification: unrecognized cause -> provider unknown error (secrets never shown)', async () => {
  const { service, compactor } = makeHarness({ now: makeClock() });
  const ids = await writeN(service, 31);
  // Exotic cause: only lowercase/dotted fields that match no allowed class.
  compactor.failWith = Object.assign(new Error(`kaboom ${DUMMY_SECRET}`), {
    name: 'weird/Case!',
    code: 'eCONN-ref.used',
    statusCode: '401',
  }) as unknown as Error;

  await expectCompactionFailure(
    service,
    'default',
    'hot/path',
    ids[30] as string,
    /\(provider unknown error\)$/,
    (message) => {
      assert.ok(!message.includes(DUMMY_SECRET));
      assert.ok(!message.includes('kaboom'));
      assert.ok(!message.includes('eCONN'));
      assert.ok(!message.includes('weird/Case!'));
    },
  );
});

test('classifyProviderCause: priorities, bounds, and unsafe-shape fallback (unit)', () => {
  // timeout beats statusCode.
  assert.strictEqual(
    classifyProviderCause(Object.assign(new Error('x'), { name: 'TimeoutError', statusCode: 401 })),
    'provider timeout',
  );
  // status beats code and name.
  assert.strictEqual(
    classifyProviderCause(Object.assign(new Error('x'), { code: 'EAI_AGAIN', statusCode: 429, name: 'SomeSDKError' })),
    'provider HTTP 429',
  );
  // code beats name.
  assert.strictEqual(
    classifyProviderCause(Object.assign(new Error('x'), { code: 'ENOTFOUND', name: 'SomeSDKError' })),
    'provider ENOTFOUND',
  );
  // statusCode must be an integer in 100..599.
  assert.strictEqual(classifyProviderCause({ statusCode: '401' }), 'provider unknown error');
  assert.strictEqual(classifyProviderCause({ statusCode: 99 }), 'provider unknown error');
  assert.strictEqual(classifyProviderCause({ statusCode: 600 }), 'provider unknown error');
  assert.strictEqual(classifyProviderCause({ statusCode: 401.5 }), 'provider unknown error');
  // code must match the strict uppercase pattern (no dots/spaces/lowercase).
  assert.strictEqual(classifyProviderCause({ code: 'econnrefused' }), 'provider unknown error');
  assert.strictEqual(classifyProviderCause({ code: 'ECONN-REFUSED' }), 'provider unknown error');
  assert.strictEqual(classifyProviderCause({ code: 'aB' }), 'provider unknown error');
  // names with unsafe characters are dropped (dot/space/slash).
  assert.strictEqual(classifyProviderCause({ name: 'TypeError: fetch failed' }), 'provider unknown error');
  assert.strictEqual(classifyProviderCause({ name: 'weird/Case!' }), 'provider unknown error');
  // A plain lowercase 'error' name still yields a deterministic safe class.
  assert.strictEqual(classifyProviderCause({ name: 'error' }), 'provider error');
  // primitives and nulls are unknown.
  assert.strictEqual(classifyProviderCause('boom'), 'provider unknown error');
  assert.strictEqual(classifyProviderCause(42), 'provider unknown error');
  assert.strictEqual(classifyProviderCause(null), 'provider unknown error');
  assert.strictEqual(classifyProviderCause(undefined), 'provider unknown error');
  // DOMException-like TimeoutError via name carries the timeout class.
  assert.strictEqual(classifyProviderCause({ name: 'TimeoutError' }), 'provider timeout');
});

// ---------------------------------------------------------------------------
// Idempotency, queue failures, concurrency
// ---------------------------------------------------------------------------

test('summary embedding enqueue failure marks failed, throws, and retry re-enqueues without duplicate summaries', async () => {
  const { service, store, queue } = makeHarness({ now: makeClock() });
  const ids = await writeN(service, 31);
  const trigger = ids[30] as string;

  queue.failEmbedding = true;
  await assert.rejects(
    () => service.processCompaction('default', 'hot/path', trigger),
    (error: unknown) => {
      assert.ok(error instanceof MemoryQueueError);
      assert.strictEqual(error.code, 'memory_queue_error');
      return true;
    },
  );

  // One pending->failed summary exists; sources already superseded exactly once.
  const summaries = await store.listActiveBlocksByPath('default', 'hot/path', { limit: 10, order: 'newest', kind: 'learning' });
  assert.strictEqual(summaries.length, 1);
  const summary = summaries[0];
  assert.ok(summary);
  assert.strictEqual(summary.embeddingStatus, 'failed');
  assert.strictEqual(await store.countActiveBlocksByPath('default', 'hot/path'), 2);

  // Job retry: same trigger -> skipped/already_compacted, enqueue retried.
  queue.failEmbedding = false;
  const retry = await service.processCompaction('default', 'hot/path', trigger);
  assert.strictEqual(retry.status, 'skipped');
  if (retry.status !== 'skipped') return;
  assert.strictEqual(retry.reason, 'already_compacted');
  assert.strictEqual(retry.summaryId, summary.id);
  assert.ok(queue.calls.embedding.includes(summary.id));

  // Still exactly one summary; sources remain superseded by it.
  const summariesAfter = await store.listActiveBlocksByPath('default', 'hot/path', { limit: 10, order: 'newest', kind: 'learning' });
  assert.strictEqual(summariesAfter.length, 1);
  for (const sourceId of ids.slice(0, 30)) {
    const source = await store.getBlock(sourceId);
    assert.strictEqual(source?.supersededById, summary.id);
  }
});

test('concurrent processCompaction runs serialize per path and never duplicate the summary', async () => {
  const { service, store } = makeHarness({ now: makeClock() });
  const ids = await writeN(service, 31);
  const trigger = ids[30] as string;

  const [first, second] = await Promise.all([
    service.processCompaction('default', 'hot/path', trigger),
    service.processCompaction('default', 'hot/path', trigger),
  ]);

  const statuses = [first.status, second.status].sort();
  assert.deepStrictEqual(statuses, ['created', 'skipped']);

  const summaries = await store.listActiveBlocksByPath('default', 'hot/path', { limit: 10, order: 'newest', kind: 'learning' });
  assert.strictEqual(summaries.length, 1);
});

test('runPathExclusive serializes work on the same key (mutex semantics)', async () => {
  const { store } = makeHarness();
  let running = 0;
  let maxConcurrent = 0;

  const jobs = [
    store.runPathExclusive('s', 'p', async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return 'a';
    }),
    store.runPathExclusive('s', 'p', async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return 'b';
    }),
  ];

  const results = await Promise.all(jobs);
  assert.deepStrictEqual(results, ['a', 'b']);
  assert.strictEqual(maxConcurrent, 1);
});

test('different paths compact independently and isolation is per exact path', async () => {
  const clock = makeClock();
  const { service, store } = makeHarness({ now: clock });
  const hotIds = await writeN(service, 31);

  // A sibling path holds many blocks but must not affect hot/path counting.
  for (let i = 0; i < COMPACTION_THRESHOLD + 5; i += 1) {
    await service.writeBlock({ path: 'hot/other', kind: 'observation', content: `sibling ${i}` });
  }

  const outcome = await service.processCompaction('default', 'hot/path', hotIds[30] as string);
  assert.strictEqual(outcome.status, 'created');
  // hot/path summary supersedes only hot/path sources.
  if (outcome.status !== 'created') return;
  for (const sourceId of hotIds.slice(0, 30)) {
    const source = await store.getBlock(sourceId);
    assert.strictEqual(source?.supersededById, outcome.summary.id);
    assert.strictEqual(source?.path, 'hot/path');
  }
  // Sibling path blocks untouched.
  const siblingActive = await store.countActiveBlocksByPath('default', 'hot/other');
  assert.strictEqual(siblingActive, COMPACTION_THRESHOLD + 5);
});

test('compaction scopes are isolated from each other', async () => {
  const clock = makeClock();
  const { service, store } = makeHarness({ now: clock });
  const ids = await writeN(service, 31);
  for (let i = 0; i < COMPACTION_THRESHOLD + 2; i += 1) {
    await service.writeBlock({ scope: 'second', path: 'hot/path', kind: 'observation', content: `other scope ${i}` });
  }

  const outcome = await service.processCompaction('default', 'hot/path', ids[30] as string);
  assert.strictEqual(outcome.status, 'created');
  if (outcome.status !== 'created') return;
  const summary = await store.getBlock(outcome.summary.id);
  assert.strictEqual(summary?.scope, 'default');
  assert.strictEqual(await store.countActiveBlocksByPath('second', 'hot/path'), COMPACTION_THRESHOLD + 2);
});

test('>50 entries: staged compactions pick the next-oldest batch and never double-supersede', async () => {
  const clock = makeClock();
  const { service, store, queue } = makeHarness({ now: clock });
  const ids = await writeN(service, 60);

  const first = await service.processCompaction('default', 'hot/path', ids[59] as string);
  assert.strictEqual(first.status, 'created');
  if (first.status !== 'created') return;
  assert.strictEqual(await store.countActiveBlocksByPath('default', 'hot/path'), 31); // 60 - 30 + 1

  // Re-delivery of the SAME trigger skips (trigger already represented).
  const redelivery = await service.processCompaction('default', 'hot/path', ids[59] as string);
  assert.strictEqual(redelivery.status, 'skipped');
  if (redelivery.status !== 'skipped') return;
  assert.strictEqual(redelivery.reason, 'already_compacted');

  // The next WRITE enqueues with a fresh trigger -> second stage compacts the
  // next-oldest 30 active blocks.
  const fresh = await service.writeBlock({ path: 'hot/path', kind: 'observation', content: 'stage 2 trigger' });
  const second = await service.processCompaction('default', 'hot/path', fresh.id);
  assert.strictEqual(second.status, 'created');
  if (second.status !== 'created') return;

  const batchOne = first.compactedFromIds;
  const batchTwo = second.compactedFromIds;
  assert.strictEqual(batchTwo.length, 30);
  assert.strictEqual(new Set([...batchOne, ...batchTwo]).size, 60); // disjoint, full coverage
  assert.deepStrictEqual(batchOne, ids.slice(0, 30));
  assert.deepStrictEqual(batchTwo, ids.slice(30, 60));

  for (const id of ids) {
    const block = await store.getBlock(id);
    assert.ok(block);
    assert.ok(block.supersededById !== null); // every source superseded once
  }
  // Active: two summaries + the fresh "stage 2 trigger" block.
  assert.strictEqual(await store.countActiveBlocksByPath('default', 'hot/path'), 3);
});

// ---------------------------------------------------------------------------
// Worker edge cases
// ---------------------------------------------------------------------------

test('processEmbedding on missing block throws typed not-found (worker contract)', async () => {
  const { service } = makeHarness();
  await assert.rejects(
    () => service.processEmbedding('00000000-0000-4000-8000-00000000000f'),
    (error: unknown) => {
      assert.ok(error instanceof MemoryNotFoundError);
      assert.strictEqual(error.code, 'memory_not_found');
      return true;
    },
  );
});

test('conflict error class is distinct from queue/compaction errors (route mapping)', () => {
  const conflict = new MemoryConflictError('x');
  const queueError = new MemoryQueueError('y');
  const compactionError = new MemoryCompactionError('z');
  assert.strictEqual(conflict.code, 'memory_conflict');
  assert.strictEqual(queueError.code, 'memory_queue_error');
  assert.strictEqual(compactionError.code, 'memory_compaction_error');
  assert.notStrictEqual(conflict.code, queueError.code);
});
