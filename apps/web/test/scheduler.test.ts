import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEDULER_CREATE_ERROR,
  SCHEDULER_LIST_ERROR,
  SCHEDULER_MAP_ERROR,
  AGENT_TASK_PROMPT_MAX,
  buildCreateTaskBody,
  buildRecurrenceConfig,
  buildSchedulerExecutionsQuery,
  buildSchedulerTasksQuery,
  buildUpdateTaskBody,
  canRetryExecution,
  createSchedulerTask,
  dateTimeLocalFromUtcIso,
  executionChatLink,
  fetchSchedulerExecutions,
  fetchSchedulerTasks,
  formatAttempt,
  formatDuration,
  formatExecutionError,
  formatRecurrenceSummary,
  formatScheduleTime,
  formatTokenUsage,
  isSettlingExecutionStatus,
  isSchedulerSkipDate,
  mapSchedulerExecution,
  mapSchedulerExecutionListResponse,
  mapSchedulerRunResponse,
  mapSchedulerTask,
  mapSchedulerTaskDetailResponse,
  mapSchedulerTaskListResponse,
  mapSchedulerTaskMutationResponse,
  mapSchedulerRetryResponse,
  parseSkipDates,
  retrySchedulerExecution,
  retrySourceChatLink,
  runSchedulerTaskNow,
  scheduleListPagePath,
  schedulerExecutionEndpoint,
  schedulerExecutionRetryEndpoint,
  schedulerExecutionsEndpoint,
  schedulerStatusBadge,
  schedulerTaskActionEndpoint,
  schedulerTaskEndpoint,
  schedulerTasksEndpoint,
  setSchedulerTaskActive,
  shouldPollExecutions,
  utcIsoFromDateTimeLocal,
  updateSchedulerTask,
  type SchedulerExecution,
  type SchedulerTask,
} from '../src/lib/scheduler.js';

/**
 * Pure Phase 5 scheduler wire-contract tests, pinned against
 * apps/api/src/app.ts mounting + apps/api/src/scheduler/routes.ts and
 * packages/core/src/scheduler (kinds/schemas/types):
 * - GET/POST/PATCH task routes, activate/pause/run, executions list + DEAD_LETTER
 *   retry — the ONLY browser routes; the WORKER-ONLY run-scheduled and
 *   executions/:id/run routes have no builder anywhere in this module.
 * - Every recurrence type valid + invalid, ONCE datetime-local → UTC ISO
 *   (minute precision, no seconds), skipDates comma/newline editor with
 *   dedupe/validate, and strict mappers that reject malformed payloads.
 * - Poll predicate: PENDING/RUNNING/RETRYING (+ just-submitted settle window),
 *   never terminal-only lists.
 * - Chat links always use the OWNING task's agent + mode.
 */

const TASK_ID = '11111111-2222-4333-8444-555555555555';
const TASK_ID_2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const EXEC_ID = '99999999-8888-4777-8666-333333333333';

function taskRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TASK_ID,
    name: 'Daily digest',
    agentSlug: 'general',
    mode: 'action',
    prompt: 'Summarize the day.',
    scope: 'default',
    recurrenceType: 'DAILY',
    recurrenceConfig: { hour: 9, minute: 30 },
    skipDates: ['2026-12-25'],
    isActive: true,
    timezone: 'UTC',
    nextRunAt: '2026-11-24T09:30:00.000Z',
    createdAt: '2026-11-23T10:00:00.000Z',
    updatedAt: '2026-11-23T10:05:00.000Z',
    ...overrides,
  };
}

function executionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EXEC_ID,
    taskId: TASK_ID,
    scheduledFor: '2026-11-23T09:30:00.000Z',
    trigger: 'MANUAL',
    status: 'COMPLETED',
    attempt: 1,
    maxAttempts: 3,
    durationMs: 1234,
    tokenUsage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
    error: null,
    chatId: EXEC_ID,
    queueJobId: 'execution-1',
    repeatJobKey: null,
    retryOfExecutionId: null,
    createdAt: '2026-11-23T09:30:00.100Z',
    updatedAt: '2026-11-23T09:31:24.000Z',
    finishedAt: '2026-11-23T09:31:24.000Z',
    ...overrides,
  };
}

function okFetch(body: unknown, status = 200) {
  return async (): Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }> => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

/* ------------------------------------------------------------------ */
/* Endpoints + queries                                                  */
/* ------------------------------------------------------------------ */

test('scheduler endpoints: exact REST URLs per app.ts mounting', () => {
  const base = 'http://localhost:3001';
  assert.equal(schedulerTasksEndpoint(base), `${base}/api/scheduler/tasks`);
  assert.equal(schedulerTaskEndpoint(base, TASK_ID), `${base}/api/scheduler/tasks/${TASK_ID}`);
  assert.equal(schedulerTaskActionEndpoint(base, TASK_ID, 'activate'), `${base}/api/scheduler/tasks/${TASK_ID}/activate`);
  assert.equal(schedulerTaskActionEndpoint(base, TASK_ID, 'pause'), `${base}/api/scheduler/tasks/${TASK_ID}/pause`);
  assert.equal(schedulerTaskActionEndpoint(base, TASK_ID, 'run'), `${base}/api/scheduler/tasks/${TASK_ID}/run`);
  assert.equal(schedulerExecutionsEndpoint(base), `${base}/api/scheduler/executions`);
  assert.equal(schedulerExecutionEndpoint(base, EXEC_ID), `${base}/api/scheduler/executions/${EXEC_ID}`);
  assert.equal(schedulerExecutionRetryEndpoint(base, EXEC_ID), `${base}/api/scheduler/executions/${EXEC_ID}/retry`);
  assert.equal(scheduleListPagePath(), '/schedules');
});

test('query builders: isActive/limit and taskId/status/limit, invalid values dropped', () => {
  assert.equal(buildSchedulerTasksQuery({}), '');
  assert.equal(buildSchedulerTasksQuery({ isActive: true }), '?isActive=true');
  assert.equal(buildSchedulerTasksQuery({ isActive: false }), '?isActive=false');
  assert.equal(buildSchedulerTasksQuery({ limit: 100 }), '?limit=100');
  assert.equal(buildSchedulerTasksQuery({ isActive: true, limit: 20 }), '?isActive=true&limit=20');
  assert.equal(buildSchedulerTasksQuery({ limit: 0 }), '');
  assert.equal(buildSchedulerTasksQuery({ limit: 101 }), '');
  assert.equal(buildSchedulerTasksQuery({ limit: 2.5 }), '');

  assert.equal(buildSchedulerExecutionsQuery({}), '');
  assert.equal(buildSchedulerExecutionsQuery({ taskId: TASK_ID, status: 'DEAD_LETTER', limit: 50 }), `?taskId=${TASK_ID}&status=DEAD_LETTER&limit=50`);
  // Invalid taskId/status are omitted; they would 400 at the API otherwise.
  assert.equal(buildSchedulerExecutionsQuery({ taskId: 'not-a-uuid', status: 'WEIRD' }), '');
  assert.equal(buildSchedulerExecutionsQuery({ status: 'running' }), '');
  assert.equal(buildSchedulerExecutionsQuery({ limit: 101 }), '');
});

/* ------------------------------------------------------------------ */
/* ONCE datetime-local → UTC ISO                                        */
/* ------------------------------------------------------------------ */

test('utcIsoFromDateTimeLocal: UTC wall clock → ISO Z, minute precision, no seconds', () => {
  assert.equal(utcIsoFromDateTimeLocal('2026-11-24T09:30'), '2026-11-24T09:30:00.000Z');
  assert.equal(utcIsoFromDateTimeLocal('2027-02-28T23:59'), '2027-02-28T23:59:00.000Z');
  // Optional seconds are accepted by datetime-local but never stored.
  assert.equal(utcIsoFromDateTimeLocal('2026-11-24T09:30:15'), '2026-11-24T09:30:00.000Z');
});

test('utcIsoFromDateTimeLocal: rejects malformed/offset/non-real inputs', () => {
  assert.equal(utcIsoFromDateTimeLocal(''), null);
  assert.equal(utcIsoFromDateTimeLocal('2026-02-30T09:30'), null); // not a real date
  assert.equal(utcIsoFromDateTimeLocal('2026-11-24T24:00'), null); // hour 24
  assert.equal(utcIsoFromDateTimeLocal('2026-11-24T09:60'), null); // minute 60
  assert.equal(utcIsoFromDateTimeLocal('2026-11-24T09:30:60'), null); // second 60
  // A timezone offset would contradict the UTC-only contract — never sent.
  assert.equal(utcIsoFromDateTimeLocal('2026-11-24T09:30+02:00'), null);
  assert.equal(utcIsoFromDateTimeLocal('2026-11-24T09:30Z'), null);
  assert.equal(utcIsoFromDateTimeLocal('2026-11-24 09:30'), null);
});

test('dateTimeLocalFromUtcIso: exact inverse of the UTC conversion', () => {
  const iso = utcIsoFromDateTimeLocal('2026-11-24T09:30') as string;
  assert.equal(dateTimeLocalFromUtcIso(iso), '2026-11-24T09:30');
  assert.equal(dateTimeLocalFromUtcIso('2026-11-24T09:30:00Z'), '2026-11-24T09:30');
  assert.equal(dateTimeLocalFromUtcIso('2026-11-24T09:30:00+02:00'), null);
  assert.equal(dateTimeLocalFromUtcIso('nope'), null);
});

/* ------------------------------------------------------------------ */
/* Recurrence configs (every type, valid + invalid)                     */
/* ------------------------------------------------------------------ */

test('buildRecurrenceConfig: ONCE with datetime-local → strict UTC runAt', () => {
  assert.deepEqual(buildRecurrenceConfig({ recurrenceType: 'ONCE', runAt: '2026-11-24T09:30' }), {
    ok: true,
    recurrenceType: 'ONCE',
    recurrenceConfig: { runAt: '2026-11-24T09:30:00.000Z' },
  });
  assert.equal(buildRecurrenceConfig({ recurrenceType: 'ONCE' }).ok, false);
  assert.equal(buildRecurrenceConfig({ recurrenceType: 'ONCE', runAt: '2026-02-30T09:30' }).ok, false);
});

test('buildRecurrenceConfig: DAILY hour/minute bounds', () => {
  assert.deepEqual(buildRecurrenceConfig({ recurrenceType: 'DAILY', hour: '0', minute: '0' }), {
    ok: true,
    recurrenceType: 'DAILY',
    recurrenceConfig: { hour: 0, minute: 0 },
  });
  assert.deepEqual(buildRecurrenceConfig({ recurrenceType: 'DAILY', hour: 23, minute: 59 }), {
    ok: true,
    recurrenceType: 'DAILY',
    recurrenceConfig: { hour: 23, minute: 59 },
  });
  for (const bad of [
    { recurrenceType: 'DAILY', hour: 24, minute: 0 },
    { recurrenceType: 'DAILY', hour: -1, minute: 0 },
    { recurrenceType: 'DAILY', hour: 9, minute: 60 },
    { recurrenceType: 'DAILY', hour: 'nine', minute: 0 },
    { recurrenceType: 'DAILY', hour: 9.5, minute: 0 },
    { recurrenceType: 'DAILY' },
  ]) {
    assert.equal(buildRecurrenceConfig(bad).ok, false, `expected invalid: ${JSON.stringify(bad)}`);
  }
});

test('buildRecurrenceConfig: WEEKLY unique weekdays 0..6', () => {
  assert.deepEqual(buildRecurrenceConfig({ recurrenceType: 'WEEKLY', hour: '8', minute: '15', weekdays: ['1', '3', '5'] }), {
    ok: true,
    recurrenceType: 'WEEKLY',
    recurrenceConfig: { hour: 8, minute: 15, weekdays: [1, 3, 5] },
  });
  assert.equal(buildRecurrenceConfig({ recurrenceType: 'WEEKLY', hour: 8, minute: 15, weekdays: [] }).ok, false);
  assert.equal(buildRecurrenceConfig({ recurrenceType: 'WEEKLY', hour: 8, minute: 15, weekdays: ['1', '1'] }).ok, false);
  assert.equal(buildRecurrenceConfig({ recurrenceType: 'WEEKLY', hour: 8, minute: 15, weekdays: ['7'] }).ok, false);
  assert.equal(buildRecurrenceConfig({ recurrenceType: 'WEEKLY', hour: 8, minute: 15, weekdays: ['-1'] }).ok, false);
  assert.equal(buildRecurrenceConfig({ recurrenceType: 'WEEKLY', hour: 8, minute: 15 }).ok, false);
});

test('buildRecurrenceConfig: MONTHLY unique daysOfMonth 1..31', () => {
  assert.deepEqual(buildRecurrenceConfig({ recurrenceType: 'MONTHLY', hour: '6', minute: '0', daysOfMonth: ['1', '15', '31'] }), {
    ok: true,
    recurrenceType: 'MONTHLY',
    recurrenceConfig: { hour: 6, minute: 0, daysOfMonth: [1, 15, 31] },
  });
  assert.equal(buildRecurrenceConfig({ recurrenceType: 'MONTHLY', hour: 6, minute: 0, daysOfMonth: ['0'] }).ok, false);
  assert.equal(buildRecurrenceConfig({ recurrenceType: 'MONTHLY', hour: 6, minute: 0, daysOfMonth: ['32'] }).ok, false);
  assert.equal(buildRecurrenceConfig({ recurrenceType: 'MONTHLY', hour: 6, minute: 0, daysOfMonth: ['15', '15'] }).ok, false);
  assert.equal(buildRecurrenceConfig({ recurrenceType: 'MONTHLY', hour: 6, minute: 0 }).ok, false);
});

test('buildRecurrenceConfig: CUSTOM_CRON exactly 5 whitespace-separated fields ≤ 200 chars', () => {
  assert.deepEqual(buildRecurrenceConfig({ recurrenceType: 'CUSTOM_CRON', cronExpression: ' */15 * * * * ' }), {
    ok: true,
    recurrenceType: 'CUSTOM_CRON',
    recurrenceConfig: { expression: '*/15 * * * *' },
  });
  for (const bad of [
    { recurrenceType: 'CUSTOM_CRON', cronExpression: '* * * *' },
    { recurrenceType: 'CUSTOM_CRON', cronExpression: '* * * * * *' },
    { recurrenceType: 'CUSTOM_CRON', cronExpression: '' },
    { recurrenceType: 'CUSTOM_CRON', cronExpression: `${'*'.repeat(196)} * * * *` }, // 5 fields but > 200 chars
    { recurrenceType: 'CUSTOM_CRON', cronExpression: `${'*'.repeat(50)} * * * * *` }, // 6 fields
  ]) {
    assert.equal(buildRecurrenceConfig(bad).ok, false, `expected invalid: ${JSON.stringify(bad)}`);
  }
});

test('buildRecurrenceConfig: unknown/missing type rejected', () => {
  assert.equal(buildRecurrenceConfig({}).ok, false);
  assert.equal(buildRecurrenceConfig({ recurrenceType: 'HOURLY', hour: 1, minute: 0 }).ok, false);
});

/* ------------------------------------------------------------------ */
/* Skip dates                                                           */
/* ------------------------------------------------------------------ */

test('parseSkipDates: comma/newline mix, trim, dedupe, real calendar dates only', () => {
  assert.deepEqual(parseSkipDates(''), { ok: true, dates: [] });
  assert.deepEqual(parseSkipDates('   '), { ok: true, dates: [] });
  assert.deepEqual(parseSkipDates('2026-12-24,2026-12-25'), { ok: true, dates: ['2026-12-24', '2026-12-25'] });
  assert.deepEqual(parseSkipDates('2026-12-24\n 2026-12-25 ,\n2026-12-26'), {
    ok: true,
    dates: ['2026-12-24', '2026-12-25', '2026-12-26'],
  });
  // Repeats collapse; first occurrence order kept.
  assert.deepEqual(parseSkipDates('2026-12-24,\n2026-12-24'), { ok: true, dates: ['2026-12-24'] });
  // Leap day allowed; non-real dates rejected.
  assert.deepEqual(parseSkipDates('2028-02-29'), { ok: true, dates: ['2028-02-29'] });
  const invalid = parseSkipDates('2026-02-30');
  assert.equal(invalid.ok, false);
  const notShape = parseSkipDates('24/12/2026');
  assert.equal(notShape.ok, false);
  // One invalid entry rejects the whole list (all-or-nothing).
  assert.equal(parseSkipDates('2026-12-24,2026-13-01').ok, false);
  const tooMany = parseSkipDates(uniqueDates(367).join(','));
  assert.equal(tooMany.ok, false);
  assert.equal(parseSkipDates(uniqueDates(366).join(',')).ok, true);
});

/** N unique real YYYY-MM-DD dates starting 2026-01-01 (UTC-safe counter). */
function uniqueDates(count: number): string[] {
  const dates: string[] = [];
  let cursor = Date.UTC(2026, 0, 1);
  while (dates.length < count) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 24 * 60 * 60 * 1000;
  }
  return dates;
}

test('isSchedulerSkipDate guards shape and calendar', () => {
  assert.equal(isSchedulerSkipDate('2026-12-24'), true);
  assert.equal(isSchedulerSkipDate('2026-02-30'), false);
  assert.equal(isSchedulerSkipDate('2026-12-24T10:00:00Z'), false);
  assert.equal(isSchedulerSkipDate(20261224), false);
  assert.equal(isSchedulerSkipDate(null), false);
});

/* ------------------------------------------------------------------ */
/* Request bodies                                                       */
/* ------------------------------------------------------------------ */

const FULL_FORM = {
  name: '  Daily digest  ',
  agentSlug: 'general',
  mode: 'action',
  prompt: 'Summarize the day.',
  scope: 'Team-1_A',
  recurrenceType: 'DAILY',
  hour: '9',
  minute: '30',
  skipDates: '2026-12-24, 2026-12-25',
};

test('buildCreateTaskBody: exact createTaskInputSchema body, scope normalized lower-case', () => {
  const result = buildCreateTaskBody(FULL_FORM);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.body, {
    name: 'Daily digest',
    agentSlug: 'general',
    mode: 'action',
    prompt: 'Summarize the day.',
    scope: 'team-1_a',
    recurrenceType: 'DAILY',
    recurrenceConfig: { hour: 9, minute: 30 },
    skipDates: ['2026-12-24', '2026-12-25'],
    timezone: 'UTC',
  });
  // No isActive/nextRunAt/id on create: dedicated routes + server-side compute.
  assert.equal('isActive' in result.body, false);
  assert.equal('nextRunAt' in result.body, false);
});

test('buildCreateTaskBody: bounds, defaults, and rejections', () => {
  assert.equal(buildCreateTaskBody({ ...FULL_FORM, name: '' }).ok, false);
  assert.equal(buildCreateTaskBody({ ...FULL_FORM, name: 'x'.repeat(201) }).ok, false);
  assert.equal(buildCreateTaskBody({ ...FULL_FORM, prompt: '' }).ok, false);
  assert.equal(buildCreateTaskBody({ ...FULL_FORM, prompt: 'x'.repeat(AGENT_TASK_PROMPT_MAX + 1) }).ok, false);
  assert.equal(buildCreateTaskBody({ ...FULL_FORM, agentSlug: 'manager' }).ok, false);
  assert.equal(buildCreateTaskBody({ ...FULL_FORM, mode: 'ask' }).ok, false);
  assert.equal(buildCreateTaskBody({ ...FULL_FORM, scope: 'team 1' }).ok, false);
  assert.equal(buildCreateTaskBody({ ...FULL_FORM, scope: 'x'.repeat(65) }).ok, false);
  // Blank scope falls back to the API default.
  const fallbackScope = buildCreateTaskBody({ ...FULL_FORM, scope: '   ' });
  assert.equal(fallbackScope.ok && fallbackScope.body.scope, 'default');
  // Skip-date failures propagate.
  assert.equal(buildCreateTaskBody({ ...FULL_FORM, skipDates: '2026-02-30' }).ok, false);
  // Recurrence failures propagate.
  assert.equal(buildCreateTaskBody({ ...FULL_FORM, recurrenceType: 'ONCE' }).ok, false);
});

test('buildUpdateTaskBody: UUID id required; same fields minus timezone; pair sent together', () => {
  const ok = buildUpdateTaskBody({ ...FULL_FORM, id: TASK_ID });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.body, {
      id: TASK_ID,
      name: 'Daily digest',
      agentSlug: 'general',
      mode: 'action',
      prompt: 'Summarize the day.',
      scope: 'team-1_a',
      recurrenceType: 'DAILY',
      recurrenceConfig: { hour: 9, minute: 30 },
      skipDates: ['2026-12-24', '2026-12-25'],
    });
    assert.equal('timezone' in ok.body, false);
    assert.equal('isActive' in ok.body, false);
  }
  assert.equal(buildUpdateTaskBody({ ...FULL_FORM, id: 'not-a-uuid' }).ok, false);
  assert.equal(buildUpdateTaskBody({ ...FULL_FORM, id: TASK_ID, name: '' }).ok, false);
});

/* ------------------------------------------------------------------ */
/* Task mappers (strict)                                                */
/* ------------------------------------------------------------------ */

test('mapSchedulerTask: valid rows across every recurrence shape', () => {
  const daily = mapSchedulerTask(taskRow());
  assert.equal(daily.ok, true);
  if (!daily.ok) return;
  assert.deepEqual(daily.value.skipDates, ['2026-12-25']);
  assert.deepEqual(daily.value.recurrenceConfig, { hour: 9, minute: 30 });

  const once = mapSchedulerTask(taskRow({ recurrenceType: 'ONCE', recurrenceConfig: { runAt: '2026-11-24T09:30:00.000Z' } }));
  assert.equal(once.ok, true);

  const weekly = mapSchedulerTask(taskRow({ recurrenceType: 'WEEKLY', recurrenceConfig: { hour: 9, minute: 30, weekdays: [1, 5] } }));
  assert.equal(weekly.ok, true);

  const monthly = mapSchedulerTask(taskRow({ recurrenceType: 'MONTHLY', recurrenceConfig: { hour: 9, minute: 30, daysOfMonth: [1, 15] } }));
  assert.equal(monthly.ok, true);

  const cron = mapSchedulerTask(taskRow({ recurrenceType: 'CUSTOM_CRON', recurrenceConfig: { expression: '*/15 * * * *' } }));
  assert.equal(cron.ok, true);

  const nullNext = mapSchedulerTask(taskRow({ nextRunAt: null }));
  assert.equal(nullNext.ok, true);
});

test('mapSchedulerTask: malformed rows rejected', () => {
  const rejects: Array<Record<string, unknown>> = [
    {},
    taskRow({ id: 'not-a-uuid' }),
    taskRow({ agentSlug: 'manager' }),
    taskRow({ mode: 'ask' }),
    taskRow({ name: '' }),
    taskRow({ scope: '' }),
    taskRow({ recurrenceType: 'HOURLY' }),
    // Config shape must match the type exactly (pair rule).
    taskRow({ recurrenceType: 'ONCE', recurrenceConfig: { hour: 9, minute: 30 } }),
    taskRow({ recurrenceType: 'DAILY', recurrenceConfig: { runAt: '2026-11-24T09:30:00.000Z' } }),
    taskRow({ recurrenceType: 'WEEKLY', recurrenceConfig: { hour: 9, minute: 30, weekdays: [] } }),
    taskRow({ recurrenceType: 'WEEKLY', recurrenceConfig: { hour: 9, minute: 30, weekdays: [1, 1] } }),
    taskRow({ recurrenceType: 'MONTHLY', recurrenceConfig: { hour: 9, minute: 30, daysOfMonth: [32] } }),
    taskRow({ recurrenceType: 'CUSTOM_CRON', recurrenceConfig: { expression: '* * * *' } }),
    // Extra/unknown keys in the config are shape drift — reject.
    taskRow({ recurrenceType: 'DAILY', recurrenceConfig: { hour: 9, minute: 30, extra: 1 } }),
    taskRow({ nextRunAt: 'not-a-date' }),
    taskRow({ nextRunAt: '2026-11-24T09:30:00+02:00' }),
    taskRow({ skipDates: ['2026-02-30'] }),
    taskRow({ skipDates: ['2026-12-24', '2026-12-24'] }),
    taskRow({ isActive: 'yes' }),
    taskRow({ timezone: 'Europe/Berlin' }),
    taskRow({ timezone: undefined }),
    taskRow({ createdAt: '' }),
    taskRow({ updatedAt: null }),
  ];
  for (const row of rejects) {
    assert.equal(mapSchedulerTask(row).ok, false, `accepted malformed: ${JSON.stringify(row)}`);
  }
});

test('mapSchedulerTaskListResponse + detail response', () => {
  const list = mapSchedulerTaskListResponse({ tasks: [taskRow(), taskRow({ id: TASK_ID_2, mode: 'plan' })] });
  assert.equal(list.ok, true);
  assert.equal(list.ok && list.value.length, 2);
  const badList = mapSchedulerTaskListResponse({ tasks: [taskRow({ name: '' })] });
  assert.equal(badList.ok, false);
  if (!badList.ok) assert.equal(badList.error, SCHEDULER_MAP_ERROR);
  assert.equal(mapSchedulerTaskListResponse({ tasks: 'nope' }).ok, false);
  assert.equal(mapSchedulerTaskListResponse({}).ok, false);

  const detail = mapSchedulerTaskDetailResponse({ task: taskRow(), executions: [executionRow()] });
  assert.equal(detail.ok, true);
  const badDetail = mapSchedulerTaskDetailResponse({ task: taskRow(), executions: [executionRow({ status: 'WEIRD' })] });
  assert.equal(badDetail.ok, false);
  assert.equal(mapSchedulerTaskDetailResponse({ task: taskRow() }).ok, false); // executions missing
});

/* ------------------------------------------------------------------ */
/* Execution mappers (strict)                                           */
/* ------------------------------------------------------------------ */

test('mapSchedulerExecution: valid rows including all statuses, triggers, nullable fields', () => {
  for (const status of ['PENDING', 'RUNNING', 'RETRYING', 'COMPLETED', 'FAILED', 'DEAD_LETTER', 'SKIPPED'] as const) {
    const mapped = mapSchedulerExecution(executionRow({ status }));
    assert.equal(mapped.ok, true, `status ${status} should map`);
  }
  for (const trigger of ['SCHEDULED', 'MANUAL', 'RETRY'] as const) {
    assert.equal(mapSchedulerExecution(executionRow({ trigger })).ok, true);
  }
  const pending = mapSchedulerExecution(
    executionRow({ status: 'PENDING', attempt: 0, durationMs: null, tokenUsage: null, error: null, finishedAt: null, queueJobId: null }),
  );
  assert.equal(pending.ok, true);
  if (pending.ok) {
    assert.equal(pending.value.attempt, 0);
    assert.equal(pending.value.tokenUsage, null);
    assert.equal(pending.value.durationMs, null);
  }
  const retryRow = mapSchedulerExecution(executionRow({ trigger: 'RETRY', status: 'PENDING', attempt: 0, retryOfExecutionId: TASK_ID_2 }));
  assert.equal(retryRow.ok, true);
});

test('mapSchedulerExecution: tokenUsage strict mapping', () => {
  assert.equal(mapSchedulerExecution(executionRow({ tokenUsage: { inputTokens: 1 } })).ok, true);
  assert.equal(mapSchedulerExecution(executionRow({ tokenUsage: { outputTokens: 2, totalTokens: 2 } })).ok, true);
  assert.equal(mapSchedulerExecution(executionRow({ tokenUsage: {} })).ok, false); // at least one field
  assert.equal(mapSchedulerExecution(executionRow({ tokenUsage: { inputTokens: -1 } })).ok, false);
  assert.equal(mapSchedulerExecution(executionRow({ tokenUsage: { inputTokens: 1.5 } })).ok, false);
  assert.equal(mapSchedulerExecution(executionRow({ tokenUsage: { inputTokens: '12' } })).ok, false);
  assert.equal(mapSchedulerExecution(executionRow({ tokenUsage: { inputTokens: 1, mystery: 2 } })).ok, false);
  assert.equal(mapSchedulerExecution(executionRow({ tokenUsage: [] })).ok, false);
  const capped = mapSchedulerExecution(executionRow({ tokenUsage: { totalTokens: 2147483647 } }));
  assert.equal(capped.ok, true);
});

test('mapSchedulerExecution: malformed rows rejected', () => {
  const rejects: Array<Record<string, unknown>> = [
    {},
    executionRow({ id: 'nope' }),
    executionRow({ taskId: 'nope' }),
    executionRow({ scheduledFor: '2026-11-23T09:30:00+02:00' }),
    executionRow({ trigger: 'CRON' }),
    executionRow({ status: 'QUEUED' }),
    executionRow({ attempt: -1 }),
    executionRow({ attempt: 1.5 }),
    executionRow({ attempt: 4 }), // > maxAttempts 3
    executionRow({ maxAttempts: 0 }),
    executionRow({ durationMs: -1 }),
    executionRow({ durationMs: 12.5 }),
    executionRow({ error: 42 }),
    executionRow({ chatId: 'unsafe id!' }),
    executionRow({ retryOfExecutionId: 'not-a-uuid' }),
    executionRow({ finishedAt: 'halfway' }),
    executionRow({ createdAt: null }),
  ];
  for (const row of rejects) {
    assert.equal(mapSchedulerExecution(row).ok, false, `accepted malformed: ${JSON.stringify(row)}`);
  }
});

test('execution list/run/mutation/retry response mappers', () => {
  assert.equal(mapSchedulerExecutionListResponse({ executions: [executionRow()] }).ok, true);
  assert.equal(mapSchedulerExecutionListResponse({ executions: [executionRow({ status: 'NOPE' })] }).ok, false);
  assert.equal(mapSchedulerExecutionListResponse({ tasks: [] }).ok, false);

  assert.equal(mapSchedulerTaskMutationResponse({ task: taskRow() }).ok, true);
  assert.equal(mapSchedulerTaskMutationResponse({ task: taskRow({ mode: '' }) }).ok, false);
  assert.equal(mapSchedulerTaskMutationResponse({}).ok, false);

  const run = mapSchedulerRunResponse({ execution: executionRow({ status: 'PENDING', attempt: 0, durationMs: null, tokenUsage: null, finishedAt: null }) });
  assert.equal(run.ok, true);

  const retry = mapSchedulerRetryResponse({ execution: executionRow({ trigger: 'RETRY', status: 'PENDING', attempt: 0, durationMs: null, tokenUsage: null, finishedAt: null }), retryOfExecutionId: TASK_ID_2 });
  assert.equal(retry.ok, true);
  assert.equal(retry.ok && retry.value.retryOfExecutionId, TASK_ID_2);
  assert.equal(mapSchedulerRetryResponse({ execution: executionRow(), retryOfExecutionId: 'nope' }).ok, false);
  assert.equal(mapSchedulerRetryResponse({ execution: executionRow() }).ok, false);
});

/* ------------------------------------------------------------------ */
/* Formatters + badges                                                  */
/* ------------------------------------------------------------------ */

test('formatRecurrenceSummary: every type summarizes in UTC', () => {
  const asTask = (recurrenceType: string, recurrenceConfig: unknown): { recurrenceType: any; recurrenceConfig: any } => ({
    recurrenceType,
    recurrenceConfig,
  });
  assert.equal(formatRecurrenceSummary(asTask('ONCE', { runAt: '2026-11-24T09:30:00.000Z' })), 'Once at 2026-11-24 09:30 UTC');
  assert.equal(formatRecurrenceSummary(asTask('DAILY', { hour: 9, minute: 30 })), 'Daily at 09:30 UTC');
  assert.equal(formatRecurrenceSummary(asTask('DAILY', { hour: 0, minute: 5 })), 'Daily at 00:05 UTC');
  assert.equal(formatRecurrenceSummary(asTask('WEEKLY', { hour: 8, minute: 15, weekdays: [1, 3, 5] })), 'Weekly at 08:15 UTC on Mon, Wed, Fri');
  assert.equal(formatRecurrenceSummary(asTask('MONTHLY', { hour: 6, minute: 0, daysOfMonth: [1, 15] })), 'Monthly at 06:00 UTC on day 1, 15');
  assert.equal(formatRecurrenceSummary(asTask('CUSTOM_CRON', { expression: '*/15 * * * *' })), 'Cron */15 * * * *');
  // Mismatched shape falls back instead of crashing.
  assert.equal(formatRecurrenceSummary(asTask('DAILY', { runAt: '2026-11-24T09:30:00.000Z' })), '(unknown schedule)');
});

test('formatters: attempt, duration, tokens, error, times, badge', () => {
  assert.equal(formatAttempt({ attempt: 0, maxAttempts: 3 }), '0/3');
  assert.equal(formatAttempt({ attempt: 3, maxAttempts: 3 }), '3/3');
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(0), '0 ms');
  assert.equal(formatDuration(1234), '1234 ms');
  assert.equal(formatTokenUsage(null), 'in — · out — · total —');
  assert.equal(formatTokenUsage({ inputTokens: 12, outputTokens: 34, totalTokens: 46 }), 'in 12 · out 34 · total 46');
  assert.equal(formatTokenUsage({ inputTokens: 12 }), 'in 12 · out — · total —');
  assert.equal(formatTokenUsage({ totalTokens: 46 }), 'in — · out — · total 46');
  assert.equal(formatExecutionError(null), '—');
  assert.equal(formatExecutionError('boom'), 'boom');
  const long = 'x'.repeat(500);
  assert.equal(formatExecutionError(long), `${'x'.repeat(280)}…`);
  assert.equal(formatScheduleTime(null), '—');
  assert.equal(formatScheduleTime('2026-11-24T09:30:00.000Z'), '2026-11-24 09:30 UTC');
  assert.equal(schedulerStatusBadge('DEAD_LETTER'), 'dead_letter');
  assert.equal(schedulerStatusBadge('RUNNING'), 'running');
});

/* ------------------------------------------------------------------ */
/* Links                                                                */
/* ------------------------------------------------------------------ */

test('executionChatLink: ALWAYS the owning task slug + explicit mode', () => {
  const general = executionChatLink({ agentSlug: 'general', mode: 'action' }, { chatId: EXEC_ID });
  assert.equal(general?.href, `/agents/general/chat/${EXEC_ID}?mode=action`);
  const orchestratorPlan = executionChatLink({ agentSlug: 'orchestrator', mode: 'plan' }, { chatId: EXEC_ID });
  assert.equal(orchestratorPlan?.href, `/agents/orchestrator/chat/${EXEC_ID}?mode=plan`);
  assert.equal(executionChatLink({ agentSlug: 'general', mode: 'action' }, { chatId: 'unsafe!' }), null);
  assert.equal(executionChatLink({ agentSlug: 'manager', mode: 'action' }, { chatId: EXEC_ID }), null);
  assert.equal(executionChatLink(null, { chatId: EXEC_ID }), null);
  assert.equal(executionChatLink(undefined, { chatId: EXEC_ID }), null);
});

test('retrySourceChatLink + canRetryExecution', () => {
  assert.equal(canRetryExecution(executionRow({ status: 'DEAD_LETTER' }) as unknown as SchedulerExecution), true);
  assert.equal(canRetryExecution(executionRow({ status: 'FAILED' }) as unknown as SchedulerExecution), false);
  assert.equal(canRetryExecution(executionRow({ status: 'COMPLETED' }) as unknown as SchedulerExecution), false);

  const link = retrySourceChatLink({ agentSlug: 'analyst', mode: 'action' }, { retryOfExecutionId: TASK_ID_2 });
  assert.equal(link?.href, `/agents/analyst/chat/${TASK_ID_2}?mode=action`);
  assert.equal(retrySourceChatLink({ agentSlug: 'analyst', mode: 'action' }, { retryOfExecutionId: 'nope' }), null);
  assert.equal(retrySourceChatLink({ agentSlug: 'analyst', mode: 'action' }, { retryOfExecutionId: null }), null);
  assert.equal(retrySourceChatLink(null, { retryOfExecutionId: TASK_ID_2 }), null);
});

/* ------------------------------------------------------------------ */
/* Poll predicate                                                       */
/* ------------------------------------------------------------------ */

test('poll predicate: PENDING/RUNNING/RETRYING settle; terminal rows never poll', () => {
  assert.equal(isSettlingExecutionStatus('PENDING'), true);
  assert.equal(isSettlingExecutionStatus('RUNNING'), true);
  assert.equal(isSettlingExecutionStatus('RETRYING'), true);
  for (const status of ['COMPLETED', 'FAILED', 'DEAD_LETTER', 'SKIPPED'] as const) {
    assert.equal(isSettlingExecutionStatus(status), false);
  }
  assert.equal(shouldPollExecutions([]), false);
  assert.equal(shouldPollExecutions([], 0), false);
  assert.equal(shouldPollExecutions([executionRow({ status: 'COMPLETED' }) as unknown as SchedulerExecution]), false);
  assert.equal(
    shouldPollExecutions([
      executionRow({ status: 'COMPLETED' }),
      executionRow({ id: TASK_ID_2, status: 'PENDING', attempt: 0, durationMs: null, tokenUsage: null, finishedAt: null }),
    ] as unknown as SchedulerExecution[]),
    true,
  );
  assert.equal(shouldPollExecutions([executionRow({ status: 'RETRYING' }) as unknown as SchedulerExecution]), true);
  // A just-submitted run keeps polling even before the list shows the row yet.
  assert.equal(shouldPollExecutions([], 2), true);
  assert.equal(shouldPollExecutions([executionRow({ status: 'COMPLETED' }) as unknown as SchedulerExecution], 1), true);
});

/* ------------------------------------------------------------------ */
/* One-call orchestration (stub fetch)                                  */
/* ------------------------------------------------------------------ */

test('fetchSchedulerTasks: ok / API error verbatim / malformed body / network', async () => {
  const ok = await fetchSchedulerTasks({ apiBaseUrl: 'http://localhost:3001', fetchImpl: okFetch({ tasks: [taskRow()] }) });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.tasks.length, 1);

  const apiError = await fetchSchedulerTasks({
    apiBaseUrl: 'http://localhost:3001',
    fetchImpl: okFetch({ error: 'Invalid scheduler request.' }, 400),
  });
  assert.equal(apiError.ok, false);
  if (!apiError.ok) assert.equal(apiError.error, 'Invalid scheduler request.');

  const malformed = await fetchSchedulerTasks({ apiBaseUrl: 'http://x', fetchImpl: okFetch({ tasks: [{}] }) });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error, SCHEDULER_MAP_ERROR);

  const network = await (async () => {
    const failing = async (): Promise<never> => {
      throw new Error('offline');
    };
    return fetchSchedulerTasks({ apiBaseUrl: 'http://x', fetchImpl: failing as never });
  })();
  assert.equal(network.ok, false);
  if (!network.ok) assert.equal(network.error, SCHEDULER_LIST_ERROR);
});

test('fetchSchedulerExecutions: filters are encoded into the real list URL', async () => {
  let requestedUrl = '';
  const stub = async (input: string): Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }> => {
    requestedUrl = input;
    return { ok: true, status: 200, json: async () => ({ executions: [] }) };
  };
  const result = await fetchSchedulerExecutions({
    apiBaseUrl: 'http://localhost:3001',
    filters: { taskId: TASK_ID, status: 'DEAD_LETTER', limit: 50 },
    fetchImpl: stub as never,
  });
  assert.equal(result.ok, true);
  assert.equal(requestedUrl, `http://localhost:3001/api/scheduler/executions?taskId=${TASK_ID}&status=DEAD_LETTER&limit=50`);
});

test('createSchedulerTask: 201 body maps; API 503 text + status propagate honestly', async () => {
  const built = buildCreateTaskBody(FULL_FORM);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const created = await createSchedulerTask({ apiBaseUrl: 'http://x', body: built.body, fetchImpl: okFetch({ task: taskRow() }, 201) });
  assert.equal(created.ok, true);

  let requestedInit: { method?: string; body?: string } | undefined;
  const capture = async (_input: string, init?: { method?: string; body?: string }): Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }> => {
    requestedInit = init;
    return { ok: false, status: 503, json: async () => ({ error: 'Scheduler queue is temporarily unavailable.' }) };
  };
  const unavailable = await createSchedulerTask({ apiBaseUrl: 'http://x', body: built.body, fetchImpl: capture });
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) {
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.error, 'Scheduler queue is temporarily unavailable.');
  }
  // The request really went through POST with a JSON body.
  assert.equal(requestedInit?.method, 'POST');
  assert.equal(typeof requestedInit?.body, 'string');

  const invalid = await createSchedulerTask({
    apiBaseUrl: 'http://x',
    body: built.body,
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({}) }),
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error, SCHEDULER_CREATE_ERROR);
});

test('updateSchedulerTask + setSchedulerTaskActive: PATCH/POST to the bound route', async () => {
  let url = '';
  let method = '';
  const stub = async (input: string, init?: { method?: string }): Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }> => {
    url = input;
    method = init?.method ?? '';
    return { ok: true, status: 200, json: async () => ({ task: taskRow() }) };
  };
  const built = buildUpdateTaskBody({ ...FULL_FORM, id: TASK_ID });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const updated = await updateSchedulerTask({ apiBaseUrl: 'http://x', taskId: TASK_ID, body: built.body, fetchImpl: stub });
  assert.equal(updated.ok, true);
  assert.equal(method, 'PATCH');
  assert.equal(url, `http://x/api/scheduler/tasks/${TASK_ID}`);

  const paused = await setSchedulerTaskActive({ apiBaseUrl: 'http://x', taskId: TASK_ID, isActive: false, fetchImpl: stub });
  assert.equal(paused.ok, true);
  assert.equal(url, `http://x/api/scheduler/tasks/${TASK_ID}/pause`);
  const activated = await setSchedulerTaskActive({ apiBaseUrl: 'http://x', taskId: TASK_ID, isActive: true, fetchImpl: stub });
  assert.equal(activated.ok, true);
  assert.equal(url, `http://x/api/scheduler/tasks/${TASK_ID}/activate`);

  const notask = await updateSchedulerTask({ apiBaseUrl: 'http://x', taskId: 'nope', body: built.body, fetchImpl: stub });
  assert.equal(notask.ok, false);
});

test('runSchedulerTaskNow: real 202 run route, never a worker-only route', async () => {
  let url = '';
  let method = '';
  const stub = async (input: string, init?: { method?: string }): Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }> => {
    url = input;
    method = init?.method ?? '';
    return {
      ok: true,
      status: 202,
      json: async () => ({ execution: executionRow({ status: 'PENDING', attempt: 0, durationMs: null, tokenUsage: null, error: null, finishedAt: null, trigger: 'MANUAL' }) }),
    };
  };
  const run = await runSchedulerTaskNow({ apiBaseUrl: 'http://x', taskId: TASK_ID, fetchImpl: stub });
  assert.equal(run.ok, true);
  if (run.ok) assert.equal(run.execution.trigger, 'MANUAL');
  assert.equal(method, 'POST');
  assert.equal(url, `http://x/api/scheduler/tasks/${TASK_ID}/run`);
  assert.notEqual(url, `http://x/api/scheduler/tasks/${TASK_ID}/run-scheduled`);

  const rejected = await runSchedulerTaskNow({
    apiBaseUrl: 'http://x',
    taskId: TASK_ID,
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ error: 'Task not found.' }) }),
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error, 'Task not found.');
});

test('retrySchedulerExecution: POSTS …/executions/:id/retry and maps the linked id', async () => {
  let url = '';
  const stub = async (input: string): Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }> => {
    url = input;
    return {
      ok: true,
      status: 202,
      json: async () => ({
        execution: executionRow({ id: TASK_ID_2, trigger: 'RETRY', status: 'PENDING', attempt: 0, durationMs: null, tokenUsage: null, error: null, finishedAt: null, retryOfExecutionId: EXEC_ID }),
        retryOfExecutionId: EXEC_ID,
      }),
    };
  };
  const retry = await retrySchedulerExecution({ apiBaseUrl: 'http://x', executionId: EXEC_ID, fetchImpl: stub });
  assert.equal(retry.ok, true);
  if (retry.ok) {
    assert.equal(retry.retryOfExecutionId, EXEC_ID);
    assert.equal(retry.execution.taskId, TASK_ID);
  }
  assert.equal(url, `http://x/api/scheduler/executions/${EXEC_ID}/retry`);
});
