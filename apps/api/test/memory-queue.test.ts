/**
 * Unit tests for the BullMQ memory queue adapter (`BullMQMemoryJobQueue`)
 * and the worker processor — all with mocked queue/job objects. No Redis, no
 * BullMQ connection, no network, no model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryJobData } from '../src/memory/bullmq-queue.js';
import {
  MEMORY_JOB_ATTEMPTS,
  MEMORY_JOB_BACKOFF_BASE_MS,
  MEMORY_JOB_OPTS,
  BullMQMemoryJobQueue,
  connectWithTimeout,
  memoryCompactJobId,
  memoryEmbedJobId,
  redisConnectionOptions,
} from '../src/memory/bullmq-queue.js';
import { processMemoryJob } from '../src/memory/worker.js';
import type { MemoryService } from '@workforce/core/memory';

// ---------------------------------------------------------------------------
// Deterministic ids
// ---------------------------------------------------------------------------

test('embed job id is UUID-based and stable', () => {
  const id = randomUuid();
  assert.equal(memoryEmbedJobId(id), `embed-${id}`);
  assert.equal(memoryEmbedJobId(id), memoryEmbedJobId(id));
  assert.equal(memoryEmbedJobId(id).includes(':'), false);
});

test('compaction job id is sha256(scope/path + trigger), stable and colon-free', () => {
  const a = memoryCompactJobId('alpha', 'a/b', randomUuid());
  assert.equal(a, memoryCompactJobId('alpha', 'a/b', '123e4567-e89b-42d3-a456-426614174000'));
  assert.equal(a.startsWith('compact-'), true);
  assert.equal(a.includes(':'), false);
  // Different triggers produce different ids.
  assert.notEqual(a, memoryCompactJobId('alpha', 'a/b', '99999999-9999-4999-8999-999999999999'));
  // Different scope/path produce different ids.
  assert.notEqual(a, memoryCompactJobId('beta', 'a/b', '123e4567-e89b-42d3-a456-426614174000'));
});

function randomUuid(): string {
  return '123e4567-e89b-42d3-a456-426614174000';
}

// ---------------------------------------------------------------------------
// Enqueue state machine against a recording fake queue
// ---------------------------------------------------------------------------

interface RecordingCall {
  name: string;
  data: MemoryJobData;
  jobId: string;
  opts?: unknown;
}

interface FakeJob {
  state: string;
  removed: boolean;
}

interface FakeQueueLike {
  add(name: string, data: MemoryJobData, opts?: unknown): Promise<undefined>;
  getJob(jobId: string): Promise<undefined | {
    getState(): Promise<string>;
    remove(): Promise<void>;
  }>;
}

interface Fake {
  calls: RecordingCall[];
  requestedIds: string[];
  jobs: Map<string, FakeJob>;
  queue: FakeQueueLike;
}

function fakeQueue(initialJobs: Map<string, FakeJob> = new Map()): Fake {
  const jobs = initialJobs as Map<string, FakeJob>;
  const calls: RecordingCall[] = [];
  const requestedIds: string[] = [];
  const queue: FakeQueueLike = {
    async add(name: string, data: MemoryJobData, opts?: unknown) {
      const jobId = (opts as { jobId: string }).jobId;
      calls.push({ name, data, jobId, opts });
      jobs.set(jobId, { state: 'waiting', removed: false });
      return undefined;
    },
    async getJob(jobId: string) {
      requestedIds.push(jobId);
      const job = jobs.get(jobId);
      return job === undefined
        ? undefined
        : {
            getState: async () => job.state,
            remove: async () => {
              job.removed = true;
              jobs.delete(jobId);
            },
          };
    },
  };
  return { calls, requestedIds, jobs, queue };
}

test('queue options carry removeOnComplete bounds with attempts/backoff', async () => {
  const fake = fakeQueue();
  const handle = new BullMQMemoryJobQueue({ queue: fake.queue });
  await handle.enqueueEmbedding(randomUuid());
  const opts = (fake.calls[0]?.opts ?? {}) as {
    attempts: number;
    backoff: { type: string; delay: number };
    removeOnComplete: { age: number; count: number };
  };
  assert.equal(opts.attempts, 3);
  assert.deepEqual(opts.backoff, { type: 'exponential', delay: 1000 });
  assert.deepEqual(opts.removeOnComplete, { age: 604800, count: 10000 });
  assert.equal(MEMORY_JOB_OPTS.removeOnComplete.age, 604_800);
  assert.equal(MEMORY_JOB_OPTS.removeOnComplete.count, 10_000);
});

test('ping with an injected queue is a no-op and never adds jobs', async () => {
  const fake = fakeQueue();
  const handle = new BullMQMemoryJobQueue({ queue: fake.queue });
  await handle.ping();
  await handle.ping(1);
  assert.equal(fake.calls.length, 0);
});

test('connectWithTimeout resolves on PONG and rejects on timeout without real Redis', async () => {
  await connectWithTimeout((client) => client.ping(), { ping: async () => 'PONG' }, 50);
  await assert.rejects(
    () =>
      connectWithTimeout(
        (client) => client.ping(),
        { ping: () => new Promise(() => undefined) },
        20,
      ),
    /Redis queue PING timeout/,
  );
  await assert.rejects(
    () =>
      connectWithTimeout(
        (client) => client.ping(),
        { ping: async () => { throw new Error('ECONNREFUSED-ish'); } },
        20,
      ),
    /ECONNREFUSED-ish/,
  );
});

// ---------------------------------------------------------------------------
// redisConnectionOptions: TLS, DB path, auth, safe failures
// ---------------------------------------------------------------------------

test('redisConnectionOptions: rediss:// gets tls, preserves host/port/auth and required blocking options', () => {
  const options = redisConnectionOptions('rediss://queue-user:not-a-secret@cache.example:6383');
  assert.equal(options.tls !== undefined, true, 'rediss must enable tls');
  assert.equal(options.host, 'cache.example');
  assert.equal(options.port, 6383);
  assert.equal(options.username, 'queue-user');
  assert.equal(options.password, 'not-a-secret');
  assert.equal(options.maxRetriesPerRequest, null);
  assert.equal(options.db, undefined, 'no db path means the server default');
});

test('redisConnectionOptions: redis://host/2 sets db 2 consistently with the chat node-redis URL parsing', () => {
  const options = redisConnectionOptions('redis://127.0.0.1:6379/2');
  assert.equal(options.db, 2);
  assert.equal(options.tls, undefined, 'plain redis:// must NOT set tls');
  assert.equal(options.host, '127.0.0.1');
  assert.equal(options.port, 6379);
  assert.equal(options.maxRetriesPerRequest, null);
});

test('redisConnectionOptions: explicit /0 keeps db 0 and stays without tls', () => {
  const options = redisConnectionOptions('redis://localhost/0');
  assert.equal(options.db, 0);
  assert.equal(options.tls, undefined);
});

test('redisConnectionOptions: no db path omits db and keeps default port', () => {
  const options = redisConnectionOptions('redis://127.0.0.1:6379');
  assert.equal(options.db, undefined);
  assert.equal(options.tls, undefined);
  assert.equal(options.port, 6379);
});

test('redisConnectionOptions: rediss with auth and /2 combines tls, db and credentials', () => {
  const options = redisConnectionOptions('rediss://tls-user:tls-pass@secure.example/2');
  assert.equal(options.tls !== undefined, true);
  assert.equal(options.db, 2);
  assert.equal(options.username, 'tls-user');
  assert.equal(options.password, 'tls-pass');
  assert.equal(options.host, 'secure.example');
});

test('redisConnectionOptions: retry strategy override and default-user handling are preserved', () => {
  const withStrategy = redisConnectionOptions('redis://127.0.0.1:6379', () => null);
  assert.equal(typeof withStrategy.retryStrategy, 'function');
  assert.equal(withStrategy.maxRetriesPerRequest, null);

  // 'default' userinfo means "no explicit username" for ioredis defaults.
  const defaultUser = redisConnectionOptions('redis://default:some-password@127.0.0.1:6379');
  assert.equal(defaultUser.username, undefined);
  assert.equal(defaultUser.password, 'some-password');
});

test('redisConnectionOptions rejects noninteger database paths with a fixed error, never the URL or secrets', () => {
  const cases: Array<[string, RegExp]> = [
    ['redis://127.0.0.1:6379/abc', /database path must be an integer/],
    ['redis://127.0.0.1:6379/1/2', /database path must be an integer/],
    ['redis://127.0.0.1:6379/-1', /database path must be an integer/],
    ['redis://127.0.0.1:6379/2.5', /database path must be an integer/],
    ['redis://127.0.0.1:6379/ 2', /database path must be an integer/],
  ];
  for (const [url, matcher] of cases) {
    try {
      redisConnectionOptions(url);
      assert.fail(`expected throw for ${'url under test'}`);
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.match(error.message, matcher);
      // Fixed safe text only: neither submitted URL characters nor credentials.
      assert.equal(error.message.includes('127.0.0.1'), false);
      assert.equal(error.message.includes('url'), false);
    }
  }

  // Secrets never leak even for an invalid path on an authenticated URL.
  const secret = 'super-secret-queue-password';
  try {
    redisConnectionOptions(`redis://queue-user:${secret}@127.0.0.1:6379/not-a-number`);
    assert.fail('expected throw');
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.message.includes('queue-user'), false);
    assert.equal(error.message.includes('not-a-number'), false);
  }
});

test('redisConnectionOptions rejects non-redis protocols with the same fixed safe error', () => {
  try {
    redisConnectionOptions('postgres://workforce@127.0.0.1:55432/db');
    assert.fail('expected throw');
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.match(error.message, /redis:\/\/ or rediss:\/\//);
    assert.equal(error.message.includes('postgres'), false);
    assert.equal(error.message.includes('workforce'), false);
  }
});

test('enqueueEmbedding adds a fresh job with attempts 3 and exponential backoff', async () => {
  const fake = fakeQueue();
  const handle = new BullMQMemoryJobQueue({ queue: fake.queue });
  const blockId = randomUuid();
  await handle.enqueueEmbedding(blockId);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0]?.data, { kind: 'embed', blockId });
  assert.equal(fake.calls[0]?.jobId, memoryEmbedJobId(blockId));
  assert.equal(MEMORY_JOB_ATTEMPTS, 3);
  assert.equal(MEMORY_JOB_BACKOFF_BASE_MS, 1000);
});

test('enqueueEmbedding no-ops while the duplicate is waiting/active/delayed/paused', async () => {
  for (const state of ['waiting', 'active', 'delayed', 'paused']) {
    const blockId = randomUuid();
    const fake = fakeQueue(new Map([[memoryEmbedJobId(blockId), { state, removed: false }]]));
    const handle = new BullMQMemoryJobQueue({ queue: fake.queue });
    await handle.enqueueEmbedding(blockId);
    assert.equal(fake.calls.length, 0, state);
  }
});

test('enqueueEmbedding no-ops when the duplicate already completed', async () => {
  const blockId = randomUuid();
  const fake = fakeQueue(new Map([[memoryEmbedJobId(blockId), { state: 'completed', removed: false }]]));
  const handle = new BullMQMemoryJobQueue({ queue: fake.queue });
  await handle.enqueueEmbedding(blockId);
  assert.equal(fake.calls.length, 0);
});

test('enqueueEmbedding genuinely requeues a FAILED job: removes it, re-adds same id', async () => {
  const blockId = randomUuid();
  const fake = fakeQueue(new Map([[memoryEmbedJobId(blockId), { state: 'failed', removed: false }]]));
  const handle = new BullMQMemoryJobQueue({ queue: fake.queue });
  await handle.enqueueEmbedding(blockId);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.jobId, memoryEmbedJobId(blockId));
});

test('enqueueCompaction follows the same state machine with deterministic id', async () => {
  const trigger = randomUuid();
  const fake = fakeQueue();
  const handle = new BullMQMemoryJobQueue({ queue: fake.queue });
  await handle.enqueueCompaction('alpha', 'a/b', trigger);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0]?.data, { kind: 'compact', scope: 'alpha', path: 'a/b', triggerBlockId: trigger });
  assert.equal(fake.calls[0]?.jobId, memoryCompactJobId('alpha', 'a/b', trigger));

  // In-flight duplicate compaction: no-op.
  const fakeActive = fakeQueue(new Map([[memoryCompactJobId('alpha', 'a/b', trigger), { state: 'active', removed: false }]]));
  const handleActive = new BullMQMemoryJobQueue({ queue: fakeActive.queue });
  await handleActive.enqueueCompaction('alpha', 'a/b', trigger);
  assert.equal(fakeActive.calls.length, 0);
});

test('a closed queue rejects further enqueues', async () => {
  const fake = fakeQueue();
  const handle = new BullMQMemoryJobQueue({ queue: fake.queue });
  await handle.close();
  await assert.rejects(
    () => handle.enqueueEmbedding(randomUuid()),
    /memory queue is closed/,
  );
});

test('missing redisUrl and injected queue throws a clear error', () => {
  assert.throws(() => new BullMQMemoryJobQueue({}), /redisUrl/);
});

// ---------------------------------------------------------------------------
// Worker processor delegation
// ---------------------------------------------------------------------------

function serviceSpy(): MemoryService & { embedded: string[]; compacted: Array<{ scope: string; path: string; triggerBlockId: string }> } {
  const spy = {
    embedded: [] as string[],
    compacted: [] as Array<{ scope: string; path: string; triggerBlockId: string }>,
    processEmbedding: async (blockId: string) => {
      spy.embedded.push(blockId);
      return { blockId, model: 'm', status: 'embedded' as const, embeddedAt: null };
    },
    processCompaction: async (scope: string, path: string, triggerBlockId: string) => {
      spy.compacted.push({ scope, path, triggerBlockId });
      return { status: 'skipped' as const, reason: 'below_threshold' as const, summaryId: null };
    },
  };
  return spy as unknown as MemoryService & {
    embedded: string[];
    compacted: Array<{ scope: string; path: string; triggerBlockId: string }>;
  };
}

function jobOf(data: unknown): Parameters<typeof processMemoryJob>[0] {
  return { data } as unknown as Parameters<typeof processMemoryJob>[0];
}

test('processor delegates embed jobs to service.processEmbedding', async () => {
  const spy = serviceSpy();
  const blockId = randomUuid();
  await processMemoryJob(jobOf({ kind: 'embed', blockId }), spy);
  assert.deepEqual(spy.embedded, [blockId]);
  assert.equal(spy.compacted.length, 0);
});

test('processor delegates compact jobs to service.processCompaction', async () => {
  const spy = serviceSpy();
  const data = { kind: 'compact', scope: 'alpha', path: 'a/b', triggerBlockId: randomUuid() };
  await processMemoryJob(jobOf(data), spy);
  assert.deepEqual(spy.compacted, [{ scope: data.scope, path: data.path, triggerBlockId: data.triggerBlockId }]);
});

test('processor throws (and rethrows for retries) unknown payloads without touching the service', async () => {
  const spy = serviceSpy();
  await assert.rejects(() => processMemoryJob(jobOf({ kind: 'nope' }), spy), /payload failed validation/);
  await assert.rejects(() => processMemoryJob(jobOf(null), spy), /payload failed validation/);
  assert.equal(spy.embedded.length, 0);
  assert.equal(spy.compacted.length, 0);
});
