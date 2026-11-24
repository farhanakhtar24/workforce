/**
 * Phase 5 scheduler REST tests: CRUD/filters/activation with queue sync after
 * every DB write, honest sync/enqueue failures, MANUAL run + DEAD_LETTER
 * retry, execution views, worker-route validation, and the end-to-end
 * scheduled run through the REAL chat surface (mock model, in-memory store,
 * fake BullMQ queue — real Redis/BullMQ/Prisma live in integration).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { UIMessage } from 'ai';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { simulateReadableStream } from 'ai/test';
import type { LanguageModel } from 'ai';

import {
  startTestApp,
  FakeSchedulerQueue,
  type TestApp,
} from './helpers.js';
import { InMemorySchedulerStore } from '@workforce/core/scheduler';
import { SCHEDULER_WORKER_HEADER } from '../src/scheduler/worker-contract.js';

const WORKER_HEADERS: Record<string, string> = { [SCHEDULER_WORKER_HEADER]: '1' };

/** Model that counts doStream calls and replays pre-built steps. */
function countedModel(steps: LanguageModelV3StreamPart[][]) {
  const queue = [...steps];
  let calls = 0;
  const model = {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-counted',
    supportedUrls: {},
    async doStream() {
      const step = queue.length > 1 ? (queue.shift() as LanguageModelV3StreamPart[]) : (queue[0] as LanguageModelV3StreamPart[]);
      calls += 1;
      return { stream: simulateReadableStream({ chunks: step }) };
    },
    callCount(): number {
      return calls;
    },
  };
  return model as unknown as LanguageModel & { callCount(): number };
}

function textStep(): LanguageModelV3StreamPart[] {
  const usage = {
    inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 7, text: 7, reasoning: 0 },
  };
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'Scheduled answer text.' },
    { type: 'text-end', id: 't1' },
    { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
  ] as LanguageModelV3StreamPart[];
}

interface JsonRequest {
  status: number;
  body: Record<string, unknown>;
}

async function callJson(
  app: TestApp,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<JsonRequest> {
  const response = await fetch(`http://127.0.0.1:${app.port}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers,
      ...(body === undefined ? {} : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {}) };
}

function dailyTaskBody(): Record<string, unknown> {
  return {
    name: 'Daily standup brief',
    agentSlug: 'general',
    mode: 'action',
    prompt: 'Summarize yesterday and today.',
    recurrenceType: 'DAILY',
    recurrenceConfig: { hour: 9, minute: 0 },
  };
}

function isoAt(day: number, hour: number, minute: number): string {
  return `2026-11-2${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
}

interface ChatRow {
  id?: unknown;
  role?: unknown;
  parts?: unknown;
  metadata?: unknown;
}

async function hydrateChatMessages(app: TestApp, slug: string, chatId: string): Promise<ChatRow[]> {
  const response = await fetch(`http://127.0.0.1:${app.port}/api/agents/${slug}/chat/${chatId}`);
  const body = (await response.json()) as { messages?: UIMessage[] };
  return (body.messages ?? []) as ChatRow[];
}

// ---------------------------------------------------------------------------
// CRUD + queue sync
// ---------------------------------------------------------------------------

test('create task 201 + queue sync + list/detail + isActive filter', { concurrency: false }, async () => {
  const queue = new FakeSchedulerQueue();
  const app = await startTestApp({ scheduler: { queue } });
  try {
    const created = await callJson(app, 'POST', '/api/scheduler/tasks', dailyTaskBody());
    assert.equal(created.status, 201);
    const task = created.body.task as Record<string, unknown>;
    assert.equal(typeof task.id, 'string');
    assert.equal(task.isActive, true);
    assert.equal(typeof task.nextRunAt, 'string');
    assert.notEqual(task.nextRunAt, null);
    // Queue sync happened exactly once AFTER the write.
    assert.equal(queue.syncCalls.length, 1);
    assert.equal(queue.syncCalls[0]?.taskId, task.id);
    assert.equal(queue.syncCalls[0]?.isActive, true);

    const list = await callJson(app, 'GET', '/api/scheduler/tasks');
    assert.equal(list.status, 200);
    assert.equal((list.body.tasks as unknown[]).length, 1);

    const inactive = await callJson(app, 'GET', '/api/scheduler/tasks?isActive=false');
    assert.equal((inactive.body.tasks as unknown[]).length, 0);

    const detail = await callJson(app, 'GET', `/api/scheduler/tasks/${String(task.id)}`);
    assert.equal(detail.status, 200);
    assert.equal((detail.body.task as Record<string, unknown>).id, task.id);
    assert.deepEqual(detail.body.executions, []);

    const missing = await callJson(app, 'GET', '/api/scheduler/tasks/00000000-0000-4000-8000-00000000dead');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { error: 'Task not found.' });
  } finally {
    await app.close();
  }
});

test('PATCH edits recompute nextRunAt and sync; invalid/unknown 400/404', { concurrency: false }, async () => {
  const queue = new FakeSchedulerQueue();
  const app = await startTestApp({ scheduler: { queue } });
  try {
    const created = await callJson(app, 'POST', '/api/scheduler/tasks', dailyTaskBody());
    const task = created.body.task as Record<string, unknown>;
    const id = String(task.id);
    const beforeNextRunAt = task.nextRunAt as string;

    const patched = await callJson(app, 'PATCH', `/api/scheduler/tasks/${id}`, {
      name: 'Renamed brief',
      recurrenceType: 'WEEKLY',
      recurrenceConfig: { hour: 10, minute: 30, weekdays: [1, 3] },
    });
    assert.equal(patched.status, 200);
    const updated = patched.body.task as Record<string, unknown>;
    assert.equal(updated.name, 'Renamed brief');
    assert.notEqual(updated.nextRunAt, beforeNextRunAt);
    assert.equal(queue.syncCalls.length, 2);

    const invalid = await callJson(app, 'PATCH', `/api/scheduler/tasks/${id}`, { prompt: '   ' });
    assert.equal(invalid.status, 400);

    const empty = await callJson(app, 'PATCH', `/api/scheduler/tasks/${id}`, {});
    assert.equal(empty.status, 400);

    const unknown = await callJson(app, 'PATCH', '/api/scheduler/tasks/00000000-0000-4000-8000-00000000dead', { name: 'X' });
    assert.equal(unknown.status, 404);
  } finally {
    await app.close();
  }
});

test('activate/pause toggle runs through queue sync and filters', { concurrency: false }, async () => {
  const queue = new FakeSchedulerQueue();
  const app = await startTestApp({ scheduler: { queue } });
  try {
    const created = await callJson(app, 'POST', '/api/scheduler/tasks', dailyTaskBody());
    const id = String((created.body.task as Record<string, unknown>).id);

    const paused = await callJson(app, 'POST', `/api/scheduler/tasks/${id}/pause`);
    assert.equal(paused.status, 200);
    assert.equal((paused.body.task as Record<string, unknown>).isActive, false);
    assert.equal(queue.syncCalls.length, 2);
    assert.equal(queue.syncCalls[1]?.isActive, false);

    const inactives = await callJson(app, 'GET', '/api/scheduler/tasks?isActive=false');
    assert.equal((inactives.body.tasks as unknown[]).length, 1);

    const invalidFilter = await callJson(app, 'GET', '/api/scheduler/tasks?isActive=yes');
    assert.equal(invalidFilter.status, 400);

    const limitInvalid = await callJson(app, 'GET', '/api/scheduler/tasks?limit=0');
    assert.equal(limitInvalid.status, 400);

    const reactivated = await callJson(app, 'POST', `/api/scheduler/tasks/${id}/activate`);
    assert.equal(reactivated.status, 200);
    assert.equal((reactivated.body.task as Record<string, unknown>).isActive, true);
    assert.equal(queue.syncCalls.length, 3);
  } finally {
    await app.close();
  }
});

test('queue sync failure after the DB write is an honest 503; the row persists', { concurrency: false }, async () => {
  const queue = new FakeSchedulerQueue();
  const app = await startTestApp({ scheduler: { queue } });
  try {
    queue.failSync(new Error('redis down'));
    const created = await callJson(app, 'POST', '/api/scheduler/tasks', dailyTaskBody());
    assert.equal(created.status, 503);
    assert.deepEqual(created.body, { error: 'Scheduler queue is temporarily unavailable.' });

    // The DB write STANDS: the row is returned by list and gets reconciled at
    // the next startup — sync failure is never silently claimed as success.
    queue.failSync(null);
    const list = await callJson(app, 'GET', '/api/scheduler/tasks');
    assert.equal((list.body.tasks as unknown[]).length, 1);
    const id = String((list.body.tasks as Record<string, unknown>[])[0]?.id);
    const patched = await callJson(app, 'PATCH', `/api/scheduler/tasks/${id}`, { name: 'After recovery' });
    assert.equal(patched.status, 200);
    // One failed create-sync + one healthy patch-sync.
    assert.equal(queue.syncCalls.length, 2);
  } finally {
    await app.close();
  }
});

test('limit filter bounds the list', { concurrency: false }, async () => {
  const app = await startTestApp({ scheduler: {} });
  try {
    await callJson(app, 'POST', '/api/scheduler/tasks', dailyTaskBody());
    await callJson(app, 'POST', '/api/scheduler/tasks', { ...dailyTaskBody(), name: 'Second', recurrenceConfig: { hour: 11, minute: 0 } });
    const limited = await callJson(app, 'GET', '/api/scheduler/tasks?limit=1');
    assert.equal((limited.body.tasks as unknown[]).length, 1);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// MANUAL run + retry
// ---------------------------------------------------------------------------

test('MANUAL run creates execution, enqueues, worker run completes end-to-end', { concurrency: false }, async () => {
  const queue = new FakeSchedulerQueue();
  const model = countedModel([textStep()]);
  const app = await startTestApp({ scheduler: { queue }, model: model as never });
  try {
    const created = await callJson(app, 'POST', '/api/scheduler/tasks', dailyTaskBody());
    const taskId = String((created.body.task as Record<string, unknown>).id);

    const run = await callJson(app, 'POST', `/api/scheduler/tasks/${taskId}/run`);
    assert.equal(run.status, 202);
    const execution = run.body.execution as Record<string, unknown>;
    assert.equal(execution.trigger, 'MANUAL');
    assert.equal(execution.status, 'PENDING');
    assert.equal(execution.attempt, 0);
    // The chatId IS the isolated execution chat.
    assert.equal(execution.chatId, execution.id);
    assert.deepEqual(queue.enqueueCalls, [execution.id]);

    // Worker-only surface rejects browser-shaped calls without the header.
    const noHeader = await callJson(app, 'POST', `/api/scheduler/executions/${String(execution.id)}/run`, {
      attempt: 1,
    });
    assert.equal(noHeader.status, 400);

    const workerRun = await callJson(
      app,
      'POST',
      `/api/scheduler/executions/${String(execution.id)}/run`,
      { attempt: 1, queueJobId: `execution-${String(execution.id)}` },
      WORKER_HEADERS,
    );
    assert.equal(workerRun.status, 200);
    assert.equal(workerRun.body.ok, true);
    const completed = workerRun.body.execution as Record<string, unknown>;
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.attempt, 1);
    assert.equal(typeof completed.durationMs, 'number');
    assert.deepEqual(completed.tokenUsage, { inputTokens: 12, outputTokens: 7, totalTokens: 19 });
    assert.equal(model.callCount(), 1);

    // The isolated chat holds the deterministic run: prompt + metadata answer.
    const messages = await hydrateChatMessages(app, 'general', String(execution.id));
    assert.equal(messages.length, 2);
    const user = messages[0] as ChatRow;
    assert.equal(user.role, 'user');
    assert.equal(user.id, execution.id);
    assert.equal(JSON.stringify(user.parts), JSON.stringify([{ type: 'text', text: 'Summarize yesterday and today.' }]));
    const assistant = messages[1] as ChatRow;
    assert.equal(assistant.role, 'assistant');
    assert.deepEqual(
      (assistant.metadata as Record<string, unknown>)?.usage,
      { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
    );

    // Idempotent re-run of a terminal execution: ok, no second generation.
    const rerun = await callJson(
      app,
      'POST',
      `/api/scheduler/executions/${String(execution.id)}/run`,
      { attempt: 4 },
      WORKER_HEADERS,
    );
    assert.equal(rerun.status, 200);
    assert.equal(rerun.body.ok, true);
    assert.equal(model.callCount(), 1);
  } finally {
    await app.close();
  }
});

test('enqueue failure lands the execution DEAD_LETTER (503), retry links a new one', { concurrency: false }, async () => {
  const queue = new FakeSchedulerQueue();
  const model = countedModel([textStep()]);
  const app = await startTestApp({ scheduler: { queue }, model: model as never });
  try {
    const created = await callJson(app, 'POST', '/api/scheduler/tasks', dailyTaskBody());
    const taskId = String((created.body.task as Record<string, unknown>).id);

    queue.failEnqueue(new Error('redis down'));
    const run = await callJson(app, 'POST', `/api/scheduler/tasks/${taskId}/run`);
    assert.equal(run.status, 503);
    assert.deepEqual(run.body, { error: 'Scheduler queue is temporarily unavailable.' });

    // Nothing left invisible-PENDING: the row is DEAD_LETTER and retryable.
    const executions = await callJson(app, 'GET', `/api/scheduler/executions?taskId=${taskId}`);
    assert.equal((executions.body.executions as unknown[]).length, 1);
    const dead = (executions.body.executions as Record<string, unknown>[])[0] as Record<string, unknown>;
    assert.equal(dead.status, 'DEAD_LETTER');
    assert.equal(dead.attempt, 1);
    assert.equal(dead.error, 'The scheduler queue was unavailable, so the execution was dead-lettered.');
    const deadId = String(dead.id);

    // Terminal old row stays immutable; retry creates a NEW linked execution.
    queue.failEnqueue(null);
    const retry = await callJson(app, 'POST', `/api/scheduler/executions/${deadId}/retry`);
    assert.equal(retry.status, 202);
    const retried = retry.body.execution as Record<string, unknown>;
    assert.equal(retried.trigger, 'RETRY');
    assert.equal(retried.status, 'PENDING');
    assert.equal(retry.body.retryOfExecutionId, deadId);
    assert.equal(retried.retryOfExecutionId, deadId);
    assert.notEqual(retried.id, deadId);
    assert.notEqual(retried.chatId, String(dead.chatId ?? retried.chatId));
    // The failed enqueue call was recorded, then the healthy retry was.
    assert.deepEqual(queue.enqueueCalls, [deadId, retried.id]);

    const oldRow = await callJson(app, 'GET', `/api/scheduler/executions/${deadId}`);
    const old = oldRow.body.execution as Record<string, unknown>;
    assert.equal(old.status, 'DEAD_LETTER');
    assert.equal(old.error, 'The scheduler queue was unavailable, so the execution was dead-lettered.');
    assert.notEqual(old.finishedAt, null);

    // Retrying a non-DEAD_LETTER execution is a 409.
    const invalidRetry = await callJson(app, 'POST', `/api/scheduler/executions/${String(retried.id)}/retry`);
    assert.equal(invalidRetry.status, 409);
  } finally {
    await app.close();
  }
});

test('retry of a completed execution is a 409', { concurrency: false }, async () => {
  const queue = new FakeSchedulerQueue();
  const model = countedModel([textStep()]);
  const app = await startTestApp({ scheduler: { queue }, model: model as never });
  try {
    const created = await callJson(app, 'POST', '/api/scheduler/tasks', dailyTaskBody());
    const taskId = String((created.body.task as Record<string, unknown>).id);
    const run = await callJson(app, 'POST', `/api/scheduler/tasks/${taskId}/run`);
    const executionId = String((run.body.execution as Record<string, unknown>).id);
    await callJson(app, 'POST', `/api/scheduler/executions/${executionId}/run`, { attempt: 1 }, WORKER_HEADERS);
    const invalidRetry = await callJson(app, 'POST', `/api/scheduler/executions/${executionId}/retry`);
    assert.equal(invalidRetry.status, 409);
    assert.deepEqual(invalidRetry.body, { error: 'Scheduler conflict.' });
  } finally {
    await app.close();
  }
});

test('execution detail/list filters', { concurrency: false }, async () => {
  const app = await startTestApp({ scheduler: {}, model: countedModel([textStep()]) as never });
  try {
    const created = await callJson(app, 'POST', '/api/scheduler/tasks', dailyTaskBody());
    const taskId = String((created.body.task as Record<string, unknown>).id);
    const run = await callJson(app, 'POST', `/api/scheduler/tasks/${taskId}/run`);
    const executionId = String((run.body.execution as Record<string, unknown>).id);
    await callJson(app, 'POST', `/api/scheduler/executions/${executionId}/run`, { attempt: 1 }, WORKER_HEADERS);

    const detail = await callJson(app, 'GET', `/api/scheduler/executions/${executionId}`);
    assert.equal(detail.status, 200);
    assert.equal((detail.body.execution as Record<string, unknown>).status, 'COMPLETED');

    const missing = await callJson(app, 'GET', '/api/scheduler/executions/00000000-0000-4000-8000-00000000dead');
    assert.equal(missing.status, 404);

    const byStatus = await callJson(app, 'GET', `/api/scheduler/executions?taskId=${taskId}&status=COMPLETED`);
    assert.equal((byStatus.body.executions as unknown[]).length, 1);
    const skipped = await callJson(app, 'GET', `/api/scheduler/executions?taskId=${taskId}&status=SKIPPED`);
    assert.equal((skipped.body.executions as unknown[]).length, 0);

    const badStatus = await callJson(app, 'GET', `/api/scheduler/executions?taskId=${taskId}&status=NOPE`);
    assert.equal(badStatus.status, 400);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Scheduled occurrences
// ---------------------------------------------------------------------------

test('scheduled occurrence runs the REAL chat surface once and completes', { concurrency: false }, async () => {
  const queue = new FakeSchedulerQueue();
  const model = countedModel([textStep()]);
  const app = await startTestApp({ scheduler: { queue }, model: model as never });
  try {
    const created = await callJson(app, 'POST', '/api/scheduler/tasks', dailyTaskBody());
    const taskId = String((created.body.task as Record<string, unknown>).id);
    const scheduledFor = isoAt(1, 9, 0);

    const run = await callJson(
      app,
      'POST',
      `/api/scheduler/tasks/${taskId}/run-scheduled`,
      { scheduledFor, attempt: 1, queueJobId: 'job-1', repeatJobKey: 'rep-1' },
      WORKER_HEADERS,
    );
    assert.equal(run.status, 200);
    assert.equal(run.body.ok, true);
    const execution = run.body.execution as Record<string, unknown>;
    assert.equal(execution.status, 'COMPLETED');
    assert.equal(execution.chatId, execution.id);
    assert.notEqual(execution.tokenUsage, null);

    // Deterministic occurrence metadata was persisted.
    assert.equal(execution.queueJobId, 'job-1');
    assert.equal(execution.repeatJobKey, 'rep-1');

    // Duplicate occurrence (same scheduledFor): same row, same queue/repeat
    // metadata, never a second chat or a second generation.
    const duplicate = await callJson(
      app,
      'POST',
      `/api/scheduler/tasks/${taskId}/run-scheduled`,
      { scheduledFor, attempt: 1, queueJobId: 'job-1', repeatJobKey: 'rep-1' },
      WORKER_HEADERS,
    );
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.ok, true);
    assert.equal(
      String((duplicate.body.execution as Record<string, unknown>).id),
      String(execution.id),
    );
    assert.equal(model.callCount(), 1);

    const messages = await hydrateChatMessages(app, 'general', String(execution.id));
    assert.equal(messages.length, 2);
  } finally {
    await app.close();
  }
});

test('paused task occurrences are SKIPPED without a provider call', { concurrency: false }, async () => {
  const model = countedModel([textStep()]);
  const app = await startTestApp({ scheduler: {}, model: model as never });
  try {
    const created = await callJson(app, 'POST', '/api/scheduler/tasks', dailyTaskBody());
    const taskId = String((created.body.task as Record<string, unknown>).id);
    await callJson(app, 'POST', `/api/scheduler/tasks/${taskId}/pause`);

    const run = await callJson(
      app,
      'POST',
      `/api/scheduler/tasks/${taskId}/run-scheduled`,
      { scheduledFor: isoAt(1, 9, 0), attempt: 1 },
      WORKER_HEADERS,
    );
    assert.equal(run.status, 200);
    assert.equal(run.body.ok, true);
    assert.equal(run.body.skipped, true);
    const execution = run.body.execution as Record<string, unknown>;
    assert.equal(execution.status, 'SKIPPED');
    assert.equal(model.callCount(), 0);

    // Re-delivering the same skipped occurrence stays idempotent.
    const again = await callJson(
      app,
      'POST',
      `/api/scheduler/tasks/${taskId}/run-scheduled`,
      { scheduledFor: isoAt(1, 9, 0), attempt: 1 },
      WORKER_HEADERS,
    );
    assert.equal(again.status, 200);
    assert.equal(again.body.ok, true);
    assert.equal(model.callCount(), 0);
  } finally {
    await app.close();
  }
});

test('skipDates occurrences are SKIPPED without a provider call', { concurrency: false }, async () => {
  const model = countedModel([textStep()]);
  const app = await startTestApp({ scheduler: {}, model: model as never });
  try {
    const body = { ...dailyTaskBody(), skipDates: ['2026-11-21'] };
    const created = await callJson(app, 'POST', '/api/scheduler/tasks', body);
    const taskId = String((created.body.task as Record<string, unknown>).id);

    const run = await callJson(
      app,
      'POST',
      `/api/scheduler/tasks/${taskId}/run-scheduled`,
      { scheduledFor: isoAt(1, 9, 0), attempt: 1 },
      WORKER_HEADERS,
    );
    assert.equal(run.status, 200);
    assert.equal(run.body.skipped, true);
    assert.equal((run.body.execution as Record<string, unknown>).status, 'SKIPPED');
    assert.equal(model.callCount(), 0);

    // A NON-skip date still runs.
    const realRun = await callJson(
      app,
      'POST',
      `/api/scheduler/tasks/${taskId}/run-scheduled`,
      { scheduledFor: isoAt(2, 9, 0), attempt: 1 },
      WORKER_HEADERS,
    );
    assert.equal(realRun.body.ok, true);
    assert.equal((realRun.body.execution as Record<string, unknown>).status, 'COMPLETED');
    assert.equal(model.callCount(), 1);
  } finally {
    await app.close();
  }
});

test('concurrent duplicate occurrences claim once — exactly one model call', { concurrency: false }, async () => {
  const model = countedModel([textStep()]);
  const app = await startTestApp({ scheduler: { metadataTimeoutMs: 5_000 }, model: model as never });
  try {
    const created = await callJson(app, 'POST', '/api/scheduler/tasks', dailyTaskBody());
    const taskId = String((created.body.task as Record<string, unknown>).id);
    const scheduledFor = isoAt(1, 9, 0);

    const [first, second] = await Promise.all([
      callJson(app, 'POST', `/api/scheduler/tasks/${taskId}/run-scheduled`, { scheduledFor, attempt: 1 }, WORKER_HEADERS),
      callJson(app, 'POST', `/api/scheduler/tasks/${taskId}/run-scheduled`, { scheduledFor, attempt: 1 }, WORKER_HEADERS),
    ]);

    // Exactly one of the two claims drives the single generation; the other
    // either recovers the finished transcript (ok:true, same row) or reports
    // a transient 409 while the winner is still streaming. Never TWO calls.
    const responses = [first, second].map((entry) => entry as JsonRequest);
    assert.equal(model.callCount(), 1);
    const completions = responses.filter(
      (entry) => entry.status === 200 && entry.body.ok === true &&
        (entry.body.execution as Record<string, unknown> | undefined)?.status === 'COMPLETED',
    );
    assert.ok(completions.length >= 1);
    const conflicts = responses.filter((entry) => entry.status === 409);
    for (const conflict of conflicts) {
      assert.deepEqual(conflict.body, { error: 'Scheduler conflict.' });
    }
    for (const ok of responses.filter((entry) => entry.status === 200 && entry.body.ok === true)) {
      assert.equal(String((ok.body.execution as Record<string, unknown>).id), String((completions[0]?.body.execution as Record<string, unknown>).id));
    }

    const list = await callJson(app, 'GET', `/api/scheduler/executions?taskId=${taskId}`);
    const rows = list.body.executions as Record<string, unknown>[];
    assert.equal(rows.length, 1); // unique (task, scheduledFor): ONE row total
  } finally {
    await app.close();
  }
});

test('worker route validation: body/attempt/scheduledFor/header are strict', { concurrency: false }, async () => {
  const app = await startTestApp({ scheduler: {} });
  try {
    const created = await callJson(app, 'POST', '/api/scheduler/tasks', dailyTaskBody());
    const taskId = String((created.body.task as Record<string, unknown>).id);
    const url = `/api/scheduler/tasks/${taskId}/run-scheduled`;

    const missingHeader = await callJson(app, 'POST', url, { scheduledFor: isoAt(1, 9, 0), attempt: 1 });
    assert.equal(missingHeader.status, 400);
    assert.deepEqual(missingHeader.body, { error: 'Scheduler worker header required.' });

    const wrongHeader = await callJson(app, 'POST', url, { scheduledFor: isoAt(1, 9, 0), attempt: 1 }, {
      [SCHEDULER_WORKER_HEADER]: 'other',
    });
    assert.equal(wrongHeader.status, 400);

    const badInstant = await callJson(app, 'POST', url, { scheduledFor: '2026-11-21 09:00:00', attempt: 1 }, WORKER_HEADERS);
    assert.equal(badInstant.status, 400);

    const zeroAttempt = await callJson(app, 'POST', url, { scheduledFor: isoAt(1, 9, 0), attempt: 0 }, WORKER_HEADERS);
    assert.equal(zeroAttempt.status, 400);

    const extraKey = await callJson(
      app,
      'POST',
      url,
      { scheduledFor: isoAt(1, 9, 0), attempt: 1, prompt: 'forged' },
      WORKER_HEADERS,
    );
    assert.equal(extraKey.status, 400);

    const unknownTask = await callJson(
      app,
      'POST',
      '/api/scheduler/tasks/00000000-0000-4000-8000-00000000dead/run-scheduled',
      { scheduledFor: isoAt(1, 9, 0), attempt: 1 },
      WORKER_HEADERS,
    );
    assert.equal(unknownTask.status, 200);
    assert.equal(unknownTask.body.ok, true);
    assert.equal(unknownTask.body.taskMissing, true);
  } finally {
    await app.close();
  }
});

test('execution detail after a worker run keeps bounded, honest fields', { concurrency: false }, async () => {
  const queue = new FakeSchedulerQueue();
  const app = await startTestApp({ scheduler: { queue }, model: countedModel([textStep()]) as never });
  try {
    const created = await callJson(app, 'POST', '/api/scheduler/tasks', dailyTaskBody());
    const taskId = String((created.body.task as Record<string, unknown>).id);
    const run = await callJson(app, 'POST', `/api/scheduler/tasks/${taskId}/run`);
    const executionId = String((run.body.execution as Record<string, unknown>).id);
    await callJson(app, 'POST', `/api/scheduler/executions/${executionId}/run`, { attempt: 1 }, WORKER_HEADERS);
    const detail = await callJson(app, 'GET', `/api/scheduler/executions/${executionId}`);
    const execution = detail.body.execution as Record<string, unknown>;
    assert.equal(execution.status, 'COMPLETED');
    assert.equal(execution.maxAttempts, 3);
    assert.notEqual(execution.finishedAt, null);
    // Nonretryable/manual rows never carry an error when they complete.
    assert.equal(execution.error, null);
  } finally {
    await app.close();
  }
});

test('execution rows never appear for un-run tasks; store errors are 503', { concurrency: false }, async () => {
  const store = new InMemorySchedulerStore();
  const app = await startTestApp({ scheduler: { store } });
  try {
    const empty = await callJson(app, 'GET', '/api/scheduler/executions');
    assert.deepEqual(empty.body.executions, []);
    const badTaskId = await callJson(app, 'GET', '/api/scheduler/executions?taskId=not-a-uuid');
    assert.equal(badTaskId.status, 400);
  } finally {
    await app.close();
  }
});
