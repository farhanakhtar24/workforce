/**
 * Unit tests for the BullMQ scheduler queue: recurring job-scheduler upsert
 * (exact pattern/tz/template, library-owned repeat ids), inactive/once
 * removals, deterministic ONCE delay/dedupe/update semantics, MANUAL/RETRY
 * execution dedupe (any-state = no duplicate), reconcile, id validation, and
 * the bounded/idempotent ping+close lifecycle. No real Redis anywhere.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AgentTask } from '@workforce/core/scheduler';

import {
  BullMQSchedulerQueue,
  SCHEDULER_COMPLETED_RETENTION_AGE_SECONDS,
  SCHEDULER_COMPLETED_RETENTION_COUNT,
  SCHEDULER_JOB_ATTEMPTS,
  SCHEDULER_JOB_BACKOFF_BASE_MS,
  SCHEDULER_QUEUE_NAME,
  SCHEDULER_WORKER_CONCURRENCY,
  SCHEDULER_TASK_JOB_NAME,
  SCHEDULER_EXECUTION_JOB_NAME,
  onceDelayMs,
  schedulerExecutionJobId,
  schedulerJobOptions,
  schedulerOnceJobId,
  type SchedulerQueueLike,
  type SchedulerQueueJobLike,
} from './scheduler/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-07-01T00:00:00.000Z');
const ONCE_AT = '2026-07-05T10:00:00.000Z';
const ONCE_LATER = '2026-07-06T10:00:00.000Z';

function makeTask(overrides?: Partial<AgentTask>): AgentTask {
  return {
    id: 'task-1',
    name: 'Task one',
    agentSlug: 'general',
    mode: 'plan',
    prompt: 'do the thing',
    scope: 'default',
    recurrenceType: 'DAILY',
    recurrenceConfig: { hour: 9, minute: 30 },
    skipDates: [],
    isActive: true,
    timezone: 'UTC',
    nextRunAt: '2026-07-02T09:30:00.000Z',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function onceTask(overrides?: Partial<AgentTask>): AgentTask {
  return makeTask({
    recurrenceType: 'ONCE',
    recurrenceConfig: { runAt: ONCE_AT },
    nextRunAt: ONCE_AT,
    ...overrides,
  });
}

interface FakeJobEntry {
  state: string;
  data?: unknown;
}

/** In-memory SchedulerQueueLike that records every call for assertions. */
class FakeSchedulerQueue implements SchedulerQueueLike {
  readonly added: Array<{ name: string; data: unknown; opts: Record<string, unknown> }> = [];
  readonly upserts: Array<{ id: string; repeatOpts: unknown; template: unknown }> = [];
  readonly schedulerRemovals: string[] = [];
  readonly jobRemovals: string[] = [];
  readonly getJobCalls: string[] = [];
  readonly jobs = new Map<string, FakeJobEntry>();
  readonly schedulers = new Map<string, unknown>();
  closeCalls = 0;

  async add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<unknown> {
    this.added.push({ name, data, opts: opts ?? {} });
    // Mirror BullMQ: a custom jobId creates the job at that id (waiting, or
    // delayed when a delay is present) so deterministic dedupe is testable.
    const jobId = typeof opts?.['jobId'] === 'string' ? opts['jobId'] : `auto-${this.added.length}`;
    this.jobs.set(jobId, {
      state: typeof opts?.['delay'] === 'number' ? 'delayed' : 'waiting',
      data,
    });
    return {};
  }

  async getJob(jobId: string): Promise<SchedulerQueueJobLike | null> {
    this.getJobCalls.push(jobId);
    const entry = this.jobs.get(jobId);
    if (entry === undefined) {
      return null;
    }
    return {
      data: entry.data,
      getState: async () => entry.state,
      remove: async () => {
        if (this.jobs.get(jobId) !== entry) {
          throw new Error(`job ${jobId} was already removed`);
        }
        this.jobs.delete(jobId);
        this.jobRemovals.push(jobId);
      },
    };
  }

  async getJobScheduler(id: string): Promise<unknown> {
    return this.schedulers.get(id) ?? undefined;
  }

  async removeJobScheduler(id: string): Promise<unknown> {
    this.schedulerRemovals.push(id);
    this.schedulers.delete(id);
    return true;
  }

  async upsertJobScheduler(id: string, repeatOpts: unknown, jobTemplate?: unknown): Promise<unknown> {
    this.upserts.push({ id, repeatOpts, template: jobTemplate });
    return {};
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function makeQueue(): { queue: BullMQSchedulerQueue; fake: FakeSchedulerQueue } {
  const fake = new FakeSchedulerQueue();
  return { queue: new BullMQSchedulerQueue({ queue: fake }), fake };
}

// ---------------------------------------------------------------------------

test('constants pin the Phase 5 queue contract', () => {
  assert.equal(SCHEDULER_QUEUE_NAME, 'workforce-scheduler');
  assert.equal(SCHEDULER_JOB_ATTEMPTS, 3);
  assert.equal(SCHEDULER_JOB_BACKOFF_BASE_MS, 1000);
  assert.equal(SCHEDULER_WORKER_CONCURRENCY, 2);
  assert.equal(SCHEDULER_COMPLETED_RETENTION_AGE_SECONDS, 604800);
  assert.equal(SCHEDULER_COMPLETED_RETENTION_COUNT, 10000);
  // Failed jobs stay in the queue: retained failed jobs ARE the DLQ evidence.
  assert.equal(schedulerJobOptions().removeOnFail, false);
  assert.equal(SCHEDULER_TASK_JOB_NAME, 'agent-task');
  assert.equal(SCHEDULER_EXECUTION_JOB_NAME, 'agent-execution');
  // Shared job-options shape
  assert.deepEqual(schedulerJobOptions(), {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { age: 604800, count: 10000 },
    removeOnFail: false,
  });
  // Deterministic ids (once-… is colon-free: BullMQ rejects ':' in custom ids)
  assert.equal(schedulerOnceJobId('task-1'), 'once-task-1');
  assert.equal(schedulerOnceJobId('task-1').includes(':'), false);
  assert.equal(schedulerExecutionJobId('exe-1'), 'execution-exe-1');
  // ONCE delay clamps to the future, never negative
  assert.equal(onceDelayMs('2025-01-01T00:00:00.000Z', NOW), 0);
  assert.equal(onceDelayMs(ONCE_AT, NOW), Date.parse(ONCE_AT) - NOW.getTime());
});

test('recurring upsert: exact pattern/tz/template and NO custom repeat jobId', async () => {
  const { queue, fake } = makeQueue();
  const result = await queue.syncTask(makeTask(), NOW); // DAILY 09:30
  assert.deepEqual(result, { recurringScheduler: 'upserted', onceJob: 'none' });
  assert.equal(fake.upserts.length, 1);
  const upsert = fake.upserts[0]!;
  assert.equal(upsert.id, 'task-1');
  assert.deepEqual(upsert.repeatOpts, { pattern: '30 9 * * *', tz: 'UTC' });
  assert.deepEqual(upsert.template, {
    name: 'agent-task',
    data: { taskId: 'task-1' },
    opts: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 604800, count: 10000 },
      removeOnFail: false,
      // Library owns repeat job ids: no custom jobId in the template.
    },
  });
  const templateOpts = (upsert.template as { opts?: Record<string, unknown> }).opts ?? {};
  assert.equal('jobId' in templateOpts, false);
  assert.equal('repeat' in templateOpts, false);
  assert.equal(fake.added.length, 0);
  assert.equal(fake.schedulerRemovals.length, 0);
});

test('recurring patterns are deterministic per type (weekly weekdays sorted)', async () => {
  const weekly = makeTask({
    recurrenceType: 'WEEKLY',
    recurrenceConfig: { hour: 8, minute: 15, weekdays: [3, 1, 5] },
  });
  const { queue, fake } = makeQueue();
  await queue.syncTask(weekly, NOW);
  assert.deepEqual(fake.upserts[0]!.repeatOpts, { pattern: '15 8 * * 1,3,5', tz: 'UTC' });
});

test('inactive task: removes scheduler and pending once job, adds nothing', async () => {
  const { queue, fake } = makeQueue();
  fake.schedulers.set('task-1', { pattern: '30 9 * * *' });
  fake.jobs.set(schedulerOnceJobId('task-1'), {
    state: 'delayed',
    data: { taskId: 'task-1', scheduledFor: ONCE_LATER },
  });
  const result = await queue.syncTask(makeTask({ isActive: false, nextRunAt: null }), NOW);
  assert.deepEqual(result, { recurringScheduler: 'removed', onceJob: 'removed' });
  assert.deepEqual(fake.schedulerRemovals, ['task-1']);
  assert.deepEqual(fake.jobRemovals, [schedulerOnceJobId('task-1')]);
  assert.equal(fake.upserts.length, 0);
  assert.equal(fake.added.length, 0);
});

test('inactive task with nothing present is a harmless none/none sync', async () => {
  const { queue, fake } = makeQueue();
  const result = await queue.syncTask(makeTask({ isActive: false, nextRunAt: null }), NOW);
  assert.deepEqual(result, { recurringScheduler: 'none', onceJob: 'none' });
  assert.equal(fake.schedulerRemovals.length, 0);
  assert.equal(fake.jobRemovals.length, 0);
});

test('active once (future): removes the stale scheduler and adds a delayed deterministic job', async () => {
  const { queue, fake } = makeQueue();
  fake.schedulers.set('task-1', { pattern: '0 12 * * 1' }); // leftover recurring scheduler
  const result = await queue.syncTask(onceTask(), NOW);
  assert.deepEqual(result, { recurringScheduler: 'removed', onceJob: 'added' });
  assert.deepEqual(fake.schedulerRemovals, ['task-1']);
  assert.equal(fake.added.length, 1);
  const added = fake.added[0]!;
  assert.equal(added.name, SCHEDULER_TASK_JOB_NAME);
  assert.deepEqual(added.data, { taskId: 'task-1', scheduledFor: ONCE_AT });
  const expectedOpts = { ...schedulerJobOptions(), jobId: schedulerOnceJobId('task-1'), delay: Date.parse(ONCE_AT) - NOW.getTime() };
  assert.deepEqual(added.opts, expectedOpts);
  assert.equal((added.opts['jobId'] as string).includes(':'), false);
});

test('once dedupe: an existing job for the SAME instant is left untouched', async () => {
  const { queue, fake } = makeQueue();
  fake.jobs.set(schedulerOnceJobId('task-1'), {
    state: 'delayed',
    data: { taskId: 'task-1', scheduledFor: ONCE_AT },
  });
  const result = await queue.syncTask(onceTask(), NOW);
  assert.deepEqual(result, { recurringScheduler: 'none', onceJob: 'none' });
  assert.equal(fake.added.length, 0);
  assert.equal(fake.jobRemovals.length, 0);
});

test('once job id is colon-free and deterministic (BullMQ custom-id contract)', () => {
  const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';
  const id = schedulerOnceJobId(uuid);
  assert.equal(id, `once-${uuid}`);
  // BullMQ rejects ':' in custom job ids — the format must never carry one.
  assert.equal(id.includes(':'), false);
  assert.equal(schedulerOnceJobId(uuid), id);
});

test('repeated once sync keeps the single deterministic job (no duplicate, no churn)', async () => {
  const { queue, fake } = makeQueue();
  const first = await queue.syncTask(onceTask(), NOW);
  assert.equal(first.onceJob, 'added');
  const second = await queue.syncTask(onceTask(), NOW);
  assert.deepEqual(second, { recurringScheduler: 'none', onceJob: 'none' });
  // Exactly ONE job under the ONE deterministic id — nothing duplicated.
  assert.equal(fake.added.length, 1);
  assert.equal(fake.jobs.size, 1);
  assert.equal(fake.jobs.has(schedulerOnceJobId('task-1')), true);
});

test('once update: a job for a DIFFERENT instant is replaced (removed then re-added)', async () => {
  const { queue, fake } = makeQueue();
  fake.jobs.set(schedulerOnceJobId('task-1'), {
    state: 'waiting',
    data: { taskId: 'task-1', scheduledFor: ONCE_LATER },
  });
  const result = await queue.syncTask(onceTask(), NOW); // task wants ONCE_AT
  assert.deepEqual(result, { recurringScheduler: 'none', onceJob: 'updated' });
  assert.deepEqual(fake.jobRemovals, [schedulerOnceJobId('task-1')]);
  assert.equal(fake.added.length, 1);
  assert.deepEqual(fake.added[0]!.data, { taskId: 'task-1', scheduledFor: ONCE_AT });
  // The reschedule lands under the SAME (new, colon-free) deterministic id.
  const rescheduleJobId = fake.added[0]!.opts['jobId'];
  assert.equal(rescheduleJobId, schedulerOnceJobId('task-1'));
  assert.equal(schedulerOnceJobId('task-1').includes(':'), false);
  // Replacement also applies over completed jobs (a re-run was scheduled).
  fake.added.length = 0;
  fake.jobRemovals.length = 0;
  fake.jobs.set(schedulerOnceJobId('task-1'), {
    state: 'completed',
    data: { taskId: 'task-1', scheduledFor: ONCE_LATER },
  });
  const afterCompleted = await queue.syncTask(onceTask(), NOW);
  assert.equal(afterCompleted.onceJob, 'updated');
  assert.equal(fake.added.length, 1);
});

test('once update on an ACTIVE job is deferred, never removed mid-run', async () => {
  const { queue, fake } = makeQueue();
  fake.jobs.set(schedulerOnceJobId('task-1'), {
    state: 'active',
    data: { taskId: 'task-1', scheduledFor: ONCE_LATER },
  });
  const result = await queue.syncTask(onceTask(), NOW);
  assert.deepEqual(result, { recurringScheduler: 'none', onceJob: 'deferred' });
  assert.equal(fake.jobRemovals.length, 0);
  assert.equal(fake.added.length, 0);
});

test('past once (nextRunAt null): adds nothing even when a job exists', async () => {
  const { queue, fake } = makeQueue();
  fake.jobs.set(schedulerOnceJobId('task-1'), {
    state: 'delayed',
    data: { taskId: 'task-1', scheduledFor: ONCE_AT },
  });
  const result = await queue.syncTask(onceTask({ nextRunAt: null }), NOW);
  assert.deepEqual(result, { recurringScheduler: 'none', onceJob: 'none' });
  assert.equal(fake.added.length, 0);
  assert.equal(fake.jobRemovals.length, 0);
});

test('manual/retry executions dedupe deterministically (any state blocks re-add)', async () => {
  const { queue, fake } = makeQueue();
  const execution = { id: 'exe-1', trigger: 'MANUAL' } as const;
  assert.equal(await queue.enqueueExecution(execution), true);
  const added = fake.added[0]!;
  assert.equal(added.name, SCHEDULER_EXECUTION_JOB_NAME);
  assert.deepEqual(added.data, { executionId: 'exe-1' });
  assert.deepEqual(added.opts, {
    ...schedulerJobOptions(),
    jobId: schedulerExecutionJobId('exe-1'),
  });

  for (const state of ['waiting', 'delayed', 'active', 'paused', 'completed', 'failed']) {
    const fresh = new FakeSchedulerQueue();
    fresh.jobs.set(schedulerExecutionJobId('exe-1'), { state, data: { executionId: 'exe-1' } });
    const retryQueue = new BullMQSchedulerQueue({ queue: fresh });
    // FAILED still returns false: no manual re-add of terminal failed runs.
    assert.equal(await retryQueue.enqueueExecution(execution), false, state);
    assert.equal(fresh.added.length, 0, state);
    assert.equal(fresh.jobRemovals.length, 0, state);
  }
});

test('enqueueExecution rejects unbounded ids', async () => {
  const { queue } = makeQueue();
  await assert.rejects(queue.enqueueExecution({ id: 'e'.repeat(129) }), /execution id failed validation/);
  await assert.rejects(queue.enqueueExecution({ id: ' exe ' }), /execution id failed validation/);
  await assert.rejects(queue.removeTask('t'.repeat(129)), /task id failed validation/);
  await assert.rejects(queue.removeTask(' spaced '), /task id failed validation/);
});

test('removeTask removes scheduler + once job and is idempotent when absent', async () => {
  const { queue, fake } = makeQueue();
  fake.schedulers.set('task-1', {});
  fake.jobs.set(schedulerOnceJobId('task-1'), { state: 'delayed', data: { taskId: 'task-1' } });
  const first = await queue.removeTask('task-1');
  assert.deepEqual(first, { recurringScheduler: 'removed', onceJob: 'removed' });
  const second = await queue.removeTask('task-1');
  assert.deepEqual(second, { recurringScheduler: 'none', onceJob: 'none' });
  assert.deepEqual(fake.schedulerRemovals, ['task-1']);
  assert.deepEqual(fake.jobRemovals, [schedulerOnceJobId('task-1')]);
});

test('reconcile syncs each task deterministically with NO catch-up extras', async () => {
  const { queue, fake } = makeQueue();
  const recurring = makeTask(); // DAILY, active
  const once = onceTask();
  const inactive = makeTask({ id: 'task-3', isActive: false, nextRunAt: null });
  const results = await queue.reconcile([recurring, once, inactive], NOW);
  assert.deepEqual(results, [
    { recurringScheduler: 'upserted', onceJob: 'none' },
    { recurringScheduler: 'none', onceJob: 'added' },
    { recurringScheduler: 'none', onceJob: 'none' },
  ]);
  // Deterministic-only: one upsert, one once add, zero execution adds.
  assert.equal(fake.upserts.length, 1);
  assert.equal(fake.added.length, 1);
  // getJob ran exactly for the two task-level once checks — nothing more.
  assert.deepEqual(fake.getJobCalls, [schedulerOnceJobId(once.id), schedulerOnceJobId(inactive.id)]);
});

test('ping is a resolved no-op for an injected queue and close is bounded/idempotent', async () => {
  const { queue, fake } = makeQueue();
  await queue.ping(25);
  await queue.close();
  await queue.close();
  assert.equal(fake.closeCalls, 1);
  await assert.rejects(queue.syncTask(makeTask(), NOW), /scheduler queue is closed/);
  await assert.rejects(queue.enqueueExecution({ id: 'exe-1' }), /scheduler queue is closed/);
  await assert.rejects(queue.reconcile([makeTask()]), /scheduler queue is closed/);
});

test('close() still resolves when the underlying queue close hangs (bounded)', async () => {
  const fake = new FakeSchedulerQueue();
  fake.close = () => new Promise<void>(() => undefined);
  const queue = new BullMQSchedulerQueue({ queue: fake, closeTimeoutMs: 25 });
  await queue.close();
  // Bounded teardown: the hanging close never blocked this resolution.
});

test('constructor requires redisUrl unless a queue is injected', () => {
  assert.throws(
    () => new BullMQSchedulerQueue({}),
    (error: unknown) => `${(error as Error).message}`.includes('requires a redisUrl'),
  );
});
