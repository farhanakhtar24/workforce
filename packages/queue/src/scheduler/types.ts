/**
 * Queue-side types for the scheduler bridge (`@workforce/queue`).
 *
 * ## Job payload shapes
 * Every job on the `workforce-scheduler` queue carries ONE of two payloads —
 * the union is discriminated by the key set (no `kind` key):
 * - `{ taskId, scheduledFor? }` — a SCHEDULED task run. Recurring jobs (job
 *   scheduler produced) carry only `taskId`; ONCE jobs additionally carry
 *   `scheduledFor` (ISO 8601 UTC 'Z'). The worker derives the instant for
 *   recurring jobs from BullMQ's own `prevMillis`/`timestamp` metadata.
 * - `{ executionId }` — a MANUAL/RETRY execution run.
 *
 * ## Injected run contract
 * The queue NEVER touches agents/providers/memory itself. It holds an
 * injected {@link SchedulerRunClient} whose two methods either
 * - return `{ ok: true }` (run finished — including `SKIPPED`,
 *   already-terminal, and other benign idempotent outcomes), or
 * - return `{ ok: false, reason? }` (transient/retryable failure — BullMQ
 *   owns the retry through its attempts/backoff), or
 * - THROWS a plain Error (permanent/internal failure — surfaces to the
 *   failure handler host-side).
 *
 * ## Secret safety
 * IDs are bounded (`AGENT_TASK_MAX_QUEUE_ID_LENGTH`); timestamps are strict
 * ISO 'Z'. All validation failures collapse into FIXED safe error messages —
 * no payload, reason, or URL text is ever echoed.
 */

import { AGENT_TASK_MAX_QUEUE_ID_LENGTH } from '@workforce/core/scheduler';

/** Job payload for SCHEDULED runs: recurring (no `scheduledFor`) or ONCE. */
export type SchedulerTaskJobData = {
  readonly taskId: string;
  /** ISO 8601 UTC 'Z' instant, present on ONCE jobs only. */
  readonly scheduledFor?: string;
};

/** Job payload for MANUAL/RETRY execution runs. */
export type SchedulerExecutionJobData = {
  readonly executionId: string;
};

export type SchedulerJobData = SchedulerTaskJobData | SchedulerExecutionJobData;

/**
 * Run outcome contract between the worker and the injected client.
 * `{ ok: true }` — terminal success (COMPLETED or SKIPPED, or the run was
 * already terminal = idempotent re-run). `{ ok: false }` — transient failure;
 * the worker throws a FIXED safe error so BullMQ retries with backoff.
 */
export type SchedulerRunResult =
  | { readonly ok: true }
  | { readonly ok: false; /** Short machine-safe code (e.g. `store-unavailable`); NEVER raw error text. */ readonly reason?: string };

/** Input of {@link SchedulerRunClient.runScheduled}. */
export interface SchedulerRunScheduledInput {
  readonly taskId: string;
  /** ISO 8601 UTC 'Z' instant the occurrence belongs to. */
  readonly scheduledFor: string;
  /** BullMQ job id of THIS occurrence, when the worker knows it. */
  readonly queueJobId?: string;
  /** Library-owned repeat job key, when BullMQ stamped one. */
  readonly repeatJobKey?: string;
  /** 1-based human attempt number (`job.attemptsMade + 1`). */
  readonly attempt: number;
}

/** Input of {@link SchedulerRunClient.runExecution}. */
export interface SchedulerRunExecutionInput {
  readonly executionId: string;
  /** BullMQ job id of THIS execution job, when the worker knows it. */
  readonly queueJobId?: string;
  /** 1-based human attempt number (`job.attemptsMade + 1`). */
  readonly attempt: number;
}

/**
 * The ONLY execution surface the worker calls. Neither method ever touches
 * providers directly; the host wires them to the scheduler service/store.
 */
export interface SchedulerRunClient {
  runScheduled(input: SchedulerRunScheduledInput): Promise<SchedulerRunResult>;
  runExecution(input: SchedulerRunExecutionInput): Promise<SchedulerRunResult>;
}

/**
 * Whether `value` is a bounded scheduler queue id: trimmed, 1..128 chars, no
 * control characters (matches the domain's `AGENT_TASK_MAX_QUEUE_ID_LENGTH`).
 */
export function isValidSchedulerQueueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= AGENT_TASK_MAX_QUEUE_ID_LENGTH &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/**
 * Optional per-job correlation hook (observability only, NEVER auth): wraps
 * ONE job's lifetime — the processor and its completed/failed event logging —
 * in a per-job async context keyed by the stringified BullMQ job id. Generic
 * over the callback's return type so async processors/`void` logging both
 * keep their context (AsyncLocalStorage propagation across awaits).
 */
export type SchedulerJobContextHook = <T>(jobId: string, next: () => T) => T;

/**
 * Whether `value` is an unambiguous ISO 8601 UTC instant string
 * (`YYYY-MM-DDTHH:MM:SS[.frac]Z`). A plain `Date` parse alone would accept
 * local-time and vendor formats; the domain boundary is 'Z' only.
 */
export function isIsoInstantZ(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) {
    return false;
  }
  return Number.isFinite(new Date(value).getTime());
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Strict payload guard: EXACTLY the task keys (`taskId`, optional
 * `scheduledFor`) or EXACTLY one `executionId` key, every value bounded.
 * Malformed payloads never reach the run client.
 */
export function isSchedulerJobData(value: unknown): value is SchedulerJobData {
  if (!isPlainRecord(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  const taskId = value['taskId'];
  if (typeof taskId === 'string') {
    if (!isValidSchedulerQueueId(taskId)) {
      return false;
    }
    if (keys.length === 1 && keys[0] === 'taskId') {
      return true; // recurring variant
    }
    return (
      keys.length === 2 &&
      keys[0] === 'scheduledFor' &&
      keys[1] === 'taskId' &&
      isIsoInstantZ(value['scheduledFor'])
    ); // ONCE variant
  }
  const executionId = value['executionId'];
  if (typeof executionId === 'string') {
    return keys.length === 1 && keys[0] === 'executionId' && isValidSchedulerQueueId(executionId);
  }
  return false;
}
