/**
 * The standalone scheduler worker (Phase 5): the ONLY process that runs the
 * `workforce-scheduler` BullMQ Worker. It owns ONLY the worker — no Prisma,
 * no Ollama key, no provider code — and executes every job by calling the
 * API's own REST run routes (ADR-002 across processes) via
 * {@link createSchedulerRestRunClient}.
 *
 * Startup contract:
 * - Gitignored env files are hydrated exactly like the API (`loadProjectEnvFiles()`),
 *   so `REDIS_URL`, `PORT`/`INTERNAL_API_BASE_URL` and
 *   `SCHEDULER_EXECUTION_TIMEOUT_MS` behave identically in `dev` and prod.
 *   The API config is REUSED (`loadApiConfig`) because none of its variables
 *   are mandatory here: `OLLAMA_API_KEY`/`DATABASE_URL` are optional — the
 *   worker never reads them (no provider, no database is even constructed).
 * - Startup PINGs the scheduler Redis connection (bounded) and fails safely
 *   otherwise: a worker that cannot reach Redis must not sit idle silently.
 * - Only fixed safe strings are ever logged (no URLs, no env values).
 *
 * Lifecycle: SIGTERM/SIGINT → bounded close (stop intake → drain active jobs
 * → close sockets) → exit. Deterministic job ids + the API's execution
 * idempotency recover a killed worker without double-generating a run.
 */
import { Redis as IORedis } from 'ioredis';
import {
  connectWithTimeout,
  createSchedulerWorker,
  isValidSchedulerQueueId,
  redisConnectionOptions,
  SCHEDULER_QUEUE_NAME,
  type SchedulerWorkerHandle,
} from '@workforce/queue/scheduler';

import { loadApiConfig } from './config.js';
import { loadProjectEnvFiles } from './env.js';
import { consoleLogger, type SafeLogger } from './logging.js';
import { createSchedulerRestRunClient } from './scheduler/run-client.js';

/** Bounded budget for the startup PING (matches the API's connect budget). */
const REDIS_PING_TIMEOUT_MS = 5_000;

/** Fixed safe startup-failure text (never env/URL values). */
function startupFailureReason(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'unknown scheduler worker startup failure';
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && ['ECONNREFUSED', 'ETIMEDOUT', 'EADDRINUSE', 'ENOTFOUND', 'ECONNRESET'].includes(code)) {
    return code;
  }
  const { message, name } = error;
  if (typeof message === 'string') {
    if (message === 'Environment file could not be loaded.') {
      return 'Environment file could not be loaded';
    }
    if (message === 'Redis connect timeout') {
      return 'Redis connection timed out';
    }
    if (message.startsWith('Redis queue PING timeout') || message === 'Redis queue PING failed' || message === 'Connection is closed.') {
      return 'Redis queue unavailable';
    }
    if (message.startsWith('Invalid API configuration (values are never included)')) {
      return 'Scheduler worker configuration is invalid (check REDIS/PORT settings)';
    }
  }
  if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(name)) {
    return name;
  }
  return 'unknown scheduler worker startup failure';
}

async function main(): Promise<void> {
  const logger: SafeLogger = consoleLogger;
  loadProjectEnvFiles();
  const config = loadApiConfig();

  // Queue name: the fixed default, overridden ONLY by a bounded
  // SCHEDULER_QUEUE_NAME (run-scoped integration tests / dedicated stacks).
  // Invalid values are ignored — never a crash, never a renamed prod queue.
  const queueNameOverride = process.env['SCHEDULER_QUEUE_NAME'];
  const queueName =
    typeof queueNameOverride === 'string' && isValidSchedulerQueueId(queueNameOverride)
      ? queueNameOverride
      : SCHEDULER_QUEUE_NAME;

  // Bounded startup honesty: the worker is useless without Redis. Fail FAST:
  // no reconnect loop, no graceful-quit hang — a hard disconnect always ends.
  const probe = new IORedis({
    ...redisConnectionOptions(config.redisUrl),
    // A probe never retries: null ends reconnection after the first failure.
    retryStrategy: () => null,
    // Commands must not queue forever behind a never-ready connection.
    maxRetriesPerRequest: 1,
  });
  probe.on('error', () => undefined); // surfaced through the bounded ping below
  try {
    await connectWithTimeout((client) => client.ping(), probe, REDIS_PING_TIMEOUT_MS);
  } finally {
    try {
      await Promise.race([probe.quit(), new Promise((resolve) => setTimeout(resolve, 500))]);
    } catch {
      /* the ping failure already decides the outcome */
    }
    probe.disconnect(); // hard close: idempotent, never hangs
  }

  const runClient = createSchedulerRestRunClient({
    fetchFn: globalThis.fetch,
    baseUrl: config.internalApiBaseUrl,
    executionTimeoutMs: config.schedulerExecutionTimeoutMs,
  });

  // SafeLogger and the queue's SchedulerLogger share this exact shape.
  const handle: SchedulerWorkerHandle = createSchedulerWorker({
    runClient,
    redisUrl: config.redisUrl,
    queueName,
    logger,
  });

  console.log(JSON.stringify({
    level: 'info',
    context: 'scheduler-worker-started',
    queue: queueName,
  }));

  let closing = false;
  const stop = (): void => {
    if (closing) {
      return;
    }
    closing = true;
    void handle
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((error: unknown) => {
  // Startup failure: log by type only, then one FIXED safe operator line.
  consoleLogger.error('scheduler-worker-startup-failed', error);
  console.error(JSON.stringify({
    level: 'error',
    context: 'scheduler-worker-startup-failed-reason',
    startupReason: startupFailureReason(error),
  }));
  process.exit(1);
});
