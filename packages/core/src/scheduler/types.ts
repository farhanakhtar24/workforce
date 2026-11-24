/**
 * Scheduler domain types (pure data; transport/queue live in the API layer).
 *
 * ## Date representation (documented choice, mirrors memory/work-docs)
 * Every timestamp is an ISO 8601 UTC string at the public boundary, keeping
 * tasks/exports JSON-serializable without a normalization layer. Stores
 * convert to their native representation.
 *
 * ## chatId IS the execution id (documented choice)
 * `AgentTaskExecution.chatId` is an ISOLATED chat bound to exactly this
 * execution: one execution — one chat. The domain copies `id` into `chatId`
 * at create time, so the global uniqueness the Phase 5 spec requires is
 * structural, and one execution can never write into another execution's
 * chat.
 *
 * ## Recurrence shape is discriminated by `recurrenceType`
 * `recurrenceConfig` carries NO type key (no arbitrary keys): the
 * `recurrenceType` field decides which shape `recurrenceConfig` must have.
 * See `./schemas.js` and `./recurrence.js`.
 *
 * ## Terminal rows are immutable
 * Once an execution reaches COMPLETED|FAILED|DEAD_LETTER|SKIPPED it never
 * changes again (not even a same-status rewrite, except a payload-equivalent
 * repeat that returns the row unchanged — see the store contract).
 */

import type { AgentTaskTrigger, AgentTaskExecutionStatus, RecurrenceType } from './kinds.js';
import type { AgentMode, AgentSlug } from '../agents/types.js';

/**
 * Per-`recurrenceType` schedule shape. Exactly ONE of the variants applies —
 * which one is pinned by {@link AgentTask.recurrenceType}:
 * - `ONCE`        -> `{ runAt: ISO datetime (UTC 'Z') }`
 * - `DAILY`       -> `{ hour: 0..23, minute: 0..59 }`
 * - `WEEKLY`      -> `{ hour, minute, weekdays: nonempty unique 0..6 }` (0=Sunday)
 * - `MONTHLY`     -> `{ hour, minute, daysOfMonth: nonempty unique 1..31 }`
 * - `CUSTOM_CRON` -> `{ expression: 5-field cron expression (<=200 chars) }`
 */
export type AgentTaskRecurrenceConfig =
  | { readonly runAt: string }
  | { readonly hour: number; readonly minute: number }
  | { readonly hour: number; readonly minute: number; readonly weekdays: readonly number[] }
  | { readonly hour: number; readonly minute: number; readonly daysOfMonth: readonly number[] }
  | { readonly expression: string };

/** A scheduled agent task definition. Mutations NEVER change `id`. */
export interface AgentTask {
  readonly id: string;
  /** Trimmed, 1..200 characters. */
  readonly name: string;
  /** Reuses the Phase 4 agent vocabulary (general/orchestrator/analyst/researcher). */
  readonly agentSlug: AgentSlug;
  /** Plan drafting (read only) versus action execution. */
  readonly mode: AgentMode;
  /** Trimmed, 1..10000 characters. */
  readonly prompt: string;
  /** Memory-domain scope rules (1..64 lowercase `[a-z0-9_-]`); default `default`. */
  readonly scope: string;
  readonly recurrenceType: RecurrenceType;
  /** Shape pinned by `recurrenceType`; no type key, no arbitrary keys. */
  readonly recurrenceConfig: AgentTaskRecurrenceConfig;
  /** Unique `YYYY-MM-DD` UTC dates on which the recurring schedule is skipped. */
  readonly skipDates: readonly string[];
  readonly isActive: boolean;
  /** Fixed literal — the whole domain computes in UTC (DST-free). */
  readonly timezone: 'UTC';
  /** Next queued occurrence; null for past ONCE or exhausted schedules. */
  readonly nextRunAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * The platform user (Better Auth `User.id`, TEXT) that owns this task, or
   * `null` for LEGACY rows. Core keeps ownership optional at call sites; the
   * authenticated API layer MUST always pass an owner filter/creation value
   * so users never touch each other's (or legacy ownerless) rows. Owner
   * filters match EXACTLY — an expected owner never matches ownerless rows
   * (what startup reconciliation needs: `ownedOnly: true` selects ONLY rows
   * with `ownerId != null`).
   */
  readonly ownerId: string | null;
}

/** Structured token usage for one execution. Fields are finite nonnegative integers. */
export interface AgentTaskExecutionTokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

/** One run of one agent task. Terminal rows are immutable. */
export interface AgentTaskExecution {
  readonly id: string;
  readonly taskId: string;
  /** When the queue intended the run to happen (exact instant; ms precision). */
  readonly scheduledFor: string;
  readonly trigger: AgentTaskTrigger;
  readonly status: AgentTaskExecutionStatus;
  /** 0 while PENDING; 1..3 once claimed (`maxAttempts` = 3, always). */
  readonly attempt: number;
  /** Fixed at 3 by the Phase 5 spec. */
  readonly maxAttempts: number;
  /** Integer >= 0; set by the COMPLETED mark. */
  readonly durationMs: number | null;
  readonly tokenUsage: AgentTaskExecutionTokenUsage | null;
  /** Trimmed, 1..1000 characters when supplied; host passes SAFE text only. */
  readonly error: string | null;
  /** Isolated chat id for this execution — always equal to `id`. */
  readonly chatId: string;
  readonly queueJobId: string | null;
  readonly repeatJobKey: string | null;
  /** Set on RETRY rows; points at a DEAD_LETTER execution of the SAME task. */
  readonly retryOfExecutionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Stamped exactly once, at the first terminal CAS; never rewritten. */
  readonly finishedAt: string | null;
  /**
   * The platform user (Better Auth `User.id`, TEXT) that owns this execution,
   * or `null` for LEGACY rows. Defaults to the task's owner at creation time
   * (an execution belongs to its task's tenant); an explicit creation
   * `ownerId` overrides. Owner filters match EXACTLY — an expected owner
   * never matches ownerless rows; the authenticated API layer MUST always
   * pass one.
   */
  readonly ownerId: string | null;
}
