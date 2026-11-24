/**
 * Pure job helpers of the scheduler bridge: deterministic job ids, the shared
 * job-options contract, ONCE delay math, and the pure job→run-input
 * extraction used by the processor (`scheduledInputFromJob`,
 * `executionInputFromJob`). All are pure functions so unit tests can assert
 * parsing WITHOUT BullMQ or Redis.
 */

import type { SchedulerRunExecutionInput, SchedulerRunScheduledInput } from './types.js';
import { isIsoInstantZ, isSchedulerJobData } from './types.js';
import {
  SCHEDULER_COMPLETED_RETENTION_AGE_SECONDS,
  SCHEDULER_COMPLETED_RETENTION_COUNT,
  SCHEDULER_JOB_ATTEMPTS,
  SCHEDULER_JOB_BACKOFF_BASE_MS,
} from './constants.js';

/**
 * BullMQ job options shared by every scheduler job. `removeOnFail: false`
 * keeps failed jobs in the queue as dead-letter evidence.
 */
export function schedulerJobOptions(): {
  attempts: number;
  backoff: { type: string; delay: number };
  removeOnComplete: { age: number; count: number };
  removeOnFail: boolean;
} {
  return {
    attempts: SCHEDULER_JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: SCHEDULER_JOB_BACKOFF_BASE_MS },
    // Keep completed jobs inspectable (bounded) so deterministic-id dedupe
    // sees the finished state and never re-runs terminal work.
    removeOnComplete: {
      age: SCHEDULER_COMPLETED_RETENTION_AGE_SECONDS,
      count: SCHEDULER_COMPLETED_RETENTION_COUNT,
    },
    // Retained failed jobs ARE the DLQ evidence — never auto-remove.
    removeOnFail: false,
  };
}

/**
 * Deterministic BullMQ job id of a task's pending ONCE run.
 * COLON-FREE on purpose: BullMQ rejects `:` in custom job ids, so the id is
 * `once-<taskId>` (a colon would make `queue.add` throw at runtime).
 */
export function schedulerOnceJobId(taskId: string): string {
  return `once-${taskId}`;
}

/** Deterministic BullMQ job id of a MANUAL/RETRY execution run. */
export function schedulerExecutionJobId(executionId: string): string {
  return `execution-${executionId}`;
}

/**
 * BullMQ `delay` for a ONCE job so it fires AT the desired instant
 * (`scheduledFor`), never before. Overflow/negative targets clamp to 0.
 */
export function onceDelayMs(scheduledFor: string, now: Date): number {
  const target = Date.parse(scheduledFor);
  if (!Number.isFinite(target)) {
    return 0;
  }
  return Math.max(0, target - now.getTime());
}

/**
 * Minimal structural surface of a BullMQ `Job` the pure helpers need.
 * Production `Job<SchedulerJobData>` values satisfy this structurally.
 */
export interface SchedulerJobLike {
  readonly data: unknown;
  /** BullMQ job id; `undefined`/`null` in fake jobs without one. */
  readonly id?: string | number | null;
  /** BullMQ stamps the enqueue time (ms). */
  readonly timestamp?: number;
  /** Attempts made BEFORE this run; the human attempt is this + 1. */
  readonly attemptsMade?: number;
  /** Library-owned repeat key of job-scheduler-produced jobs. */
  readonly repeatJobKey?: string | null;
  /** Job options; for recurring jobs `opts.repeat.prevMillis` holds the iteration instant. */
  readonly opts?: unknown;
}

/** `String(job.id)` when the job has an id; otherwise undefined. */
export function queueJobIdOf(job: SchedulerJobLike): string | undefined {
  return job.id === undefined || job.id === null ? undefined : String(job.id);
}

/** Human 1-based attempt number for a job (missing counters read as fresh). */
export function schedulerAttemptOf(job: SchedulerJobLike): number {
  const made = job.attemptsMade;
  return typeof made === 'number' && Number.isInteger(made) && made >= 0 ? made + 1 : 1;
}

/**
 * Reads the occurrence instant BullMQ stamped on a job-scheduler-produced
 * job: `opts.repeat.prevMillis` (the canonical BullMQ location) with a
 * shallow `opts.prevMillis` tolerated for fakes; falls back to `timestamp`.
 * Returns null when neither is a finite number.
 */
export function deriveScheduledForFromJob(job: SchedulerJobLike): string | null {
  const prevMillis = jobPrevMillis(job);
  if (prevMillis !== null) {
    return new Date(prevMillis).toISOString();
  }
  const timestamp = job.timestamp;
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }
  return null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function jobPrevMillis(job: SchedulerJobLike): number | null {
  const opts = job.opts;
  if (typeof opts !== 'object' || opts === null) {
    return null;
  }
  const record = opts as { prevMillis?: unknown; repeat?: { prevMillis?: unknown } | null };
  const nested = record.repeat === null || record.repeat === undefined ? null : readNumber(record.repeat.prevMillis);
  return nested ?? readNumber(record.prevMillis);
}

/**
 * PURE: extracts the `runScheduled` input a job promises, or null when the
 * payload/ids/instant fail validation. `data.scheduledFor` (ONCE) wins over
 * the derived BullMQ iteration instant; `repeatJobKey` is passed through only
 * when BullMQ stamped one.
 */
export function scheduledInputFromJob(job: SchedulerJobLike): SchedulerRunScheduledInput | null {
  if (!isSchedulerJobData(job.data)) {
    return null;
  }
  const data = job.data;
  if (!('taskId' in data)) {
    return null; // execution variant belongs to executionInputFromJob
  }
  const taskId = data.taskId;
  const scheduledFor = 'scheduledFor' in data ? data.scheduledFor : undefined;
  const instant = scheduledFor ?? deriveScheduledForFromJob(job);
  if (instant === null) {
    return null;
  }
  const queueJobId = queueJobIdOf(job);
  const repeatJobKey = typeof job.repeatJobKey === 'string' && job.repeatJobKey.length > 0 ? job.repeatJobKey : undefined;
  return {
    taskId,
    scheduledFor: instant,
    ...(queueJobId === undefined ? {} : { queueJobId }),
    ...(repeatJobKey === undefined ? {} : { repeatJobKey }),
    attempt: schedulerAttemptOf(job),
  };
}

/**
 * PURE: extracts the `runExecution` input a MANUAL/RETRY job promises, or
 * null when the payload/ids fail validation.
 */
export function executionInputFromJob(job: SchedulerJobLike): SchedulerRunExecutionInput | null {
  if (!isSchedulerJobData(job.data)) {
    return null;
  }
  const data = job.data;
  if (!('executionId' in data)) {
    return null; // task variant belongs to scheduledInputFromJob
  }
  const executionId = data.executionId;
  const queueJobId = queueJobIdOf(job);
  return {
    executionId,
    ...(queueJobId === undefined ? {} : { queueJobId }),
    attempt: schedulerAttemptOf(job),
  };
}
