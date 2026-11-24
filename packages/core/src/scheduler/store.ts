/**
 * The scheduler store contract behind {@link SchedulerService}. Two
 * implementations ship:
 *
 * - `InMemorySchedulerStore` (`./stores/in-memory-scheduler-store.js`) —
 *   exact synchronous-critical-section store for fast unit tests.
 * - `PrismaSchedulerStore` (`./postgres/index.js`, subpath
 *   `@workforce/core/scheduler/postgres`) — Prisma/Postgres adapter. Import
 *   it ONLY via the subpath so consumers that don't need Postgres (the CLI,
 *   pure domain tests) never load the generated Prisma client.
 *
 * Contract notes (both implementations, tested per store):
 * - Task writes: `createTask`/`updateTask` run in ONE atomic critical section
 *   (Map semantics in memory; `SELECT ... FOR UPDATE` on the AgentTask row in
 *   Postgres). `updateTask` preserves `id` and applies the parsed patch;
 *   recurrence changes RECOMPUTE `nextRunAt` (after = the supplied
 *   `afterAsOf` instant or the store clock); `nextRunAt` alone sets/exact-
 *   clears the value; `isActive` changes ONLY via `setTaskActive`.
 * - Executions: `chatId` ALWAYS equals the execution `id` (isolated chat per
 *   execution). `createExecution` returns `{ execution, created }`:
 *   - trigger SCHEDULED: the (taskId, scheduledFor) tuple holds at most ONE
 *     row EVER (only-SCHEDULED uniqueness, SQL partial index in Postgres).
 *     A duplicate create returns the EXISTING row with `created: false` —
 *     atomically, with no second row ever written.
 *   - trigger MANUAL or RETRY: always a NEW row (`created: true`).
 * - `claimExecution` is an atomic compare-and-set PENDING|RETRYING ->
 *   RUNNING under the execution row (lock). The requested `attempt` must
 *   equal `current + 1`. Same-status RUNNING is NOT an idempotent claim; a
 *   fresh RUNNING/terminal row throws the typed conflict.
 * - `markExecution` is the CAS transition runner: RUNNING -> RETRYING |
 *   COMPLETED | FAILED | DEAD_LETTER and PENDING -> SKIPPED ONLY. Terminal
 *   rows are immutable; a repeat of the SAME terminal outcome is idempotent
 *   ONLY when the payload is equivalent (COMPLETED: durationMs + tokenUsage;
 *   FAILED/DEAD_LETTER: error text) — otherwise a typed conflict. There is
 *   no dead_letter -> pending: RETRY creates a NEW execution row.
 * - Dates: ISO strings at the public boundary (see `./types.js`).
 * - Queue sync (BullMQ enqueue/remove/repeat) belongs to the API layer —
 *   core only records rows and never touches HTTP/Redis.
 */

import type { AgentMode, AgentSlug } from '../agents/types.js';
import type {
  AgentTaskExecutionStatus,
  AgentTaskTrigger,
  RecurrenceType,
} from './kinds.js';
import type { AgentTask, AgentTaskExecution, AgentTaskExecutionTokenUsage, AgentTaskRecurrenceConfig } from './types.js';

/** Payload for creating one task. `nextRunAt` derives from the recurrence. */
export interface SchedulerStoreTaskCreate {
  /** Optional id for deterministic tests. */
  readonly id?: string;
  readonly name: string;
  readonly agentSlug: AgentSlug;
  readonly mode: AgentMode;
  readonly prompt: string;
  /** Optional — the store defaults to the memory-domain `"default"` scope. */
  readonly scope?: string;
  readonly recurrenceType: RecurrenceType;
  readonly recurrenceConfig: AgentTaskRecurrenceConfig;
  /** Optional — the store defaults to no skips. */
  readonly skipDates?: readonly string[];
  /** Optional creation timestamp override (ISO string or Date). */
  readonly now?: string | Date;
  /** Supplied instant the initial nextRunAt computes AFTER; defaults to `now`. */
  readonly afterAsOf?: string | Date | null;
}

/**
 * Patch for an atomic task update. `id` is required and preserved; at least
 * one field must be present (service schemas enforce). `recurrenceType` and
 * `recurrenceConfig` travel together and force a nextRunAt recompute;
 * explicit `nextRunAt` wins only when no recurrence field is present.
 */
export interface SchedulerStoreTaskUpdate {
  readonly id: string;
  readonly name?: string;
  readonly prompt?: string;
  readonly agentSlug?: AgentSlug;
  readonly mode?: AgentMode;
  readonly scope?: string;
  readonly recurrenceType?: RecurrenceType;
  readonly recurrenceConfig?: AgentTaskRecurrenceConfig;
  readonly skipDates?: readonly string[];
  /** Explicit override (clears when null); ignored on recurrence updates. */
  readonly nextRunAt?: string | null;
  /** Supplied instant recompute runs AFTER; defaults to the store clock. */
  readonly afterAsOf?: string | Date | null;
  readonly now?: string | Date;
}

/** Filters for `listTasks`. Absent filters are unconstrained. */
export interface SchedulerStoreTaskListParams {
  /** `newest` = descending createdAt then id; `oldest` = ascending both. */
  readonly order?: 'newest' | 'oldest';
  /** 1..100 enforced by schemas; stores trust but bound defensively. */
  readonly limit?: number;
}

/** Payload for recording one execution row. */
export interface SchedulerStoreExecutionCreate {
  /** Optional id for deterministic tests; `chatId` is derived from it. */
  readonly id?: string;
  readonly scheduledFor: string | Date;
  readonly trigger: AgentTaskTrigger;
  readonly queueJobId?: string | null;
  readonly repeatJobKey?: string | null;
  readonly retryOfExecutionId?: string | null;
  /** Optional create-timestamp override (deterministic tests). */
  readonly now?: string | Date;
}

/** Result of `createExecution`: the row plus whether this call created it. */
export interface SchedulerStoreExecutionCreateResult {
  readonly execution: AgentTaskExecution;
  /**
   * `true` when this call inserted the row; `false` when the atomic
   * duplicate-SCHEDULED path returned an existing row (no second row).
   */
  readonly created: boolean;
}

/** Filters for `listExecutions`. Combined filters are ANDed. */
export interface SchedulerStoreExecutionListParams {
  readonly taskId?: string;
  readonly status?: AgentTaskExecutionStatus;
  /** `newest` = descending createdAt then id (default); `oldest` = ascending. */
  readonly order?: 'newest' | 'oldest';
  readonly limit?: number;
}

/** Payload for the atomic claim (compare-and-set) to RUNNING. */
export interface SchedulerStoreExecutionClaim {
  readonly id: string;
  /** Must equal the row's current attempt + 1 (1..3). */
  readonly attempt: number;
  /** The status expected atomically: PENDING or RETRYING. */
  readonly allowedFrom: AgentTaskExecutionStatus;
}

/** The five CAS writes. Targets and their expected statuses are fixed. */
export const schedulerMarkTargets = ['RETRYING', 'COMPLETED', 'FAILED', 'DEAD_LETTER', 'SKIPPED'] as const;

export type SchedulerMarkTarget = (typeof schedulerMarkTargets)[number];

export interface SchedulerStoreExecutionMark {
  readonly id: string;
  readonly target: SchedulerMarkTarget;
  /** Only COMPLETED carries durationMs (integer >= 0). */
  readonly durationMs?: number | null;
  /** Only COMPLETED carries tokenUsage when supplied. */
  readonly tokenUsage?: AgentTaskExecutionTokenUsage | null;
  /** Only FAILED/DEAD_LETTER carry error (trimmed 1..1000). */
  readonly error?: string | null;
  /** Optional clock override for deterministic tests. */
  readonly now?: string | Date;
}

export interface SchedulerStore {
  /** Atomic create; duplicate explicit id -> typed conflict. */
  createTask(data: SchedulerStoreTaskCreate): Promise<AgentTask>;

  /**
   * Atomic CAS-free patch (the row identity never changes): missing task ->
   * typed 404. Applies the patch and recomputes `nextRunAt` per the contract
   * above, all inside one critical section.
   */
  updateTask(data: SchedulerStoreTaskUpdate): Promise<AgentTask>;

  getTask(id: string): Promise<AgentTask | null>;

  /** Bounded deterministic listing (createdAt then id tie-break). */
  listTasks(params?: SchedulerStoreTaskListParams): Promise<readonly AgentTask[]>;

  /** The ONLY way `isActive` changes (missing task -> typed 404). */
  setTaskActive(id: string, isActive: boolean): Promise<AgentTask>;

  /**
   * Record one execution row atomically. The task must exist (typed 404).
   * RETRY rows additionally require the referenced source execution to exist,
   * be DEAD_LETTER, and belong to the SAME task (typed 404/409).
   */
  createExecution(task: AgentTask, data: SchedulerStoreExecutionCreate): Promise<SchedulerStoreExecutionCreateResult>;

  getExecution(id: string): Promise<AgentTaskExecution | null>;

  /** Bounded deterministic listing (createdAt then id tie-break). */
  listExecutions(params?: SchedulerStoreExecutionListParams): Promise<readonly AgentTaskExecution[]>;

  /**
   * Atomic CAS claim to RUNNING: exactly one concurrent candidate wins; every
   * loser gets the typed conflict. The requested attempt must be current + 1.
   */
  claimExecution(data: SchedulerStoreExecutionClaim): Promise<AgentTaskExecution>;

  /**
   * Atomic CAS transition to `target` (RUNNING -> RETRYING/COMPLETED/FAILED/
   * DEAD_LETTER; PENDING -> SKIPPED). Terminal rows immutable; same-outcome
   * repeats idempotent only with an equivalent payload, else typed conflict.
   */
  markExecution(data: SchedulerStoreExecutionMark): Promise<AgentTaskExecution>;
}
