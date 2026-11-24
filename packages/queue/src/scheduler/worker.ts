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
 */

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
import { isSchedulerJobData, type SchedulerJobData, type SchedulerRunClient } from './types.js';

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
  const queueName = options.queueName ?? SCHEDULER_QUEUE_NAME;
  const concurrency = options.concurrency ?? SCHEDULER_WORKER_CONCURRENCY;
  const processor: SchedulerProcessor = (job) => processSchedulerJob(job, runClient);

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
    worker.on('completed', (job) => {
      logger.warn(`scheduler-worker-completed ${String(job.id)}`);
    });
    worker.on('failed', (job, error) => {
      logger.error(`scheduler-worker-failed ${String(job?.id)}`, error);
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
