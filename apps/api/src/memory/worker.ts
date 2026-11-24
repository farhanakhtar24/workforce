/**
 * BullMQ `Worker` for the `workforce-memory` queue (Phase 3).
 *
 * Responsibilities:
 * - Parse the discriminated job payload safely; unknown shapes throw (never
 *   processed silently).
 * - Delegate to `MemoryService.processEmbedding` / `processCompaction` and
 *   RETHROW so BullMQ's retry/backoff owns failure handling (attempts: 3,
 *   exponential base 1000 ms). The service marks blocks `failed` honestly
 *   before every rethrow.
 * - Event logging is safe: ids and payload kind only — never block contents,
 *   vectors, provider bodies, or URLs.
 * - `maxRetriesPerRequest: null` on its own ioredis connection (blocking ops)
 *   and a closing helper that never breaks the existing node-redis clients
 *   used by resumable-stream.
 */
import { Worker, type Job } from 'bullmq';
import type { MemoryService } from '@workforce/core/memory';
import {
  MEMORY_QUEUE_NAME,
  isMemoryJobData,
  redisConnectionOptions,
  type MemoryJobData,
  type RedisReconnectStrategy,
} from './bullmq-queue.js';
import { processPersonalCaptureJob, type PersonalCaptureWorkerDeps } from './personal-capture.js';
import type { SafeLogger } from '../logging.js';

export interface MemoryWorkerOptions {
  service: MemoryService;
  redisUrl: string;
  /** Queue name override; default {@link MEMORY_QUEUE_NAME} (tests isolate). */
  queueName?: string;
  /** Worker concurrency; default 2 per spec. */
  concurrency?: number;
  logger: SafeLogger;
  /** ioredis reconnect strategy override (tests fail fast). */
  reconnectStrategy?: RedisReconnectStrategy;
  /**
   * Pre-Phase 6 opt-in personal capture handler. REQUIRED for `capture`
   * jobs: when absent they fail honestly (job lands in the failed log).
   */
  personalCapture?: PersonalCaptureWorkerDeps;
}

export interface MemoryWorkerHandle {
  worker: Worker<MemoryJobData, void, string>;
  /** Waits for active jobs then closes worker + its ioredis connection. */
  close(): Promise<void>;
}

/**
 * One job = one service call. Unknown payloads throw a stable error so the
 * job fails (and lands in the failed log) instead of being swallowed.
 */
export async function processMemoryJob(
  job: Job<MemoryJobData, void, string>,
  service: MemoryService,
  personalCapture?: PersonalCaptureWorkerDeps,
): Promise<void> {
  const data: unknown = job.data;
  if (!isMemoryJobData(data)) {
    throw new Error('memory job payload failed validation');
  }
  if (data.kind === 'embed') {
    await service.processEmbedding(data.blockId);
    return;
  }
  if (data.kind === 'compact') {
    await service.processCompaction(data.scope, data.path, data.triggerBlockId);
    return;
  }
  // Pre-Phase 6 opt-in personal capture: re-checked enablement, duplicate
  // guard, bounded extractor, one derived block (or a silent no-op).
  if (personalCapture === undefined) {
    throw new Error('memory job payload failed validation');
  }
  const outcome = await processPersonalCaptureJob(data, personalCapture);
  personalCapture.logger.debug?.(`personal-capture ${outcome} ${data.scope}/${personalChatPathForLog(data.chatId)} assistant ${data.assistantMessageId}`);
}

/** Log-only bounded path (ids are safe; chats/{id} is the derived path). */
function personalChatPathForLog(chatId: string): string {
  return `chats/${chatId.toLowerCase()}`;
}

export function createMemoryWorker(options: MemoryWorkerOptions): MemoryWorkerHandle {
  const { service, logger } = options;
  const queueName = options.queueName ?? MEMORY_QUEUE_NAME;
  const concurrency = options.concurrency ?? 2;

  // BullMQ OWNS sockets created from a config object (incl. its internal
  // blocking duplicate): maxRetriesPerRequest null is REQUIRED and close()
  // tears every owned socket down. An instance connection leaks duplicates
  // when close() hangs.
  const connection = redisConnectionOptions(options.redisUrl, options.reconnectStrategy);

  const worker = new Worker<MemoryJobData, void, string>(
    queueName,
    (job) => processMemoryJob(job, service, options.personalCapture),
    { connection, concurrency },
  );

  worker.on('completed', (job) => {
    const kind = typeof job.data?.kind === 'string' ? job.data['kind'] : 'unknown';
    logger.warn(`memory-worker-completed ${String(job.id)} ${kind}`);
  });
  worker.on('failed', (job, error) => {
    const kind = typeof job?.data?.kind === 'string' ? job.data['kind'] : 'unknown';
    logger.error(`memory-worker-failed ${String(job?.id)} ${kind}`, error);
  });
  worker.on('error', (error) => {
    // Worker-level (non-job) failures: connection loss, etc.
    logger.error('memory-worker-error', error);
  });

  return {
    worker,
    close: async (): Promise<void> => {
      // BullMQ owns its sockets (main + blocking duplicates): the only correct
      // teardown is worker.close(). Bounded so a hung close cannot stall the
      // caller's shutdown forever.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 10_000);
        void Promise.resolve(worker.close()).then(
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
