/**
 * REAL Phase 5 scheduler integration tests (no mocks at the seams):
 * - real Express app with the Prisma scheduler store/service + the real
 *   BullMQSchedulerQueue on a RUN-SCOPED queue name + real chat Redis store
 *   + real resumable-stream adapter,
 * - real scheduler Worker + REST run client (in-process here, SPAWNED child
 *   for the kill/recovery test) driving the API's OWN REST run routes,
 * - real `POST /api/agents/:slug/chat` generation with a scripted
 *   MockLanguageModelV3-shaped model — never a real provider/key.
 *
 * Hygiene (mirrors phase4.test.ts):
 * - NO .env reads: every stack uses a FIXED loadApiConfig({...}) object; the
 *   spawned worker child receives every decision variable explicitly and a
 *   dummy OLLAMA_API_KEY that beats any env file (Node no-override, see
 *   src/env.ts), so it neither reads nor uses any real key from this checkout.
 * - run-scoped cleanup only: Postgres tasks (executions cascade via schema'),
 *   Redis chat message/active-stream keys by exact layout, idempotency keys
 *   by chat-scoped SCAN, resumable-stream keys by run-unique prefix SCAN, and
 *   `obliterate({ force: true })` on the run-scoped queue AFTER worker close.
 *   No FLUSH, no unrelated processes touched.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { Queue } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import { PrismaClient } from '@workforce/core/generated/prisma';
import { createClient, type RedisClientType } from 'redis';
import { simulateReadableStream } from 'ai/test';
import type { LanguageModel, UIMessage } from 'ai';
import { createDelegationContextSigner } from '../src/agents/delegation-context.js';
import { TEST_DELEGATION_SECRET } from '../test/helpers.js';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';

import {
  computeNextRunAt,
  cronExpressionForRecurrence,
  SchedulerService,
  SchedulerConflictError,
  type AgentTask,
  type SchedulerStore,
} from '@workforce/core/scheduler';
import { createPrismaSchedulerStore } from '@workforce/core/scheduler/postgres';
import { BullMQSchedulerQueue, createSchedulerWorker, type SchedulerWorkerHandle } from '@workforce/queue/scheduler';
import { createSchedulerRestRunClient } from '../src/scheduler/run-client.js';
import { SCHEDULER_WORKER_HEADER } from '../src/scheduler/worker-contract.js';
import { INTERNAL_SCHEDULER_HEADER, contextWindow } from '../src/agents/delegation-context.js';
import { createBackgroundTracker } from '../src/background.js';
import { DEFAULT_DATABASE_URL, loadApiConfig, type ApiConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createRedisChatStore, REDIS_KEY_PREFIX } from '../src/store/redis.js';
import { createResumableStreamAdapter } from '../src/stream-context/resumable.js';
import type { HostCapabilityDeps } from '../src/agents/host-capabilities.js';

// -- Fixed test configuration (no .env, no real provider) ----------------------

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
const DATABASE_URL = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
const RUN_ID = `${process.pid.toString(36)}-${Date.now().toString(36)}`;
const TASK_PREFIX = `itest-${RUN_ID}-`;
/** The test-only owner identity: every scheduler row + the User row (FK). */
const LIVE_OWNER_ID = `live-owner-${RUN_ID}`;
const LIVE_OWNER_EMAIL = 'live-owner@example.com';
const STREAM_KEY_PREFIX = `workforce:phase5:stream-live:${RUN_ID}`;
const CONNECT_TIMEOUT_MS = 5_000;
const USAGE_EXPECTED = { inputTokens: 12, outputTokens: 7, totalTokens: 19 };

const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });

async function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${String(timeoutMs)}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } catch (error) {
    void error; // teardown failures must never hang the suite
    return undefined;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

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
      throw new Error(`${message} (waited ${String(Date.now() - started)}ms)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// -- Scripted model --------------------------------------------------------------

function textStep(delta = 'Scheduled integration answer.'): LanguageModelV3StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta },
    { type: 'text-end', id: 't1' },
    { type: 'finish', usage: { inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 7, text: 7, reasoning: 0 } }, finishReason: { unified: 'stop', raw: undefined } },
  ] as unknown as LanguageModelV3StreamPart[];
}

function slowTextStep(): LanguageModelV3StreamPart[] {
  const deltas = Array.from({ length: 14 }, (_, index) => ({
    type: 'text-delta', id: 't1', delta: `chunk-${String(index)} `,
  })) as LanguageModelV3StreamPart[];
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    ...deltas,
    { type: 'text-end', id: 't1' },
    { type: 'finish', usage: { inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 7, text: 7, reasoning: 0 } }, finishReason: { unified: 'stop', raw: undefined } },
  ] as unknown as LanguageModelV3StreamPart[];
}

interface ScriptedModel {
  languageModel: LanguageModel;
  callCount(): number;
  /** `fail` throws inside doStream (retryable provider failure); a stream otherwise. */
  enqueue(step: LanguageModelV3StreamPart[] | 'fail'): void;
}

function scriptedModel(options: { chunkDelayMs?: number } = {}): ScriptedModel {
  const queue: Array<LanguageModelV3StreamPart[] | 'fail'> = [];
  let calls = 0;
  const chunkDelayMs = options.chunkDelayMs ?? 0;
  const model = {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-scheduler-live',
    supportedUrls: {},
    async doStream() {
      const step = queue.shift();
      calls += 1;
      if (step === undefined || step === 'fail') {
        // Retryable provider failure (the runner maps it like a stream error).
        throw new Error('provider unavailable (unscripted call)');
      }
      return { stream: simulateReadableStream({ chunks: step, initialDelayInMs: 0, chunkDelayInMs: chunkDelayMs }) };
    },
    callCount(): number {
      return calls;
    },
    enqueue(step: LanguageModelV3StreamPart[] | 'fail'): void {
      queue.push(step);
    },
  };
  return {
    languageModel: model as unknown as LanguageModel,
    callCount: model.callCount.bind(model),
    enqueue: model.enqueue,
  } satisfies ScriptedModel;
}

// -- Stack (real app + real queue + real worker) ---------------------------------

interface StackOptions {
  label: string;
  model: LanguageModel;
  /** Real worker on the run-scoped queue (default true). */
  worker?: boolean;
  executionTimeoutMs?: number;
  /** Bounded budget for hydration/resume metadata calls (default 5_000). */
  metadataTimeoutMs?: number;
}

interface Stack {
  label: string;
  queueName: string;
  service: SchedulerService;
  queue: BullMQSchedulerQueue;
  port: number;
  close(): Promise<void>;
}

async function createSchedulerStack(options: StackOptions): Promise<Stack> {
  const label = options.label;
  const queueName = `workforce-scheduler-itest-${RUN_ID}-${label}`;
  let livePort = 0;
  const INTERNAL_ORIGIN = `http://sched-itest-${RUN_ID}-${label}`;

  const liveClient = (): RedisClientType =>
    createClient({
      url: REDIS_URL,
      socket: { reconnectStrategy: false, connectTimeout: CONNECT_TIMEOUT_MS },
    });
  const base = liveClient();
  const publisher = liveClient();
  const subscriber = liveClient();
  for (const client of [base, publisher, subscriber]) {
    client.on('error', () => undefined);
  }
  await Promise.all([base.connect(), publisher.connect(), subscriber.connect()]);

  const background = createBackgroundTracker({ onError: () => undefined });
  const redisChatStore = createRedisChatStore(base as unknown as Parameters<typeof createRedisChatStore>[0]);
  const streamContext = createResumableStreamAdapter({
    waitUntil: background.track,
    publisher,
    subscriber,
    keyPrefix: STREAM_KEY_PREFIX,
  });

  const agentFetchFn: HostCapabilityDeps['fetchFn'] = (input, init) => {
    const rewritten = typeof input === 'string' ? input.replace(INTERNAL_ORIGIN, `http://127.0.0.1:${livePort}`) : input;
    return fetch(rewritten, init);
  };

  const schedulerStore: SchedulerStore = createPrismaSchedulerStore(prisma);
  const service = new SchedulerService({ store: schedulerStore });
  const queue = new BullMQSchedulerQueue({
    redisUrl: REDIS_URL,
    queueName,
    logger: { warn: () => undefined, error: () => undefined },
    reconnectStrategy: () => null,
    closeTimeoutMs: 3_000,
  });

  const config: ApiConfig = loadApiConfig({
    OLLAMA_API_KEY: 'test-only-not-a-real-key',
    OLLAMA_BASE_URL: 'https://ollama.invalid/v1',
    OLLAMA_MODEL: 'mock-scheduler-live',
    REDIS_URL,
    DATABASE_URL,
    PORT: '29991',
    INTERNAL_API_BASE_URL: INTERNAL_ORIGIN,
  });

  const executionTimeoutMs = options.executionTimeoutMs ?? 20_000;
  const debugLogs = process.env['WF_SCHED_DEBUG'] === '1';
  const silentLogger = debugLogs
    ? { error: (context: string, error: unknown): void => console.error('STACK-ERR', context, error), warn: (context: string): void => console.warn('STACK-WARN', context) }
    : { error: (): void => undefined, warn: (): void => undefined };
  const app = buildApp({
    config,
    store: redisChatStore,
    streamContext,
    model: options.model,
    background,
    auth: { staticOwner: { userId: LIVE_OWNER_ID, email: LIVE_OWNER_EMAIL, emailVerified: true } },
    scheduler: {
      service,
      queue,
      run: {
        fetchFn: agentFetchFn,
        baseUrl: INTERNAL_ORIGIN,
        executionTimeoutMs,
        metadataTimeoutMs: options.metadataTimeoutMs ?? 5_000,
        staleRunningMs: 30_000,
        // The API verifies the worker's signed run contexts with the SAME
        // secret (and signs internal chat calls with row-derived owners).
        signer: createDelegationContextSigner(Buffer.from(TEST_DELEGATION_SECRET, 'utf8')),
        logger: silentLogger,
      },
      logger: silentLogger,
    },
  });
  const server: Server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', 'ephemeral test port');
  livePort = address.port;

  let workerHandle: SchedulerWorkerHandle | null = null;
  if (options.worker !== false) {
    workerHandle = createSchedulerWorker({
      runClient: createSchedulerRestRunClient({
        fetchFn: agentFetchFn,
        baseUrl: INTERNAL_ORIGIN,
        executionTimeoutMs,
        // The live worker signs its run contexts with the SAME fixed test
        // secret the API-side signer uses (internal-trust contract).
        signer: createDelegationContextSigner(Buffer.from(TEST_DELEGATION_SECRET, 'utf8')),
      }),
      redisUrl: REDIS_URL,
      queueName,
      logger: silentLogger,
      reconnectStrategy: () => null,
      closeTimeoutMs: 3_000,
    });
  }

  const trackedTaskIds: string[] = [];

  const close = async (): Promise<void> => {
    await bounded(
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
      10_000,
      'server close',
    );
    server.closeIdleConnections?.();
    await bounded(background.waitForAll(5_000), 6_000, 'background drain');
    if (workerHandle !== null) {
      await bounded(workerHandle.close(), 15_000, 'scheduler worker close');
    }

    // Run-scoped Redis cleanup BEFORE dropping rows (needs the chat ids).
    try {
      const chatIds: string[] = [];
      if (trackedTaskIds.length > 0) {
        const executions = await bounded(
          prisma.agentTaskExecution.findMany({ where: { taskId: { in: trackedTaskIds } }, select: { chatId: true } }),
          10_000,
          'chat id lookup',
        );
        for (const row of executions ?? []) {
          chatIds.push(row.chatId);
        }
      }
      for (const chatId of chatIds) {
        await base.del(`${REDIS_KEY_PREFIX}:chat:general:${chatId}:messages`);
        await base.del(`${REDIS_KEY_PREFIX}:chat:general:${chatId}:active-stream`);
        // The activity-index member this run's appends created.
        await base.zRem(`${REDIS_KEY_PREFIX}:chat-index`, `general:${chatId}`);
        let idemCursor = '0';
        do {
          const scan = await base.scan(idemCursor, { MATCH: `${REDIS_KEY_PREFIX}:idempotency:general:${chatId}:*`, COUNT: 50 });
          idemCursor = scan.cursor;
          if (scan.keys.length > 0) {
            await base.del(scan.keys);
          }
        } while (idemCursor !== '0');
      }
      let streamCursor = '0';
      do {
        const scan = await base.scan(streamCursor, { MATCH: `${STREAM_KEY_PREFIX}:*`, COUNT: 100 });
        streamCursor = scan.cursor;
        if (scan.keys.length > 0) {
          await base.del(scan.keys);
        }
      } while (streamCursor !== '0');
    } catch (error) {
      void error;
    }

    // Exact Postgres cleanup: tasks cascade executions (schema onDelete).
    try {
      if (trackedTaskIds.length > 0) {
        await bounded(prisma.agentTask.deleteMany({ where: { id: { in: trackedTaskIds } } }), 10_000, 'task cleanup');
      }
    } catch (error) {
      void error;
    }

    // Obliterate ONLY this run's queue AFTER the worker closed.
    try {
      const cleaner = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, retryStrategy: () => null });
      cleaner.on('error', () => undefined); // obliterate path; errors surface via bounded calls
      const testQueue = new Queue(queueName, { connection: cleaner });
      await bounded(testQueue.obliterate({ force: true }), 10_000, 'scheduler queue obliterate');
      await bounded(testQueue.close(), 5_000, 'obliterate queue close');
      await bounded(cleaner.quit(), 5_000, 'obliterate cleaner quit');
    } catch (error) {
      void error;
    }
    await bounded(queue.close(), 15_000, 'scheduler queue handle close');

    for (const client of [base, publisher, subscriber]) {
      try {
        await bounded(client.quit(), 3_000, 'redis client quit');
      } catch {
        client.disconnect();
      }
    }
  };

  const stack: Stack = {
    label,
    queueName,
    service,
    queue,
    port: livePort,
    close: async () => {
      // Run-scoped sweep: stacks run sequentially, so at close time every
      // remaining task of THIS RUN (any test label) belongs to this stack or
      // a previously closed one — delete exactly the run's rows (cascade).
      const found = await bounded(
        prisma.agentTask.findMany({ where: { name: { startsWith: TASK_PREFIX } }, select: { id: true } }),
        10_000,
        'task tracking',
      );
      trackedTaskIds.push(...(found ?? []).map((row) => row.id));
      await close();
    },
  };
  return stack;
}

// -- Route + probe helpers --------------------------------------------------------

async function callJson(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/scheduler${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {}) };
}

function createTaskBody(label: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `itest-${RUN_ID}-${label}`,
    agentSlug: 'general',
    mode: 'action',
    prompt: 'Run the scheduled prompt.',
    recurrenceType: 'DAILY',
    recurrenceConfig: { hour: 9, minute: 0 },
    ...overrides,
  };
}

const LIVE_SCHEDULER_SIGNER = createDelegationContextSigner(Buffer.from(TEST_DELEGATION_SECRET, 'utf8'));
/**
 * Worker run headers for the live suite: convention marker + SIGNED
 * `internal-scheduler-run` context bound to the run target (the API route
 * derives the owner from the row, so the worker never needs the owner id).
 */
function workerRunHeaders(target: { taskId?: string; executionId?: string }): Record<string, string> {
  return {
    [SCHEDULER_WORKER_HEADER]: '1',
    [INTERNAL_SCHEDULER_HEADER]: LIVE_SCHEDULER_SIGNER.sign({
      kind: 'internal-scheduler-run',
      ...(target.taskId !== undefined ? { taskId: target.taskId } : {}),
      ...(target.executionId !== undefined ? { executionId: target.executionId } : {}),
      expiresAt: Date.now() + contextWindow(20_000).expiresAt,
    }),
  };
}

async function createTask(stack: Stack, label: string, overrides: Record<string, unknown> = {}): Promise<AgentTask> {
  const response = await callJson(stack.port, 'POST', '/tasks', createTaskBody(label, overrides));
  assert.equal(response.status, 201, `task create failed: ${JSON.stringify(response.body)}`);
  return response.body.task as AgentTask;
}

async function chatMessages(port: number, chatId: string): Promise<UIMessage[]> {
  const response = await fetch(`http://127.0.0.1:${port}/api/agents/general/chat/${chatId}`);
  assert.equal(response.status, 200, 'chat hydration');
  const body = (await response.json()) as { messages?: UIMessage[] };
  return body.messages ?? [];
}

function isoFuture(secondsFromNow: number): string {
  return new Date(Date.now() + secondsFromNow * 1_000).toISOString();
}

/** Independent BullMQ probe on the run-scoped queue (mirrors phase4 style). */
async function probeQueue<T>(queueName: string, action: (queue: Queue) => Promise<T>): Promise<T> {
  const cleaner = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, retryStrategy: () => null });
  cleaner.on('error', (error: Error) => undefined); // surfaced through bounded probe calls
  const probe = new Queue(queueName, { connection: cleaner });
  try {
    return await action(probe);
  } finally {
    await bounded(probe.close(), 5_000, 'probe close').catch(() => undefined);
    cleaner.disconnect();
  }
}

async function schedulerExists(queueName: string, taskTaskId: string): Promise<boolean> {
  return await probeQueue(queueName, async (probe) => {
    const record = await probe.getJobScheduler(taskTaskId);
    return record !== null && record !== undefined;
  });
}

// ---------------------------------------------------------------------------
// Store-health probe: the REAL Prisma scheduler store must accept an
// execution insert at module load (this used to guard skipped-by-reason
// tests while packages/core wrote `tokenUsage: Prisma.JsonNull`; the core
// fix to `Prisma.DbNull` landed, so this is now a hard expectation, not a
// skip trigger).
// ---------------------------------------------------------------------------

const probeService = new SchedulerService({ store: createPrismaSchedulerStore(prisma) });
const probeTask = await probeService.createTask({
  name: `${TASK_PREFIX}store-probe`,
  agentSlug: 'general',
  mode: 'action',
  prompt: 'probe',
  recurrenceType: 'DAILY',
  recurrenceConfig: { hour: 9, minute: 0 },
});
try {
  const probeCreated = await probeService.createExecution(probeTask, {
    scheduledFor: isoFuture(5),
    trigger: 'SCHEDULED',
  });
  assert.ok(probeCreated.created, 'store health probe: execution insert works');
} finally {
  await prisma.agentTask.deleteMany({ where: { id: probeTask.id } }).catch(() => undefined);
}

// -- Suite-level setup/teardown ---------------------------------------------------

before(async () => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Postgres connect timeout')), CONNECT_TIMEOUT_MS);
  });
  try {
    await Promise.race([prisma.$connect(), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
  const tables = await prisma.$queryRaw<Array<{ found: number }>>`
    SELECT COUNT(*)::int AS found FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('AgentTask', 'AgentTaskExecution')`;
  if (Number(tables[0]?.found ?? 0) !== 2) {
    throw new Error('Phase 5 scheduler tables missing — apply the Phase 5 migration first (root: npm run db:migrate).');
  }
  // The run owner is a REAL Better Auth row: ownerId FKs (AgentTask/
  // AgentTaskExecution) target "User", so the test-only owner identity must
  // exist before any owner-scoped write. Test-only injection (not a
  // production bypass); deleted once in after().
  await prisma.user.upsert({
    where: { id: LIVE_OWNER_ID },
    create: { id: LIVE_OWNER_ID, email: LIVE_OWNER_EMAIL, name: 'live scheduler owner' },
    update: {},
  });
  // Defensive pre-clean (run ids never repeat): orphan rows of THIS run only.
  try {
    await prisma.agentTask.deleteMany({ where: { name: { startsWith: TASK_PREFIX } } });
  } catch {
    /* first run: nothing to clean */
  }
});

after(async () => {
  try {
    await prisma.agentTask.deleteMany({ where: { name: { startsWith: TASK_PREFIX } } });
    await prisma.user.deleteMany({ where: { id: LIVE_OWNER_ID } });
  } catch {
    void 0;
  }
  await bounded(prisma.$disconnect(), 10_000, 'prisma disconnect');
});

// ---------------------------------------------------------------------------
// 1. Real CRUD + queue sync
// ---------------------------------------------------------------------------

test('recurring sync upserts the UTC job scheduler; re-sync never duplicates; pause removes', async () => {
  const model = scriptedModel();
  const stack = await createSchedulerStack({ label: 'cruds', model: model.languageModel, worker: false });
  try {
    const task = await createTask(stack, 'cruds-daily');
    assert.equal(cronExpressionForRecurrence('DAILY', { hour: 9, minute: 0 }), '0 9 * * *');

    const scheduler = await probeQueue(stack.queueName, async (probe) =>
      (await probe.getJobScheduler(task.id)) as unknown as Record<string, unknown> | null);
    assert.ok(scheduler, 'job scheduler visible in real BullMQ');
    // UTC pattern, no custom repeat id: the scheduler id IS the task id.
    const repeat = (scheduler.repeat ?? scheduler) as Record<string, unknown>;
    assert.equal(repeat['tz'] ?? (scheduler.tz as string | undefined), 'UTC');
    assert.equal(String(repeat['pattern'] ?? repeat['cron'] ?? ''), '0 9 * * *');

    // Repeated sync/reconcile: still exactly ONE scheduler with the task id.
    await stack.queue.reconcile([await stack.service.getTask(task.id) as AgentTask]);
    const schedulers = await probeQueue(stack.queueName, (probe) => probe.getJobSchedulers() as Promise<unknown>);
    const owned = (schedulers as Array<Record<string, unknown>>).filter((entry) => entry['key'] === task.id);
    assert.equal(owned.length, 1);

    // Pause removes the scheduler after the DB write.
    await callJson(stack.port, 'POST', `/tasks/${task.id}/pause`);
    assert.equal(await schedulerExists(stack.queueName, task.id), false);

    // Activate re-upserts.
    await callJson(stack.port, 'POST', `/tasks/${task.id}/activate`);
    assert.equal(await schedulerExists(stack.queueName, task.id), true);
  } finally {
    await stack.close();
  }
});

/**
 * ONCE deterministic delayed job on REAL BullMQ: create → one deterministic
 * colon-free job id `once-<taskId>` with the bounded delay and payload
 * `{ taskId, scheduledFor }`; re-sync/reconcile never duplicates it.
 * (The queue package's original `once-task:<id>` id contained ':' and real
 * BullMQ v6 rejects that — fixed upstream to `once-${taskId}`; this test
 * pins the FIXED shape.)
 */
test('ONCE deterministic delayed job dedupes across syncs and nulls nextRunAt after the run', async () => {
  const model = scriptedModel();
  model.enqueue(textStep());
  const stack = await createSchedulerStack({ label: 'once', model: model.languageModel, worker: false });
  try {
    const runAt = isoFuture(4);
    const task = await createTask(stack, 'once-task', { recurrenceType: 'ONCE', recurrenceConfig: { runAt } });
    await stack.queue.reconcile([await stack.service.getTask(task.id) as AgentTask]);

    const job = await probeQueue(stack.queueName, (probe) => probe.getJob(`once-${task.id}`));
    assert.ok(job, 'deterministic once job exists');
    const payload = job?.data as { taskId?: string; scheduledFor?: string };
    assert.equal(payload.taskId, task.id);
    assert.equal(payload.scheduledFor, runAt);

    // Re-sync/reconcile: STILL exactly one once job (same deterministic id).
    await stack.queue.reconcile([await stack.service.getTask(task.id) as AgentTask]);
    const second = await probeQueue(stack.queueName, (probe) => probe.getJob(`once-${task.id}`));
    assert.ok(second, 'once job still exactly one');

    // The occurrence RUNS through the own-REST path (inline here): the
    // materialized execution completes, and the guarded advancement nulls
    // the task's nextRunAt. Startup reconcile therefore never re-adds a dead
    // once job: the adapter adds nothing for a null nextRunAt, and repeated
    // reconciles cannot churn duplicates.
    const occurrence = await callJson(
      stack.port,
      'POST',
      `/tasks/${task.id}/run-scheduled`,
      { scheduledFor: runAt, attempt: 1 },
      workerRunHeaders({ taskId: task.id }),
    );
    assert.equal(occurrence.status, 200, JSON.stringify(occurrence.body));
    assert.equal((occurrence.body.execution as Record<string, unknown>).status, 'COMPLETED');
    assert.equal(model.callCount(), 1, 'the once occurrence generated exactly once');

    const afterRun = await callJson(stack.port, 'GET', `/tasks/${task.id}`);
    assert.equal((afterRun.body.task as Record<string, unknown>).nextRunAt, null, 'ONCE nextRunAt cleared after the run');

    await stack.queue.reconcile([await stack.service.getTask(task.id) as AgentTask]);
    const firstCount = await probeQueue(stack.queueName, (probe) => probe.getJob(`once-${task.id}`));
    assert.ok(firstCount, 'the original once job stays (never re-added)');
    await stack.queue.reconcile([await stack.service.getTask(task.id) as AgentTask]);
    // The run-scoped queue holds EXACTLY this once job across reconciles:
    // a null nextRunAt adds nothing and churns no duplicates.
    const counts = await probeQueue(stack.queueName, (probe) => probe.getJobCounts());
    const total = Object.values(counts as Record<string, number>).reduce((sum, value) => sum + Number(value ?? 0), 0);
    assert.equal(total, 1, 'reconcile churns no duplicate once job');
  } finally {
    await stack.close();
  }
});

test('partial unique (task, scheduledFor); queue/repeat identities conflict', async () => {
  const model = scriptedModel();
  const stack = await createSchedulerStack({ label: 'uniq', model: model.languageModel, worker: false });
  try {
    const task = await createTask(stack, 'uniq-task');
    const scheduledFor = isoFuture(3600);

    // Concurrent duplicate SCHEDULED creates: at most ONE row, ever.
    await Promise.all([
      stack.service.createExecution(task, { scheduledFor, trigger: 'SCHEDULED', queueJobId: 'job-a', repeatJobKey: 'rep-a' }),
      stack.service.createExecution(task, { scheduledFor, trigger: 'SCHEDULED', queueJobId: 'job-b', repeatJobKey: 'rep-b' }),
    ]);
    const rows = await stack.service.listExecutions({ taskId: task.id });
    assert.equal(rows.length, 1, 'partial unique allows exactly one scheduled row per instant');

    // Queue identity uniqueness: the RECORDED queue id (either of the two
    // racing creates may win) cannot be reused for a DIFFERENT instant.
    const rowsForIdentity = await stack.service.listExecutions({ taskId: task.id });
    const recordedQueueJobId = rowsForIdentity[0]?.queueJobId ?? null;
    assert.ok(typeof recordedQueueJobId === 'string', 'the recorded row carries its queue identity');
    const otherInstant = isoFuture(7200);
    await assert.rejects(
      () => stack.service.createExecution(task, { scheduledFor: otherInstant, trigger: 'SCHEDULED', queueJobId: recordedQueueJobId }),
      SchedulerConflictError,
    );
    const rowsAfter = await stack.service.listExecutions({ taskId: task.id });
    assert.equal(rowsAfter.length, 1);
  } finally {
    await stack.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Manual run through REAL queue + worker → own REST → real chat
// ---------------------------------------------------------------------------

test('manual run: real queue → real worker → own REST → real chat COMPLETED', async () => {
  const model = scriptedModel();
  model.enqueue(textStep());
  const stack = await createSchedulerStack({ label: 'manual', model: model.languageModel });
  try {
    const task = await createTask(stack, 'manual-task');
    const run = await callJson(stack.port, 'POST', `/tasks/${task.id}/run`);
    assert.equal(run.status, 202);
    const execution = run.body.execution as Record<string, unknown>;
    assert.equal(execution.status, 'PENDING');
    assert.equal(execution.trigger, 'MANUAL');
    const executionId = String(execution.id);

    await waitFor(async () =>
      String(((await callJson(stack.port, 'GET', `/executions/${executionId}`)).body.execution as Record<string, unknown>).status) === 'COMPLETED',
    25_000, 'manual execution completed');

    const completed = (await callJson(stack.port, 'GET', `/executions/${executionId}`)).body.execution as Record<string, unknown>;
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.attempt, 1);
    assert.equal(typeof completed.durationMs, 'number');
    assert.deepEqual(completed.tokenUsage, USAGE_EXPECTED);
    assert.equal(completed.chatId, executionId);
    assert.equal(model.callCount(), 1);

    // Isolated chat persisted through the REAL chat Redis store.
    const messages = await chatMessages(stack.port, executionId);
    assert.equal(messages.length, 2);
    const user = messages[0] as UIMessage;
    assert.equal(user.role, 'user');
    assert.equal(user.id, executionId);
    assert.equal(JSON.stringify(user.parts), JSON.stringify([{ type: 'text', text: 'Run the scheduled prompt.' }]));
    const assistant = messages[1] as UIMessage;
    assert.equal(assistant.role, 'assistant');
    assert.equal(JSON.stringify(assistant.parts).includes('Scheduled integration answer.'), true);
    assert.deepEqual((assistant.metadata as Record<string, unknown> | undefined)?.usage, USAGE_EXPECTED);

    // The Idempotency-Key (`chatId:executionId`) was acquired in REAL Redis.
    const idemKeys = await probeQueue(stack.queueName, async (probe) => {
      void probe;
      const client = createClient({ url: REDIS_URL, socket: { reconnectStrategy: false, connectTimeout: CONNECT_TIMEOUT_MS } });
      await client.connect();
      try {
        let cursor = '0';
        const keys: string[] = [];
        do {
          const scan = await client.scan(cursor, { MATCH: `${REDIS_KEY_PREFIX}:idempotency:*:general:${executionId}:*`, COUNT: 50 });
          cursor = scan.cursor;
          keys.push(...scan.keys);
        } while (cursor !== '0');
        return keys;
      } finally {
        await client.quit().catch(() => client.disconnect());
      }
    });
    assert.equal(idemKeys.length, 1, 'exactly the run-scoped idempotency key exists');
    assert.ok(String(idemKeys[0]).endsWith(`:${executionId}:${executionId}`), 'key equals {chatId}:{messageId}');

    // Terminal re-run (worker route): ok, ZERO extra generation.
    const rerun = await callJson(stack.port, 'POST', `/executions/${executionId}/run`, { attempt: 4 }, workerRunHeaders({ executionId }));
    assert.equal(rerun.status, 200);
    assert.equal(rerun.body.ok, true);
    assert.equal(model.callCount(), 1);
  } finally {
    await stack.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Duplicate occurrence: one row, one claim, one model call
// ---------------------------------------------------------------------------

test('duplicate occurrence deliveries: one row, one claim, no duplicate chat', async () => {
  const model = scriptedModel();
  model.enqueue(textStep());
  const stack = await createSchedulerStack({ label: 'dupe', model: model.languageModel });
  try {
    const task = await createTask(stack, 'dupe-task');
    const scheduledFor = isoFuture(30);

    // Two concurrent occurrence deliveries hitting the own-REST route. Either
    // delivery may win the atomic claim: the loser recovers (same row, 200)
    // or reports a transient 409 while the winner streams — NEVER a second
    // row, claim, or model call.
    const [d1, d2] = await Promise.all([
      callJson(stack.port, 'POST', `/tasks/${task.id}/run-scheduled`, { scheduledFor, attempt: 1, queueJobId: 'dup-job-1', repeatJobKey: 'dup-rep-1' }, workerRunHeaders({ taskId: task.id })),
      callJson(stack.port, 'POST', `/tasks/${task.id}/run-scheduled`, { scheduledFor, attempt: 1, queueJobId: 'dup-job-1', repeatJobKey: 'dup-rep-1' }, workerRunHeaders({ taskId: task.id })),
    ]);
    for (const delivery of [d1, d2]) {
      assert.ok(delivery.status === 200 || delivery.status === 409, `delivery outcome ${delivery.status}`);
      if (delivery.status === 409) {
        assert.deepEqual(delivery.body, { error: 'Scheduler conflict.' });
      }
    }
    const completions = [d1, d2].filter((delivery) => delivery.status === 200 && delivery.body.ok === true);
    assert.ok(completions.length >= 1, 'one delivery drives the occurrence');

    const firstId = String((completions[0]?.body.execution as Record<string, unknown>).id);
    await waitFor(async () =>
      String(((await callJson(stack.port, 'GET', `/executions/${firstId}`)).body.execution as Record<string, unknown>).status) === 'COMPLETED',
    25_000, 'duplicate occurrence completed');

    for (const delivery of completions) {
      assert.equal(String((delivery.body.execution as Record<string, unknown>).id), firstId, 'duplicate deliveries resolve to the SAME row');
    }
    assert.equal(model.callCount(), 1);

    const rows = await stack.service.listExecutions({ taskId: task.id });
    assert.equal(rows.length, 1);
    const messages = await chatMessages(stack.port, firstId);
    assert.equal(messages.length, 2, 'exactly one user + one assistant message');

    // A third redelivery AFTER terminal: idempotent, still one chat.
    const again = await callJson(stack.port, 'POST', `/tasks/${task.id}/run-scheduled`, { scheduledFor, attempt: 1, queueJobId: 'dup-job-1', repeatJobKey: 'dup-rep-1' }, workerRunHeaders({ taskId: task.id }));
    assert.equal(again.status, 200);
    assert.equal((again.body.execution as Record<string, unknown>).id, firstId);
    assert.equal(model.callCount(), 1);

    // The occurrence advanced the task's nextRunAt metadata to the next
    // computed occurrence (UI/reconcile only — NO queue sync happened, so
    // the recurring job scheduler stays exactly as it was).
    const expectedNext = computeNextRunAt({
      recurrenceType: 'DAILY',
      recurrenceConfig: { hour: 9, minute: 0 },
      after: new Date(scheduledFor),
      skipDates: [],
    });
    assert.ok(expectedNext !== null);
    const afterRun = await callJson(stack.port, 'GET', `/tasks/${task.id}`);
    assert.equal((afterRun.body.task as Record<string, unknown>).nextRunAt, expectedNext.toISOString());
    const ownerCount = await probeQueue(stack.queueName, (probe) => probe.getJobSchedulers() as Promise<unknown>);
    const ownedSchedulers = (ownerCount as Array<Record<string, unknown>>).filter((entry) => entry['key'] === task.id);
    assert.equal(ownedSchedulers.length, 1, 'no scheduler churn from the run path');
  } finally {
    await stack.close();
  }
});

// ---------------------------------------------------------------------------
// 4. RETRYING audit → success; dead letter + retained job; manual retry; skip
// ---------------------------------------------------------------------------

test('provider fails twice then succeeds: RETRYING audit, then COMPLETED attempt 3', async () => {
  const model = scriptedModel();
  model.enqueue('fail');
  model.enqueue('fail');
  model.enqueue(textStep());
  const stack = await createSchedulerStack({ label: 'retryok', model: model.languageModel });
  try {
    const task = await createTask(stack, 'retry-ok-task');
    const run = await callJson(stack.port, 'POST', `/tasks/${task.id}/run`);
    const executionId = String((run.body.execution as Record<string, unknown>).id);

    const seen = new Set<string>();
    await waitFor(async () => {
      const status = String(((await callJson(stack.port, 'GET', `/executions/${executionId}`)).body.execution as Record<string, unknown>).status);
      seen.add(status);
      return status === 'COMPLETED';
    }, 30_000, 'retry-then-success completed');

    const row = (await callJson(stack.port, 'GET', `/executions/${executionId}`)).body.execution as Record<string, unknown>;
    assert.equal(row.status, 'COMPLETED');
    assert.equal(row.attempt, 3);
    assert.equal(model.callCount(), 3);
    assert.equal(seen.has('RETRYING'), true, `RETRYING audit observed (${[...seen].join(',')})`);
    // Every attempt re-asked with its own deterministic message id (attempt 1
    // re-owned key makes retries impossible otherwise); exactly ONE assistant.
    const messages = await chatMessages(stack.port, executionId);
    assert.equal(messages.length, 4);
    const userIds = messages.slice(0, 3).map((entry) => String((entry as UIMessage).id));
    assert.deepEqual(userIds, [executionId, `${executionId}-a2`, `${executionId}-a3`]);
    for (const entry of messages.slice(0, 3)) {
      assert.equal((entry as UIMessage).role, 'user');
    }
    const assistants = messages.filter((entry) => (entry as UIMessage).role === 'assistant');
    assert.equal(assistants.length, 1, 'exactly one assistant generation across all attempts');
  } finally {
    await stack.close();
  }
});

test('always-failing task lands DEAD_LETTER after exactly 3; failed job retained; manual retry succeeds', async () => {
  const model = scriptedModel();
  model.enqueue('fail');
  model.enqueue('fail');
  model.enqueue('fail');
  const stack = await createSchedulerStack({ label: 'dlq', model: model.languageModel });
  try {
    const task = await createTask(stack, 'dlq-task');
    const run = await callJson(stack.port, 'POST', `/tasks/${task.id}/run`);
    const executionId = String((run.body.execution as Record<string, unknown>).id);

    const seen = new Set<string>();
    await waitFor(async () => {
      const status = String(((await callJson(stack.port, 'GET', `/executions/${executionId}`)).body.execution as Record<string, unknown>).status);
      seen.add(status);
      return status === 'DEAD_LETTER';
    }, 30_000, 'dead letter reached');

    const row = (await callJson(stack.port, 'GET', `/executions/${executionId}`)).body.execution as Record<string, unknown>;
    assert.equal(row.status, 'DEAD_LETTER');
    assert.equal(row.attempt, 3);
    assert.equal(model.callCount(), 3);
    assert.equal(row.error, 'The scheduled task failed all attempts and moved to the dead letter queue.');
    assert.equal(seen.has('RETRYING'), true);
    assert.notEqual(row.finishedAt, null);

    // BullMQ retains the failed job (removeOnFail: false) as DLQ evidence.
    const retained = await probeQueue(stack.queueName, async (probe) => {
      const failedJob = await probe.getJob(`execution-${executionId}`);
      const state = failedJob !== null && failedJob !== undefined ? await failedJob.getState() : null;
      const failedCount = await probe.getFailedCount();
      return { exists: failedJob !== null && failedJob !== undefined, state, failedCount };
    });
    assert.equal(retained.exists, true, 'failed job retained in the queue');
    assert.equal(retained.state, 'failed');

    // Manual retry: NEW linked execution + NEW chat; the DEAD_LETTER old row
    // is immutable. Then the retry SUCCEEDS with a scripted answer.
    model.enqueue(textStep());
    const retry = await callJson(stack.port, 'POST', `/executions/${executionId}/retry`);
    assert.equal(retry.status, 202, JSON.stringify(retry.body));
    const retried = retry.body.execution as Record<string, unknown>;
    assert.equal(retried.trigger, 'RETRY');
    assert.equal(retried.retryOfExecutionId, executionId);
    assert.notEqual(retried.chatId, executionId);
    const retriedId = String(retried.id);

    await waitFor(async () =>
      String(((await callJson(stack.port, 'GET', `/executions/${retriedId}`)).body.execution as Record<string, unknown>).status) === 'COMPLETED',
    25_000, 'retry execution completed');

    const oldRow = (await callJson(stack.port, 'GET', `/executions/${executionId}`)).body.execution as Record<string, unknown>;
    assert.equal(oldRow.status, 'DEAD_LETTER', 'old row immutable');
    // Every failed attempt re-asked in the SAME isolated chat (attempt-scoped
    // user ids), and NO assistant message was ever persisted there.
    const oldMessages = await chatMessages(stack.port, executionId);
    assert.equal(oldMessages.length, 3);
    assert.deepEqual(
      oldMessages.map((entry) => String((entry as UIMessage).id)),
      [executionId, `${executionId}-a2`, `${executionId}-a3`],
    );
    for (const entry of oldMessages) {
      assert.equal((entry as UIMessage).role, 'user');
    }
    assert.equal((await chatMessages(stack.port, String(retried.chatId))).length, 2, 'new isolated chat completed');
  } finally {
    await stack.close();
  }
});

test('pause and skipDates occurrences are SKIPPED with zero model calls', async () => {
  const model = scriptedModel();
  const stack = await createSchedulerStack({ label: 'skip', model: model.languageModel, worker: false });
  try {
    const pausedTask = await createTask(stack, 'paused-task');
    await callJson(stack.port, 'POST', `/tasks/${pausedTask.id}/pause`);
    const suspended = await callJson(
      stack.port,
      'POST',
      `/tasks/${pausedTask.id}/run-scheduled`,
      { scheduledFor: isoFuture(60), attempt: 1 },
      workerRunHeaders({ taskId: pausedTask.id }),
    );
    assert.equal(suspended.status, 200);
    assert.equal(suspended.body.skipped, true);
    assert.equal((suspended.body.execution as Record<string, unknown>).status, 'SKIPPED');

    const skipTask = await createTask(stack, 'skipdate-task', {
      skipDates: [new Date(Date.now() + 60_000).toISOString().slice(0, 10)],
    });
    const skipped = await callJson(
      stack.port,
      'POST',
      `/tasks/${skipTask.id}/run-scheduled`,
      { scheduledFor: isoFuture(60), attempt: 1 },
      workerRunHeaders({ taskId: skipTask.id }),
    );
    assert.equal(skipped.status, 200);
    assert.equal(skipped.body.skipped, true);
    assert.equal(model.callCount(), 0, 'no model calls for skipped occurrences');
  } finally {
    await stack.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Duplicate POST / active-stream recovery: exactly one generation
// ---------------------------------------------------------------------------

test('duplicate run POSTs while streaming recover without a second generation', async () => {
  const model = scriptedModel({ chunkDelayMs: 120 });
  model.enqueue(slowTextStep());
  const stack = await createSchedulerStack({ label: 'recovery', model: model.languageModel, worker: false, executionTimeoutMs: 20_000 });
  try {
    const task = await createTask(stack, 'recovery-task');
    const run = await callJson(stack.port, 'POST', `/tasks/${task.id}/run`);
    assert.equal(run.status, 202);
    const executionId = String((run.body.execution as Record<string, unknown>).id);

    // Two concurrent "worker" run POSTs: the atomic claim produces exactly one
    // winner; the loser recovers through durable hydration/resume — never a
    // second chat POST, never a second user message.
    const [a, b] = await Promise.all([
      callJson(stack.port, 'POST', `/executions/${executionId}/run`, { attempt: 1 }, workerRunHeaders({ executionId })),
      callJson(stack.port, 'POST', `/executions/${executionId}/run`, { attempt: 1 }, workerRunHeaders({ executionId })),
    ]);
    for (const entry of [a, b]) {
      assert.ok(entry.status === 200 || entry.status === 409, `recovery outcome ${entry.status}`);
      if (entry.status === 409) {
        assert.deepEqual(entry.body, { error: 'Scheduler conflict.' });
      }
    }

    await waitFor(async () => {
      const current = await callJson(stack.port, 'GET', `/executions/${executionId}`);
      return String((current.body.execution as Record<string, unknown>).status) === 'COMPLETED';
    }, 30_000, 'recovered execution completed');

    assert.equal(model.callCount(), 1, 'exactly one model generation despite duplicate POSTs');
    const row = (await callJson(stack.port, 'GET', `/executions/${executionId}`)).body.execution as Record<string, unknown>;
    assert.equal(row.status, 'COMPLETED');
    const messages = await chatMessages(stack.port, executionId);
    assert.equal(messages.length, 2, 'no duplicate assistant/user messages');
  } finally {
    await stack.close();
  }
});

// ---------------------------------------------------------------------------
// 6. Worker killed mid-job: spawned real child, SIGKILL, restart recovery
// ---------------------------------------------------------------------------

function workerChildEnv(stack: Stack): NodeJS.ProcessEnv {
  // Every decision variable is explicit; the dummy OLLAMA_API_KEY beats any
  // env file (Node no-override semantics), so the child NEVER reads or uses a
  // real key from this checkout.
  return {
    ...process.env,
    OLLAMA_API_KEY: 'test-only-not-a-real-key',
    REDIS_URL,
    SCHEDULER_QUEUE_NAME: stack.queueName,
    INTERNAL_API_BASE_URL: `http://127.0.0.1:${stack.port}`,
    SCHEDULER_EXECUTION_TIMEOUT_MS: '180000',
    // The worker signs its run contexts with the shared secret (pre-Phase 6
    // internal trust: no unsigned/ephemeral fallback across processes).
    DELEGATION_CONTEXT_SECRET: TEST_DELEGATION_SECRET,
  };
}

interface WorkerChild {
  pid: number | undefined;
  kill(signal: NodeJS.Signals): boolean;
  exited: Promise<number>;
  ready: Promise<void>;
}

test('worker killed mid-job: spawned child dies, restart recovers, one generation', { timeout: 170_000 }, async () => {
  // Slow generation (~14 x 4s ≈ 56s) so the SIGKILLed child's job genuinely
  // STALLS (~30s BullMQ default) while the row is still RUNNING: the
  // restarted child must recover it through durable hydration + the /stream
  // resume (NOT a fresh claim) and land COMPLETED with exactly one
  // generation. Budgets are raised so recovery can drain the live stream.
  const model = scriptedModel({ chunkDelayMs: 4_000 });
  model.enqueue(slowTextStep());
  const stack = await createSchedulerStack({
    label: 'kill',
    model: model.languageModel,
    worker: false,
    executionTimeoutMs: 70_000,
    metadataTimeoutMs: 70_000,
  });
  const workerEntry = fileURLToPath(new URL('../dist/scheduler-worker.js', import.meta.url));
  assert.ok(existsSync(workerEntry), `worker entry exists (build apps/api first): ${workerEntry}`);

  const children: WorkerChild[] = [];
  const spawnWorker = (): WorkerChild => {
    const child = spawn(process.execPath, [workerEntry], {
      env: workerChildEnv(stack),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += String(chunk);
    });
    const exited = new Promise<number>((resolve) => {
      child.on('exit', (code) => resolve(code ?? -1));
    });
    const childRecord: WorkerChild = {
      pid: child.pid,
      kill: (signal: NodeJS.Signals) => child.kill(signal),
      exited,
      ready: waitFor(() => stdout.includes('scheduler-worker-started'), 15_000, 'worker child started'),
    };
    children.push(childRecord);
    return childRecord;
  };

  try {
    const child1 = spawnWorker();
    await child1.ready;

    const task = await createTask(stack, 'kill-task');
    const run = await callJson(stack.port, 'POST', `/tasks/${task.id}/run`);
    assert.equal(run.status, 202);
    const executionId = String((run.body.execution as Record<string, unknown>).id);

    // Generation has begun (the child claims via the own REST route; the
    // runner executes in the API process) → kill ONLY the spawned child.
    await waitFor(async () =>
      String(((await callJson(stack.port, 'GET', `/executions/${executionId}`)).body.execution as Record<string, unknown>).status) === 'RUNNING',
    20_000, 'execution claimed by child');
    await new Promise((resolve) => setTimeout(resolve, 150)); // kill mid-stream
    assert.equal(typeof child1.pid, 'number');
    child1.kill('SIGKILL');
    await child1.exited;

    // Restart ONLY that worker child; BullMQ recovers the stalled job
    // (default ~30s stall interval). The API-side generation continues
    // independently of the dead child — recovery must land COMPLETED with
    // exactly one generation and two chat messages.
    const child2 = spawnWorker();
    await child2.ready;

    try {
      await waitFor(async () =>
        String(((await callJson(stack.port, 'GET', `/executions/${executionId}`)).body.execution as Record<string, unknown>).status) === 'COMPLETED',
      90_000, 'restarted worker recovered the killed job to COMPLETED');

      const row = (await callJson(stack.port, 'GET', `/executions/${executionId}`)).body.execution as Record<string, unknown>;
      assert.equal(row.status, 'COMPLETED');
      assert.equal(row.attempt, 1, 'no retry burned: recovered via hydration/resume');
      assert.equal(model.callCount(), 1, 'exactly one model generation total');
      const messages = await chatMessages(stack.port, executionId);
      assert.equal(messages.length, 2, 'one user + one assistant message only');
      const assistant = messages[1] as UIMessage;
      assert.equal(JSON.stringify(assistant.parts).includes('chunk-'), true);
    } finally {
      child2.kill('SIGTERM');
      await Promise.race([child2.exited, new Promise((resolve) => setTimeout(resolve, 8_000))]);
      child2.kill('SIGKILL'); // belt and braces; a dead pid ignores this
      await Promise.race([child2.exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
  } finally {
    for (const child of children) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      await Promise.race([child.exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    await stack.close();
  }
});

// ---------------------------------------------------------------------------
// 7. Run-scoped cleanup itself is verified (no FLUSH anywhere)
// ---------------------------------------------------------------------------

test('run-scoped cleanup leaves zero rows/keys/queues for this run id', async () => {
  // Every stack close in the suites above deleted EXACTLY its own rows/keys
  // and obliterated exactly its own run-scoped queue. This test proves it.
  const tasks = await prisma.agentTask.findMany({ where: { name: { startsWith: TASK_PREFIX } } });
  assert.deepEqual(tasks, [], 'no AgentTask rows remain for this run');
  const executions = await prisma.agentTaskExecution.findMany({
    where: { task: { name: { startsWith: TASK_PREFIX } } },
  });
  assert.deepEqual(executions, [], 'no execution rows remain for this run');

  const client = createClient({ url: REDIS_URL, socket: { reconnectStrategy: false, connectTimeout: CONNECT_TIMEOUT_MS } });
  client.on('error', () => undefined);
  await client.connect();
  try {
    const scanAll = async (pattern: string): Promise<string[]> => {
      let cursor = '0';
      const keys: string[] = [];
      do {
        const scan = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
        cursor = scan.cursor;
        keys.push(...scan.keys);
      } while (cursor !== '0');
      return keys;
    };
    assert.deepEqual(await scanAll(`${STREAM_KEY_PREFIX}:*`), [], 'no resumable-stream keys remain for this run');
    assert.deepEqual(await scanAll(`workforce-scheduler-itest-${RUN_ID}*`), [], 'no run-scoped queue keys remain');
  } finally {
    await client.quit().catch(() => client.disconnect());
  }
});
