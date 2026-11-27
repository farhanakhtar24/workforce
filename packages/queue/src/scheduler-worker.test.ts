/**
 * Unit tests for the scheduler worker bridge: PURE job→input extraction
 * (prevMillis vs timestamp vs ONCE payload, attemptsMade+1, bounded ids) and
 * the processor retry contract (!ok/malformed → fixed safe throw; client
 * throws propagate). The BullMQ worker itself is faked via workerFactory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  INVALID_SCHEDULER_PAYLOAD_MESSAGE,
  SCHEDULER_RUN_MALFORMED_MESSAGE,
  SCHEDULER_RUN_RETRYABLE_MESSAGE,
  SCHEDULER_WORKER_CONCURRENCY,
  schedulerAttemptOf,
  scheduledInputFromJob,
  executionInputFromJob,
  queueJobIdOf,
  processSchedulerJob,
  createSchedulerWorker,
  type SchedulerJobLike,
  type SchedulerLogger,
  type SchedulerProcessor,
  type SchedulerRunClient,
  type SchedulerRunResult,
  type SchedulerRunScheduledInput,
  type SchedulerRunExecutionInput,
} from './scheduler/index.js';

const stubLogger: SchedulerLogger = { error: () => undefined, warn: () => undefined };


// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Builds a job-like with defaults overridable per test. */
function makeJob(overrides?: Partial<SchedulerJobLike>): SchedulerJobLike {
  return {
    data: { taskId: 'task-1' },
    id: 42,
    timestamp: 1751692801001,
    attemptsMade: 0,
    repeatJobKey: null,
    opts: { repeat: { prevMillis: 1751692800000 } },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

test('constants pin the Phase 5 worker budget', () => {
  assert.equal(SCHEDULER_WORKER_CONCURRENCY, 2);
});

test('queueJobIdOf stringifies the job id and stays undefined without one', () => {
  assert.equal(queueJobIdOf({ data: {} }), undefined);
  assert.equal(queueJobIdOf({ data: {}, id: null }), undefined);
  assert.equal(queueJobIdOf({ data: {}, id: 7 }), '7');
  assert.equal(queueJobIdOf({ data: {}, id: 'job-1' }), 'job-1');
});

test('schedulerAttemptOf is attemptsMade+1 with a fresh-run fallback', () => {
  assert.equal(schedulerAttemptOf({ data: {}, attemptsMade: 0 }), 1);
  assert.equal(schedulerAttemptOf({ data: {}, attemptsMade: 2 }), 3);
  assert.equal(schedulerAttemptOf({ data: {} }), 1);
  assert.equal(schedulerAttemptOf({ data: {}, attemptsMade: -1 }), 1);
});

test('scheduledInputFromJob prefers the ONCE payload scheduledFor', () => {
  const input = scheduledInputFromJob(makeJob({
    data: { taskId: 'task-1', scheduledFor: '2026-07-05T10:00:00.000Z' },
    repeatJobKey: null,
  }));
  assert.deepEqual(input, {
    taskId: 'task-1',
    scheduledFor: '2026-07-05T10:00:00.000Z',
    queueJobId: '42',
    attempt: 1,
  } satisfies SchedulerRunScheduledInput);
});

test('scheduledInputFromJob derives the instant from opts.repeat.prevMillis', () => {
  const input = scheduledInputFromJob(makeJob({
    repeatJobKey: 'repeat:task-1:0',
  }));
  assert.deepEqual(input, {
    taskId: 'task-1',
    scheduledFor: new Date(1751692800000).toISOString(),
    queueJobId: '42',
    repeatJobKey: 'repeat:task-1:0',
    attempt: 1,
  } satisfies SchedulerRunScheduledInput);
});

test('scheduledInputFromJob tolerates a shallow opts.prevMillis (fakes)', () => {
  const input = scheduledInputFromJob(makeJob({
    opts: { prevMillis: 1751692800000 },
  }));
  assert.equal(input?.scheduledFor, new Date(1751692800000).toISOString());
});

test('scheduledInputFromJob falls back to the job timestamp', () => {
  const input = scheduledInputFromJob(makeJob({ opts: {} }));
  assert.equal(input?.scheduledFor, new Date(1751692801001).toISOString());
});

test('scheduledInputFromJob rejects malformed payloads and unbounded ids', () => {
  // Not an object
  assert.equal(scheduledInputFromJob({ data: null }), null);
  // No taskId
  assert.equal(scheduledInputFromJob({ data: {} }), null);
  // Overlong taskId (> AGENT_TASK_MAX_QUEUE_ID_LENGTH = 128)
  assert.equal(scheduledInputFromJob({ data: { taskId: 't'.repeat(129) } }), null);
  // Untrimmed taskId
  assert.equal(scheduledInputFromJob({ data: { taskId: ' task-1' } }), null);
  // scheduledFor without the Z suffix is rejected
  assert.equal(
    scheduledInputFromJob(makeJob({ data: { taskId: 't1', scheduledFor: '2026-07-05T10:00:00+02:00' } })),
    null,
  );
  // Recurring job with NO derivable instant
  assert.equal(scheduledInputFromJob(makeJob({ data: { taskId: 't1' }, opts: {}, timestamp: undefined })), null);
  // Non-finite prevMillis is ignored, timestamp fallback still applies
  const input = scheduledInputFromJob(makeJob({ opts: { repeat: { prevMillis: Number.NaN } } }));
  assert.equal(input?.scheduledFor, new Date(1751692801001).toISOString());
});

test('executionInputFromJob maps execution payloads with attemptsMade+1', () => {
  const input = executionInputFromJob(makeJob({
    data: { executionId: 'exe-1' },
    id: 'job-9',
    attemptsMade: 2,
  }));
  assert.deepEqual(input, {
    executionId: 'exe-1',
    queueJobId: 'job-9',
    attempt: 3,
  } satisfies SchedulerRunExecutionInput);
  // Overlong executionId is rejected
  assert.equal(executionInputFromJob({ data: { executionId: 'e'.repeat(129) } }), null);
});

// ---------------------------------------------------------------------------
// Processor contract
// ---------------------------------------------------------------------------

function fixedClient(result: unknown, throws?: () => Error): SchedulerRunClient {
  const respond = (): unknown => {
    if (throws !== undefined) {
      throw throws();
    }
    return result;
  };
  return {
    runScheduled: async (input) => {
      assert.equal(input.taskId, 'task-1');
      assert.equal(typeof input.attempt, 'number');
      return respond() as SchedulerRunResult;
    },
    runExecution: async (input) => {
      assert.equal(input.executionId, 'exe-1');
      return respond() as SchedulerRunResult;
    },
  };
}

test('processor resolves cleanly on ok:true (terminal/skipped success)', async () => {
  await processSchedulerJob(makeJob({ data: { taskId: 'task-1' } }), fixedClient({ ok: true }));
  await processSchedulerJob(makeJob({ data: { executionId: 'exe-1' } }), fixedClient({ ok: true }));
});

test('processor throws the FIXED retryable error on ok:false', async () => {
  await assert.rejects(
    processSchedulerJob(makeJob({ data: { taskId: 'task-1' } }), fixedClient({ ok: false, reason: 'store down' })),
    (error: unknown) => `${(error as Error).message}` === SCHEDULER_RUN_RETRYABLE_MESSAGE,
  );
});

test('processor throws the FIXED malformed-result error on an unusable result', async () => {
  await assert.rejects(
    processSchedulerJob(makeJob({ data: { executionId: 'exe-1' } }), fixedClient(undefined)),
    (error: unknown) => `${(error as Error).message}` === SCHEDULER_RUN_MALFORMED_MESSAGE,
  );
  await assert.rejects(
    processSchedulerJob(makeJob({ data: { executionId: 'exe-1' } }), fixedClient({ ok: 'yes' })),
    (error: unknown) => `${(error as Error).message}` === SCHEDULER_RUN_MALFORMED_MESSAGE,
  );
});

test('processor propagates run-client throws untouched (host owns permanence)', async () => {
  await assert.rejects(
    processSchedulerJob(
      makeJob({ data: { taskId: 'task-1' } }),
      fixedClient(undefined, () => new Error('scheduler store unavailable')),
    ),
    (error: unknown) => `${(error as Error).message}` === 'scheduler store unavailable',
  );
});

test('processor throws the FIXED payload error on malformed jobs', async () => {
  await assert.rejects(
    processSchedulerJob(makeJob({ data: 'junk' }), fixedClient({ ok: true })),
    (error: unknown) => `${(error as Error).message}` === INVALID_SCHEDULER_PAYLOAD_MESSAGE,
  );
  // Recurring variant with no instant to derive → payload rejected
  await assert.rejects(
    processSchedulerJob(makeJob({ data: { taskId: 'task-1' }, opts: {}, timestamp: undefined }), fixedClient({ ok: true })),
    (error: unknown) => `${(error as Error).message}` === INVALID_SCHEDULER_PAYLOAD_MESSAGE,
  );
});

// ---------------------------------------------------------------------------
// Worker lifecycle (fake factory, offline)
// ---------------------------------------------------------------------------

class FakeWorker {
  closeCalls = 0;
  hang = false;
  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.hang) {
      return new Promise<void>(() => undefined);
    }
  }
}

test('createSchedulerWorker routes jobs through the factory processor', async () => {
  const fake = new FakeWorker();
  let received: SchedulerProcessor | undefined;
  const handle = createSchedulerWorker({
    runClient: fixedClient({ ok: true }),
    logger: stubLogger,
    workerFactory: (processor) => {
      received = processor;
      return fake;
    },
  });
  assert.equal(received !== undefined, true);
  assert.equal(handle.worker, fake);
  await received!(makeJob({ data: { taskId: 'task-1', scheduledFor: '2026-07-05T10:00:00.000Z' } }));
  await assert.rejects(
    received!(makeJob({ data: { taskId: 'task-1' }, opts: {}, timestamp: undefined })),
    (error: unknown) => `${(error as Error).message}` === INVALID_SCHEDULER_PAYLOAD_MESSAGE,
  );
  await handle.close();
  assert.equal(fake.closeCalls, 1);
});

test('worker close is bounded when the worker hangs', async () => {
  const fake = new FakeWorker();
  fake.hang = true;
  const handle = createSchedulerWorker({
    runClient: fixedClient({ ok: true }),
    logger: stubLogger,
    workerFactory: () => fake,
    closeTimeoutMs: 25,
  });
  await handle.close();
  // Bounded: returned before the hanging worker did.
});

test('createSchedulerWorker requires a redisUrl without a factory', () => {
  assert.throws(
    () =>
      createSchedulerWorker({
        runClient: fixedClient({ ok: true }),
        logger: { error: () => undefined, warn: () => undefined },
      }),
    (error: unknown) => `${(error as Error).message}`.includes('requires redisUrl'),
  );
});

// ---------------------------------------------------------------------------
// Job correlation context (hook + deterministic request id)
// ---------------------------------------------------------------------------

import { AsyncLocalStorage } from 'node:async_hooks';

import {
  createSchedulerJobEventHandlers,
  schedulerJobContextId,
  schedulerRequestId,
  type SchedulerWorkerEventHandlers,
} from './scheduler/index.js';

test('schedulerRequestId is deterministic, bounded and safe for hostile job ids', () => {
  const first = schedulerRequestId('job-1');
  // Deterministic: same job id → same id.
  assert.equal(schedulerRequestId('job-1'), first);
  // Different job id → different id.
  assert.notEqual(schedulerRequestId('job-2'), first);
  // Shape: `scheduler-` + hex, bounded to the safe request-id contract.
  assert.match(first, /^scheduler-[0-9a-f]{32}$/);
  assert.ok(first.length <= 128);
  // Hostile ids (colons/repeats/unicode/empty) stay deterministic + safe.
  for (const hostile of ['repeat:task-1:0', 'job with spaces', 'jobé', '']) {
    const id = schedulerRequestId(hostile);
    assert.match(id, /^scheduler-[0-9a-f]{32}$/);
    assert.equal(schedulerRequestId(hostile), id);
  }
});

test('schedulerJobContextId stringifies ids and falls back safely', () => {
  assert.equal(schedulerJobContextId('job-1'), 'job-1');
  assert.equal(schedulerJobContextId(42), '42');
  assert.equal(schedulerJobContextId(undefined), 'unknown');
  assert.equal(schedulerJobContextId(null), 'unknown');
});

test('processor + completed/failed events share ONE per-job context', async () => {
  const als = new AsyncLocalStorage<string>();
  const hookArgs: string[] = [];
  // EXACTLY the host hook shape (apps/api/src/scheduler-worker.ts): bind the
  // DETERMINISTIC request id derived from the raw job id the queue passes.
  const hook = <T,>(jobId: string, next: () => T): T => {
    hookArgs.push(jobId);
    return als.run(schedulerRequestId(jobId), next);
  };
  const observed: string[] = [];

  const seenClient: SchedulerRunClient = {
    runScheduled: async (input) => {
      observed.push(`scheduled:${als.getStore() ?? 'none'}:${input.queueJobId}`);
      return { ok: true };
    },
    runExecution: async () => ({ ok: true }),
  };

  let completedInContext: string | undefined;
  let failedInContext: string | undefined;
  let failedErrorType: string | undefined;
  const logger = {
    warn: (context: string): void => {
      completedInContext = `${context}@${als.getStore() ?? 'none'}`;
    },
    error: (context: string, error: unknown): void => {
      failedInContext = `${context}@${als.getStore() ?? 'none'}`;
      failedErrorType = error instanceof Error ? error.name : typeof error;
    },
  };

  const handlers: SchedulerWorkerEventHandlers = createSchedulerJobEventHandlers(logger, hook);
  handlers.onCompleted(makeJob({ id: 'job-1' }));
  handlers.onFailed(undefined, new TypeError('synthetic'));

  let receivedProcessor: SchedulerProcessor | undefined;
  const fake = new FakeWorker();
  const handle = createSchedulerWorker({
    runClient: seenClient,
    logger,
    withJobContext: hook,
    workerFactory: (processor) => {
      receivedProcessor = processor;
      return fake;
    },
  });
  await receivedProcessor!(makeJob({ id: 'job-1', data: { taskId: 'task-1' } }));

  // Same deterministic id in ALL three surfaces for one job occurrence.
  const expected = schedulerRequestId('job-1');
  assert.equal(completedInContext, `scheduler-worker-completed job-1@${expected}`);
  // Failed event WITHOUT a job: safe fallback id, byte-identical log text.
  assert.equal(failedInContext, `scheduler-worker-failed undefined@${schedulerRequestId('unknown')}`);
  assert.equal(failedErrorType, 'TypeError');
  assert.equal(observed[0], `scheduled:${expected}:job-1`);
  // The queue hands the hook the RAW stringified job id (host hashes it).
  assert.deepEqual(hookArgs, ['job-1', 'unknown', 'job-1']);
});

test('without a hook the previous no-context behavior is unchanged', async () => {
  let processed = 0;
  const client: SchedulerRunClient = {
    runScheduled: async () => {
      processed += 1;
      return { ok: true };
    },
    runExecution: async () => ({ ok: true }),
  };
  const lines: string[] = [];
  const logger = {
    warn: (context: string): void => {
      lines.push(context);
    },
    error: (context: string): void => {
      lines.push(context);
    },
  };

  let receivedProcessor: SchedulerProcessor | undefined;
  const fake = new FakeWorker();
  const handle = createSchedulerWorker({
    runClient: client,
    logger,
    workerFactory: (processor) => {
      receivedProcessor = processor;
      return fake;
    },
  });
  await receivedProcessor!(makeJob({ id: 'job-1', data: { taskId: 'task-1' } }));
  assert.equal(processed, 1);

  const handlers = createSchedulerJobEventHandlers(logger);
  handlers.onCompleted(makeJob({ id: 'job-1' }));
  handlers.onFailed(undefined, new Error('synthetic'));
  // Byte-identical texts, no context machinery involved.
  assert.deepEqual(lines, ['scheduler-worker-completed job-1', 'scheduler-worker-failed undefined']);
  await handle.close();
});
