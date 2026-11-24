import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_TASK_TIMEZONE,
  MAX_DURATION_MS,
  MAX_RECURRENCE_ITERATIONS,
  MAX_TASK_ATTEMPTS,
  InMemorySchedulerStore,
  SchedulerConflictError,
  SchedulerNotFoundError,
  SchedulerService,
  SchedulerValidationError,
  claimExecutionInputSchema,
  computeNextRunAt,
  cronExpressionForRecurrence,
  createTaskInputSchema,
  createExecutionInputSchema,
  customCronRecurrenceConfigSchema,
  dailyRecurrenceConfigSchema,
  isRealUtcCalendarDate,
  markExecutionCompletedInputSchema,
  markExecutionFailedInputSchema,
  parseSchedulerInput,
  recurrenceConfigSchema,
  skipDatesSchema,
  updateTaskInputSchema,
  validateCronExpression,
  weeklyRecurrenceConfigSchema,
  monthlyRecurrenceConfigSchema,
  type AgentTask,
} from './index.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeHarness() {
  const store = new InMemorySchedulerStore();
  const service = new SchedulerService({ store });
  return { store, service };
}

function dailyConfig(hour: number, minute: number) {
  return { hour, minute };
}

function onceConfig(iso: string) {
  return { runAt: iso };
}

async function createDailyTask(
  service: SchedulerService,
  overrides?: Partial<Parameters<SchedulerService['createTask']>[0]>,
): Promise<AgentTask> {
  return service.createTask({
    name: 'Daily digest',
    agentSlug: 'general',
    mode: 'action',
    prompt: 'Summarize yesterday.',
    recurrenceType: 'DAILY',
    recurrenceConfig: dailyConfig(5, 30),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Schemas, bounds, and normalization
// ---------------------------------------------------------------------------

test('create task schema normalizes scope, trims, and applies defaults', () => {
  const parsed = parseSchedulerInput(createTaskInputSchema, {
    name: '  Nightly sweep  ',
    agentSlug: 'general',
    mode: 'plan',
    prompt: ' do it ',
    scope: 'ATLAS_Team',
    recurrenceType: 'DAILY',
    recurrenceConfig: { hour: 3, minute: 45 },
  });
  assert.equal(parsed.name, 'Nightly sweep');
  assert.equal(parsed.prompt, 'do it');
  assert.equal(parsed.scope, 'atlas_team');
  assert.equal(parsed.timezone, AGENT_TASK_TIMEZONE);
  assert.deepEqual(parsed.skipDates, []);
  assert.equal(parsed.afterAsOf, undefined);
});

test('create task schema enforces name/prompt bounds and enum vocabulary', () => {
  const base = {
    agentSlug: 'general',
    mode: 'plan',
    prompt: 'work',
    recurrenceType: 'DAILY',
    recurrenceConfig: dailyConfig(1, 0),
  } as const;
  assert.throws(
    () => parseSchedulerInput(createTaskInputSchema, { ...base, name: '' }),
    SchedulerValidationError,
  );
  assert.throws(
    () => parseSchedulerInput(createTaskInputSchema, { ...base, name: 'x'.repeat(201) }),
    SchedulerValidationError,
  );
  assert.throws(
    () => parseSchedulerInput(createTaskInputSchema, { ...base, name: 'ok', prompt: 'x'.repeat(10001) }),
    SchedulerValidationError,
  );
  assert.throws(
    () => parseSchedulerInput(createTaskInputSchema, { ...base, name: 'ok', agentSlug: 'boss' }),
    SchedulerValidationError,
  );
  assert.throws(
    () => parseSchedulerInput(createTaskInputSchema, { ...base, name: 'ok', mode: 'chaos' }),
    SchedulerValidationError,
  );
  // Unknown keys are rejected (strictObject).
  assert.throws(
    () => parseSchedulerInput(createTaskInputSchema, { ...base, name: 'ok', rogue: 1 }),
    SchedulerValidationError,
  );
});

test('recurrence config shapes are strict per type (pair rule, no arbitrary keys)', () => {
  assert.deepEqual(parseSchedulerInput(dailyRecurrenceConfigSchema, { hour: 6, minute: 15 }), {
    hour: 6,
    minute: 15,
  });
  // Extra keys are rejected on every variant.
  for (const config of [
    { runAt: '2027-01-01T00:00:00Z', rogue: 1 },
    { hour: 1, minute: 2, rogue: 1 },
    { hour: 1, minute: 2, weekdays: [1], rogue: 1 },
    { hour: 1, minute: 2, daysOfMonth: [3], rogue: 1 },
    { expression: '* * * * *', rogue: 1 },
  ]) {
    assert.throws(() => parseSchedulerInput(recurrenceConfigSchema, config), SchedulerValidationError);
  }
  // Pair rule: a DAILY config under WEEKLY/MONTHLY/ONCE/CUSTOM_CRON is rejected
  // by the create/update schema refine.
  assert.throws(
    () =>
      parseSchedulerInput(createTaskInputSchema, {
        name: 'x',
        agentSlug: 'general',
        mode: 'plan',
        prompt: 'p',
        recurrenceType: 'WEEKLY',
        recurrenceConfig: dailyConfig(1, 2),
      }),
    SchedulerValidationError,
  );
  assert.throws(() => parseSchedulerInput(dailyRecurrenceConfigSchema, { hour: 24, minute: 0 }));
  assert.throws(() => parseSchedulerInput(dailyRecurrenceConfigSchema, { hour: 0, minute: 60 }));
  assert.throws(() => parseSchedulerInput(weeklyRecurrenceConfigSchema, { hour: 1, minute: 0, weekdays: [] }));
  assert.throws(() => parseSchedulerInput(weeklyRecurrenceConfigSchema, { hour: 1, minute: 0, weekdays: [1, 1] }));
  assert.throws(() => parseSchedulerInput(weeklyRecurrenceConfigSchema, { hour: 1, minute: 0, weekdays: [7] }));
  assert.throws(() => parseSchedulerInput(monthlyRecurrenceConfigSchema, { hour: 1, minute: 0, daysOfMonth: [0] }));
  assert.throws(() => parseSchedulerInput(monthlyRecurrenceConfigSchema, { hour: 1, minute: 0, daysOfMonth: [32] }));
  assert.throws(() => parseSchedulerInput(monthlyRecurrenceConfigSchema, { hour: 1, minute: 0, daysOfMonth: [5, 5] }));
  // runAt must be a UTC 'Z' ISO datetime.
  assert.throws(
    () =>
      parseSchedulerInput(createTaskInputSchema, {
        name: 'x',
        agentSlug: 'general',
        mode: 'plan',
        prompt: 'p',
        recurrenceType: 'ONCE',
        recurrenceConfig: { runAt: '2027-01-01T00:00:00' },
      }),
    SchedulerValidationError,
  );
});

test('cron expressions: exactly five fields, bounded length, engine-validated', () => {
  assert.deepEqual(parseSchedulerInput(customCronRecurrenceConfigSchema, { expression: '30 4 * * 1-5' }), {
    expression: '30 4 * * 1-5',
  });
  assert.throws(() => parseSchedulerInput(customCronRecurrenceConfigSchema, { expression: '* * * * * *' }));
  assert.throws(() => parseSchedulerInput(customCronRecurrenceConfigSchema, { expression: '* * * *' }));
  assert.throws(() => parseSchedulerInput(customCronRecurrenceConfigSchema, { expression: 'x'.repeat(201) }));
  // Field count ok but the engine rejects out-of-range values.
  assert.throws(() => validateCronExpression('99 * * * *'), SchedulerValidationError);
  assert.throws(() => validateCronExpression('0 24 * * *'), SchedulerValidationError);
  assert.doesNotThrow(() => validateCronExpression('30 4 * * 1-5'));
});

test('skipDates: unique real YYYY-MM-DD UTC dates, bounded at 366', () => {
  const ok = parseSchedulerInput(skipDatesSchema, ['2026-01-01', '2028-02-29']);
  assert.deepEqual(ok, ['2026-01-01', '2028-02-29']);
  // Not real dates.
  assert.throws(() => parseSchedulerInput(skipDatesSchema, ['2026-02-30']), SchedulerValidationError);
  assert.throws(() => parseSchedulerInput(skipDatesSchema, ['2026-13-01']), SchedulerValidationError);
  assert.throws(() => parseSchedulerInput(skipDatesSchema, ['2026-1-1']), SchedulerValidationError);
  // Leap day IS real.
  assert.equal(isRealUtcCalendarDate('2028-02-29'), true);
  assert.equal(isRealUtcCalendarDate('2026-02-29'), false);
  // Uniqueness + hard bound.
  assert.throws(() => parseSchedulerInput(skipDatesSchema, ['2026-01-01', '2026-01-01']));
  assert.throws(() => parseSchedulerInput(skipDatesSchema, Array.from({ length: 367 }, (_, i) => `2026-01-01`)), SchedulerValidationError);
  const max = Array.from({ length: 366 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 0, 1 + i));
    return date.toISOString().slice(0, 10);
  });
  assert.doesNotThrow(() => parseSchedulerInput(skipDatesSchema, max));
});

// ---------------------------------------------------------------------------
// Recurrence engine
// ---------------------------------------------------------------------------

test('cron generation is deterministic from the config (sorted lists)', () => {
  assert.equal(cronExpressionForRecurrence('DAILY', dailyConfig(5, 30)), '30 5 * * *');
  assert.equal(
    cronExpressionForRecurrence('WEEKLY', { hour: 9, minute: 15, weekdays: [6, 0] }),
    '15 9 * * 0,6',
  );
  assert.equal(
    cronExpressionForRecurrence('MONTHLY', { hour: 20, minute: 0, daysOfMonth: [10, 1] }),
    '0 20 1,10 * *',
  );
  assert.equal(cronExpressionForRecurrence('ONCE', onceConfig('2027-01-01T00:00:00Z')), null);
  assert.equal(cronExpressionForRecurrence('CUSTOM_CRON', { expression: '30 4 * * 1-5' }), '30 4 * * 1-5');
});

test('ONCE: next run is runAt (future), null once the instant has passed or equals after', () => {
  const runAt = new Date('2027-03-01T12:00:00Z');
  assert.deepEqual(
    computeNextRunAt({ recurrenceType: 'ONCE', recurrenceConfig: onceConfig(runAt.toISOString()), after: new Date('2026-01-01T00:00:00Z'), skipDates: [] }),
    runAt,
  );
  assert.equal(
    computeNextRunAt({ recurrenceType: 'ONCE', recurrenceConfig: onceConfig(runAt.toISOString()), after: runAt, skipDates: [] }),
    null,
  );
  assert.equal(
    computeNextRunAt({ recurrenceType: 'ONCE', recurrenceConfig: onceConfig(runAt.toISOString()), after: new Date('2027-06-01T00:00:00Z'), skipDates: [] }),
    null,
  );
});

test('recurring next runs: strictly after the supplied instant, in UTC', () => {
  // DAILY 05:30 UTC: after 08:00 on May 1 -> next 05:30 on May 2.
  assert.deepEqual(
    computeNextRunAt({
      recurrenceType: 'DAILY',
      recurrenceConfig: dailyConfig(5, 30),
      after: new Date('2026-05-01T08:00:00Z'),
      skipDates: [],
    }),
    new Date('2026-05-02T05:30:00Z'),
  );
  // Strictly after: at exactly 05:30 the same day is already consumed.
  assert.deepEqual(
    computeNextRunAt({
      recurrenceType: 'DAILY',
      recurrenceConfig: dailyConfig(5, 30),
      after: new Date('2026-05-01T05:30:00Z'),
      skipDates: [],
    }),
    new Date('2026-05-02T05:30:00Z'),
  );
  // WEEKLY (0=Sunday): after a Saturday -> Sunday.
  assert.deepEqual(
    computeNextRunAt({
      recurrenceType: 'WEEKLY',
      recurrenceConfig: { hour: 1, minute: 0, weekdays: [0, 5] },
      after: new Date('2026-11-21T00:00:00Z'),
      skipDates: [],
    }),
    new Date('2026-11-22T01:00:00Z'),
  );
  // MONTHLY day 31 skips short months (Feb): Jan 31 -> Mar 31.
  assert.deepEqual(
    computeNextRunAt({
      recurrenceType: 'MONTHLY',
      recurrenceConfig: { hour: 0, minute: 0, daysOfMonth: [31] },
      after: new Date('2026-01-31T00:00:00Z'),
      skipDates: [],
    }),
    new Date('2026-03-31T00:00:00Z'),
  );
  // MONTHLY: after 2026-03-01 the next 29th is Mar 29 (cron month-of-day
  // semantics; a Feb-only leap gate is not expressible with this config).
  assert.deepEqual(
    computeNextRunAt({
      recurrenceType: 'MONTHLY',
      recurrenceConfig: { hour: 0, minute: 0, daysOfMonth: [29] },
      after: new Date('2026-03-01T00:00:00Z'),
      skipDates: [],
    }),
    new Date('2026-03-29T00:00:00Z'),
  );
  // CUSTOM_CRON passes straight through croner.
  assert.deepEqual(
    computeNextRunAt({
      recurrenceType: 'CUSTOM_CRON',
      recurrenceConfig: { expression: '50 23 * * *' },
      after: new Date('2026-01-01T00:00:00Z'),
      skipDates: [],
    }),
    new Date('2026-01-01T23:50:00Z'),
  );
});

test('UTC is DST-free: fixed hours keep exact UTC instants across shifts', () => {
  // US spring-forward weekend (2026-03-08): the schedule stays 02:30 UTC.
  assert.deepEqual(
    computeNextRunAt({
      recurrenceType: 'DAILY',
      recurrenceConfig: dailyConfig(2, 30),
      after: new Date('2026-03-08T09:00:00Z'),
      skipDates: [],
    }),
    new Date('2026-03-09T02:30:00Z'),
  );
});

test('skipDates are honored with bounded iteration (366 days -> still instant)', () => {
  // 366 consecutive skipped UTC days: 2026-01-01 .. 2027-01-01.
  const skipDates = Array.from({ length: MAX_RECURRENCE_ITERATIONS / 2 }, (_, i) => {
    return new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
  });
  assert.equal(skipDates.length, 366);
  // Every-minute custom cron: the whole-day jump keeps iteration O(days).
  assert.deepEqual(
    computeNextRunAt({
      recurrenceType: 'CUSTOM_CRON',
      recurrenceConfig: { expression: '* * * * *' },
      after: new Date('2026-01-01T00:00:00Z'),
      skipDates,
    }),
    new Date('2027-01-02T00:00:00Z'),
  );
  assert.deepEqual(
    computeNextRunAt({
      recurrenceType: 'DAILY',
      recurrenceConfig: dailyConfig(0, 0),
      after: new Date('2026-01-01T00:00:00Z'),
      skipDates,
    }),
    new Date('2027-01-02T00:00:00Z'),
  );
  // A skipped day in the middle only shifts by that day.
  assert.deepEqual(
    computeNextRunAt({
      recurrenceType: 'DAILY',
      recurrenceConfig: dailyConfig(7, 15),
      after: new Date('2026-06-09T08:00:00Z'),
      skipDates: ['2026-06-10'],
    }),
    new Date('2026-06-11T07:15:00Z'),
  );
});

// ---------------------------------------------------------------------------
// Task CRUD + nextRunAt rules (service over the in-memory store)
// ---------------------------------------------------------------------------

test('createTask computes nextRunAt from the recurrence and honors afterAsOf', async () => {
  const { service } = makeHarness();

  const pastOnce = await service.createTask({
    name: 'One shot (past)',
    agentSlug: 'analyst',
    mode: 'plan',
    prompt: 'past',
    recurrenceType: 'ONCE',
    recurrenceConfig: { runAt: '2020-01-01T00:00:00Z' },
  });
  assert.equal(pastOnce.nextRunAt, null);
  assert.equal(pastOnce.isActive, true);
  assert.equal(pastOnce.timezone, 'UTC');

  const futureOnce = await service.createTask({
    name: 'One shot',
    agentSlug: 'analyst',
    mode: 'action',
    prompt: 'run later',
    recurrenceType: 'ONCE',
    recurrenceConfig: { runAt: '2030-01-01T05:06:07.008Z' },
  });
  assert.equal(futureOnce.nextRunAt, '2030-01-01T05:06:07.008Z');

  // DAILY: deterministic next run from the supplied afterAsOf instant.
  const daily = await createDailyTask(service, {
    afterAsOf: '2026-05-01T08:00:00Z',
  });
  assert.equal(daily.nextRunAt, '2026-05-02T05:30:00.000Z');

  // CUSTOM_CRON invalid -> typed 400 with croner as cause.
  await assert.rejects(
    () =>
      service.createTask({
        name: 'Broken cron',
        agentSlug: 'general',
        mode: 'action',
        prompt: 'x',
        recurrenceType: 'CUSTOM_CRON',
        recurrenceConfig: { expression: '99 * * * *' },
      }),
    (error: unknown) => {
      assert.ok(error instanceof SchedulerValidationError);
      assert.equal(error.code, 'scheduler_validation_error');
      assert.ok(error.message.includes('cron engine'));
      return true;
    },
  );
});

test('updateTask preserves id, recomputes on recurrence change, honors explicit nextRunAt otherwise', async () => {
  const { service } = makeHarness();
  const task = await createDailyTask(service, { afterAsOf: '2026-05-01T08:00:00Z' });

  // Name-only update keeps nextRunAt.
  const renamed = await service.updateTask({ id: task.id, name: 'Daily digest v2' });
  assert.equal(renamed.id, task.id);
  assert.equal(renamed.name, 'Daily digest v2');
  assert.equal(renamed.nextRunAt, task.nextRunAt);

  // Recurrence change recomputes (afterAsOf seeds the recompute instant).
  const weekly = await service.updateTask({
    id: task.id,
    recurrenceType: 'WEEKLY',
    recurrenceConfig: { hour: 9, minute: 15, weekdays: [1] },
    afterAsOf: '2026-05-01T00:00:00Z',
  });
  assert.equal(weekly.nextRunAt, '2026-05-04T09:15:00.000Z');

  // skipDates change alone recomputes.
  const skipped = await service.updateTask({
    id: task.id,
    skipDates: ['2026-05-04'],
    afterAsOf: '2026-05-01T00:00:00Z',
  });
  assert.equal(skipped.nextRunAt, '2026-05-11T09:15:00.000Z');

  // Explicit nextRunAt (without recurrence fields) wins exactly.
  const pinned = await service.updateTask({ id: task.id, nextRunAt: '2026-12-25T00:00:00Z' });
  assert.equal(pinned.nextRunAt, '2026-12-25T00:00:00.000Z');
  const cleared = await service.updateTask({ id: task.id, nextRunAt: null });
  assert.equal(cleared.nextRunAt, null);

  // Pair rule: recurrenceType without recurrenceConfig is a 400.
  await assert.rejects(
    () => service.updateTask({ id: task.id, recurrenceType: 'DAILY' }),
    SchedulerValidationError,
  );
  await assert.rejects(
    () => service.updateTask({ id: task.id, recurrenceConfig: dailyConfig(1, 1) }),
    SchedulerValidationError,
  );
  // No-op updates are rejected.
  await assert.rejects(
    () => service.updateTask({ id: task.id }),
    SchedulerValidationError,
  );
  // isActive is NOT part of update.
  await assert.rejects(
    () => service.updateTask({ id: task.id, isActive: false } as never),
    SchedulerValidationError,
  );
  // Unknown id -> typed 404.
  await assert.rejects(
    () => service.updateTask({ id: '00000000-0000-4000-8000-00000000dead', name: 'nope' }),
    SchedulerNotFoundError,
  );
});

test('getTask/setTaskActive/listTasks behave with typed errors and bounded deterministic listing', async () => {
  const { service } = makeHarness();
  const task = await createDailyTask(service);

  assert.deepEqual(await service.getTask(task.id), task);
  assert.equal(await service.getTask('00000000-0000-4000-8000-00000000dead'), null);

  const paused = await service.setTaskActive({ id: task.id, isActive: false });
  assert.equal(paused.isActive, false);
  assert.ok(paused.updatedAt >= paused.createdAt);
  const resumed = await service.setTaskActive({ id: task.id, isActive: true });
  assert.equal(resumed.isActive, true);
  await assert.rejects(
    () => service.setTaskActive({ id: '00000000-0000-4000-8000-00000000dead', isActive: true }),
    SchedulerNotFoundError,
  );

  assert.throws(
    () => parseSchedulerInput(updateTaskInputSchema, { id: task.id, nextRunAt: 'not-a-date' }),
    SchedulerValidationError,
  );
  // Strict schemas reject unknown keys on lists too.
  assert.throws(
    () => parseSchedulerInput(updateTaskInputSchema, { id: task.id, limit: 5 }),
    SchedulerValidationError,
  );

  // Listing is deterministic (createdAt then id) and bounded; the store honors
  // clock overrides so ordering is provable.
  const { store } = makeHarness();
  await store.createTask({ name: 'older', agentSlug: 'general', mode: 'plan', prompt: 'p', recurrenceType: 'DAILY', recurrenceConfig: dailyConfig(0, 0), now: new Date('2026-01-01T00:00:00Z') });
  await store.createTask({ name: 'newer', agentSlug: 'general', mode: 'plan', prompt: 'p', recurrenceType: 'DAILY', recurrenceConfig: dailyConfig(0, 0), now: new Date('2026-06-01T00:00:00Z') });
  const newest = await store.listTasks({ order: 'newest', limit: 10 });
  assert.deepEqual(newest.map((entry) => entry.name), ['newer', 'older']);
  const oldest = await new SchedulerService({ store }).listTasks({ order: 'oldest', limit: 1 });
  assert.deepEqual(oldest.map((entry) => entry.name), ['older']);
  await assert.rejects(
    () => new SchedulerService({ store }).listTasks({ limit: 101 }),
    SchedulerValidationError,
  );
});

// ---------------------------------------------------------------------------
// Executions: create/dedupe/retry (service over the in-memory store)
// ---------------------------------------------------------------------------

test('createExecution: isolated chatId, attempt 0, SCHEDULED duplicate returns existing', async () => {
  const { service } = makeHarness();
  const task = await createDailyTask(service);
  const scheduledFor = '2026-05-02T05:30:00Z';

  const first = await service.createExecution(task, { scheduledFor, trigger: 'SCHEDULED' });
  assert.equal(first.created, true);
  assert.equal(first.execution.chatId, first.execution.id);
  assert.equal(first.execution.taskId, task.id);
  assert.equal(first.execution.status, 'PENDING');
  assert.equal(first.execution.attempt, 0);
  assert.equal(first.execution.maxAttempts, MAX_TASK_ATTEMPTS);
  assert.equal(first.execution.finishedAt, null);

  // Atomic duplicate: same task + instant -> the SAME row, created:false.
  const duplicate = await service.createExecution(task, { scheduledFor, trigger: 'SCHEDULED' });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.execution.id, first.execution.id);
  const listed = await service.listExecutions({ taskId: task.id });
  assert.equal(listed.length, 1);

  // Same instant on ANOTHER task is unaffected.
  const other = await createDailyTask(service, { name: 'Second task' });
  const otherRow = await service.createExecution(other, { scheduledFor, trigger: 'SCHEDULED' });
  assert.equal(otherRow.created, true);
  assert.notEqual(otherRow.execution.id, first.execution.id);

  // MANUAL always inserts a new row, even for the same instant.
  const manualA = await service.createExecution(task, { scheduledFor, trigger: 'MANUAL' });
  const manualB = await service.createExecution(task, { scheduledFor, trigger: 'MANUAL' });
  assert.equal(manualA.created, true);
  assert.equal(manualB.created, true);
  assert.notEqual(manualA.execution.id, manualB.execution.id);
  assert.equal((await service.listExecutions({ taskId: task.id })).length, 3);
});

test('SCHEDULED dedupe wins over queue identities (Prisma parity, retry redelivery)', async () => {
  const { service } = makeHarness();
  const task = await createDailyTask(service);
  const base = {
    scheduledFor: '2026-05-02T05:30:00Z',
    trigger: 'SCHEDULED' as const,
    queueJobId: 'job-dedupe-1',
    repeatJobKey: 'task:daily:05:30',
  };

  const first = await service.createExecution(task, base);
  assert.equal(first.created, true);

  // Redelivered occurrence carrying the SAME BullMQ identity must return the
  // EXISTING row (created: false), not a queue-identity conflict: the
  // (taskId, scheduledFor) dedupe runs BEFORE the queue/repeat guards, like
  // the Prisma store (task row lock -> dedupe -> insert-or-P2002-reread).
  const redelivered = await service.createExecution(task, base);
  assert.equal(redelivered.created, false);
  assert.equal(redelivered.execution.id, first.execution.id);
  assert.equal(redelivered.execution.chatId, first.execution.chatId);
  assert.equal((await service.listExecutions({ taskId: task.id })).length, 1);

  // Dedupe also wins when the redelivery carries a brand-new explicit id:
  // no insert happens, so the id guard is never consulted.
  const withNewId = await service.createExecution(task, {
    ...base,
    id: '00000000-0000-4000-8000-00000000ff01',
  });
  assert.equal(withNewId.created, false);
  assert.equal(withNewId.execution.id, first.execution.id);
  assert.equal((await service.listExecutions({ taskId: task.id })).length, 1);
});

test('queue identity uniqueness still holds for genuinely new executions', async () => {
  const { service } = makeHarness();
  const task = await createDailyTask(service);

  await service.createExecution(task, {
    scheduledFor: '2026-05-02T05:30:00Z',
    trigger: 'SCHEDULED',
    queueJobId: 'job-new-1',
  });
  // Same queueJobId on a DIFFERENT scheduledFor -> real conflict, for
  // SCHEDULED and MANUAL alike.
  await assert.rejects(
    () =>
      service.createExecution(task, {
        scheduledFor: '2026-05-03T05:30:00Z',
        trigger: 'SCHEDULED',
        queueJobId: 'job-new-1',
      }),
    SchedulerConflictError,
  );
  await assert.rejects(
    () =>
      service.createExecution(task, {
        scheduledFor: '2026-05-03T05:30:00Z',
        trigger: 'MANUAL',
        queueJobId: 'job-new-1',
      }),
    SchedulerConflictError,
  );
  // Same for repeatJobKey.
  await service.createExecution(task, {
    scheduledFor: '2026-05-02T05:30:00Z',
    trigger: 'MANUAL',
    repeatJobKey: 'repeat-key-1',
  });
  await assert.rejects(
    () =>
      service.createExecution(task, {
        scheduledFor: '2026-05-03T05:30:00Z',
        trigger: 'SCHEDULED',
        repeatJobKey: 'repeat-key-1',
      }),
    SchedulerConflictError,
  );
});

test('createExecution: missing task 404, duplicate queue identities 409, scheduledFor bounds', async () => {
  const { service } = makeHarness();
  const task = await createDailyTask(service);

  await assert.rejects(
    () =>
      service.createExecution(
        { ...task, id: '00000000-0000-4000-8000-00000000dead' },
        { scheduledFor: '2026-05-02T05:30:00Z', trigger: 'SCHEDULED' },
      ),
    SchedulerNotFoundError,
  );

  await service.createExecution(task, {
    scheduledFor: '2026-05-02T05:30:00Z',
    trigger: 'MANUAL',
    queueJobId: 'job-1',
  });
  await assert.rejects(
    () =>
      service.createExecution(task, {
        scheduledFor: '2026-05-03T05:30:00Z',
        trigger: 'MANUAL',
        queueJobId: 'job-1',
      }),
    SchedulerConflictError,
  );
  await service.createExecution(task, {
    scheduledFor: '2026-05-02T05:30:00Z',
    trigger: 'MANUAL',
    repeatJobKey: 'task:daily:05:30',
  });
  await assert.rejects(
    () =>
      service.createExecution(task, {
        scheduledFor: '2026-05-04T05:30:00Z',
        trigger: 'MANUAL',
        repeatJobKey: 'task:daily:05:30',
      }),
    SchedulerConflictError,
  );
  // Bad scheduledFor -> 400.
  await assert.rejects(
    () => service.createExecution(task, { scheduledFor: '2026-05-02 05:30', trigger: 'MANUAL' }),
    SchedulerValidationError,
  );
  // Unknown queue ids >128 chars -> 400.
  await assert.rejects(
    () => service.createExecution(task, { scheduledFor: '2026-05-02T05:30:00Z', trigger: 'MANUAL', queueJobId: 'q'.repeat(129) }),
    SchedulerValidationError,
  );
});

test('retry: only DEAD_LETTER sources on the same task; new row, new chat', async () => {
  const { service } = makeHarness();
  const task = await createDailyTask(service);

  const scheduledFor = '2026-05-02T05:30:00Z';
  const original = (await service.createExecution(task, { scheduledFor, trigger: 'MANUAL' })).execution;
  await service.claimExecution({ id: original.id, attempt: 1, allowedFrom: 'PENDING' });
  await service.markFailed({ id: original.id, error: 'transient' });
  // FAILED (not DEAD_LETTER) cannot be retried.
  await assert.rejects(
    () => service.createExecution(task, { scheduledFor, trigger: 'RETRY', retryOfExecutionId: original.id }),
    SchedulerConflictError,
  );

  // Drive a second row to DEAD_LETTER (RUNNING -> DEAD_LETTER is legal).
  const exhausted = (await service.createExecution(task, { scheduledFor, trigger: 'MANUAL' })).execution;
  await service.claimExecution({ id: exhausted.id, attempt: 1, allowedFrom: 'PENDING' });
  const deadRow = await service.markDeadLetter({ id: exhausted.id, error: 'attempts exhausted' });
  assert.equal(deadRow.status, 'DEAD_LETTER');

  // RETRY creates a NEW row linked to the DEAD_LETTER source.
  const retry = await service.createExecution(task, {
    scheduledFor: '2026-05-03T05:30:00Z',
    trigger: 'RETRY',
    retryOfExecutionId: exhausted.id,
  });
  assert.equal(retry.created, true);
  assert.equal(retry.execution.retryOfExecutionId, exhausted.id);
  assert.notEqual(retry.execution.id, exhausted.id);
  assert.equal(retry.execution.chatId, retry.execution.id);
  assert.equal(retry.execution.attempt, 0);
  assert.equal(retry.execution.status, 'PENDING');

  // Cross-task retry is a conflict.
  const other = await createDailyTask(service, { name: 'Other task' });
  await assert.rejects(
    () =>
      service.createExecution(other, {
        scheduledFor: '2026-05-03T05:30:00Z',
        trigger: 'RETRY',
        retryOfExecutionId: exhausted.id,
      }),
    SchedulerConflictError,
  );
  // Missing source -> 404.
  await assert.rejects(
    () =>
      service.createExecution(task, {
        scheduledFor: '2026-05-03T05:30:00Z',
        trigger: 'RETRY',
        retryOfExecutionId: '00000000-0000-4000-8000-00000000dead',
      }),
    SchedulerNotFoundError,
  );
  // RETRY without retryOfExecutionId -> 400.
  await assert.rejects(
    () => service.createExecution(task, { scheduledFor, trigger: 'RETRY' }),
    SchedulerValidationError,
  );
  // retryOfExecutionId on MANUAL -> 400.
  await assert.rejects(
    () =>
      service.createExecution(task, {
        scheduledFor,
        trigger: 'MANUAL',
        retryOfExecutionId: exhausted.id,
      }),
    SchedulerValidationError,
  );
  // A DEAD_LETTER row itself can never leave terminal.
  await assert.rejects(
    () => service.claimExecution({ id: exhausted.id, attempt: 2, allowedFrom: 'RETRYING' }),
    SchedulerConflictError,
  );
});

// ---------------------------------------------------------------------------
// CAS: claim + marks
// ---------------------------------------------------------------------------

test('claimExecution: exactly one winner; running is NOT idempotent; attempt must increment', async () => {
  const { service } = makeHarness();
  const task = await createDailyTask(service);
  const execution = (
    await service.createExecution(task, { scheduledFor: '2026-05-02T05:30:00Z', trigger: 'SCHEDULED' })
  ).execution;

  const claimed = await service.claimExecution({ id: execution.id, attempt: 1, allowedFrom: 'PENDING' });
  assert.equal(claimed.status, 'RUNNING');
  assert.equal(claimed.attempt, 1);

  // Same-status RUNNING is not an idempotent claim.
  await assert.rejects(
    () => service.claimExecution({ id: execution.id, attempt: 2, allowedFrom: 'PENDING' }),
    SchedulerConflictError,
  );
  await assert.rejects(
    () => service.claimExecution({ id: execution.id, attempt: 2, allowedFrom: 'RUNNING' } as never),
    SchedulerValidationError,
  );
  // Attempt must move exactly +1.
  const retrying = await service.markRetrying({ id: execution.id });
  assert.equal(retrying.status, 'RETRYING');
  await assert.rejects(
    () => service.claimExecution({ id: execution.id, attempt: 1, allowedFrom: 'RETRYING' }),
    SchedulerConflictError,
  );
  const claimedAgain = await service.claimExecution({ id: execution.id, attempt: 2, allowedFrom: 'RETRYING' });
  assert.equal(claimedAgain.attempt, 2);
  assert.equal(claimedAgain.status, 'RUNNING');

  // Bounds: attempt 0 / 4 rejected.
  assert.throws(
    () => parseSchedulerInput(claimExecutionInputSchema, { id: execution.id, attempt: 0, allowedFrom: 'PENDING' }),
    SchedulerValidationError,
  );
  assert.throws(
    () => parseSchedulerInput(claimExecutionInputSchema, { id: execution.id, attempt: 4, allowedFrom: 'RETRYING' }),
    SchedulerValidationError,
  );

  // Fresh RUNNING/terminal rows reject claims.
  await service.markCompleted({ id: execution.id, durationMs: 10 });
  await assert.rejects(
    () => service.claimExecution({ id: execution.id, attempt: 3, allowedFrom: 'RETRYING' }),
    SchedulerConflictError,
  );
  // Missing execution -> 404.
  await assert.rejects(
    () => service.claimExecution({ id: '00000000-0000-4000-8000-00000000dead', attempt: 1, allowedFrom: 'PENDING' }),
    SchedulerNotFoundError,
  );
});

test('marks: terminal stamps, payload-equivalent idempotency, immutability, bounds', async () => {
  const { service } = makeHarness();
  const task = await createDailyTask(service);

  const mk = async () => {
    const execution = (
      await service.createExecution(task, { scheduledFor: '2026-05-02T05:30:00Z', trigger: 'MANUAL' })
    ).execution;
    await service.claimExecution({ id: execution.id, attempt: 1, allowedFrom: 'PENDING' });
    return execution;
  };

  // COMPLETED with duration + structured token usage.
  const done = await mk();
  const completed = await service.markCompleted({
    id: done.id,
    durationMs: 1200,
    tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  });
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.durationMs, 1200);
  assert.deepEqual(completed.tokenUsage, { inputTokens: 10, outputTokens: 20, totalTokens: 30 });
  assert.ok(completed.finishedAt !== null);

  // Payload-equivalent repeat is idempotent.
  const repeat = await service.markCompleted({
    id: done.id,
    durationMs: 1200,
    tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  });
  assert.deepEqual(repeat, completed);
  // Different payload -> conflict.
  await assert.rejects(
    () => service.markCompleted({ id: done.id, durationMs: 1300 }),
    SchedulerConflictError,
  );
  // Partial tokenUsage differs too.
  await assert.rejects(
    () => service.markCompleted({ id: done.id, durationMs: 1200, tokenUsage: { inputTokens: 10 } }),
    SchedulerConflictError,
  );
  // Terminal rows never take other outcomes or claims.
  await assert.rejects(() => service.markFailed({ id: done.id, error: 'late' }), SchedulerConflictError);
  await assert.rejects(() => service.markRetrying({ id: done.id }), SchedulerConflictError);

  // FAILED: error equivalence idempotency; error bound 1000.
  const failed = await mk();
  await service.markFailed({ id: failed.id, error: 'boom' });
  const failedRow = await service.getExecution(failed.id);
  assert.equal(failedRow?.status, 'FAILED');
  assert.equal(failedRow?.error, 'boom');
  await assert.rejects(
    () => service.markFailed({ id: failed.id, error: 'different' }),
    SchedulerConflictError,
  );
  assert.throws(
    () => parseSchedulerInput(markExecutionFailedInputSchema, { id: failed.id, error: 'x'.repeat(1001) }),
    SchedulerValidationError,
  );
  // DEAD_LETTER from RUNNING.
  const dead = await mk();
  const deadRow = await service.markDeadLetter({ id: dead.id, error: 'exhausted' });
  assert.equal(deadRow.status, 'DEAD_LETTER');
  assert.ok(deadRow.finishedAt !== null);
  // No dead_letter -> anything; retry is a NEW row (covered in the retry test).

  // SKIPPED only from PENDING; double-skip conflicts.
  const skippedExecution = (
    await service.createExecution(task, { scheduledFor: '2026-06-01T05:30:00Z', trigger: 'SCHEDULED' })
  ).execution;
  const skipped = await service.markSkipped({ id: skippedExecution.id });
  assert.equal(skipped.status, 'SKIPPED');
  assert.ok(skipped.finishedAt !== null);
  await assert.rejects(() => service.markSkipped({ id: skippedExecution.id }), SchedulerConflictError);
  const running = await mk();
  await assert.rejects(() => service.markSkipped({ id: running.id }), SchedulerConflictError);

  // RETRYING carries no finishedAt and never terminal.
  const retrying = await mk();
  const pendingRow = await service.getExecution(retrying.id);
  await service.markRetrying({ id: retrying.id });
  const retryingRow = await service.getExecution(retrying.id);
  assert.equal(retryingRow?.status, 'RETRYING');
  assert.equal(retryingRow?.finishedAt, null);
  assert.equal(pendingRow?.finishedAt, null);

  // Bounds: durationMs / tokenUsage.
  assert.throws(
    () => parseSchedulerInput(markExecutionCompletedInputSchema, { id: '00000000-0000-4000-8000-000000000001', durationMs: -1 }),
    SchedulerValidationError,
  );
  assert.throws(
    () =>
      parseSchedulerInput(markExecutionCompletedInputSchema, {
        id: '00000000-0000-4000-8000-000000000001',
        durationMs: MAX_DURATION_MS + 1,
      }),
    SchedulerValidationError,
  );
  assert.throws(
    () => parseSchedulerInput(markExecutionCompletedInputSchema, { id: '00000000-0000-4000-8000-000000000001', durationMs: 1, tokenUsage: { inputTokens: -1 } }),
    SchedulerValidationError,
  );
  assert.throws(
    () => parseSchedulerInput(markExecutionCompletedInputSchema, { id: '00000000-0000-4000-8000-000000000001', durationMs: 1, tokenUsage: {} }),
    SchedulerValidationError,
  );
});

test('markExecution paths only accept the documented statuses for each target', async () => {
  const { service, store } = makeHarness();
  const task = await createDailyTask(service);
  const execution = (
    await service.createExecution(task, { scheduledFor: '2026-05-02T05:30:00Z', trigger: 'SCHEDULED' })
  ).execution;
  // PENDING only allows SKIPPED — COMPLETED and DEAD_LETTER are conflicts.
  await assert.rejects(
    () => store.markExecution({ id: execution.id, target: 'COMPLETED', durationMs: 5 }),
    SchedulerConflictError,
  );
  await assert.rejects(
    () => store.markExecution({ id: execution.id, target: 'DEAD_LETTER', error: 'early' }),
    SchedulerConflictError,
  );
});

// ---------------------------------------------------------------------------
// Listing/filtering parity
// ---------------------------------------------------------------------------

test('listExecutions filters by taskId/status with deterministic bounded order', async () => {
  const { store, service } = makeHarness();
  const taskA = await store.createTask({
    name: 'A',
    agentSlug: 'general',
    mode: 'plan',
    prompt: 'p',
    recurrenceType: 'DAILY',
    recurrenceConfig: dailyConfig(0, 0),
    now: new Date('2026-01-01T00:00:00Z'),
  });
  const taskB = await store.createTask({
    name: 'B',
    agentSlug: 'general',
    mode: 'plan',
    prompt: 'p',
    recurrenceType: 'DAILY',
    recurrenceConfig: dailyConfig(0, 0),
    now: new Date('2026-01-01T00:00:00Z'),
  });

  // Same createdAt for all three -> id tie-break decides.
  await store.createExecution(taskA, { scheduledFor: '2026-02-01T00:00:00Z', trigger: 'SCHEDULED', now: new Date('2026-05-01T00:00:00Z') });
  await store.createExecution(taskA, { scheduledFor: '2026-02-02T00:00:00Z', trigger: 'MANUAL', now: new Date('2026-05-01T00:00:00Z') });
  await store.createExecution(taskB, { scheduledFor: '2026-02-03T00:00:00Z', trigger: 'MANUAL', now: new Date('2026-05-01T00:00:00Z') });

  const all = await service.listExecutions({ limit: 10, order: 'oldest' });
  assert.equal(all.length, 3);
  const ids = all.map((row) => row.id);
  assert.deepEqual([...ids].sort(), ids);

  const forTaskA = await service.listExecutions({ taskId: taskA.id });
  assert.equal(forTaskA.length, 2);
  assert.ok(forTaskA.every((row) => row.taskId === taskA.id));

  const skippedFirst = await service.listExecutions({ status: 'PENDING' });
  assert.equal(skippedFirst.length, 3);
  const first = await store.markExecution({ id: skippedFirst[0]!.id, target: 'SKIPPED' });
  const others = await service.listExecutions({ status: 'PENDING' });
  assert.equal(others.length, 2);
  assert.equal(first.status, 'SKIPPED');

  // Deterministic limit bound.
  await assert.rejects(() => service.listExecutions({ limit: 101 }), SchedulerValidationError);
  await assert.rejects(() => service.listExecutions({ taskId: 'not-a-uuid' }), SchedulerValidationError);
});

// ---------------------------------------------------------------------------
// Store contract guards (defense in depth)
// ---------------------------------------------------------------------------

test('stores reject malformed payloads independently of the service', async () => {
  const { store } = makeHarness();
  await assert.rejects(
    () =>
      store.createTask({
        name: 'Broken timezone',
        agentSlug: 'general',
        mode: 'plan',
        prompt: 'p',
        recurrenceType: 'DAILY',
        recurrenceConfig: { hour: 1, minute: 2 },
        now: 'not-a-date',
      }),
    SchedulerValidationError,
  );
  await assert.rejects(
    () =>
      store.createTask({
        name: 'Broken scope',
        agentSlug: 'general',
        mode: 'plan',
        prompt: 'p',
        recurrenceType: 'DAILY',
        recurrenceConfig: { hour: 1, minute: 2 },
        scope: 'bad scope!',
      }),
    SchedulerValidationError,
  );
});

test('createExecution input schema rejects unknown keys and optional id wins', async () => {
  const { store } = makeHarness();
  const task = await store.createTask({
    name: 'T',
    agentSlug: 'general',
    mode: 'plan',
    prompt: 'p',
    recurrenceType: 'DAILY',
    recurrenceConfig: dailyConfig(0, 0),
  });
  assert.throws(
    () =>
      parseSchedulerInput(createExecutionInputSchema, {
        scheduledFor: '2026-05-02T05:30:00Z',
        trigger: 'MANUAL',
        rogue: 1,
      }),
    SchedulerValidationError,
  );
  const result = await store.createExecution(task, {
    scheduledFor: '2026-05-02T05:30:00Z',
    trigger: 'MANUAL',
    id: '00000000-0000-4000-8000-00000000abcd',
  });
  assert.equal(result.execution.id, '00000000-0000-4000-8000-00000000abcd');
  await assert.rejects(
    () =>
      store.createExecution(task, {
        scheduledFor: '2026-05-03T05:30:00Z',
        trigger: 'MANUAL',
        id: '00000000-0000-4000-8000-00000000abcd',
      }),
    SchedulerConflictError,
  );
});
