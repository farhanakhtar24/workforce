import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Prisma, type PrismaClient } from '@workforce/core/generated/prisma';

import { PrismaSchedulerStore } from './index.js';
import {
  SchedulerConflictError,
  SchedulerNotFoundError,
  SchedulerValidationError,
} from '../errors.js';

/**
 * Fake Prisma ONLY — no database, no network. Proves: row-lock ordering for
 * task updates / claims / marks, the atomic SCHEDULED dedupe (findFirst ->
 * create, P2002 re-read OUTSIDE the aborted transaction), RETRY preconditions
 * under the lock, P2002 -> typed conflicts for queue identities, DB enum +
 * JSON mapping with ISO output, mapping guards (chatId == id, UTC timezone),
 * bounded deterministic listing passthrough — and the Phase 5 migration
 * regression (applied migrations byte-for-byte pinned; forward-only ordering;
 * SQL-only partial index + CHECKs present; enum parity with schema.prisma).
 */

type AnyArgs = Record<string, unknown>;

const UTC_TS = new Date('2026-11-23T00:00:00.000Z');

const TASK_ID = '00000000-0000-4000-8000-00000000t001'.replace('t001', '0001');
const EXEC_ID = '00000000-0000-4000-8000-00000000e001'.replace('e001', '0001');

function taskRow(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: TASK_ID,
    name: 'Daily digest',
    agentSlug: 'general',
    mode: 'action',
    prompt: 'Summarize yesterday.',
    scope: 'default',
    recurrenceType: 'daily',
    recurrenceConfig: { hour: 5, minute: 30 },
    skipDates: ['2026-12-25'],
    isActive: true,
    timezone: 'UTC',
    nextRunAt: new Date('2026-05-02T05:30:00.000Z'),
    createdAt: UTC_TS,
    updatedAt: UTC_TS,
    ...overrides,
  };
}

function executionRow(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: EXEC_ID,
    taskId: TASK_ID,
    retryOfExecutionId: null,
    scheduledFor: new Date('2026-05-02T05:30:00.000Z'),
    trigger: 'scheduled',
    status: 'pending',
    attempt: 0,
    maxAttempts: 3,
    durationMs: null,
    tokenUsage: null,
    error: null,
    chatId: EXEC_ID,
    queueJobId: null,
    repeatJobKey: null,
    createdAt: UTC_TS,
    updatedAt: UTC_TS,
    finishedAt: null,
    ...overrides,
  };
}

function likeRealPrismaWrite(data: AnyArgs): AnyArgs {
  // The fake mirrors Prisma 6.19 nullable-Json create semantics: `Prisma.DbNull`
  // means SQL NULL and reads back as `null` (that is what the store must send).
  // `Prisma.JsonNull` intentionally stays the raw sentinel here — a live DB
  // would store the JSON literal `null` (jsonb_typeof 'null') and the Phase 5
  // AgentTaskExecution_token_usage_check would reject it; see the regression
  // test pinning create to DbNull.
  const copy: AnyArgs = { ...data };
  if (copy.tokenUsage === Prisma.DbNull) {
    copy.tokenUsage = null;
  }
  return copy;
}

class FakeModel {
  readonly calls: string[] = [];
  readonly data: AnyArgs[] = [];

  findUniqueImpl: ((args: AnyArgs) => unknown) | null = null;
  findFirstImpl: ((args: AnyArgs) => unknown) | null = null;
  findManyImpl: ((args: AnyArgs) => unknown[]) | null = null;
  createImpl: ((args: AnyArgs) => unknown) | null = null;
  updateImpl: ((args: AnyArgs) => unknown) | null = null;

  async findUnique(args: AnyArgs): Promise<unknown> {
    this.calls.push('findUnique');
    return this.findUniqueImpl ? this.findUniqueImpl(args) : null;
  }

  async findFirst(args: AnyArgs): Promise<unknown> {
    this.calls.push('findFirst');
    return this.findFirstImpl ? this.findFirstImpl(args) : null;
  }

  async findMany(args: AnyArgs): Promise<unknown[]> {
    this.calls.push('findMany');
    return this.findManyImpl ? this.findManyImpl(args) : [];
  }

  async create(args: AnyArgs): Promise<unknown> {
    this.calls.push('create');
    this.data.push(args);
    if (this.createImpl) {
      return this.createImpl(args);
    }
    return executionRow(likeRealPrismaWrite((args.data as AnyArgs) ?? {}));
  }

  async update(args: AnyArgs): Promise<unknown> {
    this.calls.push('update');
    this.data.push(args);
    if (this.updateImpl) {
      return this.updateImpl(args);
    }
    throw new Error('fake updateImpl not configured');
  }
}

class FakePrisma {
  readonly log: string[] = [];
  transactionCount = 0;
  /** Raw-SQL probe results; defaults to a "locked" row. */
  queryRawImpl: ((strings: TemplateStringsArray, values: unknown[]) => unknown[]) | null = null;

  agentTask = new FakeModel();
  agentTaskExecution = new FakeModel();

  async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    const statement = strings.join('?');
    this.log.push(`query:${statement.replace(/\s+/g, ' ').trim()}`);
    if (this.queryRawImpl) {
      return this.queryRawImpl(strings, values);
    }
    return [{ id: 'locked-row' }];
  }

  async $transaction<T>(work: (tx: FakePrisma) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    this.log.push('tx:begin');
    const result = await work(this);
    this.log.push('tx:commit');
    return result;
  }
}

function makeStore(prisma: FakePrisma): PrismaSchedulerStore {
  return new PrismaSchedulerStore(prisma as unknown as PrismaClient);
}

function p2002(message = 'dup'): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, { code: 'P2002', clientVersion: 'test' });
}

const CREATE_TASK_INPUT = {
  name: 'Daily digest',
  agentSlug: 'general' as const,
  mode: 'action' as const,
  prompt: 'Summarize yesterday.',
  scope: 'default',
  recurrenceType: 'DAILY' as const,
  recurrenceConfig: { hour: 5, minute: 30 },
  skipDates: ['2026-12-25'],
  now: UTC_TS,
  afterAsOf: new Date('2026-05-01T08:00:00Z'),
};

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

test('createTask maps DB enums/JSON to the public shape with ISO dates', async () => {
  const prisma = new FakePrisma();
  prisma.agentTask.createImpl = (args) => taskRow({ ...(args.data as AnyArgs), createdAt: UTC_TS, updatedAt: UTC_TS });
  const task = await makeStore(prisma).createTask(CREATE_TASK_INPUT);

  assert.equal(task.agentSlug, 'general');
  assert.equal(task.mode, 'action');
  assert.equal(task.recurrenceType, 'DAILY');
  assert.deepEqual(task.recurrenceConfig, { hour: 5, minute: 30 });
  assert.deepEqual(task.skipDates, ['2026-12-25']);
  assert.equal(task.timezone, 'UTC');
  assert.equal(task.nextRunAt, '2026-05-02T05:30:00.000Z');
  assert.equal(task.createdAt, UTC_TS.toISOString());
  const write = prisma.agentTask.data[0]!.data as AnyArgs;
  assert.equal(write.recurrenceType, 'daily');
  assert.equal(write.isActive, true);
  assert.deepEqual(write.skipDates, ['2026-12-25']);
  assert.deepEqual(write.nextRunAt, new Date('2026-05-02T05:30:00.000Z'));
});

test('createTask maps a P2002 id violation to a typed conflict', async () => {
  const prisma = new FakePrisma();
  prisma.agentTask.createImpl = () => {
    throw p2002();
  };
  await assert.rejects(
    () => makeStore(prisma).createTask({ ...CREATE_TASK_INPUT, id: TASK_ID }),
    (error: unknown) => error instanceof SchedulerConflictError && error.code === 'scheduler_conflict',
  );
});

test('updateTask locks the row, preserves id, merges the patch, resolves nextRunAt', async () => {
  const prisma = new FakePrisma();
  prisma.agentTask.findUniqueImpl = () =>
    taskRow({
      recurrenceType: 'once',
      recurrenceConfig: { runAt: '2030-01-01T05:06:07.000Z' },
      nextRunAt: new Date('2030-01-01T05:06:07.000Z'),
    });
  prisma.agentTask.updateImpl = (args) => taskRow((args.data as AnyArgs) ?? {});
  const store = makeStore(prisma);

  const renamed = await store.updateTask({
    id: TASK_ID,
    name: 'Digest v2',
    now: UTC_TS,
  });
  assert.equal(renamed.id, TASK_ID);
  assert.equal(renamed.name, 'Digest v2');
  // No recurrence change -> explicit nextRunAt untouched (stays the ONCE runAt).
  assert.equal(renamed.nextRunAt, '2030-01-01T05:06:07.000Z');
  assert.ok(prisma.log.some((entry) => entry.includes('FOR UPDATE')));
  const renameWrite = prisma.agentTask.data[0]!.data as AnyArgs;
  assert.deepEqual(renameWrite.nextRunAt, new Date('2030-01-01T05:06:07.000Z'));
  assert.equal('id' in renameWrite, false);

  // A skipped occurrence shifts to the following day (skip on May 2).
  const prisma2 = new FakePrisma();
  prisma2.agentTask.findUniqueImpl = () => taskRow();
  prisma2.agentTask.updateImpl = (args) => taskRow((args.data as AnyArgs) ?? {});
  const skipped = await makeStore(prisma2).updateTask({
    id: TASK_ID,
    skipDates: ['2026-05-02'],
    afterAsOf: '2026-05-02T00:00:00.000Z',
    now: UTC_TS,
  });
  // The only remaining occurrence after the skip is May 3, 05:30 UTC.
  assert.equal(skipped.nextRunAt, '2026-05-03T05:30:00.000Z');
});

test('setTaskActive locks and writes; missing task is a typed 404', async () => {
  const prisma = new FakePrisma();
  prisma.agentTask.findUniqueImpl = () => taskRow({ isActive: true });
  prisma.agentTask.updateImpl = (args) => taskRow({ isActive: (args.data as AnyArgs).isActive });
  const paused = await makeStore(prisma).setTaskActive(TASK_ID, false);
  assert.equal(paused.isActive, false);
  assert.ok(prisma.log.some((entry) => entry.includes('FOR UPDATE')));

  const missing = new FakePrisma();
  missing.agentTask.findUniqueImpl = () => null;
  await assert.rejects(
    () => makeStore(missing).setTaskActive(TASK_ID, true),
    (error: unknown) => error instanceof SchedulerNotFoundError && error.code === 'scheduler_not_found',
  );
});

// ---------------------------------------------------------------------------
// Executions: dedupe + queue identities + retry
// ---------------------------------------------------------------------------

test('createExecution SCHEDULED: task lock, findFirst dedupe probe, chatId == id', async () => {
  const prisma = new FakePrisma();
  prisma.agentTaskExecution.findFirstImpl = (args) => {
    prisma.log.push(`dedupe:${String((args.where as AnyArgs).trigger)}`);
    return null;
  };
  const result = await makeStore(prisma).createExecution(
    taskRow() as never,
    { scheduledFor: '2026-05-02T05:30:00.000Z', trigger: 'SCHEDULED', now: UTC_TS },
  );
  assert.equal(result.created, true);
  assert.ok(prisma.log.some((entry) => entry.includes('"AgentTask"') && entry.includes('FOR UPDATE')));
  assert.ok(prisma.log.some((entry) => entry.startsWith('dedupe:scheduled')));
  const write = prisma.agentTaskExecution.data[0]!.data as AnyArgs;
  assert.equal(write.chatId, write.id);
  assert.equal(write.trigger, 'scheduled');
  assert.equal(write.status, 'pending');
  assert.equal(write.attempt, 0);
  assert.equal(write.maxAttempts, 3);
  assert.equal(write.retryOfExecutionId, undefined);
  assert.equal(result.execution.chatId, result.execution.id);
  assert.equal(result.execution.trigger, 'SCHEDULED');
  assert.equal(result.execution.scheduledFor, '2026-05-02T05:30:00.000Z');
});

test('createExecution SCHEDULED duplicate returns the existing row without a second write', async () => {
  const prisma = new FakePrisma();
  prisma.agentTaskExecution.findFirstImpl = () => executionRow();
  const result = await makeStore(prisma).createExecution(
    taskRow() as never,
    { scheduledFor: '2026-05-02T05:30:00.000Z', trigger: 'SCHEDULED', now: UTC_TS },
  );
  assert.equal(result.created, false);
  assert.equal(result.execution.id, EXEC_ID);
  assert.ok(!prisma.agentTaskExecution.calls.includes('create'));
});

test('createExecution P2002 race re-reads the SCHEDULED winner outside the transaction', async () => {
  const prisma = new FakePrisma();
  prisma.agentTaskExecution.findFirstImpl = () => null; // race window inside the tx
  prisma.agentTaskExecution.createImpl = () => {
    throw p2002('AgentTaskExecution_taskId_scheduledFor_scheduled_key');
  };
  const store = makeStore(prisma);
  // The re-read happens on a FRESH connection (this.prisma), not the aborted
  // tx — reconfigure the finder after the attempted create (i.e. after the tx
  // body has run) so the outer winner lookup resolves.
  prisma.agentTaskExecution.createImpl = () => {
    prisma.agentTaskExecution.findFirstImpl = () => executionRow();
    throw p2002('AgentTaskExecution_taskId_scheduledFor_scheduled_key');
  };

  const result = await store.createExecution(
    taskRow() as never,
    { scheduledFor: '2026-05-02T05:30:00.000Z', trigger: 'SCHEDULED', now: UTC_TS },
  );
  assert.equal(result.created, false);
  assert.equal(result.execution.id, EXEC_ID);
  // Exactly one create attempted, and the abort happened after BEGIN.
  assert.equal(prisma.agentTaskExecution.calls.filter((call) => call === 'create').length, 1);
  assert.ok(prisma.log.includes('tx:begin'));
});

test('tokenUsage persistence: no-usage create passes DbNull (SQL NULL), supplied usage stays an object', async () => {
  const prisma = new FakePrisma();
  prisma.agentTaskExecution.createImpl = (args) => {
    const data = args.data as AnyArgs;
    // Regression (live-integration backed): no-usage create MUST pass
    // Prisma.DbNull. Prisma.JsonNull inserts the JSON literal `null`
    // (jsonb_typeof 'null') and violates AgentTaskExecution_token_usage_check
    // (SQL NULL or object only). SQL-null semantics are NOT JsonNull.
    assert.equal(data.tokenUsage, Prisma.DbNull);
    assert.notEqual(data.tokenUsage, Prisma.JsonNull);
    return executionRow();
  };
  const store = makeStore(prisma);
  const created = await store.createExecution(
    taskRow() as never,
    { scheduledFor: '2026-05-02T05:30:00.000Z', trigger: 'SCHEDULED', now: UTC_TS },
  );
  assert.equal(created.created, true);
  // SQL NULL reads back as tokenUsage: null on the mapped row.
  assert.equal(created.execution.tokenUsage, null);

  // Supplied usage on the COMPLETED mark is a plain JSON object in the
  // write payload — never wrapped in a null sentinel.
  const usage = { inputTokens: 3, outputTokens: 4, totalTokens: 7 };
  const usagePrisma = new FakePrisma();
  usagePrisma.agentTaskExecution.findUniqueImpl = () => executionRow({ status: 'running', attempt: 1 });
  usagePrisma.agentTaskExecution.updateImpl = (args) =>
    executionRow({ ...(args.data as AnyArgs), status: 'completed', finishedAt: UTC_TS });
  const marked = await makeStore(usagePrisma).markExecution({
    id: EXEC_ID,
    target: 'COMPLETED',
    durationMs: 10,
    tokenUsage: usage,
  });
  assert.deepEqual(marked.tokenUsage, usage);
  const write = usagePrisma.agentTaskExecution.data[0]!.data as AnyArgs;
  // The validated payload is a structurally equal plain object (zod parse
  // produces a fresh clone), never wrapped in a null sentinel.
  assert.deepEqual(write.tokenUsage, usage);
  assert.notEqual(write.tokenUsage, Prisma.DbNull);
  assert.notEqual(write.tokenUsage, Prisma.JsonNull);
});

test('createExecution MANUAL with a duplicate queue identity -> typed conflict', async () => {
  const prisma = new FakePrisma();
  prisma.agentTaskExecution.createImpl = () => {
    throw p2002('AgentTaskExecution_queueJobId_key');
  };
  await assert.rejects(
    () =>
      makeStore(prisma).createExecution(taskRow() as never, {
        scheduledFor: '2026-05-03T05:30:00.000Z',
        trigger: 'MANUAL',
        queueJobId: 'job-1',
        now: UTC_TS,
      }),
    SchedulerConflictError,
  );
});

test('createExecution RETRY: source must exist, be DEAD_LETTER, and share the task', async () => {
  const base = { scheduledFor: '2026-06-01T05:30:00.000Z', trigger: 'RETRY' as const, retryOfExecutionId: '00000000-0000-4000-8000-000000000002' as const, now: UTC_TS };
  // Every row-lock probe resolves (task lock AND source lock).
  const lockRows = (_strings: TemplateStringsArray, values: unknown[]) => [{ id: String(values[0]) }];

  // Missing source -> 404.
  const missing = new FakePrisma();
  missing.queryRawImpl = lockRows;
  missing.agentTaskExecution.findUniqueImpl = () => null;
  await assert.rejects(() => makeStore(missing).createExecution(taskRow() as never, base), SchedulerNotFoundError);

  // RUNNING source -> 409.
  const running = new FakePrisma();
  running.queryRawImpl = lockRows;
  running.agentTaskExecution.findUniqueImpl = () =>
    executionRow({ id: '00000000-0000-4000-8000-000000000002', status: 'running' });
  await assert.rejects(() => makeStore(running).createExecution(taskRow() as never, base), SchedulerConflictError);

  // Same status but a DIFFERENT task -> 409.
  const wrongTask = new FakePrisma();
  wrongTask.queryRawImpl = lockRows;
  wrongTask.agentTaskExecution.findUniqueImpl = () =>
    executionRow({ id: '00000000-0000-4000-8000-000000000002', status: 'dead_letter', taskId: '00000000-0000-4000-8000-000000000099' });
  await assert.rejects(() => makeStore(wrongTask).createExecution(taskRow() as never, base), SchedulerConflictError);

  // Happy path: create carries retryOfExecutionId.
  const happy = new FakePrisma();
  happy.queryRawImpl = lockRows;
  happy.agentTaskExecution.findUniqueImpl = () =>
    executionRow({ id: '00000000-0000-4000-8000-000000000002', status: 'dead_letter' });
  happy.agentTaskExecution.createImpl = (args) =>
    executionRow({ retryOfExecutionId: (args.data as AnyArgs).retryOfExecutionId });
  const result = await makeStore(happy).createExecution(taskRow() as never, base);
  assert.equal(result.created, true);
  const write = happy.agentTaskExecution.data[0]!.data as AnyArgs;
  assert.equal(write.retryOfExecutionId, '00000000-0000-4000-8000-000000000002');
  assert.equal(write.trigger, 'retry');

  // Missing task -> 404 before anything else.
  const noTask = new FakePrisma();
  noTask.queryRawImpl = () => [];
  await assert.rejects(() => makeStore(noTask).createExecution(taskRow() as never, base), SchedulerNotFoundError);
});

// ---------------------------------------------------------------------------
// CAS: claim + marks under the row lock
// ---------------------------------------------------------------------------

test('claimExecution: CAS to running with attempt increment; mismatches conflict', async () => {
  const prisma = new FakePrisma();
  prisma.agentTaskExecution.findUniqueImpl = () => executionRow();
  prisma.agentTaskExecution.updateImpl = (args) =>
    executionRow({ ...(args.data as AnyArgs), status: 'running', attempt: (args.data as AnyArgs).attempt });
  const store = makeStore(prisma);
  const claimed = await store.claimExecution({ id: EXEC_ID, attempt: 1, allowedFrom: 'PENDING' });
  assert.equal(claimed.status, 'RUNNING');
  assert.equal(claimed.attempt, 1);
  assert.ok(prisma.log.some((entry) => entry.includes('"AgentTaskExecution"') && entry.includes('FOR UPDATE')));
  const write = prisma.agentTaskExecution.data[0]!.data as AnyArgs;
  assert.equal(write.status, 'running');
  assert.equal(write.attempt, 1);

  // allowedFrom mismatch -> typed conflict (e.g. fresh RUNNING row).
  const runningPrisma = new FakePrisma();
  runningPrisma.agentTaskExecution.findUniqueImpl = () => executionRow({ status: 'running', attempt: 1 });
  await assert.rejects(
    () => makeStore(runningPrisma).claimExecution({ id: EXEC_ID, attempt: 2, allowedFrom: 'PENDING' }),
    SchedulerConflictError,
  );
  // Attempt not exactly +1 -> typed conflict.
  await assert.rejects(
    () => makeStore(runningPrisma).claimExecution({ id: EXEC_ID, attempt: 3, allowedFrom: 'PENDING' }),
    SchedulerConflictError,
  );
  // Missing row -> 404.
  const missing = new FakePrisma();
  missing.agentTaskExecution.findUniqueImpl = () => null;
  await assert.rejects(
    () => makeStore(missing).claimExecution({ id: EXEC_ID, attempt: 1, allowedFrom: 'PENDING' }),
    SchedulerNotFoundError,
  );
});

test('markExecution COMPLETED: stamps duration/tokenUsage/finishedAt; idempotent only when equivalent', async () => {
  // COMPLETED with duration + token usage (claim first: RUNNING -> COMPLETED).
  const prisma = new FakePrisma();
  prisma.agentTaskExecution.findUniqueImpl = () => executionRow({ status: 'running', attempt: 1 });
  prisma.agentTaskExecution.updateImpl = (args) =>
    executionRow({
      ...(args.data as AnyArgs),
      tokenUsage: (args.data as AnyArgs).tokenUsage,
      status: 'completed',
      finishedAt: UTC_TS,
    });
  const store = makeStore(prisma);
  const completed = await store.markExecution({
    id: EXEC_ID,
    target: 'COMPLETED',
    durationMs: 1200,
    tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    now: UTC_TS,
  });
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.durationMs, 1200);
  assert.deepEqual(completed.tokenUsage, { inputTokens: 10, outputTokens: 20, totalTokens: 30 });
  assert.ok(completed.finishedAt !== null);
  const write = prisma.agentTaskExecution.data[0]!.data as AnyArgs;
  assert.equal(write.status, 'completed');
  assert.ok(write.finishedAt instanceof Date);

  // Equivalent repeat: no second UPDATE, row returned unchanged.
  const prisma2 = new FakePrisma();
  prisma2.agentTaskExecution.findUniqueImpl = () => executionRow({ status: 'completed', durationMs: 1200, tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, finishedAt: UTC_TS });
  const repeated = await makeStore(prisma2).markExecution({
    id: EXEC_ID,
    target: 'COMPLETED',
    durationMs: 1200,
    tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  });
  assert.equal(repeated.status, 'COMPLETED');
  assert.ok(!prisma2.agentTaskExecution.calls.includes('update'));

  // Non-equivalent payload -> conflict.
  const prisma3 = new FakePrisma();
  prisma3.agentTaskExecution.findUniqueImpl = () => executionRow({ status: 'completed', durationMs: 999, finishedAt: UTC_TS });
  await assert.rejects(
    () =>
      makeStore(prisma3).markExecution({
        id: EXEC_ID,
        target: 'COMPLETED',
        durationMs: 1200,
        tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      }),
    SchedulerConflictError,
  );
});

test('markExecution matrix: SKIPPED only from PENDING; RETRYING from RUNNING; terminal stays', async () => {
  const store = (prisma: FakePrisma, row: Record<string, unknown>) => {
    prisma.agentTaskExecution.findUniqueImpl = () => row;
    return makeStore(prisma);
  };

  // RUNNING -> FAILED with error; error equivalence idempotency.
  const failedPrisma = new FakePrisma();
  failedPrisma.agentTaskExecution.updateImpl = (args) =>
    executionRow({ ...(args.data as AnyArgs), status: 'failed', finishedAt: UTC_TS });
  const failed = await store(failedPrisma, executionRow({ status: 'running', attempt: 1 })).markExecution({
    id: EXEC_ID,
    target: 'FAILED',
    error: 'boom',
  });
  assert.equal(failed.status, 'FAILED');
  assert.ok(failed.finishedAt !== null);

  // PENDING -> SKIPPED ok; RUNNING -> SKIPPED conflicts; SKIPPED repeats conflict.
  const skipPrisma = new FakePrisma();
  skipPrisma.agentTaskExecution.updateImpl = (args) =>
    executionRow({ ...(args.data as AnyArgs), status: 'skipped', finishedAt: UTC_TS });
  const skip = await store(skipPrisma, executionRow()).markExecution({ id: EXEC_ID, target: 'SKIPPED' });
  assert.equal(skip.status, 'SKIPPED');
  await assert.rejects(
    () =>
      store(new FakePrisma(), executionRow({ status: 'running' })).markExecution({ id: EXEC_ID, target: 'SKIPPED' }),
    SchedulerConflictError,
  );
  await assert.rejects(
    () =>
      store(new FakePrisma(), executionRow({ status: 'skipped', finishedAt: UTC_TS })).markExecution({
        id: EXEC_ID,
        target: 'SKIPPED',
      }),
    SchedulerConflictError,
  );

  // RUNNING -> RETRYING carries no finishedAt (not terminal).
  const retryingPrisma = new FakePrisma();
  retryingPrisma.agentTaskExecution.updateImpl = (args) =>
    executionRow({ ...(args.data as AnyArgs), status: 'retrying' });
  const retrying = await store(retryingPrisma, executionRow({ status: 'running', attempt: 1 })).markExecution({
    id: EXEC_ID,
    target: 'RETRYING',
  });
  assert.equal(retrying.status, 'RETRYING');
  assert.equal(retrying.finishedAt, null);
  const write = retryingPrisma.agentTaskExecution.data[0]!.data as AnyArgs;
  assert.equal('finishedAt' in write, false);

  // RETRYING row cannot be marked COMPLETED (expected RUNNING only).
  await assert.rejects(
    () =>
      store(new FakePrisma(), executionRow({ status: 'retrying', attempt: 2 })).markExecution({
        id: EXEC_ID,
        target: 'COMPLETED',
        durationMs: 5,
      }),
    SchedulerConflictError,
  );
});

// ---------------------------------------------------------------------------
// Mapping guards + listing passthrough
// ---------------------------------------------------------------------------

test('guards: chatId mismatch, non-UTC timezone, unknown enum, invalid tokenUsage are typed 400s', async () => {
  const brokenChat = new FakePrisma();
  brokenChat.agentTaskExecution.findUniqueImpl = () => executionRow({ chatId: 'other' });
  await assert.rejects(
    () => makeStore(brokenChat).getExecution(EXEC_ID),
    (error: unknown) =>
      error instanceof SchedulerValidationError && error.message.includes('chatId'),
  );

  const brokenTz = new FakePrisma();
  brokenTz.agentTask.findUniqueImpl = () => taskRow({ timezone: 'America/New_York' });
  await assert.rejects(() => makeStore(brokenTz).getTask(TASK_ID), SchedulerValidationError);

  const brokenStatus = new FakePrisma();
  brokenStatus.agentTaskExecution.findUniqueImpl = () => executionRow({ status: 'zombie' });
  await assert.rejects(() => makeStore(brokenStatus).getExecution(EXEC_ID), SchedulerValidationError);

  const brokenSkip = new FakePrisma();
  brokenSkip.agentTask.findUniqueImpl = () => taskRow({ skipDates: ['2026-02-30'] });
  await assert.rejects(() => makeStore(brokenSkip).getTask(TASK_ID), SchedulerValidationError);
});

test('listings pass bounded deterministic ordering through', async () => {
  const prisma = new FakePrisma();
  prisma.agentTask.findManyImpl = (args) => {
    prisma.log.push(`orderBy:${JSON.stringify((args as AnyArgs).orderBy)}:take:${String((args as AnyArgs).take)}`);
    return [taskRow(), taskRow({ id: '00000000-0000-4000-8000-000000000002' })];
  };
  const store = makeStore(prisma);

  const tasks = await store.listTasks();
  assert.equal(tasks.length, 2);
  assert.ok(prisma.log.some((entry) => entry.includes('"desc"') && entry.includes('take:20')));

  await store.listTasks({ order: 'oldest', limit: 5 });
  assert.ok(prisma.log.some((entry) => entry.includes('"asc"') && entry.includes('take:5')));

  await assert.rejects(() => store.listTasks({ limit: 101 }), SchedulerValidationError);

  prisma.agentTaskExecution.findManyImpl = (args) => {
    prisma.log.push(
      `execWhere:${JSON.stringify((args as AnyArgs).where)}:take:${String((args as AnyArgs).take)}`,
    );
    return [executionRow()];
  };
  const filtered = await store.listExecutions({ taskId: TASK_ID, status: 'PENDING', limit: 7 });
  assert.equal(filtered.length, 1);
  assert.ok(
    prisma.log.some(
      (entry) =>
        entry.includes('execWhere:') && entry.includes('"pending"') && entry.includes('take:7'),
    ),
  );
});

// ---------------------------------------------------------------------------
// Migration regression (byte-for-byte applied migrations + Phase 5 SQL)
// ---------------------------------------------------------------------------

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const APPLIED_MIGRATIONS = [
  '20261119000000_memory_core',
  '20261120000000_memory_superseded_by_many_to_one',
  '20261120000100_memory_relation_tuple_unique',
  '20261123000000_phase4_work_docs',
] as const;

const APPLIED_MIGRATION_SHA256: Record<(typeof APPLIED_MIGRATIONS)[number], string> = {
  '20261119000000_memory_core': '4d548106d4727a1934c690874542caef1b1b775c9070e0cad8abd1053bd0da61',
  '20261120000000_memory_superseded_by_many_to_one': '97297aa0c9f923eb7038f6946d5f6818e1f590749f80429d91c28019ea367e5b',
  '20261120000100_memory_relation_tuple_unique': '25c98618e6b9ebc8e871fd0c9a2de2d715e429ab3a3b65826a2055dd0bda5732',
  '20261123000000_phase4_work_docs': 'a301a5db397057b6130c6c0af7129fea39d1b583fe6e3c35212e192fa87b32e7',
};

const PHASE5_MIGRATION = '20261123000100_phase5_scheduler';

test('migrations: the four applied migrations stay byte-for-byte; Phase 5 is forward-only', () => {
  const migrationsDir = path.join(packageRoot, 'prisma', 'migrations');
  const entries = readdirSync(migrationsDir).filter((entry) => entry !== 'migration_lock.toml').sort();

  // Exact ORDER: applied migrations stay first, never renamed or removed.
  assert.deepStrictEqual(entries.slice(0, APPLIED_MIGRATIONS.length), [...APPLIED_MIGRATIONS]);
  assert.ok(entries.includes(PHASE5_MIGRATION));
  assert.ok(PHASE5_MIGRATION > APPLIED_MIGRATIONS[APPLIED_MIGRATIONS.length - 1]!);

  // BYTE-FOR-BYTE pins for every already-applied migration.
  for (const name of APPLIED_MIGRATIONS) {
    const bytes = readFileSync(path.join(migrationsDir, name, 'migration.sql'));
    const digest = createHash('sha256').update(bytes).digest('hex');
    assert.equal(
      digest,
      APPLIED_MIGRATION_SHA256[name],
      `applied migration ${name} must never be edited (forward-only policy)`,
    );
  }

  // Phase 5 SQL: enum parity with schema.prisma + SQL-only extras present.
  const sql = readFileSync(path.join(migrationsDir, PHASE5_MIGRATION, 'migration.sql'), 'utf8');
  const schema = readFileSync(path.join(packageRoot, 'prisma', 'schema.prisma'), 'utf8');

  const sqlEnumPattern = /CREATE TYPE "([A-Za-z]+)" AS ENUM \(([^)]*)\)/g;
  const prismaEnumPattern = /enum ([A-Za-z]+) \{([^}]*)\}/g;
  const sqlEnums = new Map<string, string[]>();
  for (const match of sql.matchAll(sqlEnumPattern)) {
    const raw = match[2] ?? '';
    const values = raw
      .split(',')
      .map((part) => part.trim().replace(/^'|'$/g, ''))
      .filter((value) => value.length > 0);
    const enumName = match[1] ?? '';
    sqlEnums.set(enumName, values);
  }
  const prismaEnums = new Map<string, string[]>();
  for (const match of schema.matchAll(prismaEnumPattern)) {
    const raw = match[2] ?? '';
    const values = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('//'));
    const enumName = match[1] ?? '';
    prismaEnums.set(enumName, values);
  }
  const phase5EnumNames = [
    'AgentTaskRecurrenceType',
    'AgentTaskAgentSlug',
    'AgentTaskMode',
    'AgentTaskTrigger',
    'AgentTaskExecutionStatus',
  ];
  for (const enumName of phase5EnumNames) {
    const fromSql = sqlEnums.get(enumName);
    const fromPrisma = prismaEnums.get(enumName);
    assert.ok(fromSql && fromPrisma, `${enumName} must exist in BOTH the migration SQL and schema.prisma`);
    assert.deepStrictEqual(fromSql, fromPrisma, `${enumName} values must match between SQL and schema.prisma`);
  }

  // SQL-only partial unique index: one SCHEDULED row per (taskId, scheduledFor).
  assert.ok(
    sql.includes(
      'CREATE UNIQUE INDEX "AgentTaskExecution_taskId_scheduledFor_scheduled_key" ' +
        'ON "AgentTaskExecution"("taskId" ASC, "scheduledFor" ASC) WHERE "trigger" = \'scheduled\'',
    ),
  );

  // Documented CHECK constraints (SQL-only by design).
  for (const checkName of [
    'AgentTask_name_length_check',
    'AgentTask_prompt_length_check',
    'AgentTask_timezone_utc_check',
    'AgentTask_skip_dates_check',
    'AgentTask_recurrence_config_check',
    'AgentTaskExecution_max_attempts_check',
    'AgentTaskExecution_attempt_check',
    'AgentTaskExecution_duration_ms_check',
    'AgentTaskExecution_error_length_check',
    'AgentTaskExecution_chat_id_shape_check',
    'AgentTaskExecution_token_usage_check',
  ]) {
    assert.ok(sql.includes(`CONSTRAINT "${checkName}"`), `missing CHECK constraint ${checkName}`);
  }
  assert.ok(sql.includes('"maxAttempts" = 3'), 'maxAttempts is fixed at 3 in SQL');

  // Uniques + indexes + FKs.
  for (const constraintName of [
    'AgentTaskExecution_chatId_key',
    'AgentTaskExecution_queueJobId_key',
    'AgentTaskExecution_repeatJobKey_key',
    'AgentTaskExecution_taskId_fkey',
    'AgentTaskExecution_retryOfExecutionId_fkey',
  ]) {
    assert.ok(sql.includes(`CONSTRAINT "${constraintName}"`), `missing constraint ${constraintName}`);
  }
  for (const indexName of [
    'AgentTaskExecution_taskId_scheduledFor_idx',
    'AgentTaskExecution_status_idx',
    'AgentTaskExecution_scheduledFor_idx',
    'AgentTask_isActive_nextRunAt_idx',
    'AgentTask_createdAt_idx',
    'AgentTask_agentSlug_idx',
  ]) {
    assert.ok(sql.includes(`CREATE INDEX "${indexName}"`), `missing index ${indexName}`);
  }
  assert.ok(sql.includes("ON DELETE SET NULL"), 'retry self-FK must be SET NULL');
  assert.ok(sql.includes("ON DELETE CASCADE"), 'task FK must cascade');

  // Schema side: chatId/queueJobId/repeatJobKey uniques + task relation cascade.
  assert.ok(schema.includes('chatId             String                   @unique'));
  assert.ok(schema.includes('queueJobId         String?                  @unique'));
  assert.ok(schema.includes('repeatJobKey       String?                  @unique'));
  assert.ok(schema.includes('onDelete: Cascade, onUpdate: Cascade'));
  assert.ok(schema.includes('onDelete: SetNull, onUpdate: Cascade'));
});
