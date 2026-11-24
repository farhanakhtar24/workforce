/**
 * BullMQ queue + worker for async delegations (Phase 4): queue
 * `workforce-delegation`, one job per delegation with the DETERMINISTIC job id
 * `delegation-<delegationId>` (dedupe by id, never by wall clock), attempts 3,
 * exponential backoff, worker concurrency 2.
 *
 * Job payload: `{ delegationId, parentSlug }` — the worker does NOT run the
 * child itself. It POSTs the OWN run REST route
 * (`/api/agents/{parentSlug}/delegations/{delegationId}/run`), which performs
 * the child generation through the same chat endpoint humans use
 * (ADR-002/ADR-004). Retried jobs are safe: the run route returns the row
 * untouched when it is running/terminal, so there is never a second child
 * generation.
 *
 * Shutdown/drain choice (H3): the worker's close() is bounded the same way as
 * the memory worker (10 s) — a delegation run can legitimately occupy a job
 * for the full `DELEGATION_TIMEOUT_MS`. Rather than awaiting arbitrarily long
 * runs, a delegation left mid-flight (row `running`) is RECOVERED by the run
 * route on its next execution: once `row.updatedAt` (the running claim time)
 * exceeds the delegation budget, the route treats it as stale, reads the
 * child chat's durable transcript, and lands the row `completed` (recovered
 * answer) or `failed` — never a duplicate child generation. BullMQ retries
 * the same deterministic job id after a restart, which invokes exactly that
 * recovery path.
 *
 * Connection rules mirror `memory/bullmq-queue.ts`: BullMQ owns every socket
 * created from a config object, `maxRetriesPerRequest: null` is required, and
 * `close()` tears everything down without touching the chat Redis clients.
 */
import { Queue, Worker, type Job } from 'bullmq';
import { redisConnectionOptions, type RedisReconnectStrategy } from '../memory/bullmq-queue.js';
import type { SafeLogger } from '../logging.js';

export const DELEGATION_QUEUE_NAME = 'workforce-delegation';
export const DELEGATION_JOB_ATTEMPTS = 3;
export const DELEGATION_JOB_BACKOFF_BASE_MS = 1000;
export const DELEGATION_WORKER_CONCURRENCY = 2;

export interface DelegationJobData {
  readonly delegationId: string;
  readonly parentSlug: string;
  /**
   * The platform owner (Better Auth `User.id`) the delegation belongs to,
   * captured at CREATE time: BullMQ persists job payloads, so the async run
   * (including after a restart) recovers the SAME owner and can mint a
   * signed run context bound to the row. Ownerless legacy delegations are
   * never enqueued (the create route is authenticated).
   */
  readonly ownerId: string;
}

export function isDelegationJobData(value: unknown): value is DelegationJobData {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { delegationId?: unknown }).delegationId === 'string' &&
    typeof (value as { parentSlug?: unknown }).parentSlug === 'string' &&
    typeof (value as { ownerId?: unknown }).ownerId === 'string'
  );
}

/** Deterministic BullMQ job id for one delegation. */
export function delegationJobId(delegationId: string): string {
  return `delegation-${delegationId}`;
}

export function delegationJobOptions(): {
  attempts: number;
  backoff: { type: string; delay: number };
  removeOnComplete: { age: number; count: number };
} {
  return {
    attempts: DELEGATION_JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: DELEGATION_JOB_BACKOFF_BASE_MS },
    // Keep completed jobs inspectable (bounded) so a duplicate add sees the
    // finished state and never re-runs terminal delegations.
    removeOnComplete: { age: 604_800, count: 10_000 },
  };
}

/** Structural BullMQ queue surface so tests can inject fakes. */
export interface DelegationQueueLike {
  add(name: string, data: DelegationJobData, opts?: unknown): Promise<unknown>;
  getJob(jobId: string): Promise<{ getState(): Promise<string>; remove(): Promise<void> } | null | undefined>;
}

/** Structural BullMQ worker surface so tests can inject fakes. */
export interface DelegationWorkerLike {
  close(): Promise<void>;
}

export interface DelegationJobQueueOptions {
  redisUrl?: string;
  queue?: DelegationQueueLike;
  queueName?: string;
  logger?: SafeLogger;
  reconnectStrategy?: RedisReconnectStrategy;
}

export interface DelegationJobQueue {
  /** Enqueues one run job; duplicate ids while in-flight are no-ops. */
  enqueue(delegationId: string, parentSlug: string, ownerId: string): Promise<boolean>;
  ping(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export class BullMQDelegationJobQueue implements DelegationJobQueue {
  readonly queue: DelegationQueueLike;
  private closed = false;
  private readonly connectionOptions: import('ioredis').RedisOptions | null = null;

  constructor(options: DelegationJobQueueOptions) {
    const queueName = options.queueName ?? DELEGATION_QUEUE_NAME;
    if (options.queue !== undefined) {
      this.queue = options.queue;
      return;
    }
    if (options.redisUrl === undefined) {
      throw new Error('BullMQDelegationJobQueue requires a redisUrl (or an injected queue).');
    }
    this.connectionOptions = redisConnectionOptions(options.redisUrl, options.reconnectStrategy);
    this.queue = new Queue<DelegationJobData, void, string>(queueName, {
      connection: this.connectionOptions,
    }) as unknown as DelegationQueueLike;
  }

  async enqueue(delegationId: string, parentSlug: string, ownerId: string): Promise<boolean> {
    if (this.closed) {
      throw new Error('delegation queue is closed');
    }
    if (typeof ownerId !== 'string' || ownerId.length === 0) {
      throw new Error('delegation enqueue requires an ownerId');
    }
    const jobId = delegationJobId(delegationId);
    const existing = await this.queue.getJob(jobId);
    if (existing !== null && existing !== undefined) {
      const state = await existing.getState();
      if (state !== 'failed') {
        return false; // waiting/delayed/active/paused/completed — already scheduled or done.
      }
      await existing.remove(); // genuine requeue under the same deterministic id.
    }
    // The owner rides in the persisted payload: retried jobs (even across a
    // restart) recover the SAME owner for the signed run context.
    await this.queue.add('run', { delegationId, parentSlug, ownerId } as DelegationJobData, {
      ...delegationJobOptions(),
      jobId,
    });
    return true;
  }

  async ping(timeoutMs = 5_000): Promise<void> {
    if (this.connectionOptions === null) {
      return; // injected queue (tests): nothing to probe.
    }
    // One-shot client with the shared bounded-ping helper from the memory
    // queue module (same ioredis semantics; quit closes its socket).
    const { connectWithTimeout } = await import('../memory/bullmq-queue.js');
    const { Redis: IORedis } = await import('ioredis');
    const client = new IORedis(this.connectionOptions);
    try {
      await connectWithTimeout((c) => c.ping(), client, timeoutMs);
    } finally {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 10_000);
      const target = this.queue as unknown as { close?: () => Promise<void> };
      void Promise.resolve(target.close?.()).then(
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
  }
}

export interface DelegationRunJobClient {
  /**
   * Runs one delegation through the OWN run route with the owner from the
   * persisted job payload. Returns whether the call succeeded (2xx) —
   * terminal/running no-ops are successes.
   */
  run(delegationId: string, parentSlug: string, ownerId: string): Promise<boolean>;
}

export interface DelegationWorkerOptions {
  /** Executes the run REST call; injectable for offline tests. */
  runClient: DelegationRunJobClient;
  redisUrl?: string;
  queueName?: string;
  concurrency?: number;
  logger: SafeLogger;
  reconnectStrategy?: RedisReconnectStrategy;
  /** Injected worker factory (tests fake the BullMQ worker). */
  workerFactory?: (processor: (job: Job<DelegationJobData, void, string>) => Promise<void>) => DelegationWorkerLike;
}

export interface DelegationWorkerHandle {
  /** Underlying worker (real BullMQ Worker in production). */
  worker: unknown;
  /** Waits for active jobs then closes worker + sockets; bounded. */
  close(): Promise<void>;
}

/** One job → one run REST call. Unknown payloads throw (BullMQ retries then). */
export async function processDelegationJob(
  job: Pick<Job<DelegationJobData, void, string>, 'data' | 'id'>,
  runClient: DelegationRunJobClient,
): Promise<void> {
  const data: unknown = job.data;
  if (!isDelegationJobData(data)) {
    throw new Error('delegation job payload failed validation');
  }
  const ok = await runClient.run(data.delegationId, data.parentSlug, data.ownerId);
  if (!ok) {
    // Transient REST failure: throw so BullMQ's attempts/backoff own the
    // retry. The run route's row-state guarantee keeps retries idempotent.
    throw new Error('delegation run REST call failed');
  }
}

export function createDelegationWorker(options: DelegationWorkerOptions): DelegationWorkerHandle {
  const { runClient, logger } = options;
  const queueName = options.queueName ?? DELEGATION_QUEUE_NAME;
  const concurrency = options.concurrency ?? DELEGATION_WORKER_CONCURRENCY;

  let handle: DelegationWorkerLike;
  if (options.workerFactory !== undefined) {
    handle = options.workerFactory(async (job) => processDelegationJob(job, runClient));
  } else {
    if (options.redisUrl === undefined) {
      throw new Error('createDelegationWorker requires redisUrl (or a workerFactory).');
    }
    const connection = redisConnectionOptions(options.redisUrl, options.reconnectStrategy);
    const worker = new Worker<DelegationJobData, void, string>(
      queueName,
      (job) => processDelegationJob(job, runClient),
      { connection, concurrency },
    );
    worker.on('completed', (job) => {
      logger.warn(`delegation-worker-completed ${String(job.id)}`);
    });
    worker.on('failed', (job, error) => {
      logger.error(`delegation-worker-failed ${String(job?.id)}`, error);
    });
    worker.on('error', (error) => {
      logger.error('delegation-worker-error', error);
    });
    handle = worker;
  }

  return {
    worker: handle,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 10_000);
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
