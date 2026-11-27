/**
 * Phase 5 runner-level tests: claim/retry/dead-letter semantics, recovery of
 * RUNNING rows through durable hydration and resume streams (with
 * `staleRunningMs` shortened per test), token-usage metadata, `ask_user`
 * nonretryable failures, the standalone worker's REST run client contract,
 * and the BullMQ job → run-client bridge with graceful lifecycle.
 *
 * The scheduler service runs against the real in-memory core store; every
 * HTTP surface is a recorder fetch. No Redis, no Prisma, no provider.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SchedulerService,
  InMemorySchedulerStore,
  computeNextRunAt,
  type AgentTask,
  type AgentTaskExecution,
} from '@workforce/core/scheduler';
import {
  createSchedulerRunService,
  RUN_FAILED_TEXT_PENDING_QUESTION,
  RUN_FAILED_TEXT_REQUEST_INVALID,
  RUN_FAILED_TEXT_DEAD_LETTER,
  type SchedulerRunOutcome,
} from '../src/scheduler/run-service.js';
import { createSchedulerRestRunClient } from '../src/scheduler/run-client.js';
import { INTERNAL_SCHEDULER_HEADER } from '../src/agents/delegation-context.js';
import { TEST_OWNER, testInternalSigner } from './helpers.js';
import {
  createSchedulerWorker,
  processSchedulerJob,
  SCHEDULER_RUN_RETRYABLE_MESSAGE,
  schedulerRequestId,
  type SchedulerRunClient,
  type SchedulerRunExecutionInput,
  type SchedulerRunScheduledInput,
} from '@workforce/queue/scheduler';
import { withRequestLogContext } from '../src/logging.js';
import type { FetchLike } from '../src/agents/host-capabilities.js';

const silentLogger = { error: (): void => undefined, warn: (): void => undefined };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sseResponse(chunks: unknown[]): Response {
  const sse = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('');
  return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const USAGE = { inputTokens: 12, outputTokens: 7, totalTokens: 19 };

function successChunks(withUsage = true): unknown[] {
  const finish: Record<string, unknown> = { type: 'finish' };
  if (withUsage) {
    finish.messageMetadata = { usage: USAGE };
  }
  return [
    { type: 'start', messageId: 'msg-1' },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'Recovered answer text.' },
    { type: 'text-end', id: 't1' },
    finish,
  ];
}

function errorChunks(): unknown[] {
  return [
    { type: 'start', messageId: 'msg-1' },
    { type: 'error', errorText: 'An error occurred while generating the response. Please try again.' },
  ];
}

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly init: RequestInit | undefined;
}

interface RecorderFetch {
  readonly calls: RecordedCall[];
  handler: (call: RecordedCall) => Response | Promise<Response>;
  fetchFn: FetchLike;
}

function recorder(): RecorderFetch {
  const state: RecorderFetch = {
    calls: [],
    handler: () => jsonResponse(500, { error: 'unrouted call' }),
    fetchFn: async (input, init) => {
      const call: RecordedCall = { url: String(input), method: String(init?.method ?? 'GET'), init };
      state.calls.push(call);
      return await state.handler(call);
    },
  };
  return state;
}

interface Fixture {
  store: InMemorySchedulerStore;
  service: SchedulerService;
  rec: RecorderFetch;
  task: AgentTask;
  runner: ReturnType<typeof createSchedulerRunService>;
  postCount(): number;
  /** Sets a plain per-call handler. */
  route(handler: (call: RecordedCall) => Response | Promise<Response>): void;
  /** Installs the DEFAULT happy-path handler (chat + hydration + 204 resume). */
  defaultHandler(): void;
  /** Hydration body helper. */
  hydration(chatId: string, messages: unknown[], hasActiveStream: boolean): Response;
  /** When true, fake hydration reports the finished assistant (post-POST). */
  answered: boolean;
}

const TASK_PROMPT = 'Run the scheduled prompt.';

async function setupFixture(options: { staleRunningMs?: number; isActive?: boolean; skipDates?: readonly string[] } = {}): Promise<Fixture> {
  const store = new InMemorySchedulerStore();
  const service = new SchedulerService({ store });
  const rec = recorder();
  const runner = createSchedulerRunService({
    service,
    budgets: {
      fetchFn: rec.fetchFn,
      baseUrl: 'http://api-test',
      executionTimeoutMs: 5_000,
      metadataTimeoutMs: 2_000,
      staleRunningMs: options.staleRunningMs ?? 30_000,
      // Scheduler runs sign their loopback chat/hydration/resume calls with
      // the ROW-derived owner (tests use the fixed TEST owner identity).
      signer: testInternalSigner(),
      logger: silentLogger,
    },
  });
  let task = await service.createTask({
    name: 'Runner task',
    agentSlug: 'general',
    mode: 'plan',
    prompt: TASK_PROMPT,
    recurrenceType: 'DAILY',
    recurrenceConfig: { hour: 9, minute: 0 },
    ownerId: TEST_OWNER.userId,
    ...(options.skipDates !== undefined ? { skipDates: [...options.skipDates] } : {}),
  });
  if (options.isActive === false) {
    task = await service.setTaskActive({ id: task.id, isActive: false });
  }

  const hydration = (chatId: string, messages: unknown[], hasActiveStream: boolean): Response =>
    jsonResponse(200, { messages, hasActiveStream });

  const fixture: Fixture = {
    store,
    service,
    rec,
    task,
    runner,
    answered: false,
    postCount: () => rec.calls.filter((call) => call.method === 'POST').length,
    route(handler): void {
      rec.handler = handler;
    },
    defaultHandler(): void {
      rec.handler = (call) => {
        if (call.method === 'POST') {
          fixture.answered = true;
          return sseResponse(successChunks());
        }
        if (call.method === 'GET' && call.url.endsWith('/stream')) {
          return new Response(null, { status: 204 });
        }
        return hydration(
          String(chatIdOf(call.url)),
          fixture.answered
            ? [
                { id: chatIdOf(call.url), role: 'user', parts: [{ type: 'text', text: TASK_PROMPT }] },
                { id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'Recovered answer text.' }], metadata: { usage: USAGE } },
              ]
            : [{ id: chatIdOf(call.url), role: 'user', parts: [{ type: 'text', text: TASK_PROMPT }] }],
          false,
        );
      };
    },
    hydration,
  };
  return fixture;
}

function chatIdOf(url: string): string {
  const match = /\/api\/agents\/general\/chat\/([^/?]+)/.exec(url);
  return match?.[1] ?? decodeURIComponent(match?.[1] ?? url);
}

function okBodyOf(outcome: SchedulerRunOutcome): Record<string, unknown> {
  assert.equal(outcome.status, 200);
  const body = outcome.body as Record<string, unknown>;
  assert.equal(body.ok, true);
  return body;
}

function failedBodyOf(outcome: SchedulerRunOutcome): Record<string, unknown> {
  assert.equal(outcome.status, 200);
  const body = outcome.body as Record<string, unknown>;
  assert.equal(body.ok, false);
  return body;
}

/** Deterministic short delay so 1ms stale thresholds are always crossed. */
const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 5));

function isoFuture(secondsFromNow: number): string {
  return new Date(Date.now() + secondsFromNow * 1_000).toISOString();
}

/** MANUAL execution factory for runExecution tests. */
async function manualExecution(fixture: Fixture): Promise<AgentTaskExecution> {
  const created = await fixture.service.createExecution(fixture.task, {
    scheduledFor: new Date().toISOString(),
    trigger: 'MANUAL',
  });
  return created.execution;
}

// ---------------------------------------------------------------------------
// Successful runs + metadata
// ---------------------------------------------------------------------------

test('claimed execution posts the isolated chat ONCE and completes with usage', async () => {
  const fixture = await setupFixture();
  fixture.defaultHandler();
  const execution = await manualExecution(fixture);

  const outcome = await fixture.runner.runExecution({ executionId: execution.id, attempt: 1 });
  const body = okBodyOf(outcome);
  const completed = body.execution as Record<string, unknown>;
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.attempt, 1);
  assert.equal(typeof completed.durationMs, 'number');
  assert.deepEqual(completed.tokenUsage, USAGE);
  assert.equal(body.executed, true);

  // Exactly one POST: the isolated chat, with the exact wire contract.
  assert.equal(fixture.postCount(), 1);
  const post = fixture.rec.calls.find((call) => call.method === 'POST') as RecordedCall;
  assert.equal(post.url, `http://api-test/api/agents/general/chat`);
  assert.equal(post.init?.method, 'POST');
  const headers = post.init?.headers as Record<string, string>;
  assert.equal(headers['Idempotency-Key'], `${execution.id}:${execution.id}`);
  // The SIGNED internal-owner context is present and bound to the owner.
  const ownerHeaderName = Object.keys(headers).find((name) => name === 'X-Workforce-Internal-Owner') ?? '';
  assert.ok(ownerHeaderName !== '' && String(headers[ownerHeaderName]).length > 0);
  const payload = JSON.parse(String(post.init?.body)) as Record<string, unknown>;
  assert.equal(payload.id, execution.chatId);
  assert.deepEqual(payload.message, {
    id: execution.id,
    role: 'user',
    parts: [{ type: 'text', text: TASK_PROMPT }],
  });
  assert.equal(payload.mode, 'plan');
  // No delegation context header, no worker header on the chat POST.
  assert.equal(Object.keys(headers).length, 3);
});

test('tokenUsage stays null when the provider exposed no metadata', async () => {
  const fixture = await setupFixture();
  fixture.route((call) => {
    if (call.method === 'POST') {
      fixture.answered = true;
      return sseResponse(successChunks(false));
    }
    if (call.method === 'GET' && call.url.endsWith('/stream')) {
      return new Response(null, { status: 204 });
    }
    return fixture.hydration(
      chatIdOf(call.url),
      fixture.answered
        ? [
            { id: chatIdOf(call.url), role: 'user', parts: [{ type: 'text', text: TASK_PROMPT }] },
            { id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'Recovered answer text.' }] },
          ]
        : [{ id: chatIdOf(call.url), role: 'user', parts: [{ type: 'text', text: TASK_PROMPT }] }],
      false,
    );
  });
  const execution = await manualExecution(fixture);
  const outcome = await fixture.runner.runExecution({ executionId: execution.id, attempt: 1 });
  const completed = okBodyOf(outcome).execution as Record<string, unknown>;
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.tokenUsage, null); // never fabricated
});

test('runScheduled materializes, runs, and dedupes the second occurrence', async () => {
  const fixture = await setupFixture();
  fixture.defaultHandler();
  const scheduledFor = '2026-11-21T09:00:00.000Z';

  const first = await fixture.runner.runScheduled({
    taskId: fixture.task.id,
    scheduledFor,
    attempt: 1,
    queueJobId: 'job-1',
    repeatJobKey: 'rep-1',
  });
  const rowOne = okBodyOf(first).execution as Record<string, unknown>;
  assert.equal(rowOne.status, 'COMPLETED');
  assert.equal(rowOne.queueJobId, 'job-1');
  assert.equal(rowOne.repeatJobKey, 'rep-1');
  assert.equal(fixture.postCount(), 1);

  // Duplicate delivery of the SAME occurrence: same row/queue/repeat metadata,
  // already terminal → ok, no second chat.
  const second = await fixture.runner.runScheduled({
    taskId: fixture.task.id,
    scheduledFor,
    attempt: 1,
    queueJobId: 'job-1',
    repeatJobKey: 'rep-1',
  });
  const rowTwo = okBodyOf(second).execution as Record<string, unknown>;
  assert.equal(rowTwo.id, rowOne.id);
  assert.equal(rowTwo.chatId, rowOne.chatId);
  assert.equal(fixture.postCount(), 1);
});

test('paused task occurrence is SKIPPED with zero provider calls', async () => {
  const fixture = await setupFixture({ isActive: false });
  const outcome = await fixture.runner.runScheduled({
    taskId: fixture.task.id,
    scheduledFor: '2026-11-21T09:00:00.000Z',
    attempt: 1,
  });
  const body = okBodyOf(outcome);
  assert.equal(body.skipped, true);
  const row = body.execution as Record<string, unknown>;
  assert.equal(row.status, 'SKIPPED');
  assert.equal(fixture.rec.calls.length, 0); // no fetch at all
});

test('skipDates occurrence is SKIPPED; other dates run', async () => {
  const fixture = await setupFixture({ skipDates: ['2026-11-21'] });
  const skipped = await fixture.runner.runScheduled({
    taskId: fixture.task.id,
    scheduledFor: '2026-11-21T09:00:00.000Z',
    attempt: 1,
  });
  assert.equal((okBodyOf(skipped).execution as Record<string, unknown>).status, 'SKIPPED');
  assert.equal(fixture.rec.calls.length, 0);

  fixture.defaultHandler();
  const ran = await fixture.runner.runScheduled({
    taskId: fixture.task.id,
    scheduledFor: '2026-11-22T09:00:00.000Z',
    attempt: 1,
  });
  assert.equal((okBodyOf(ran).execution as Record<string, unknown>).status, 'COMPLETED');
});

test('unknown taskId reports ok with taskMissing (nothing a retry could fix)', async () => {
  const fixture = await setupFixture();
  const outcome = await fixture.runner.runScheduled({
    taskId: '00000000-0000-4000-8000-00000000dead',
    scheduledFor: '2026-11-21T09:00:00.000Z',
    attempt: 1,
  });
  const body = okBodyOf(outcome);
  assert.equal(body.taskMissing, true);
  assert.equal(false, 'execution' in body);
});

// ---------------------------------------------------------------------------
// nextRunAt metadata advancement (guarded, queue-sync-free)
// ---------------------------------------------------------------------------

test('recurring occurrence advances nextRunAt once and never overwrites on duplicates', async () => {
  const fixture = await setupFixture();
  fixture.defaultHandler();
  // The DAILY 09:00 task's own scheduled nextRunAt is the occurrence instant.
  const occurrence = fixture.task.nextRunAt as string;
  assert.ok(occurrence !== null, 'recurring task has a computed nextRunAt');

  const outcome = await fixture.runner.runScheduled({
    taskId: fixture.task.id,
    scheduledFor: occurrence,
    attempt: 1,
  });
  const row = okBodyOf(outcome).execution as Record<string, unknown>;
  assert.equal(row.status, 'COMPLETED');
  assert.equal(fixture.postCount(), 1, 'exactly one chat generation');

  // Metadata advanced from the occurrence T to computeNextRunAt(after T).
  const expected = computeNextRunAt({
    recurrenceType: 'DAILY',
    recurrenceConfig: { hour: 9, minute: 0 },
    after: new Date(occurrence),
    skipDates: [],
  });
  const task = await fixture.service.getTask(fixture.task.id) as AgentTask;
  assert.equal(task.nextRunAt, expected?.toISOString());

  // A duplicate occurrence T (redelivery AFTER advancement) does not advance
  // again and does not overwrite; the row is already terminal and answers
  // idempotently without a second generation.
  const duplicate = await fixture.runner.runScheduled({
    taskId: fixture.task.id,
    scheduledFor: occurrence,
    attempt: 1,
  });
  assert.equal(okBodyOf(duplicate).executed, false);
  const taskAfterDuplicate = await fixture.service.getTask(fixture.task.id) as AgentTask;
  assert.equal(taskAfterDuplicate.nextRunAt, expected?.toISOString());
  assert.equal(fixture.postCount(), 1);
  // The runner NEVER syncs the queue from the run path: it holds no queue
  // dependency at all (routes own syncs after CRUD writes).
});

test('ONCE occurrence nulls nextRunAt; duplicates leave it null (no dead re-add)', async () => {
  const fixture = await setupFixture();
  fixture.defaultHandler();
  const runAt = isoFuture(3600);
  const onceTask = await fixture.service.createTask({
    name: 'Once task',
    agentSlug: 'general',
    mode: 'action',
    prompt: TASK_PROMPT,
    recurrenceType: 'ONCE',
    recurrenceConfig: { runAt },
    ownerId: TEST_OWNER.userId,
  });
  assert.equal(onceTask.nextRunAt, runAt);

  const outcome = await fixture.runner.runScheduled({
    taskId: onceTask.id,
    scheduledFor: runAt,
    attempt: 1,
  });
  assert.equal((okBodyOf(outcome).execution as Record<string, unknown>).status, 'COMPLETED');
  let task = await fixture.service.getTask(onceTask.id) as AgentTask;
  assert.equal(task.nextRunAt, null, 'ONCE occurrence nulls nextRunAt');

  const duplicate = await fixture.runner.runScheduled({
    taskId: onceTask.id,
    scheduledFor: runAt,
    attempt: 1,
  });
  assert.equal(okBodyOf(duplicate).executed, false);
  task = await fixture.service.getTask(onceTask.id) as AgentTask;
  assert.equal(task.nextRunAt, null, 'duplicate leaves the cleared metadata');
  assert.equal(fixture.postCount(), 1, 'no second generation from the duplicate');
});

test('paused occurrence advances metadata; skip-dated occurrence stays SKIPPED (metadata already past it)', async () => {
  // INACTIVE: pause never recomputes nextRunAt, so a paused task's nextRunAt
  // still points AT the occurrence -> the guard passes and the metadata
  // advances (stale occurrences never linger).
  const fixture = await setupFixture({ isActive: false });
  const occurrence = fixture.task.nextRunAt as string;
  const outcome = await fixture.runner.runScheduled({
    taskId: fixture.task.id,
    scheduledFor: occurrence,
    attempt: 1,
  });
  const row = okBodyOf(outcome).execution as Record<string, unknown>;
  assert.equal(row.status, 'SKIPPED');
  const expected = computeNextRunAt({
    recurrenceType: 'DAILY',
    recurrenceConfig: { hour: 9, minute: 0 },
    after: new Date(occurrence),
    skipDates: [],
  });
  const task = await fixture.service.getTask(fixture.task.id) as AgentTask;
  assert.equal(task.nextRunAt, expected?.toISOString(), 'paused occurrence advanced metadata');
  assert.equal(fixture.rec.calls.length, 0, 'no provider call');

  // SKIP DATE: the occurrence instant was removed from the schedule at patch
  // time and nextRunAt was recomputed PAST it. When BullMQ still fires that
  // dead occurrence (the queue cannot know skipDates), it is SKIPPED
  // without a provider call, and the exact-instant guard leaves the stored
  // metadata alone — by design, because it already points at the true next
  // occurrence (a skipped instant must never be re-suggested as next).
  const skipFixture = await setupFixture();
  const deadOccurrence = skipFixture.task.nextRunAt as string;
  const deadDate = deadOccurrence.slice(0, 10);
  await skipFixture.service.updateTask({
    id: skipFixture.task.id,
    skipDates: [deadDate],
  });
  const skippedTask = await skipFixture.service.getTask(skipFixture.task.id) as AgentTask;
  assert.notEqual(skippedTask.nextRunAt, deadOccurrence, 'recompute moved metadata past the skip date');

  const skipped = await skipFixture.runner.runScheduled({
    taskId: skipFixture.task.id,
    scheduledFor: deadOccurrence,
    attempt: 1,
  });
  assert.equal((okBodyOf(skipped).execution as Record<string, unknown>).status, 'SKIPPED');
  const afterSkip = await skipFixture.service.getTask(skipFixture.task.id) as AgentTask;
  assert.equal(afterSkip.nextRunAt, skippedTask.nextRunAt, 'guard leaves the already-advanced metadata');
  assert.equal(skipFixture.rec.calls.length, 0);
});

test('runner never overwrites a diverged (human-edited) nextRunAt', async () => {
  const fixture = await setupFixture();
  fixture.defaultHandler();
  const movedTo = '2030-05-06T09:30:00.000Z';
  await fixture.service.updateTask({ id: fixture.task.id, nextRunAt: movedTo });
  const occurrence = fixture.task.nextRunAt as string; // no longer the row's instant

  const outcome = await fixture.runner.runScheduled({
    taskId: fixture.task.id,
    scheduledFor: occurrence,
    attempt: 1,
  });
  // The occurrence still runs (valid delivery; the divergence is not the
  // runner's business) but the guard leaves the human-edited value alone.
  const row = okBodyOf(outcome).execution as Record<string, unknown>;
  assert.equal(row.status, 'COMPLETED');
  const task = await fixture.service.getTask(fixture.task.id) as AgentTask;
  assert.equal(task.nextRunAt, movedTo);
});

// ---------------------------------------------------------------------------
// Retry chain: RETRYING while attempts remain, DEAD_LETTER at 3
// ---------------------------------------------------------------------------

test('error part retries: RETRYING (ok:false) then success on attempt 2', async () => {
  const fixture = await setupFixture();
  fixture.route((call) => {
    if (call.method === 'POST') {
      return sseResponse(errorChunks());
    }
    if (call.method === 'GET' && call.url.endsWith('/stream')) {
      return new Response(null, { status: 204 });
    }
    // Pre-check hydration: user-only transcript, stream not active.
    return fixture.hydration(
      chatIdOf(call.url),
      [{ id: chatIdOf(call.url), role: 'user', parts: [{ type: 'text', text: TASK_PROMPT }] }],
      false,
    );
  });
  const execution = await manualExecution(fixture);

  const first = await fixture.runner.runExecution({ executionId: execution.id, attempt: 1 });
  assert.equal(failedBodyOf(first).reason, 'retrying');
  let row = await fixture.service.getExecution(execution.id);
  assert.equal(row?.status, 'RETRYING');
  assert.equal(row?.attempt, 1);

  // Attempt 2 succeeds.
  fixture.defaultHandler();
  const second = await fixture.runner.runExecution({ executionId: execution.id, attempt: 2 });
  const completed = okBodyOf(second).execution as Record<string, unknown>;
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.attempt, 2);
  assert.equal(fixture.postCount(), 2);
  row = await fixture.service.getExecution(execution.id);
  assert.equal(row?.status, 'COMPLETED');
});

test('three failing attempts land DEAD_LETTER (ok:false, retained job)', async () => {
  const fixture = await setupFixture();
  fixture.route((call) => {
    if (call.method === 'POST') {
      return jsonResponse(500, { error: 'boom' });
    }
    if (call.method === 'GET' && call.url.endsWith('/stream')) {
      return new Response(null, { status: 204 });
    }
    return fixture.hydration(
      chatIdOf(call.url),
      [{ id: chatIdOf(call.url), role: 'user', parts: [{ type: 'text', text: TASK_PROMPT }] }],
      false,
    );
  });
  const execution = await manualExecution(fixture);

  assert.equal(failedBodyOf(await fixture.runner.runExecution({ executionId: execution.id, attempt: 1 })).reason, 'retrying');
  assert.equal(failedBodyOf(await fixture.runner.runExecution({ executionId: execution.id, attempt: 2 })).reason, 'retrying');
  const third = await fixture.runner.runExecution({ executionId: execution.id, attempt: 3 });
  assert.equal(failedBodyOf(third).reason, 'dead-letter');

  const row = await fixture.service.getExecution(execution.id);
  assert.equal(row?.status, 'DEAD_LETTER');
  assert.equal(row?.attempt, 3);
  assert.equal(row?.error, RUN_FAILED_TEXT_DEAD_LETTER);
  assert.notEqual(row?.finishedAt, null);

  // Terminal rows answer themselves idempotently (no fourth POST).
  const callsBefore = fixture.rec.calls.length;
  const rerun = await fixture.runner.runExecution({ executionId: execution.id, attempt: 4 });
  assert.deepEqual(okBodyOf(rerun).executed, false);
  assert.equal(fixture.rec.calls.length, callsBefore);
});

test('chat 400 is nonretryable FAILED (ok:true)', async () => {
  const fixture = await setupFixture();
  fixture.route((call) => {
    if (call.method === 'POST') {
      return jsonResponse(400, { error: 'Message failed validation.' });
    }
    if (call.method === 'GET' && call.url.endsWith('/stream')) {
      return new Response(null, { status: 204 });
    }
    return fixture.hydration(
      chatIdOf(call.url),
      [{ id: chatIdOf(call.url), role: 'user', parts: [{ type: 'text', text: TASK_PROMPT }] }],
      false,
    );
  });
  const execution = await manualExecution(fixture);
  const outcome = await fixture.runner.runExecution({ executionId: execution.id, attempt: 1 });
  const completed = okBodyOf(outcome).execution as Record<string, unknown>;
  assert.equal(completed.status, 'FAILED');
  assert.equal(completed.error, RUN_FAILED_TEXT_REQUEST_INVALID);
  assert.equal(fixture.postCount(), 1);
});

test('pending ask_user in an autonomous scheduled chat is FAILED (ok:true)', async () => {
  const fixture = await setupFixture();
  fixture.route((call) => {
    if (call.method === 'POST') {
      // Stream completes successfully (no error part), but the transcript
      // holds an UNANSWERED ask_user question — no human in a scheduled run.
      return sseResponse([
        { type: 'start', messageId: 'msg-1' },
        { type: 'finish' },
      ]);
    }
    if (call.method === 'GET' && call.url.endsWith('/stream')) {
      return new Response(null, { status: 204 });
    }
    return fixture.hydration(
      chatIdOf(call.url),
      [
        { id: chatIdOf(call.url), role: 'user', parts: [{ type: 'text', text: TASK_PROMPT }] },
        {
          id: 'msg-1',
          role: 'assistant',
          parts: [{ type: 'tool-ask_user', toolCallId: 'c1', state: 'input-available', input: { question: 'Which date?' } }],
        },
      ],
      false,
    );
  });
  const execution = await manualExecution(fixture);
  const outcome = await fixture.runner.runExecution({ executionId: execution.id, attempt: 1 });
  const completed = okBodyOf(outcome).execution as Record<string, unknown>;
  assert.equal(completed.status, 'FAILED');
  assert.equal(completed.error, RUN_FAILED_TEXT_PENDING_QUESTION);
  // The question remains linked in the isolated chat for human inspection.
  assert.equal(fixture.postCount(), 1);
});

// ---------------------------------------------------------------------------
// RUNNING recovery: never regenerate
// ---------------------------------------------------------------------------

test('fresh RUNNING conflict recovers a completed transcript, no new POST', async () => {
  const fixture = await setupFixture({ staleRunningMs: 60_000 }); // nothing is stale
  fixture.defaultHandler();
  fixture.answered = true; // the earlier attempt's generation finished durably
  const execution = await manualExecution(fixture);
  // Simulate a concurrent winner: atomic claim PENDING → RUNNING.
  await fixture.service.claimExecution({ id: execution.id, attempt: 1, allowedFrom: 'PENDING' });

  const outcome = await fixture.runner.runExecution({ executionId: execution.id, attempt: 1 });
  const completed = okBodyOf(outcome).execution as Record<string, unknown>;
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(fixture.postCount(), 0); // recovery NEVER regenerates
});

test('fresh RUNNING with nothing recoverable is a transient 409', async () => {
  const fixture = await setupFixture({ staleRunningMs: 60_000 });
  fixture.route((call) =>
    fixture.hydration(chatIdOf(call.url), [
      { id: chatIdOf(call.url), role: 'user', parts: [{ type: 'text', text: TASK_PROMPT }] },
    ], false),
  );
  const execution = await manualExecution(fixture);
  await fixture.service.claimExecution({ id: execution.id, attempt: 1, allowedFrom: 'PENDING' });

  const outcome = await fixture.runner.runExecution({ executionId: execution.id, attempt: 1 });
  assert.equal(outcome.status, 409);
  assert.deepEqual(outcome.body, { error: 'Scheduler conflict.' });
  assert.equal(fixture.postCount(), 0);
});

test('stale RUNNING + live stream: resume consumed, then COMPLETED from transcript', async () => {
  const fixture = await setupFixture({ staleRunningMs: 1 });
  const execution = await manualExecution(fixture);
  await fixture.service.claimExecution({ id: execution.id, attempt: 1, allowedFrom: 'PENDING' });
  let hydrationCalls = 0;
  fixture.route((call) => {
    if (call.method === 'POST') {
      assert.fail('recovery must never POST the chat again');
    }
    if (call.method === 'GET' && call.url.endsWith('/stream')) {
      return sseResponse(successChunks());
    }
    hydrationCalls += 1;
    if (hydrationCalls === 1) {
      return fixture.hydration(chatIdOf(call.url), [], true); // stream active
    }
    return fixture.hydration(
      chatIdOf(call.url),
      [
        { id: chatIdOf(call.url), role: 'user', parts: [{ type: 'text', text: TASK_PROMPT }] },
        { id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'Recovered answer text.' }], metadata: { usage: USAGE } },
      ],
      false,
    );
  });

  const outcome = await fixture.runner.runExecution({ executionId: execution.id, attempt: 1 });
  const completed = okBodyOf(outcome).execution as Record<string, unknown>;
  assert.equal(completed.status, 'COMPLETED');
  assert.deepEqual(completed.tokenUsage, USAGE);
  assert.equal(fixture.postCount(), 0);
});

test('stale RUNNING with attempts remaining lands RETRYING (ok:false)', async () => {
  const fixture = await setupFixture({ staleRunningMs: 1 });
  fixture.route((call) =>
    fixture.hydration(chatIdOf(call.url), [
      { id: chatIdOf(call.url), role: 'user', parts: [{ type: 'text', text: TASK_PROMPT }] },
    ], false),
  );
  const execution = await manualExecution(fixture);
  await fixture.service.claimExecution({ id: execution.id, attempt: 1, allowedFrom: 'PENDING' });
  await tick(); // make the RUNNING row deterministically stale

  const outcome = await fixture.runner.runExecution({ executionId: execution.id, attempt: 1 });
  assert.equal(failedBodyOf(outcome).reason, 'retrying');
  const row = await fixture.service.getExecution(execution.id);
  assert.equal(row?.status, 'RETRYING');
  // A RETRYING row only re-runs through a new claim — no POST was made here.
  assert.equal(fixture.postCount(), 0);
});

test('stale RUNNING at attempt 3 lands DEAD_LETTER (final, ok:false)', async () => {
  const fixture = await setupFixture({ staleRunningMs: 1 });
  fixture.route((call) =>
    fixture.hydration(chatIdOf(call.url), [
      { id: chatIdOf(call.url), role: 'user', parts: [{ type: 'text', text: TASK_PROMPT }] },
    ], false),
  );
  const execution = await manualExecution(fixture);
  await fixture.service.claimExecution({ id: execution.id, attempt: 1, allowedFrom: 'PENDING' });
  await fixture.service.markRetrying({ id: execution.id });
  await fixture.service.claimExecution({ id: execution.id, attempt: 2, allowedFrom: 'RETRYING' });
  await fixture.service.markRetrying({ id: execution.id });
  await fixture.service.claimExecution({ id: execution.id, attempt: 3, allowedFrom: 'RETRYING' });
  await tick(); // deterministically stale

  const outcome = await fixture.runner.runExecution({ executionId: execution.id, attempt: 3 });
  assert.equal(failedBodyOf(outcome).reason, 'dead-letter');
  const row = await fixture.service.getExecution(execution.id);
  assert.equal(row?.status, 'DEAD_LETTER');
  assert.equal(row?.error, RUN_FAILED_TEXT_DEAD_LETTER);
  assert.equal(fixture.postCount(), 0);
});

test('failed hydration during recovery reads as a transient 503 (no false recovery)', async () => {
  const fixture = await setupFixture({ staleRunningMs: 1 });
  fixture.route((call) => {
    if (call.method === 'POST') {
      assert.fail('a failed recovery read must never reach a chat POST');
    }
    return jsonResponse(503, { error: 'Chat state is temporarily unavailable.' });
  });
  const execution = await manualExecution(fixture);
  await fixture.service.claimExecution({ id: execution.id, attempt: 1, allowedFrom: 'PENDING' });

  const outcome = await fixture.runner.runExecution({ executionId: execution.id, attempt: 1 });
  assert.equal(outcome.status, 503);
  const row = await fixture.service.getExecution(execution.id);
  assert.equal(row?.status, 'RUNNING'); // untouched by a failed recovery read
  assert.equal(fixture.postCount(), 0);
});

// ---------------------------------------------------------------------------
// Standalone worker run client (REST mapping)
// ---------------------------------------------------------------------------

interface RunClientHarness {
  rec: RecorderFetch;
  client: ReturnType<typeof createSchedulerRestRunClient>;
  runCalls(): RecordedCall[];
}

function runClientFixture(
  handler: (call: RecordedCall) => Response | Promise<Response>,
  fetchFn?: FetchLike,
): RunClientHarness {
  const rec = recorder();
  rec.handler = handler;
  const client = createSchedulerRestRunClient({
    fetchFn: fetchFn ?? rec.fetchFn,
    baseUrl: 'http://api-test',
    executionTimeoutMs: 1_000,
    signer: testInternalSigner(),
  });
  return {
    rec,
    client,
    runCalls: () => rec.calls.filter((call) => call.method === 'POST'),
  };
}

test('run client posts the worker header and occurrence metadata; ok maps', async () => {
  const harness = runClientFixture(() => jsonResponse(200, { ok: true }));
  const result = await harness.client.runScheduled({
    taskId: '00000000-0000-4000-8000-00000000def0',
    scheduledFor: '2026-11-21T09:00:00.000Z',
    queueJobId: 'job-9',
    repeatJobKey: 'rep-9',
    attempt: 2,
  });
  assert.deepEqual(result, { ok: true });
  const call = harness.runCalls()[0] as RecordedCall;
  assert.equal(call.url, 'http://api-test/api/scheduler/tasks/00000000-0000-4000-8000-00000000def0/run-scheduled');
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers['X-Workforce-Scheduler-Worker'], '1');
  // The signed `internal-scheduler-run` context is bound to THIS task id.
  const signedContext = testInternalSigner().verify(String(headers[INTERNAL_SCHEDULER_HEADER]), { kind: 'internal-scheduler-run', taskId: '00000000-0000-4000-8000-00000000def0' });
  assert.equal(signedContext.ok, true);
  // ...and carries NO owner (the run route derives the owner from the row).
  assert.equal(signedContext.ok === true ? (signedContext.payload as unknown as Record<string, unknown>)['ownerId'] : 'leaked', undefined);
  const payload = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
  assert.deepEqual(payload, {
    scheduledFor: '2026-11-21T09:00:00.000Z',
    attempt: 2,
    queueJobId: 'job-9',
    repeatJobKey: 'rep-9',
  });
  assert.ok(call.init?.signal instanceof AbortSignal);
});

test('run client propagates the per-job request id; signed headers unaffected', async () => {
  const harness = runClientFixture(() => jsonResponse(200, { ok: true }));
  const taskId = '00000000-0000-4000-8000-00000000def0';
  // Host hook shape (scheduler-worker.ts): one deterministic id per job id,
  // hostile ids included; bound around the run-client call.
  const jobId = 'repeat:task-1:0';
  const requestId = schedulerRequestId(jobId);
  assert.match(requestId, /^[A-Za-z0-9._-]{1,128}$/);
  const result = await withRequestLogContext(requestId, () =>
    harness.client.runScheduled({
      taskId,
      scheduledFor: '2026-11-21T09:00:00.000Z',
      queueJobId: jobId,
      attempt: 1,
    }),
  );
  assert.deepEqual(result, { ok: true });
  const headers = (harness.runCalls()[0] as RecordedCall).init?.headers as Record<string, string>;
  assert.equal(headers['x-request-id'], requestId);
  // Signed/worker convention headers intact — correlation never weakens auth.
  assert.equal(headers['X-Workforce-Scheduler-Worker'], '1');
  const signedContext = testInternalSigner().verify(String(headers[INTERNAL_SCHEDULER_HEADER]), { kind: 'internal-scheduler-run', taskId });
  assert.equal(signedContext.ok, true);

  // Outside any job context: NO x-request-id header at all.
  const outside = await harness.client.runExecution({ executionId: '00000000-0000-4000-8000-00000000def1', attempt: 1 });
  assert.deepEqual(outside, { ok: true });
  const outsideHeaders = (harness.runCalls()[1] as RecordedCall).init?.headers as Record<string, string>;
  assert.equal('x-request-id' in outsideHeaders, false);
  assert.equal(outsideHeaders['X-Workforce-Scheduler-Worker'], '1');
});

test('run client execution mapping: path/body/attempt/queueJobId', async () => {
  const harness = runClientFixture(() => jsonResponse(200, { ok: true }));
  const result = await harness.client.runExecution({
    executionId: '00000000-0000-4000-8000-00000000def1',
    queueJobId: 'execution-1',
    attempt: 1,
  });
  assert.deepEqual(result, { ok: true });
  const call = harness.runCalls()[0] as RecordedCall;
  assert.equal(call.url, 'http://api-test/api/scheduler/executions/00000000-0000-4000-8000-00000000def1/run');
  const payload = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
  assert.deepEqual(payload, { attempt: 1, queueJobId: 'execution-1' });
});

test('run client maps ok:false, http failures, malformed and network errors', async () => {
  const retrying = runClientFixture(() => jsonResponse(200, { ok: false, reason: 'retrying' }));
  assert.deepEqual(await retrying.client.runExecution({ executionId: 'e1', attempt: 1 }), {
    ok: false,
    reason: 'retrying',
  });

  const unsafe = runClientFixture(() => jsonResponse(200, { ok: false, reason: '; DROP TABLE x' }));
  assert.deepEqual(await unsafe.client.runExecution({ executionId: 'e1', attempt: 1 }), {
    ok: false,
    reason: 'run-failed',
  });

  const http500 = runClientFixture(() => jsonResponse(503, { error: 'unavailable' }));
  assert.deepEqual(await http500.client.runExecution({ executionId: 'e1', attempt: 1 }), {
    ok: false,
    reason: 'run-http-503',
  });

  const badKey = runClientFixture(() => jsonResponse(404, { error: 'Execution not found.' }));
  assert.deepEqual(await badKey.client.runExecution({ executionId: 'e1', attempt: 1 }), {
    ok: false,
    reason: 'run-http-404',
  });

  const malformed = runClientFixture(() => jsonResponse(200, { ok: 1 }));
  assert.deepEqual(await malformed.client.runExecution({ executionId: 'e1', attempt: 1 }), {
    ok: false,
    reason: 'run-malformed',
  });

  const notJson = runClientFixture(() => new Response('<html>', { status: 200 }));
  assert.deepEqual(await notJson.client.runExecution({ executionId: 'e1', attempt: 1 }), {
    ok: false,
    reason: 'run-malformed',
  });

  const network = runClientFixture(() => jsonResponse(200, { ok: true }), async () => {
    throw new TypeError('fetch failed');
  });
  assert.deepEqual(await network.client.runExecution({ executionId: 'e1', attempt: 1 }), {
    ok: false,
    reason: 'run-unavailable',
  });
});

// ---------------------------------------------------------------------------
// BullMQ job → run-client bridge (worker owns only the queue consumption)
// ---------------------------------------------------------------------------

type AnyJob = Parameters<typeof processSchedulerJob>[0];

function fakeJob(shape: {
  data: unknown;
  id?: string;
  attemptsMade?: number;
  timestamp?: number;
  repeatJobKey?: string | null;
  opts?: unknown;
}): AnyJob {
  return shape as unknown as AnyJob;
}

test('processSchedulerJob bridges task jobs to runScheduled with BullMQ metadata', async () => {
  const calls: Array<SchedulerRunScheduledInput | SchedulerRunExecutionInput> = [];
  const client: SchedulerRunClient = {
    async runScheduled(input: SchedulerRunScheduledInput) {
      calls.push(input);
      return { ok: true };
    },
    async runExecution(): Promise<{ ok: true }> {
      throw new Error('must not run executions for task jobs');
    },
  };
  const job = fakeJob({
    data: { taskId: '00000000-0000-4000-8000-00000000def2' },
    id: '42',
    attemptsMade: 2,
    timestamp: 1_700_000_000_000,
    repeatJobKey: '00000000-0000-4000-8000-00000000def2::1700000000000',
  });
  await processSchedulerJob(job, client);
  const input = calls[0] as SchedulerRunScheduledInput;
  assert.deepEqual(input, {
    taskId: '00000000-0000-4000-8000-00000000def2',
    scheduledFor: new Date(1_700_000_000_000).toISOString(),
    queueJobId: '42',
    repeatJobKey: '00000000-0000-4000-8000-00000000def2::1700000000000',
    attempt: 3,
  });
});

test('processSchedulerJob bridges execution jobs to runExecution', async () => {
  const calls: Array<SchedulerRunExecutionInput> = [];
  const client: SchedulerRunClient = {
    async runScheduled(): Promise<{ ok: true }> {
      throw new Error('must not run scheduled for execution jobs');
    },
    async runExecution(input: SchedulerRunExecutionInput) {
      calls.push(input);
      return { ok: false, reason: 'retrying' };
    },
  };
  await assert.rejects(
    () => processSchedulerJob(fakeJob({ data: { executionId: 'x1' }, id: '9', attemptsMade: 0 }), client),
    (error: Error) => error.message === SCHEDULER_RUN_RETRYABLE_MESSAGE,
  );
  assert.deepEqual(calls[0], { executionId: 'x1', queueJobId: '9', attempt: 1 });
});

test('createSchedulerWorker via factory: processor wired + graceful bounded close', async () => {
  let processorCalls = 0;
  let schedules = 0;
  let closes = 0;
  let captured: { processor: (job: AnyJob) => Promise<void> } | null = null;
  const handle = createSchedulerWorker({
    runClient: {
      async runScheduled() {
        schedules += 1;
        return { ok: true };
      },
      async runExecution() {
        processorCalls += 1;
        return { ok: true };
      },
    },
    logger: silentLogger,
    workerFactory: (processor) => {
      captured = { processor };
      return { close: async (): Promise<void> => { closes += 1; } };
    },
  });
  assert.notEqual(captured, null);
  await (captured as unknown as { processor: (job: AnyJob) => Promise<void> }).processor(
    fakeJob({ data: { executionId: 'e2' }, id: '3', attemptsMade: 0 }),
  );
  assert.equal(processorCalls, 1);
  assert.equal(schedules, 0);
  await handle.close();
  assert.equal(closes, 1);
  await handle.close(); // idempotent + bounded
  assert.equal(closes, 2);
});
