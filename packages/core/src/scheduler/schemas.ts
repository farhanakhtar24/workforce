/**
 * Zod schemas for scheduler inputs. These are the authoritative input
 * contracts for the {@link SchedulerService}; raw JSON and pre-parsed objects
 * are both safe to pass because the service re-validates with these schemas.
 *
 * Normalizing behavior (zod 4 executes chained checks in order):
 * - `scope`: optional, defaults to `"default"`; memory-domain scope rules
 *   (1..64 lowercase `[a-z0-9_-]`), normalized on parse.
 * - `name`: trimmed, 1..200 characters.
 * - `prompt`: trimmed, 1..10000 characters.
 * - `agentSlug`: reuses the Phase 4 vocabulary (`general`|`orchestrator`|
 *   `analyst`|`researcher`); `mode`: `plan`|`action`.
 * - `timezone`: literal `"UTC"` — the whole domain computes in UTC.
 * - `recurrenceConfig`: strict union WITHOUT a type key; the shape must match
 *   `recurrenceType` exactly (`recurrencePair` rule):
 *   ONCE `{runAt}` (UTC `Z` ISO datetime) | DAILY `{hour,minute}` |
 *   WEEKLY `{hour,minute,weekdays unique 0..6}` | MONTHLY
 *   `{hour,minute,daysOfMonth unique 1..31}` | CUSTOM_CRON `{expression}`
 *   (exactly 5 whitespace-separated fields, <=200 chars).
 * - `skipDates`: unique real `YYYY-MM-DD` UTC calendar dates, max 366.
 * - `afterAsOf` (create/update): optional UTC ISO datetime — the supplied
 *   instant the next run is computed AFTER (defaults to the service clock).
 * - `nextRunAt` (update): optional UTC ISO datetime or null (clears); only
 *   honored when NO recurrence field changes (recurrence updates always
 *   recompute).
 * - ids: RFC 9562 UUIDs; `queueJobId`/`repeatJobKey`: trimmed 1..128 chars.
 * - `ownerId`/`expectedOwnerId` (platform-user owner, Better Auth `User.id`):
 *   trimmed 1..128 chars, optional everywhere. Owner guard mismatches read as
 *   404; owner filters match EXACTLY and never return ownerless/other rows.
 * - `limit`: integer 1..100 (lists), defaults 20.
 * - `attempt` (claim): integer 1..3 (`maxAttempts` is fixed at 3).
 * - `durationMs`: integer 0..2147483647; `tokenUsage` fields: integer
 *   0..2147483647, object non-empty; `error`: trimmed, 1..1000 characters.
 */

import { z } from 'zod';

import { memoryScopeSchema } from '../memory/schemas.js';
import { agentModes, agentSlugs } from '../agents/types.js';
import {
  AGENT_TASK_EXECUTION_MAX_ERROR_LENGTH,
  AGENT_TASK_MAX_NAME_LENGTH,
  AGENT_TASK_MAX_PROMPT_LENGTH,
  AGENT_TASK_MAX_QUEUE_ID_LENGTH,
  AGENT_TASK_TIMEZONE,
  CRON_FIELD_COUNT,
  MAX_CRON_EXPRESSION_LENGTH,
  MAX_DURATION_MS,
  MAX_SKIP_DATES,
  MAX_TASK_ATTEMPTS,
  MAX_TOKEN_COUNT,
  SCHEDULER_LIST_LIMIT_DEFAULT,
  SCHEDULER_LIST_LIMIT_MAX,
  type AgentTaskExecutionStatus,
  type AgentTaskTrigger,
  type RecurrenceType,
} from './kinds.js';
import {
  isRealUtcCalendarDate,
  recurrenceConfigMatchesType,
} from './recurrence.js';
import { SchedulerValidationError } from './errors.js';

export const schedulerIdSchema = z.uuid();

export const schedulerExternalIdSchema = z
  .string()
  .trim()
  .min(1, 'external id must not be empty')
  .max(AGENT_TASK_MAX_QUEUE_ID_LENGTH, `external id must be at most ${AGENT_TASK_MAX_QUEUE_ID_LENGTH} characters`);

/**
 * Platform-user owner id (Better Auth `User.id`, TEXT — NOT a UUID): trimmed,
 * 1..128 characters. Legacy ownerless rows carry `null`; owner filters match
 * EXACTLY (an expected owner never matches ownerless rows).
 */
export const schedulerOwnerIdSchema = schedulerExternalIdSchema;

export const agentTaskNameSchema = z
  .string()
  .trim()
  .min(1, 'name must not be empty')
  .max(AGENT_TASK_MAX_NAME_LENGTH, `name must be at most ${AGENT_TASK_MAX_NAME_LENGTH} characters`);

export const agentTaskPromptSchema = z
  .string()
  .trim()
  .min(1, 'prompt must not be empty')
  .max(AGENT_TASK_MAX_PROMPT_LENGTH, `prompt must be at most ${AGENT_TASK_MAX_PROMPT_LENGTH} characters`);

export const agentSlugSchema = z.enum(agentSlugs);

export const agentModeSchema = z.enum(agentModes);

export const recurrenceTypeSchema = z.enum(['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM_CRON']);

export const agentTaskTriggerSchema = z.enum(['SCHEDULED', 'MANUAL', 'RETRY']);

export const agentTaskExecutionStatusSchema = z.enum([
  'PENDING',
  'RUNNING',
  'RETRYING',
  'COMPLETED',
  'FAILED',
  'DEAD_LETTER',
  'SKIPPED',
]);

export const agentTaskTimezoneSchema = z.literal(AGENT_TASK_TIMEZONE);

/** UTC calendar date `YYYY-MM-DD`; real dates only (2026-02-30 is invalid). */
export const skipDateSchema = z
  .string()
  .regex(/^(\d{4})-(\d{2})-(\d{2})$/, 'skip dates must be YYYY-MM-DD')
  .refine(isRealUtcCalendarDate, 'skip dates must be a real calendar date');

export const skipDatesSchema = z
  .array(skipDateSchema)
  .max(MAX_SKIP_DATES, `skip dates must hold at most ${MAX_SKIP_DATES} entries`)
  .refine((dates) => new Set(dates).size === dates.length, {
    message: 'skip dates must not repeat',
  });

// ---------------------------------------------------------------------------
// Recurrence configuration (strict per-recurrence shapes, no type key)
// ---------------------------------------------------------------------------

export const onceRecurrenceConfigSchema = z.strictObject({
  /** UTC ISO datetime ending in `Z`. */
  runAt: z.iso.datetime(),
});

export const dailyRecurrenceConfigSchema = z.strictObject({
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
});

export const weeklyRecurrenceConfigSchema = z
  .strictObject({
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    /** Cron weekday numbers: 0 = Sunday .. 6 = Saturday. */
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1, 'weekdays must hold at least one entry')
      .max(7)
      .refine((weekdays) => new Set(weekdays).size === weekdays.length, {
        message: 'weekdays must not repeat',
      }),
  });

export const monthlyRecurrenceConfigSchema = z
  .strictObject({
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    /** Cron day-of-month numbers: 1..31 (short months skip absent days). */
    daysOfMonth: z
      .array(z.number().int().min(1).max(31))
      .min(1, 'daysOfMonth must hold at least one entry')
      .max(31)
      .refine((days) => new Set(days).size === days.length, {
        message: 'daysOfMonth must not repeat',
      }),
  });

export const customCronRecurrenceConfigSchema = z.strictObject({
  /** Exactly 5 whitespace-separated fields, trimmed, at most 200 characters. */
  expression: z
    .string()
    .trim()
    .min(1, 'cron expression must not be empty')
    .max(MAX_CRON_EXPRESSION_LENGTH, `cron expression must be at most ${MAX_CRON_EXPRESSION_LENGTH} characters`)
    .refine((expression) => expression.split(/\s+/).length === CRON_FIELD_COUNT, {
      message: `cron expression must have exactly ${CRON_FIELD_COUNT} whitespace-separated fields`,
    }),
});

export const recurrenceConfigSchema = z.union([
  onceRecurrenceConfigSchema,
  dailyRecurrenceConfigSchema,
  weeklyRecurrenceConfigSchema,
  monthlyRecurrenceConfigSchema,
  customCronRecurrenceConfigSchema,
]);

/**
 * The (recurrenceType, recurrenceConfig) PAIR rule: the config shape must be
 * the one selected by the type. Applied inside every task create/update
 * schema; also exported for stores (defense in depth).
 */
export const recurrencePairMessage = (type: RecurrenceType): string =>
  `recurrenceConfig shape does not match recurrenceType ${type}`;

export function assertRecurrencePair(
  recurrenceType: RecurrenceType,
  recurrenceConfig: unknown,
): void {
  if (!recurrenceConfigMatchesType(recurrenceType, recurrenceConfig)) {
    throw new SchedulerValidationError(`invalid recurrence input (${recurrencePairMessage(recurrenceType)})`, {
      issues: [recurrencePairMessage(recurrenceType)],
    });
  }
}

// ---------------------------------------------------------------------------
// Route/service input schemas
// ---------------------------------------------------------------------------

/** Optional UTC ISO datetime: the supplied instant next runs compute AFTER. */
const afterAsOfSchema = z.iso.datetime();

/** Body for creating a task (recurrence determines the initial nextRunAt). */
export const createTaskInputSchema = z
  .strictObject({
    /** Optional id for deterministic tests. */
    id: schedulerIdSchema.optional(),
    name: agentTaskNameSchema,
    agentSlug: agentSlugSchema,
    mode: agentModeSchema,
    prompt: agentTaskPromptSchema,
    scope: memoryScopeSchema.optional().default('default'),
    recurrenceType: recurrenceTypeSchema,
    recurrenceConfig: recurrenceConfigSchema,
    skipDates: skipDatesSchema.optional().default([]),
    /** Only UTC is supported. */
    timezone: agentTaskTimezoneSchema.optional().default(AGENT_TASK_TIMEZONE),
    /**
     * Optional platform-user owner id (legacy callers omit it; the task is
     * then ownerless). The authenticated API layer MUST always pass the
     * acting user.
     */
    ownerId: schedulerOwnerIdSchema.optional(),
    afterAsOf: afterAsOfSchema.optional(),
  })
  .refine((value) => recurrenceConfigMatchesType(value.recurrenceType, value.recurrenceConfig), {
    message: 'recurrenceConfig shape does not match recurrenceType',
  });

/**
 * Body for a task update. `id` is required and stays untouched (no-op-guard:
 * at least one mutable field must be present). `recurrenceType` and
 * `recurrenceConfig` must change TOGETHER; recurrence changes always recompute
 * `nextRunAt` (`afterAsOf` is the supplied compute-after instant). Explicit
 * `nextRunAt` (UTC ISO datetime or null to clear) is honored only when no
 * recurrence field is present. `isActive` is NOT updatable here — the
 * dedicated `setTaskActive` owns it.
 */
export const updateTaskInputSchema = z
  .strictObject({
    id: schedulerIdSchema,
    name: agentTaskNameSchema.optional(),
    prompt: agentTaskPromptSchema.optional(),
    agentSlug: agentSlugSchema.optional(),
    mode: agentModeSchema.optional(),
    scope: memoryScopeSchema.optional(),
    recurrenceType: recurrenceTypeSchema.optional(),
    recurrenceConfig: recurrenceConfigSchema.optional(),
    skipDates: skipDatesSchema.optional(),
    nextRunAt: z.iso.datetime().nullable().optional(),
    afterAsOf: afterAsOfSchema.optional(),
    /**
     * Owner guard (NOT a mutable field — excluded from the no-op refine):
     * when set, the task must belong EXACTLY to this user or the update
     * reads as 404 (ownerless legacy rows never match).
     */
    expectedOwnerId: schedulerOwnerIdSchema.optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.prompt !== undefined ||
      value.agentSlug !== undefined ||
      value.mode !== undefined ||
      value.scope !== undefined ||
      value.recurrenceType !== undefined ||
      value.recurrenceConfig !== undefined ||
      value.skipDates !== undefined ||
      value.nextRunAt !== undefined,
    { message: 'update must change at least one of name, prompt, agentSlug, mode, scope, recurrence, skipDates, or nextRunAt' },
  )
  .refine(
    (value) =>
      (value.recurrenceType === undefined) === (value.recurrenceConfig === undefined),
    { message: 'recurrenceType and recurrenceConfig must be provided together' },
  )
  .refine(
    (value) =>
      value.recurrenceType === undefined ||
      value.recurrenceConfig === undefined ||
      recurrenceConfigMatchesType(value.recurrenceType, value.recurrenceConfig),
    { message: 'recurrenceConfig shape does not match recurrenceType' },
  );

export const setTaskActiveInputSchema = z.strictObject({
  id: schedulerIdSchema,
  isActive: z.boolean(),
  /**
   * Owner guard: when set, the task must belong EXACTLY to this user
   * (ownerless legacy rows never match) or the write reads as 404.
   */
  expectedOwnerId: schedulerOwnerIdSchema.optional(),
});

export const listTasksInputSchema = z.strictObject({
  /**
   * Owner filter: EXACT match only. When set, ownerless legacy tasks and
   * other users' tasks are never returned (prevents unbounded global reads).
   */
  ownerId: schedulerOwnerIdSchema.optional(),
  /**
   * Owner-required selector (startup reconciliation): when true, ONLY tasks
   * with `ownerId != null` match — legacy ownerless tasks are excluded even
   * when no exact `ownerId` is supplied.
   */
  ownedOnly: z.boolean().optional(),
  /** Active filter (`isActive`); undefined leaves all tasks visible. */
  isActive: z.boolean().optional(),
  order: z.enum(['newest', 'oldest']).optional().default('newest'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SCHEDULER_LIST_LIMIT_MAX)
    .optional()
    .default(SCHEDULER_LIST_LIMIT_DEFAULT),
});

/**
 * Body for recording one execution row. `trigger` tells the store how the
 * dedupe/upsert contract applies: SCHEDULED rows dedupe atomically per
 * (taskId, scheduledFor); MANUAL and RETRY always insert a new row.
 */
export const createExecutionInputSchema = z.strictObject({
  /** Optional id for deterministic tests; `chatId` is derived from it. */
  id: schedulerIdSchema.optional(),
  scheduledFor: z.iso.datetime(),
  trigger: agentTaskTriggerSchema,
  queueJobId: schedulerExternalIdSchema.optional(),
  repeatJobKey: schedulerExternalIdSchema.optional(),
  retryOfExecutionId: schedulerIdSchema.optional(),
  /**
   * Optional explicit platform-user owner id. When omitted, the execution
   * INHERITS the owning task's `ownerId` (ownerless legacy tasks produce
   * ownerless executions).
   */
  ownerId: schedulerOwnerIdSchema.optional(),
});

/** CAS claim: only PENDING|RETRYING may be claimed; attempt must increment. */
export const claimExecutionInputSchema = z.strictObject({
  id: schedulerIdSchema,
  attempt: z.number().int().min(1).max(MAX_TASK_ATTEMPTS),
  allowedFrom: z.enum(['PENDING', 'RETRYING']),
  /**
   * Owner guard: when set, the execution must belong EXACTLY to this user
   * (ownerless legacy rows never match) or the claim reads as 404 BEFORE the
   * CAS — a wrong owner is never a status/attempt oracle.
   */
  expectedOwnerId: schedulerOwnerIdSchema.optional(),
});

export const agentTaskExecutionTokenUsageSchema = z
  .strictObject({
    inputTokens: z.number().int().min(0).max(MAX_TOKEN_COUNT).optional(),
    outputTokens: z.number().int().min(0).max(MAX_TOKEN_COUNT).optional(),
    totalTokens: z.number().int().min(0).max(MAX_TOKEN_COUNT).optional(),
  })
  .refine((value) => value.inputTokens !== undefined || value.outputTokens !== undefined || value.totalTokens !== undefined, {
    message: 'tokenUsage must contain at least one of inputTokens, outputTokens, totalTokens',
  });

export const markExecutionRetryingInputSchema = z.strictObject({
  id: schedulerIdSchema,
  /** Owner guard; see {@link claimExecutionInputSchema}. */
  expectedOwnerId: schedulerOwnerIdSchema.optional(),
});

export const markExecutionCompletedInputSchema = z.strictObject({
  id: schedulerIdSchema,
  durationMs: z.number().int().min(0).max(MAX_DURATION_MS),
  tokenUsage: agentTaskExecutionTokenUsageSchema.optional(),
  /** Owner guard; see {@link claimExecutionInputSchema}. */
  expectedOwnerId: schedulerOwnerIdSchema.optional(),
});

export const markExecutionFailedInputSchema = z.strictObject({
  id: schedulerIdSchema,
  error: z
    .string()
    .trim()
    .min(1, 'error must not be empty')
    .max(AGENT_TASK_EXECUTION_MAX_ERROR_LENGTH, `error must be at most ${AGENT_TASK_EXECUTION_MAX_ERROR_LENGTH} characters`),
  /** Owner guard; see {@link claimExecutionInputSchema}. */
  expectedOwnerId: schedulerOwnerIdSchema.optional(),
});

export const markExecutionDeadLetterInputSchema = z.strictObject({
  id: schedulerIdSchema,
  error: z
    .string()
    .trim()
    .min(1, 'error must not be empty')
    .max(AGENT_TASK_EXECUTION_MAX_ERROR_LENGTH, `error must be at most ${AGENT_TASK_EXECUTION_MAX_ERROR_LENGTH} characters`),
  /** Owner guard; see {@link claimExecutionInputSchema}. */
  expectedOwnerId: schedulerOwnerIdSchema.optional(),
});

export const markExecutionSkippedInputSchema = z.strictObject({
  id: schedulerIdSchema,
  /** Owner guard; see {@link claimExecutionInputSchema}. */
  expectedOwnerId: schedulerOwnerIdSchema.optional(),
});

export const listExecutionsInputSchema = z.strictObject({
  taskId: schedulerIdSchema.optional(),
  status: agentTaskExecutionStatusSchema.optional(),
  /**
   * Owner filter: EXACT match only. When set, ownerless legacy executions and
   * other users' executions are never returned (prevents unbounded reads).
   */
  ownerId: schedulerOwnerIdSchema.optional(),
  order: z.enum(['newest', 'oldest']).optional().default('newest'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SCHEDULER_LIST_LIMIT_MAX)
    .optional()
    .default(SCHEDULER_LIST_LIMIT_DEFAULT),
});

/**
 * Read options for `getTask`/`getExecution`: the owner guard reads a foreign
 * or ownerless row as absent (`null`) — never an existence oracle.
 */
export const schedulerReadOptionsSchema = z.strictObject({
  expectedOwnerId: schedulerOwnerIdSchema.optional(),
});

// ---------------------------------------------------------------------------
// Parsed (post-normalization) input types
// ---------------------------------------------------------------------------

export type CreateTaskInput = z.input<typeof createTaskInputSchema>;
export type UpdateTaskInput = z.input<typeof updateTaskInputSchema>;
export type SetTaskActiveInput = z.input<typeof setTaskActiveInputSchema>;
export type ListTasksInput = z.input<typeof listTasksInputSchema>;
export type CreateExecutionInput = z.input<typeof createExecutionInputSchema>;
export type ClaimExecutionInput = z.input<typeof claimExecutionInputSchema>;
export type MarkExecutionRetryingInput = z.input<typeof markExecutionRetryingInputSchema>;
export type MarkExecutionCompletedInput = z.input<typeof markExecutionCompletedInputSchema>;
export type MarkExecutionFailedInput = z.input<typeof markExecutionFailedInputSchema>;
export type MarkExecutionDeadLetterInput = z.input<typeof markExecutionDeadLetterInputSchema>;
export type MarkExecutionSkippedInput = z.input<typeof markExecutionSkippedInputSchema>;
export type ListExecutionsInput = z.input<typeof listExecutionsInputSchema>;

export type ParsedRecurrenceType = RecurrenceType;
export type ParsedAgentTaskTrigger = AgentTaskTrigger;
export type ParsedAgentTaskExecutionStatus = AgentTaskExecutionStatus;

export type ParsedRecurrenceConfig = z.output<typeof recurrenceConfigSchema>;
export type ParsedSkipDates = z.output<typeof skipDatesSchema>;

export type ParsedCreateTaskInput = z.output<typeof createTaskInputSchema>;
export type ParsedUpdateTaskInput = z.output<typeof updateTaskInputSchema>;
export type ParsedSetTaskActiveInput = z.output<typeof setTaskActiveInputSchema>;
export type ParsedListTasksInput = z.output<typeof listTasksInputSchema>;
export type ParsedCreateExecutionInput = z.output<typeof createExecutionInputSchema>;
export type ParsedClaimExecutionInput = z.output<typeof claimExecutionInputSchema>;
export type ParsedMarkExecutionRetryingInput = z.output<typeof markExecutionRetryingInputSchema>;
export type ParsedMarkExecutionCompletedInput = z.output<typeof markExecutionCompletedInputSchema>;
export type ParsedMarkExecutionFailedInput = z.output<typeof markExecutionFailedInputSchema>;
export type ParsedMarkExecutionDeadLetterInput = z.output<typeof markExecutionDeadLetterInputSchema>;
export type ParsedMarkExecutionSkippedInput = z.output<typeof markExecutionSkippedInputSchema>;
export type ParsedListExecutionsInput = z.output<typeof listExecutionsInputSchema>;
// NOTE: the SchedulerReadOptions interface lives in `./store.js` (the store
// contract); the parsed `schedulerReadOptionsSchema` output is structurally
// assignable to it, so the service parses with the schema and passes it
// through.
export type ParsedSchedulerReadOptions = z.output<typeof schedulerReadOptionsSchema>;

/**
 * Parse route/service input against `schema`, converting Zod errors into the
 * typed {@link SchedulerValidationError} routes can map to 400. Issue messages
 * never echo submitted values.
 */
export function parseSchedulerInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new SchedulerValidationError(`invalid scheduler input (${issues.join('; ')})`, { issues });
  }
  return result.data;
}
