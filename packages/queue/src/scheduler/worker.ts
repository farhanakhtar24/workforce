/**
 * BullMQ worker for the `workforce-scheduler` queue: bridges jobs to the
 * injected {@link SchedulerRunClient} (host-owned scheduler service).
 *
 * ## Processor rules
 * - `{ taskId }` data (SCHEDULED): `runScheduled` with `scheduledFor` taken
 *   from the ONCE payload when present, otherwise DERIVED from BullMQ's
 *   metadata — `opts.repeat.prevMillis` when finite (the library-stamped
 *   iteration instant), falling back to `job.timestamp`. `repeatJobKey` passes
 *   through when BullMQ stamped one.
 * - `{ executionId }` data (MANUAL/RETRY): `runExecution`; the human attempt
 *   number is `attempt = job.attemptsMade + 1`; `queueJobId` is `String(job.id)`.
 * - Payload/ids/instant validation failures and `!ok` run results THROW a
 *   FIXED safe error — BullMQ owns the retry (attempts 3, exponential
 *   backoff). A run client that THROWS keeps its error untouched.
 * - NO raw payload, reason, or error text is ever logged: failure/error
 *   contexts carry only a fixed type plus the job id.
 * - Correlation (observability only): with a configured
 *   {@link SchedulerJobContextHook}, the processor AND the completed/failed
 *   event logging run inside one per-job async context keyed by
 *   {@link schedulerRequestId} — the same deterministic id the host's outgoing
 *   calls can carry as `x-request-id`. No hook = previous no-context behavior.
 */

import { createHash } from 'node:crypto';

import { Worker } from 'bullmq';

import { redisConnectionOptions, type RedisReconnectStrategy } from '../redis-options.js';
import type { SchedulerLogger } from '../logger.js';
import {
  SCHEDULER_CLOSE_TIMEOUT_MS,
  SCHEDULER_QUEUE_NAME,
  SCHEDULER_WORKER_CONCURRENCY,
} from './constants.js';
import {
  executionInputFromJob,
  scheduledInputFromJob,
  type SchedulerJobLike,
} from './job-helpers.js';
import { isSchedulerJobData, type SchedulerJobData, type SchedulerJobContextHook, type SchedulerRunClient } from './types.js';

/**
 * Minimal structural surface of a running worker (tests fake the BullMQ
 * worker through {@link SchedulerWorkerFactory}).
 */
export interface SchedulerWorkerLike {
  close(): Promise<void>;
}

/** Processor signature handed to BullMQ/the factory. */
export type SchedulerProcessor = (job: SchedulerJobLike) => Promise<void>;

/** Injectable worker factory (tests fake the BullMQ worker entirely). */
export type SchedulerWorkerFactory = (processor: SchedulerProcessor) => SchedulerWorkerLike;

export interface SchedulerWorkerOptions {
  /** Executes the scheduled/execution run; injectable for offline tests. */
  runClient: SchedulerRunClient;
  redisUrl?: string;
  queueName?: string;
  concurrency?: number;
  logger: SchedulerLogger;
  reconnectStrategy?: RedisReconnectStrategy;
  /** Injected worker factory (tests fake the BullMQ worker). */
  workerFactory?: SchedulerWorkerFactory;
  /** close() bound; default {@link SCHEDULER_CLOSE_TIMEOUT_MS} (tests shorten). */
  closeTimeoutMs?: number;
  /**
   * Per-job context hook around the processor and completed/failed logging
   * (see {@link SchedulerJobContextHook}); optional, undefined = no context.
   */
  withJobContext?: SchedulerJobContextHook;
}

export interface SchedulerWorkerHandle {
  /** Underlying worker (real BullMQ Worker in production). */
  worker: unknown;
  /** Waits for active jobs then closes worker + sockets; bounded. */
  close(): Promise<void>;
}

/** FIXED safe errors (no payload/reason text ever). */
export const INVALID_SCHEDULER_PAYLOAD_MESSAGE = 'scheduler job payload failed validation' as const;
export const SCHEDULER_RUN_RETRYABLE_MESSAGE = 'scheduler run result requested a retry' as const;
export const SCHEDULER_RUN_MALFORMED_MESSAGE = 'scheduler run client returned a malformed result' as const;

/** `scheduler-` + sha256 hex prefix: bounded to `[A-Za-z0-9-]` ⊂ request-id contract. */
const SCHEDULER_REQUEST_ID_PREFIX = 'scheduler-';
const SCHEDULER_REQUEST_ID_HASH_CHARS = 32;
/** Event fallback when a failed/completed event carries NO job (e.g. stalled). */
export const SCHEDULER_JOB_CONTEXT_ID_FALLBACK = 'unknown' as const;

/**
 * Pure deterministic correlation id for ONE BullMQ job occurrence: every
 * context binding for the same job id yields the SAME value, hostile job ids
 * (colons/unicode/overlong) hash to the same safe shape. `scheduler-` + 32
 * hex chars = 42 chars of `[A-Za-z0-9-]` (safe request-id contract).
 */
export function schedulerRequestId(jobId: string): string {
  const digest = createHash('sha256').update(jobId, 'utf8').digest('hex');
  return `${SCHEDULER_REQUEST_ID_PREFIX}${digest.slice(0, SCHEDULER_REQUEST_ID_HASH_CHARS)}`;
}

/**
 * Stringifies a BullMQ job id exactly like the log lines do; events without
 * a job collapse into the fixed, safe {@link SCHEDULER_JOB_CONTEXT_ID_FALLBACK}.
 */
export function schedulerJobContextId(jobId: unknown): string {
  if (typeof jobId === 'string' || typeof jobId === 'number') {
    return String(jobId);
  }
  return SCHEDULER_JOB_CONTEXT_ID_FALLBACK;
}

/** Runs `next`, optionally bound to the job's correlation context. */
function withOptionalJobContext<T>(
  withJobContext: SchedulerJobContextHook | undefined,
  jobId: unknown,
  next: () => T,
): T {
  if (withJobContext === undefined) {
    return next();
  }
  return withJobContext(schedulerJobContextId(jobId), next);
}

/**
 * The completed/failed event logging, extracted so tests can drive it
 * WITHOUT Redis: the SAME hook wraps the SAME stringified job id as the
 * processor, and the log text stays byte-identical to the previous behavior.
 */
export interface SchedulerWorkerEventHandlers {
  onCompleted(job: SchedulerJobLike | undefined): void;
  onFailed(job: SchedulerJobLike | undefined, error: unknown): void;
}

export function createSchedulerJobEventHandlers(
  logger: SchedulerLogger,
  withJobContext?: SchedulerJobContextHook,
): SchedulerWorkerEventHandlers {
  return {
    onCompleted(job): void {
      withOptionalJobContext(withJobContext, job?.id, () => {
        logger.warn(`scheduler-worker-completed ${String(job?.id)}`);
      });
    },
    onFailed(job, error): void {
      withOptionalJobContext(withJobContext, job?.id, () => {
        logger.error(`scheduler-worker-failed ${String(job?.id)}`, error);
      });
    },
  };
}

/**
 * Worker→BullMQ retry bridge for the result contract: `ok: true` resolves;
 * `ok: false` and malformed results throw FIXED safe errors so BullMQ's
 * attempts/backoff own the retry. Errors THROWN by the run client propagate
 * untouched (host-side permanence handling).
 */
function throwIfRunFailed(result: unknown): void {
  if (
    typeof result !== 'object' ||
    result === null ||
    typeof (result as { ok?: unknown }).ok !== 'boolean'
  ) {
    throw new Error(SCHEDULER_RUN_MALFORMED_MESSAGE);
  }
  if ((result as { ok: boolean }).ok) {
    return;
  }
  throw new Error(SCHEDULER_RUN_RETRYABLE_MESSAGE);
}

/**
 * One job → one run-client call. Unknown payloads/instants throw (BullMQ
 * retries); the run client's `ok:false` throws the fixed retryable error.
 */
export async function processSchedulerJob(
  job: SchedulerJobLike,
  runClient: SchedulerRunClient,
): Promise<void> {
  if (!isSchedulerJobData(job.data)) {
    throw new Error(INVALID_SCHEDULER_PAYLOAD_MESSAGE);
  }
  const data = job.data as SchedulerJobData;
  if ('taskId' in data) {
    const scheduledInput = scheduledInputFromJob(job);
    if (scheduledInput === null) {
      throw new Error(INVALID_SCHEDULER_PAYLOAD_MESSAGE);
    }
    throwIfRunFailed(await runClient.runScheduled(scheduledInput));
    return;
  }
  const executionInput = executionInputFromJob(job);
  if (executionInput === null) {
    throw new Error(INVALID_SCHEDULER_PAYLOAD_MESSAGE);
  }
  throwIfRunFailed(await runClient.runExecution(executionInput));
}

/** Creates the real BullMQ worker (or the factory-faked one) for a processor. */
export function createSchedulerWorker(options: SchedulerWorkerOptions): SchedulerWorkerHandle {
  const { runClient, logger } = options;
  const withJobContext = options.withJobContext;
  const queueName = options.queueName ?? SCHEDULER_QUEUE_NAME;
  const concurrency = options.concurrency ?? SCHEDULER_WORKER_CONCURRENCY;
  // Processor runs INSIDE the job's correlation context (when a hook is
  // configured), so the injected run client's outgoing calls observe it.
  const processor: SchedulerProcessor = (job) =>
    withOptionalJobContext(withJobContext, job.id, () => processSchedulerJob(job, runClient));

  let handle: SchedulerWorkerLike;
  if (options.workerFactory !== undefined) {
    handle = options.workerFactory(processor);
  } else {
    if (options.redisUrl === undefined) {
      throw new Error('createSchedulerWorker requires redisUrl (or a workerFactory).');
    }
    const connection = redisConnectionOptions(options.redisUrl, options.reconnectStrategy);
    const worker = new Worker<SchedulerJobData, unknown, string>(
      queueName,
      processor,
      // BullMQ OWNS the sockets created from this config object (duplicate
      // connections for blocking commands are all closed by worker.close()).
      { connection, concurrency },
    );
    const jobEvents = createSchedulerJobEventHandlers(logger, withJobContext);
    worker.on('completed', (job) => {
      jobEvents.onCompleted(job);
    });
    worker.on('failed', (job, error) => {
      jobEvents.onFailed(job, error);
    });
    worker.on('error', (error) => {
      logger.error('scheduler-worker-error', error);
    });
    handle = worker as unknown as SchedulerWorkerLike;
  }

  return {
    worker: handle,
    close: async (): Promise<void> => {
      // Bounded like every other teardown in this package: a worker may be
      // mid-drain, and the caller cannot wait forever.
      const timeoutMs = options.closeTimeoutMs ?? SCHEDULER_CLOSE_TIMEOUT_MS;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), timeoutMs);
        void Promise.resolve(handle.close()).then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          () => {
            clearTimeout(timer);
            resolve();
          },
        );
      });
    },
  };
}
