/**
 * Constants of the scheduler queue (Phase 5), mirroring the Phase 3/4 queue
 * shapes (`workforce-memory`, `workforce-delegation`): attempts 3, exponential
 * backoff base 1000 ms, worker concurrency 2, bounded completed retention
 * (`removeOnComplete { age: 604800, count: 10000 }`) and
 * `removeOnFail: false` — a failed job STAYS in the queue as dead-letter
 * evidence (`removeJobScheduler`/retry tooling can inspect it; the store's
 * DEAD_LETTER row is the domain-side counterpart).
 */

/** Queue name fixed for agent-task scheduler + executions (Phase 5). */
export const SCHEDULER_QUEUE_NAME = 'workforce-scheduler';

/** Attempts for every scheduler job (BullMQ `attempts`, incl. the first run). */
export const SCHEDULER_JOB_ATTEMPTS = 3;

/** Base delay (ms) of the exponential backoff for retried jobs. */
export const SCHEDULER_JOB_BACKOFF_BASE_MS = 1000;

/** Fixed worker concurrency (matches the delegation worker budget). */
export const SCHEDULER_WORKER_CONCURRENCY = 2;

/** Completed jobs stay inspectable for 7 days (604800 s), bounded by count. */
export const SCHEDULER_COMPLETED_RETENTION_AGE_SECONDS = 604_800 as const;
export const SCHEDULER_COMPLETED_RETENTION_COUNT = 10_000 as const;

/** Bounded teardown budget for queue/worker `close()` (ms). */
export const SCHEDULER_CLOSE_TIMEOUT_MS = 10_000 as const;

/** Default bound for the startup PING (ms). */
export const SCHEDULER_PING_TIMEOUT_MS = 5_000 as const;

/** BullMQ job name of every scheduled (`agent-task`) job: recurring and ONCE. */
export const SCHEDULER_TASK_JOB_NAME = 'agent-task' as const;

/** BullMQ job name of MANUAL/RETRY execution jobs. */
export const SCHEDULER_EXECUTION_JOB_NAME = 'agent-execution' as const;
