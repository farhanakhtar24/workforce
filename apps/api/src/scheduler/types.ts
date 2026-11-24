/**
 * Shared Phase 5 scheduler-module types (`apps/api/src/scheduler`): the
 * structural queue port the routes need and the run-service dependency
 * shapes. Nothing here touches BullMQ/Prisma directly — `src/server.ts` wires
 * the real implementations (`BullMQSchedulerQueue`, Prisma store + service).
 */

import type { AgentTask, AgentTaskExecution } from '@workforce/core/scheduler';
import type { SchedulerSyncResult } from '@workforce/queue/scheduler';
import type { SafeLogger } from '../logging.js';
import type { FetchLike } from '../agents/host-capabilities.js';

/**
 * Structural surface of the BullMQ scheduler queue the API layer owns (the
 * real `BullMQSchedulerQueue` from `@workforce/queue` satisfies this; tests
 * inject fakes). The API process NEVER runs the scheduler worker — it only
 * produces/syncs Redis job state and enqueues MANUAL/RETRY runs.
 */
export interface SchedulerQueuePort {
  /** Puts Redis job state in lockstep with one task row (after the DB write). */
  syncTask(task: AgentTask, now?: Date): Promise<SchedulerSyncResult>;
  /** Enqueues the deterministic `execution-<id>` job for MANUAL/RETRY runs. */
  enqueueExecution(execution: Pick<AgentTaskExecution, 'id'>): Promise<boolean>;
  /** Bounded startup PING (startup honesty; injected fakes are no-ops). */
  ping(timeoutMs?: number): Promise<void>;
  /** Bounded, idempotent teardown. */
  close(): Promise<void>;
}

/**
 * Fixed safe error texts for the `/api/scheduler` routes. Every client-facing
 * failure is one of these constants — no store/queue/provider text, no ids
 * from payloads, ever.
 */
export const INVALID_SCHEDULER_REQUEST = 'Invalid scheduler request.';
export const SCHEDULER_TASK_NOT_FOUND = 'Task not found.';
export const SCHEDULER_EXECUTION_NOT_FOUND = 'Execution not found.';
export const SCHEDULER_CONFLICT = 'Scheduler conflict.';
export const SCHEDULER_STORE_UNAVAILABLE = 'Scheduler service is temporarily unavailable.';
export const SCHEDULER_QUEUE_UNAVAILABLE = 'Scheduler queue is temporarily unavailable.';
export const SCHEDULER_WORKER_HEADER_REQUIRED = 'Scheduler worker header required.';

/**
 * Bounded budgets for the scheduler run service (defaults follow the Phase 5
 * spec; tests shorten them). `executionTimeoutMs` bounds ONE internal chat
 * POST (plus {@link SCHEDULER_RUN_STREAM_MARGIN_MS}); every ordinary metadata
 * call (hydration/resume) uses `metadataTimeoutMs`.
 */
export const SCHEDULER_RUN_STREAM_MARGIN_MS = 10_000 as const;
export const SCHEDULER_METADATA_TIMEOUT_MS = 30_000 as const;
/** A RUNNING execution untouched for at least this long counts as stale. */
export const SCHEDULER_RUNNING_STALE_MS = 30_000 as const;

export interface SchedulerRunBudgets {
  readonly fetchFn: FetchLike;
  /** Loopback base URL the runner posts the isolated chats to. */
  readonly baseUrl: string;
  /** Budget (ms) for one internal chat POST; stream margin added on top. */
  readonly executionTimeoutMs: number;
  /** Budget (ms) for bounded metadata calls (hydration + resume). */
  readonly metadataTimeoutMs: number;
  /** Stale threshold (ms) for RUNNING rows in recovery. */
  readonly staleRunningMs: number;
  readonly logger: SafeLogger;
}

/** Fixed safe failure text routes land on rows after enqueue failures. */
export const RUN_ERROR_QUEUE_ENQUEUE = 'The scheduler queue was unavailable, so the execution was dead-lettered.';
