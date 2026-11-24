/**
 * Scheduler vocabulary (Phase 5): recurrence types, execution triggers,
 * execution statuses, and every numeric bound pinned by the Phase 5 spec.
 *
 * Constants only — no imports — so every other scheduler module can depend on
 * this file without cycles. Enum VALUES are the public API strings (SCREAMING
 * CASE); the Prisma enum columns store the lowercase DB spellings and the
 * Postgres adapter maps between them (see `./postgres/index.js`).
 */

/** How a task repeats. */
export const recurrenceTypes = ['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM_CRON'] as const;

export type RecurrenceType = (typeof recurrenceTypes)[number];

/** Who asked for one execution row to exist. */
export const agentTaskTriggers = ['SCHEDULED', 'MANUAL', 'RETRY'] as const;

export type AgentTaskTrigger = (typeof agentTaskTriggers)[number];

/** Lifecycle of one execution row. */
export const agentTaskExecutionStatuses = [
  'PENDING',
  'RUNNING',
  'RETRYING',
  'COMPLETED',
  'FAILED',
  'DEAD_LETTER',
  'SKIPPED',
] as const;

export type AgentTaskExecutionStatus = (typeof agentTaskExecutionStatuses)[number];

/** Never changes again. */
export const agentTaskExecutionTerminalStatuses = ['COMPLETED', 'FAILED', 'DEAD_LETTER', 'SKIPPED'] as const;

/**
 * Allowed CAS transitions for {@link SchedulerService.markExecution}.
 * CLAIMS (PENDING|RETRYING -> RUNNING) are NOT transitions — they have their
 * own atomic path (`claimExecution`) because a claim is not idempotent.
 */
export const agentTaskExecutionTransitions: Readonly<
  Record<AgentTaskExecutionStatus, readonly AgentTaskExecutionStatus[]>
> = {
  PENDING: ['SKIPPED'],
  RUNNING: ['RETRYING', 'COMPLETED', 'FAILED', 'DEAD_LETTER'],
  RETRYING: [],
  COMPLETED: [],
  FAILED: [],
  DEAD_LETTER: [],
  SKIPPED: [],
};

export function isRecurrenceType(value: unknown): value is RecurrenceType {
  return typeof value === 'string' && (recurrenceTypes as readonly string[]).includes(value);
}

export function isAgentTaskTrigger(value: unknown): value is AgentTaskTrigger {
  return typeof value === 'string' && (agentTaskTriggers as readonly string[]).includes(value);
}

export function isAgentTaskExecutionStatus(value: unknown): value is AgentTaskExecutionStatus {
  return typeof value === 'string' && (agentTaskExecutionStatuses as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Bounds (Phase 5 spec)
// ---------------------------------------------------------------------------

/** Task name bound: trimmed 1..200. */
export const AGENT_TASK_MAX_NAME_LENGTH = 200 as const;

/** Task prompt bound: trimmed 1..10000. */
export const AGENT_TASK_MAX_PROMPT_LENGTH = 10000 as const;

/** Fixed retry depth: `maxAttempts` is ALWAYS 3 on every execution row. */
export const MAX_TASK_ATTEMPTS = 3 as const;

/** Skip-date entries: at most 366 unique `YYYY-MM-DD` UTC calendar dates. */
export const MAX_SKIP_DATES = 366 as const;

/**
 * Bounded skip-date iteration: when computing a next run, at most this many
 * scheduled occurrences are examined (>= the 366 spec floor) before the
 * result is declared exhausted (null).
 */
export const MAX_RECURRENCE_ITERATIONS = 732 as const;

/** CUSTOM_CRON expression bound: trimmed, exactly 5 fields, 1..200 chars. */
export const MAX_CRON_EXPRESSION_LENGTH = 200 as const;
export const CRON_FIELD_COUNT = 5 as const;

/** Execution error bound: trimmed 1..1000 characters (host passes SAFE text). */
export const AGENT_TASK_EXECUTION_MAX_ERROR_LENGTH = 1000 as const;

/** `durationMs` bound: integer 0..2147483647 (int4-safe). */
export const MAX_DURATION_MS = 2147483647 as const;

/** Token-usage counter bound: integer 0..2147483647 per field. */
export const MAX_TOKEN_COUNT = 2147483647 as const;

/** Queue identifiers (BullMQ job ids / repeat keys): trimmed 1..128 chars. */
export const AGENT_TASK_MAX_QUEUE_ID_LENGTH = 128 as const;

/** Listing page size bound; defaults set by the schemas. */
export const SCHEDULER_LIST_LIMIT_MAX = 100 as const;
export const SCHEDULER_LIST_LIMIT_DEFAULT = 20 as const;

/** The only supported timezone. UTC makes recurrence DST-free by construction. */
export const AGENT_TASK_TIMEZONE = 'UTC' as const;
